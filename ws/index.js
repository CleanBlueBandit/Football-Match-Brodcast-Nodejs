const { WebSocketServer, WebSocket } = require('ws');
const { prisma } = require('../db/prisma');
const { canRunCommand, isRole } = require('../lib/roles');
const { finishLiveMatch } = require('../lib/matches');

let state = null;
let wss = null;
let timerInterval = null;
let heartbeatInterval = null;
let overlayTimer = null; // kept out of `state`: a Timeout object can't be JSON-serialised
let finishing = false;

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
        timer: 0,
        running: false,
        startedAt: null,
        matchId: null, // id of the live row in the `matches` table
    },
    goalHistory: [],
    overlay: {
        visible: false,
        type: null,
        data: null,
    },
};

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

function broadcast() {
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
    if (overlayTimer) {
        clearTimeout(overlayTimer);
        overlayTimer = null;
    }
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

// The shape lib/matches.js finishLiveMatch() expects.
function buildLiveState() {
    const { homeTeam, awayTeam } = state.match;
    const playerStats = { home: {}, away: {} };
    let homeFouls = 0;
    let awayFouls = 0;

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

        if (side === 'home') homeFouls += player.fouls || 0;
        else awayFouls += player.fouls || 0;
    }

    return {
        currentMatch: { homeId: homeTeam, awayId: awayTeam },
        match: {
            homeScore: state.match.homeScore,
            awayScore: state.match.awayScore,
            homeFouls,
            awayFouls,
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

            if (
                !state.teams.some((t) => t.id === homeId) ||
                !state.teams.some((t) => t.id === awayId)
            ) {
                reply(ws, { type: 'error', message: 'Unknown team.' });
                return;
            }

            // Whatever was live before is abandoned (nothing is recorded for it).
            await releaseLiveMatch(state.match.matchId);
            state.match.matchId = null;

            // Start an existing fixture, or create a match row on the spot.
            let row;
            const fixtureId = Number(command.matchId);

            if (Number.isInteger(fixtureId) && fixtureId > 0) {
                const fixture = await prisma.match.findUnique({ where: { id: fixtureId } });

                if (!fixture || fixture.status !== 'scheduled') {
                    reply(ws, { type: 'error', message: 'That fixture is not available to start.' });
                    return;
                }

                row = await prisma.match.update({
                    where: { id: fixtureId },
                    data: { status: 'live', startedAt: new Date(), updatedAt: new Date() },
                });
            } else {
                row = await prisma.match.create({
                    data: {
                        homeTeamId: homeId,
                        awayTeamId: awayId,
                        status: 'live',
                        startedAt: new Date(),
                    },
                });
            }

            state.match = {
                ...state.match,
                // A fixture decides its own teams.
                homeTeam: row.homeTeamId,
                awayTeam: row.awayTeamId,
                homeScore: 0,
                awayScore: 0,
                homePossession: 50,
                awayPossession: 50,
                timer: 0,
                running: false,
                startedAt: null,
                matchId: row.id,
            };
            state.goalHistory = [];

            resetPlayerStats();
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
                const player = state.players.find(
                    (entry) => entry.id === command.playerId
                );

                if (player) {
                    player.goals = (player.goals || 0) + 1;
                }
            }

            broadcast();
            break;
        }

        case 'assist': {
            if (!command.playerId) return;

            const player = state.players.find(
                (entry) => entry.id === command.playerId
            );

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

            const player = state.players.find(
                (entry) => entry.id === command.playerId
            );

            if (!player) return;

            player[stat] = Math.max(
                0,
                (player[stat] || 0) + (Number(command.amount) || 1)
            );

            broadcast();
            break;
        }

        case 'overlay': {
            clearAutoHideTimers();

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

        case 'finish-match': {
            const matchId = state.match.matchId;

            // Nothing live (e.g. a double click), or already being saved.
            if (!matchId || finishing) return;
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

            // Stop the clock, keep the final score on screen, pick up the new table.
            state.match.running = false;
            state.match.startedAt = null;
            state.match.matchId = null;

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

        broadcast();
    }, 1000);
}

function setupWebSocket(server, sessionMiddleware) {
  wss = new WebSocketServer({ server, path: '/ws' });
  console.log('WebSocket server ready (state.status protocol: tv.html, /control and /stats all use it)');

  loadState()
    .then(() => {
      timerInterval = setInterval(() => {
        if (state.match.isRunning) {
          state.match.time += 1;
          scheduleSave();
          broadcast();
        }
      }, 1000);
    })
    .catch((err) => console.error('Failed to load initial state:', err.message));

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

        ws.on('message', async (raw) => {
            try {
                const command = JSON.parse(raw.toString());
                const role = await rolePromise;

                await handleCommand(command, role, ws);
            } catch (error) {
                console.error('WebSocket message error:', error);
            }
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

module.exports = { setupWebSocket, getMatchState };