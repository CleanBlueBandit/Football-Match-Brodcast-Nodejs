const { WebSocketServer, WebSocket } = require('ws');
const { prisma } = require('../db/prisma');
const { canRunCommand, isRole } = require('../lib/roles');
const { finishLiveMatch } = require('../lib/matches');

let state = null;
let wss = null;
let timerInterval = null;
let heartbeatInterval = null;
let graphicTimer = null;
let refCallTimer = null;
let overlayTimer = null; // kept out of `state`: a Timeout object can't be JSON-serialised
let finishing = false;
let commandQueue = Promise.resolve();

// Per-player numbers tracked during the live match (in memory only; they are
// written to the database once, by finishLiveMatch, when the match ends).
const LIVE_STATS = ['goals', 'assists', 'fouls', 'yellowCards', 'redCards'];
// The control panel / older code may use snake_case names for the card stats.
const STAT_ALIASES = { yellow_cards: 'yellowCards', red_cards: 'redCards' };

const DEFAULT_STATE = {
    teams: [],
    players: [],
    table: [],
    match: {
        homeTeam: null,
        awayTeam: null,
        homeScore: 0,
        awayScore: 0,
        homePossession: 50,
        awayPossession: 50,
        homeFouls: 0,
        awayFouls: 0,
        timer: 0,
        running: false,
        startedAt: null,
        matchId: null, // id of the live row in the `matches` table
        addedTime: 0,
        homeFormation: '4-3-3',
        awayFormation: '4-4-2',
    },
    goalHistory: [],
    // Toggle graphics (possession, fouls, table, formations, replay): one at a time.
    overlay: {
        visible: false,
        type: null,
        data: null,
    },
    // Event popups (goal / card / sub). Separate from `overlay` so a goal
    // graphic doesn't knock a toggled possession bar off screen. Auto-hides.
    graphic: {
        visible: false,
        type: null,
        data: null,
    },
    // VAR banner: phase is 'checking' or 'verdict'.
    var: {
        visible: false,
        phase: '',
        checkType: '',
        verdict: '',
    },
    // Quick referee call: 'offside' | 'handball' | 'penalty' | null. Auto-hides.
    refCall: null,
};

const GRAPHIC_TYPES = ['goal', 'card', 'sub'];
const REF_CALLS = ['offside', 'handball', 'penalty'];
const FORMATION_NAMES = ['4-3-3', '4-4-2', '3-5-2', '5-4-1'];
const GRAPHIC_MS = 8000;
const REF_CALL_MS = 6000;
const MAX_GRAPHIC_MS = 60000;

// Event-graphic payloads are shown as text on the TV; keep them small plain values.
function cleanData(data) {
    if (!data || typeof data !== 'object') return null;
    const out = {};
    for (const [key, value] of Object.entries(data).slice(0, 20)) {
        if (typeof value === 'string') out[key] = value.slice(0, 100);
        else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    }
    return out;
}

// Back to the "no match" state: teams unset, score zero, nothing on screen.
function clearMatchState() {
    clearAutoHideTimers();
    state.match = { ...DEFAULT_STATE.match };
    state.goalHistory = [];
    state.overlay = { ...DEFAULT_STATE.overlay };
    state.graphic = { ...DEFAULT_STATE.graphic };
    state.var = { ...DEFAULT_STATE.var };
    state.refCall = null;
    resetPlayerStats();
}

function mergeDefaults(value, defaults) {
    if (!value || typeof value !== 'object') return defaults;

    const result = Array.isArray(defaults) ? [] : {};

    for (const key of Object.keys(defaults)) {
        if (
            value[key] &&
            typeof value[key] === 'object' &&
            !Array.isArray(value[key]) &&
            defaults[key] &&
            typeof defaults[key] === 'object' &&
            !Array.isArray(defaults[key])
        ) {
            result[key] = mergeDefaults(value[key], defaults[key]);
        } else if (value[key] !== undefined) {
            result[key] = value[key];
        } else {
            result[key] = defaults[key];
        }
    }

    return result;
}

