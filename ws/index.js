const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const pool = require('../db/pool');

// This mirrors the state shape from the original tv.js's getDefaultState(),
// since that is the authoritative schema the real broadcast display expects.
function getDefaultState() {
  return {
    match: {
      homeTeam: 'HOME',
      awayTeam: 'AWAY',
      homeScore: 0,
      awayScore: 0,
      time: 0,
      isRunning: false,
      addedTime: 0,
      homeFouls: 0,
      awayFouls: 0,
      homePossession: 50,
      awayPossession: 50,
      homeFormation: '4-3-3',
      awayFormation: '4-4-2',
    },
    players: { home: [], away: [] },
    overlays: {
      goal: { visible: false, team: '', scorer: '', assist: '', number: '', assistNumber: '' },
      possession: false,
      fouls: false,
      card: { visible: false, player: '', type: '', team: '', number: '' },
      sub: { visible: false, out: '', in: '', team: '', outNumber: '', inNumber: '' },
      var: { visible: false, phase: '', checkType: '', verdict: '' },
      formations: false,
      table: false,
      goalHistory: false,
      offside: false,
      advantage: false,
      penaltyCall: false,
      handball: false,
      replay: false,
    },
    goals: [],
    table: [],
  };
}

let state = null;
let wss = null;
let timerInterval = null;
let saveTimeout = null;
const autoHideTimers = {};

// Defensively reconciles whatever is stored in Postgres with the current
// default shape, the same way the original tv.js sanitized the `var`
// overlay after every sync from state.json.
function mergeDefaults(saved = {}) {
  const base = getDefaultState();
  return {
    match: { ...base.match, ...(saved.match || {}) },
    players: {
      home: Array.isArray(saved.players?.home) ? saved.players.home : [],
      away: Array.isArray(saved.players?.away) ? saved.players.away : [],
    },
    overlays: {
      goal: { ...base.overlays.goal, ...(saved.overlays?.goal || {}) },
      possession: !!saved.overlays?.possession,
      fouls: !!saved.overlays?.fouls,
      card: { ...base.overlays.card, ...(saved.overlays?.card || {}) },
      sub: { ...base.overlays.sub, ...(saved.overlays?.sub || {}) },
      var: { ...base.overlays.var, ...(saved.overlays?.var || {}) },
      formations: !!saved.overlays?.formations,
      table: !!saved.overlays?.table,
      goalHistory: !!saved.overlays?.goalHistory,
      offside: !!saved.overlays?.offside,
      advantage: !!saved.overlays?.advantage,
      penaltyCall: !!saved.overlays?.penaltyCall,
      handball: !!saved.overlays?.handball,
      replay: !!saved.overlays?.replay,
    },
    goals: Array.isArray(saved.goals) ? saved.goals : [],
    table: Array.isArray(saved.table) ? saved.table : [],
  };
}

// Original tv.js fetched standings.json / players.json from the client on
// every page load and wrote them into shared state. We do that once,
// server-side, the first time app_state is created, so both control.html
// and tv.html start from the same seed data without re-fetching on load.
function seedFromFiles() {
  const publicDir = path.join(__dirname, '..', 'public');

  try {
    const standingsPath = path.join(publicDir, 'standings.json');
    if (fs.existsSync(standingsPath)) {
      state.table = JSON.parse(fs.readFileSync(standingsPath, 'utf8'));
    }
  } catch (err) {
    console.warn('Could not seed standings.json:', err.message);
  }

  try {
    const playersPath = path.join(publicDir, 'players.json');
    if (fs.existsSync(playersPath)) {
      const data = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
      state.players.home = data.home || [];
      state.players.away = data.away || [];
    }
  } catch (err) {
    console.warn('Could not seed players.json:', err.message);
  }
}

async function loadState() {
  const result = await pool.query('SELECT data FROM app_state WHERE id = 1');
  if (result.rows.length > 0) {
    state = mergeDefaults(result.rows[0].data);
  } else {
    state = getDefaultState();
    seedFromFiles();
    await pool.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [state]);
  }
}

