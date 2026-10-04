const { WebSocketServer, WebSocket } = require('ws');
const { prisma } = require('../db/prisma');
const { canRunCommand, isRole } = require('../lib/roles');
const { STAT_FIELDS, zeroStats } = require('../lib/leagueTotals');
const { finishLiveMatch } = require('../lib/matches');

let state = null;
let wss = null;
let timerInterval = null;
let heartbeatInterval = null;
let saveTimeout = null;

const DEFAULT_STATE = {
    teams: [],
    players: [],
    table: [],
    match: {
        homeTeam: null,
        awayTeam: null,
        homeScore: 0,
        awayScore: 0,
        timer: 0,
        running: false,
        startedAt: null,
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

    state.teams = teams;
    state.players = teams.flatMap((team) => team.players);
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

function scheduleSave() {
    if (saveTimeout) clearTimeout(saveTimeout);

    saveTimeout = setTimeout(async () => {
        saveTimeout = null;

        try {
            await saveState();
        } catch (error) {
            console.error('Failed to save match state:', error);
        }
    }, 500);
}

async function saveState() {
    if (!state) return;

    for (const team of state.teams) {
        await prisma.team.update({
            where: {
                id: team.id,
            },
            data: {
                played: team.played || 0,
                won: team.won || 0,
                drawn: team.drawn || 0,
                lost: team.lost || 0,
                gf: team.gf || 0,
                ga: team.ga || 0,
                points: team.points || 0,
            },
        });
    }

    for (const player of state.players) {
        await prisma.player.update({
            where: {
                id: player.id,
            },
            data: {
                goals: player.goals || 0,
                assists: player.assists || 0,
                fouls: player.fouls || 0,
                yellowCards: player.yellowCards || 0,
                redCards: player.redCards || 0,
            },
        });
    }
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
    if (!state?.overlay) return;

    if (state.overlay.autoHideTimer) {
        clearTimeout(state.overlay.autoHideTimer);
        state.overlay.autoHideTimer = null;
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

function updateTeamStats(homeTeam, awayTeam, homeScore, awayScore) {
    const home = state.teams.find((team) => team.id === homeTeam);
    const away = state.teams.find((team) => team.id === awayTeam);

    if (!home || !away) return;

    home.played = (home.played || 0) + 1;
    away.played = (away.played || 0) + 1;

    home.gf = (home.gf || 0) + homeScore;
    home.ga = (home.ga || 0) + awayScore;

    away.gf = (away.gf || 0) + awayScore;
    away.ga = (away.ga || 0) + homeScore;

    if (homeScore > awayScore) {
        home.won = (home.won || 0) + 1;
        away.lost = (away.lost || 0) + 1;
        home.points = (home.points || 0) + 3;
    } else if (homeScore < awayScore) {
        away.won = (away.won || 0) + 1;
        home.lost = (home.lost || 0) + 1;
        away.points = (away.points || 0) + 3;
    } else {
        home.drawn = (home.drawn || 0) + 1;
        away.drawn = (away.drawn || 0) + 1;
        home.points = (home.points || 0) + 1;
        away.points = (away.points || 0) + 1;
    }
}

function resetPlayerStats() {
    for (const player of state.players) {
        const zero = zeroPlayerStats();

        for (const field of STAT_FIELDS) {
            player[field] = zero[field];
        }
    }
}

function roleOf(req, sessionMiddleware) {
    return new Promise((resolve) => {
        sessionMiddleware(req, {}, () => {
            resolve(req.session?.user?.role || null);
        });
    });
}

async function handleCommand(command, role) {
    if (!command || typeof command !== 'object') return;

    const action = command.action;

    if (!canRunCommand(role, action)) {
        return;
    }

    switch (action) {
        case 'set-match': {
            state.match.homeTeam = command.homeTeam || null;
            state.match.awayTeam = command.awayTeam || null;
            state.match.homeScore = 0;
            state.match.awayScore = 0;
            state.match.timer = 0;
            state.match.running = false;
            state.match.startedAt = null;
            state.goalHistory = [];

            resetPlayerStats();
            broadcast();
            scheduleSave();
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
            scheduleSave();
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
            scheduleSave();
            break;
        }

        case 'stat': {
            if (!command.playerId || !STAT_FIELDS.includes(command.stat)) {
                return;
            }

            const player = state.players.find(
                (entry) => entry.id === command.playerId
            );

            if (!player) return;

            player[command.stat] = Math.max(
                0,
                (player[command.stat] || 0) + (command.amount || 1)
            );

            broadcast();
            scheduleSave();
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
                state.overlay.autoHideTimer = setTimeout(() => {
                    state.overlay.visible = false;
                    state.overlay.autoHideTimer = null;
                    broadcast();
                }, command.duration);
            }

            broadcast();
            break;
        }

        case 'finish-match': {
            if (!state.match.homeTeam || !state.match.awayTeam) return;

            state.match.running = false;
            state.match.startedAt = null;

            updateTeamStats(
                state.match.homeTeam,
                state.match.awayTeam,
                state.match.homeScore,
                state.match.awayScore
            );

            await finishLiveMatch({
                homeTeamId: state.match.homeTeam,
                awayTeamId: state.match.awayTeam,
                homeScore: state.match.homeScore,
                awayScore: state.match.awayScore,
                goalHistory: state.goalHistory,
            });

            broadcast();
            await saveState();
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

async function setupWebSocket(server, sessionMiddleware) {
    state = mergeDefaults({}, DEFAULT_STATE);

    await loadLeague();

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

        ws.on('message', async (raw) => {
            try {
                const command = JSON.parse(raw.toString());
                const role = await rolePromise;

                await handleCommand(command, role);
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

process.on('SIGTERM', () => {
    clearInterval(timerInterval);
    clearInterval(heartbeatInterval);
    clearAutoHideTimers();
});

module.exports = {
    setupWebSocket,
    getMatchState,
    broadcast,
};