async function loadLeague() {
    const teams = await prisma.team.findMany({
        include: {
            players: true,
        },
        orderBy: {
            name: 'asc',
        },
    });

    // teams: league standings (from the DB).
    // players: this match's numbers only, all starting at zero. Career totals
    // stay in the DB and are updated when a match is finished.
    state.teams = teams.map(({ players, ...team }) => team);
    state.players = teams.flatMap((team) =>
        team.players.map((player) => ({
            id: player.id,
            teamId: player.teamId,
            number: player.number,
            name: player.name,
            ...zeroPlayerStats(),
        }))
    );
}

// Re-reads the standings after a finished match changed them.
async function refreshStandings() {
    const teams = await prisma.team.findMany({ orderBy: { name: 'asc' } });
    state.teams = teams;
}

function zeroPlayerStats() {
    return {
        goals: 0,
        assists: 0,
        fouls: 0,
        yellowCards: 0,
        redCards: 0,
    };
}

function zeroTeamStats() {
    return {
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        gf: 0,
        ga: 0,
        points: 0,
    };
}

function buildTable() {
    const table = state.teams.map((team) => ({
        id: team.id,
        name: team.name,
        ...zeroTeamStats(),
    }));

    for (const team of state.teams) {
        const existing = table.find((entry) => entry.id === team.id);
        if (!existing) continue;

        existing.played = team.played || 0;
        existing.won = team.won || 0;
        existing.drawn = team.drawn || 0;
        existing.lost = team.lost || 0;
        existing.gf = team.gf || 0;
        existing.ga = team.ga || 0;
        existing.points = team.points || 0;
    }

    return table.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;

        const goalDifferenceA = a.gf - a.ga;
        const goalDifferenceB = b.gf - b.ga;

        if (goalDifferenceB !== goalDifferenceA) {
            return goalDifferenceB - goalDifferenceA;
        }

        return b.gf - a.gf;
    });
}

function publicState() {
    return {
        ...state,
        table: buildTable(),
    };
}

function broadcast(persist = true) {
    if (persist) persistSoon();
    if (!wss) return;

    const msg = JSON.stringify({
        type: 'state',
        state: publicState(),
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

function clearAutoHideTimers() {
    for (const name of ['overlayTimer', 'graphicTimer', 'refCallTimer']) {
        const timer = { overlayTimer, graphicTimer, refCallTimer }[name];
        if (timer) clearTimeout(timer);
    }
    overlayTimer = null;
    graphicTimer = null;
    refCallTimer = null;
}

function startWebSocketHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    heartbeatInterval = setInterval(() => {
        if (!wss) return;

        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                return ws.terminate();
            }

            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);
}

function resetPlayerStats() {
    for (const player of state.players) {
        Object.assign(player, zeroPlayerStats());
    }
}

// Sends a message to one socket only.
function reply(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

// A live match that is abandoned (replaced by another one, or the server
// restarted) goes back to being a fixture, or is removed if it was an ad-hoc
// match with no schedule.
async function releaseLiveMatch(matchId) {
    if (!matchId) return;
    const row = await prisma.match.findUnique({ where: { id: matchId } });
    if (!row || row.status !== 'live') return;
    if (row.scheduledAt) {
        await prisma.match.update({
            where: { id: matchId },
            data: { status: 'scheduled', startedAt: null, updatedAt: new Date() },
        });
    } else {
        await prisma.match.delete({ where: { id: matchId } });
    }
}


function clampInt(value, min, max) {
    return Math.min(max, Math.max(min, Math.trunc(value)));
}

// The control page sends ids taken from <select> values, which are strings,
// while player ids are numbers: compare them as text.
function findPlayer(id) {
    if (id === null || id === undefined || id === '') return undefined;
    return state.players.find((entry) => String(entry.id) === String(id));
}

function teamExists(id) {
    return state.teams.some((t) => t.id === id);
}

// Changes one of a player's live numbers. A player foul is also a team foul
// (same rule the statistician's editor uses).
function applyPlayerStat(player, stat, delta) {
    const before = player[stat] || 0;
    player[stat] = Math.max(0, before + delta);

    if (stat === 'fouls' && player[stat] !== before) {
        const key = player.teamId === state.match.homeTeam ? 'homeFouls' : 'awayFouls';
        state.match[key] = Math.max(0, (state.match[key] || 0) + (player[stat] - before));
    }
}

// A 'live' row nobody is running any more (the server restarted without a saved
// state, or a start failed half way) goes back to being a fixture / is removed.
async function releaseOrphanedLiveMatches() {
    const orphans = await prisma.match.findMany({ where: { status: 'live' }, select: { id: true } });
    for (const { id } of orphans) await releaseLiveMatch(id);
}


// ---- Surviving a restart ----
// The live match (score, clock, per-player numbers) only exists in memory. It is
// copied into app_state so that a restart (nodemon, a deploy, a crash) picks the
// match up where it was instead of making it disappear.
let persistTimer = null;

function persistSoon() {
    if (persistTimer || !state) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        persistState().catch((error) => console.error('Failed to save live state:', error));
    }, 1500);
}

async function persistState() {
    if (!state) return;
    const data = state.match.matchId
        ? { match: state.match, goalHistory: state.goalHistory, players: state.players }
        : { match: null };

    await prisma.appState.upsert({
        where: { id: 1 },
        update: { data, updatedAt: new Date() },
        create: { id: 1, data },
    });
}

async function flushState() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    await persistState().catch((error) => console.error('Failed to save live state:', error));
}