function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      await pool.query(
        `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [state]
      );
    } catch (err) {
      console.error('State save error:', err.message);
    }
  }, 500);
}

function broadcast() {
  if (!wss) return;
  const msg = JSON.stringify({ type: 'state', state });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// quickRefCall in the original control panel calls with 'penalty', but
// tv.js's renderTV() only ever checks overlays.penaltyCall - that mismatch
// meant the Penalty ref-call graphic never actually appeared on the real
// broadcast page. Normalized here so the button works as intended.
function normalizeOverlayKey(key) {
  return key === 'penalty' ? 'penaltyCall' : key;
}

function scheduleAutoHide(key) {
  clearTimeout(autoHideTimers[key]);
  autoHideTimers[key] = setTimeout(() => {
    state.overlays[key] = false;
    scheduleSave();
    broadcast();
  }, 3000);
}

// One case per window.* function the control panel used to call directly
// against its local `state` object before POSTing to save_state.php.
function applyCommand(cmd) {
  switch (cmd.action) {
    case 'toggleTimer':
      state.match.isRunning = !state.match.isRunning;
      break;

    case 'resetTimer':
      state.match.isRunning = false;
      state.match.time = 0;
      break;

    case 'modScore': {
      const key = cmd.team === 'home' ? 'homeScore' : 'awayScore';
      state.match[key] = Math.max(0, state.match[key] + Number(cmd.delta || 0));
      break;
    }

    case 'updateStat': {
      const numericFields = ['addedTime', 'homeFouls', 'awayFouls'];
      const stringFields = ['homeFormation', 'awayFormation'];
      if (numericFields.includes(cmd.field)) {
        state.match[cmd.field] = parseInt(cmd.value, 10) || 0;
      } else if (stringFields.includes(cmd.field)) {
        state.match[cmd.field] = cmd.value;
      } else {
        return false;
      }
      break;
    }

    case 'setTeamName':
      if (cmd.team === 'home') state.match.homeTeam = cmd.value;
      else if (cmd.team === 'away') state.match.awayTeam = cmd.value;
      else return false;
      break;

    case 'updatePossession':
      state.match.homePossession = parseInt(cmd.home, 10) || 0;
      state.match.awayPossession = parseInt(cmd.away, 10) || 0;
      break;

    case 'addPlayer':
      if (!state.players[cmd.team]) return false;
      state.players[cmd.team].push({ name: cmd.name, number: cmd.number });
      break;

    case 'removePlayer':
      if (!state.players[cmd.team]) return false;
      state.players[cmd.team].splice(cmd.index, 1);
      break;

    case 'triggerGoal': {
      const teamNameKey = cmd.team === 'home' ? 'homeTeam' : 'awayTeam';
      const scoreKey = cmd.team === 'home' ? 'homeScore' : 'awayScore';
      state.match[scoreKey] += 1;
      state.overlays.goal = {
        visible: true,
        team: state.match[teamNameKey],
        scorer: cmd.scorerName || '',
        number: cmd.scorerNumber || '',
        assist: cmd.assistName || '',
        assistNumber: cmd.assistNumber || '',
      };
      state.goals.push({ scorer: cmd.scorerName || '', minute: state.match.time, team: cmd.team });
      break;
    }

    case 'triggerCard': {
      const teamNameKey = cmd.team === 'home' ? 'homeTeam' : 'awayTeam';
      state.overlays.card = {
        visible: true,
        player: cmd.playerName || '',
        type: cmd.cardType,
        team: state.match[teamNameKey],
        number: cmd.playerNumber || '',
      };
      break;
    }

    case 'triggerSub': {
      const teamNameKey = cmd.team === 'home' ? 'homeTeam' : 'awayTeam';
      state.overlays.sub = {
        visible: true,
        out: cmd.outName || '',
        in: cmd.inName || '',
        team: state.match[teamNameKey],
        outNumber: cmd.outNumber || '',
        inNumber: cmd.inNumber || '',
      };
      break;
    }

    case 'hideOverlay': {
      const target = state.overlays[cmd.name];
      if (target && typeof target === 'object') target.visible = false;
      else if (cmd.name in state.overlays) state.overlays[cmd.name] = false;
      else return false;
      break;
    }

    case 'toggleOverlay': {
      const target = state.overlays[cmd.name];
      if (target && typeof target === 'object') target.visible = !target.visible;
      else if (cmd.name in state.overlays) state.overlays[cmd.name] = !state.overlays[cmd.name];
      else return false;
      break;
    }

    case 'triggerVarCheck':
      state.overlays.var = { visible: true, phase: 'checking', checkType: cmd.checkType, verdict: '' };
      break;

    case 'showVarVerdict':
      state.overlays.var.phase = 'verdict';
      state.overlays.var.verdict = cmd.verdict;
      break;

    case 'clearVarGraphic':
      state.overlays.var.visible = false;
      break;

    case 'quickRefCall': {
      const key = normalizeOverlayKey(cmd.call);
      if (!(key in state.overlays)) return false;
      state.overlays[key] = true;
      scheduleAutoHide(key);
      break;
    }

    default:
      console.warn('Unknown WS command:', cmd.action);
      return false;
  }
  return true;
}

function setupWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

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

  wss.on('connection', (ws) => {
    // Every new connection - control panel tab or tv.html output - gets
    // an immediate snapshot, same as the old initial GET of state.json.
    if (state) ws.send(JSON.stringify({ type: 'state', state }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg && msg.type === 'command' && applyCommand(msg)) {
        scheduleSave();
        broadcast();
      }
    });
  });

  process.on('SIGTERM', () => {
    clearInterval(timerInterval);
    Object.values(autoHideTimers).forEach(clearTimeout);
  });
}

module.exports = { setupWebSocket };