// Puts a saved live match back, but only if its database row is still 'live'.
async function restoreLiveMatch() {
    let saved = null;
    try {
        const row = await prisma.appState.findUnique({ where: { id: 1 } });
        saved = row?.data?.match ? row.data : null;
    } catch (error) {
        console.error('Could not read saved live state:', error);
    }

    const matchId = saved?.match?.matchId;
    const row = matchId ? await prisma.match.findUnique({ where: { id: matchId } }) : null;

    if (!row || row.status !== 'live' || !teamExists(row.homeTeamId) || !teamExists(row.awayTeamId)) {
        // Nothing valid to resume: give back every stray 'live' row.
        await releaseOrphanedLiveMatches();
        return;
    }

    state.match = { ...DEFAULT_STATE.match, ...saved.match, matchId: row.id };
    state.goalHistory = Array.isArray(saved.goalHistory) ? saved.goalHistory : [];

    const byId = new Map((saved.players || []).map((p) => [p.id, p]));
    for (const player of state.players) {
        const old = byId.get(player.id);
        if (old) for (const key of LIVE_STATS) player[key] = Number(old[key]) || 0;
    }

    // Any other 'live' rows are strays.
    const others = await prisma.match.findMany({
        where: { status: 'live', id: { not: row.id } },
        select: { id: true },
    });
    for (const { id } of others) await releaseLiveMatch(id);

    console.log(`Resumed live match #${row.id} after restart.`);
}

// The shape lib/matches.js finishLiveMatch() expects.
function buildLiveState() {
    const { homeTeam, awayTeam } = state.match;
    const playerStats = { home: {}, away: {} };

    for (const player of state.players) {
        const side = player.teamId === homeTeam ? 'home' : player.teamId === awayTeam ? 'away' : null;
        if (!side) continue;

        playerStats[side][String(player.number)] = {
            number: player.number,
            name: player.name,
            goals: player.goals || 0,
            assists: player.assists || 0,
            fouls: player.fouls || 0,
            yellow_cards: player.yellowCards || 0,
            red_cards: player.redCards || 0,
        };
    }

    return {
        currentMatch: { homeId: homeTeam, awayId: awayTeam },
        match: {
            homeScore: state.match.homeScore,
            awayScore: state.match.awayScore,
            homeFouls: state.match.homeFouls || 0,
            awayFouls: state.match.awayFouls || 0,
            homePossession: state.match.homePossession ?? 50,
            awayPossession: state.match.awayPossession ?? 50,
        },
        playerStats,
    };
}

function roleOf(req, sessionMiddleware) {
    return new Promise((resolve) => {
        sessionMiddleware(req, {}, () => {
            resolve(req.session?.loggedin === true ? req.session.role || null : null);
        });
    });
}

async function handleCommand(command, role, ws) {
    if (!command || typeof command !== 'object') return;

    const action = command.action;

    if (!canRunCommand(role, action)) {
        reply(ws, { type: 'rejected', action });
        return;
    }

    switch (action) {
        case 'set-match': {
            const homeId = command.homeTeam || null;
            const awayId = command.awayTeam || null;

            if (!homeId || !awayId || homeId === awayId) {
                reply(ws, { type: 'error', message: 'Pick two different teams.' });
                return;
            }

            // One live match at a time. The server is the judge of this, not the
            // control page: a second start is refused until the first one is ended.
            if (state.match.matchId) {
                reply(ws, {
                    type: 'error',
                    message: 'A match is already live. End it before starting another.',
                });
                return;
            }

            // Memory says nothing is live, so any 'live' row left in the database
            // is an orphan (e.g. from a crash). Give those back before starting.
            await releaseOrphanedLiveMatches();

            // Validate everything BEFORE touching the database or the state.
            let row;
            const fixtureId = Number(command.matchId);
            const isFixture = Number.isInteger(fixtureId) && fixtureId > 0;

            if (isFixture) {
                const fixture = await prisma.match.findUnique({ where: { id: fixtureId } });

                if (!fixture || fixture.status !== 'scheduled') {
                    reply(ws, { type: 'error', message: 'That fixture is not available to start.' });
                    return;
                }

                // A fixture decides its own teams.
                if (!teamExists(fixture.homeTeamId) || !teamExists(fixture.awayTeamId)) {
                    reply(ws, { type: 'error', message: 'Unknown team.' });
                    return;
                }

                // Only succeeds if it is still 'scheduled' (guards against two clients).
                const { count } = await prisma.match.updateMany({
                    where: { id: fixtureId, status: 'scheduled' },
                    data: { status: 'live', startedAt: new Date(), updatedAt: new Date() },
                });

                if (!count) {
                    reply(ws, { type: 'error', message: 'That fixture is not available to start.' });
                    return;
                }

                row = await prisma.match.findUnique({ where: { id: fixtureId } });
            } else {
                if (!teamExists(homeId) || !teamExists(awayId)) {
                    reply(ws, { type: 'error', message: 'Unknown team.' });
                    return;
                }

                row = await prisma.match.create({
                    data: {
                        homeTeamId: homeId,
                        awayTeamId: awayId,
                        status: 'live',
                        startedAt: new Date(),
                    },
                });
            }

            clearMatchState();

            state.match = {
                ...DEFAULT_STATE.match,
                homeTeam: row.homeTeamId,
                awayTeam: row.awayTeamId,
                matchId: row.id,
            };

            broadcast();
            break;
        }

        case 'start-timer': {
            if (state.match.running) return;

            state.match.running = true;
            state.match.startedAt = Date.now() - state.match.timer * 1000;
            broadcast();
            break;
        }

        case 'pause-timer': {
            state.match.running = false;
            state.match.startedAt = null;
            broadcast();
            break;
        }

        case 'reset-timer': {
            state.match.running = false;
            state.match.startedAt = null;
            state.match.timer = 0;
            broadcast();
            break;
        }

        case 'goal': {
            const side = command.side === 'away' ? 'away' : 'home';
            const scoreKey = side === 'home' ? 'homeScore' : 'awayScore';

            state.match[scoreKey] += 1;

            state.goalHistory.push({
                side,
                playerId: command.playerId || null,
                playerName: command.playerName || null,
                minute: Math.floor(state.match.timer / 60),
            });

            if (command.playerId) {
                const player = findPlayer(command.playerId);

                if (player) {
                    player.goals = (player.goals || 0) + 1;
                }
            }

            broadcast();
            break;
        }

        case 'assist': {
            if (!command.playerId) return;

            const player = findPlayer(command.playerId);

            if (!player) return;

            player.assists = (player.assists || 0) + 1;

            broadcast();
            break;
        }

        case 'stat': {
            const stat = STAT_ALIASES[command.stat] || command.stat;

            if (!command.playerId || !LIVE_STATS.includes(stat)) {
                return;
            }

            const player = findPlayer(command.playerId);

            if (!player) return;

            applyPlayerStat(player, stat, Number(command.amount) || 1);

            broadcast();
            break;
        }

        // ---- Statistician (live match) ----
        // Everything below needs a live match; the statistician's page is only
        // useful while one is running.

        case 'modScore': {
            if (!state.match.matchId) return;

            const side = command.team === 'away' ? 'away' : 'home';
            const scoreKey = side === 'home' ? 'homeScore' : 'awayScore';
            const delta = Math.trunc(Number(command.delta)) || 0;
            if (!delta) return;

            const before = state.match[scoreKey];
            state.match[scoreKey] = clampInt(before + delta, 0, 999);

            // Taking a goal away also takes the latest one of that side off the
            // goal list and the scorer's tally, so the three never disagree.
            if (state.match[scoreKey] < before) {
                const idx = state.goalHistory.map((g) => g.side).lastIndexOf(side);
                if (idx !== -1) {
                    const [removed] = state.goalHistory.splice(idx, 1);
                    const scorer = removed.playerId && state.players.find((p) => p.id === removed.playerId);
                    if (scorer) scorer.goals = Math.max(0, (scorer.goals || 0) - 1);
                }
            }

            broadcast();
            break;
        }

        case 'setTeamStat': {
            if (!state.match.matchId) return;
            if (!['homeFouls', 'awayFouls'].includes(command.field)) return;

            const value = Number(command.value);
            if (!Number.isFinite(value)) return;

            state.match[command.field] = clampInt(value, 0, 999);
            broadcast();
            break;
        }

        case 'updatePossession': {
            if (!state.match.matchId) return;

            const home = Number(command.home);
            if (!Number.isFinite(home)) return;

            state.match.homePossession = clampInt(home, 0, 100);
            state.match.awayPossession = 100 - state.match.homePossession;
            broadcast();
            break;
        }

        case 'adjustPlayerStat': {
            if (!state.match.matchId) return;

            const teamId = command.team === 'away' ? state.match.awayTeam : state.match.homeTeam;
            const stat = STAT_ALIASES[command.field] || command.field;
            const delta = Math.trunc(Number(command.delta)) || 0;

            if (!delta || !LIVE_STATS.includes(stat)) return;

            const player = state.players.find(
                (p) => p.teamId === teamId && String(p.number) === String(command.number)
            );
            if (!player) return;

            applyPlayerStat(player, stat, delta);
            broadcast();
            break;
        }

        case 'overlay': {
            if (overlayTimer) clearTimeout(overlayTimer);
            overlayTimer = null;

            state.overlay = {
                visible: command.visible !== false,
                type: command.type || null,
                data: command.data || null,
            };

            if (command.duration) {
                overlayTimer = setTimeout(() => {
                    overlayTimer = null;
                    state.overlay.visible = false;
                    broadcast();
                }, command.duration);
            }

            broadcast();
            break;
        }

        case 'graphic': {
            if (graphicTimer) clearTimeout(graphicTimer);
            graphicTimer = null;

            const visible = command.visible !== false && GRAPHIC_TYPES.includes(command.type);

            state.graphic = visible
                ? { visible: true, type: command.type, data: cleanData(command.data) }
                : { ...DEFAULT_STATE.graphic };

            if (visible) {
                const ms = Math.min(Number(command.duration) || GRAPHIC_MS, MAX_GRAPHIC_MS);
                graphicTimer = setTimeout(() => {
                    graphicTimer = null;
                    state.graphic = { ...DEFAULT_STATE.graphic };
                    broadcast();
                }, ms);
            }

            broadcast();
            break;
        }

        case 'var-check': {
            const checkType = String(command.checkType || '').slice(0, 40);
            if (!checkType) return;
            state.var = { visible: true, phase: 'checking', checkType, verdict: '' };
            broadcast();
            break;
        }

        case 'var-verdict': {
            const verdict = String(command.verdict || '').slice(0, 40);
            if (!verdict) return;
            const checkType = String(command.checkType || state.var.checkType || '').slice(0, 40);
            state.var = { visible: true, phase: 'verdict', checkType, verdict };
            broadcast();
            break;
        }

        case 'var-clear': {
            state.var = { ...DEFAULT_STATE.var };
            broadcast();
            break;
        }

        case 'ref-call': {
            if (refCallTimer) clearTimeout(refCallTimer);
            refCallTimer = null;

            // Accept 'penaltyCall' too (older name for the same graphic).
            const call = command.call === 'penaltyCall' ? 'penalty' : command.call;
            state.refCall = command.visible !== false && REF_CALLS.includes(call) ? call : null;

            if (state.refCall) {
                refCallTimer = setTimeout(() => {
                    refCallTimer = null;
                    state.refCall = null;
                    broadcast();
                }, REF_CALL_MS);
            }

            broadcast();
            break;
        }

        case 'match-setting': {
            const { setting, value } = command;

            if (setting === 'addedTime') {
                const n = Math.floor(Number(value));
                state.match.addedTime = Number.isFinite(n) ? Math.min(Math.max(n, 0), 30) : 0;
            } else if (setting === 'homeFormation' || setting === 'awayFormation') {
                if (!FORMATION_NAMES.includes(value)) return;
                state.match[setting] = value;
            } else {
                return;
            }

            broadcast();
            break;
        }

        case 'finish-match': {
            const matchId = state.match.matchId;

            // Nothing live (e.g. a double click), or already being saved.
            if (finishing) return;
            if (!matchId) {
                reply(ws, { type: 'error', message: 'There is no live match to end.' });
                return;
            }
            finishing = true;

            // The panel's "Record result and player stats" checkbox; saving is the default.
            const saveResult = command.saveResult !== false;

            try {
                await finishLiveMatch(prisma, matchId, buildLiveState(), saveResult);
            } catch (error) {
                console.error('Failed to finish match:', error);
                reply(ws, {
                    type: 'error',
                    message: 'The match could not be saved. It is still live - try ending it again.',
                });
                return;
            } finally {
                finishing = false;
            }

            // The result is saved: go back to "no match" (control panel shows the
            // start menu again, the TV shows "The match will begin soon") and
            // pick up the new table.
            clearMatchState();

            await refreshStandings().catch((error) =>
                console.error('Failed to refresh standings:', error)
            );

            broadcast();
            break;
        }

        default:
            break;
    }
}

function startTimerBroadcast() {
    if (timerInterval) clearInterval(timerInterval);

    timerInterval = setInterval(() => {
        if (!state?.match?.running || !state.match.startedAt) return;

        state.match.timer = Math.max(
            0,
            Math.floor((Date.now() - state.match.startedAt) / 1000)
        );

        broadcast(false);
    }, 1000);
}

async function setupWebSocket(server, sessionMiddleware) {
    state = mergeDefaults({}, DEFAULT_STATE);

    await loadLeague();

    // A restart loses the in-memory live state: resume the saved match if there
    // is one, otherwise give back any match left 'live'.
    await restoreLiveMatch();

    wss = new WebSocketServer({
        server,
        path: '/ws',
    });

    startWebSocketHeartbeat();
    startTimerBroadcast();

    wss.on('connection', (ws, req) => {
        ws.isAlive = true;

        ws.on('pong', () => {
            ws.isAlive = true;
        });

        const rolePromise = roleOf(req, sessionMiddleware);

        ws.send(
            JSON.stringify({
                type: 'state',
                state: publicState(),
            })
        );

        ws.on('message', (raw) => {
            // One command at a time, in arrival order. Several of them wait on the
            // database, and two overlapping 'set-match' commands could otherwise
            // both pass the "nothing is live" check.
            commandQueue = commandQueue.then(async () => {
                try {
                    const command = JSON.parse(raw.toString());
                    const role = await rolePromise;

                    await handleCommand(command, role, ws);
                } catch (error) {
                    console.error('WebSocket message error:', error);
                    reply(ws, { type: 'error', message: 'The server could not run that command.' });
                }
            });
        });
    });

    wss.on('error', (error) => {
        console.error('WebSocket server error:', error);
    });

    return wss;
}

function getMatchState() {
    return state;
}

process.on('SIGTERM', () => {
    clearInterval(timerInterval);
    clearInterval(heartbeatInterval);
    clearAutoHideTimers();
});

module.exports = {
    setupWebSocket,
    getMatchState,
    broadcast,
    flushState,
};