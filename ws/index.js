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
    // Per-match player stats, keyed by shirt number: { home: { '7': { number, name, goals, assists, fouls } }, away: {...} }.
    // Kept apart from state.players so removing a player mid-match doesn't lose their goals.
    playerStats: { home: {}, away: {} },
    // 'idle' = no match running (control shows the start menu, TV shows the
    // "match will begin soon" card). 'live' = a match is in progress.
    status: 'idle',
    currentMatch: null, // { homeId, awayId } while live
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
    playerStats: {
      home: saved.playerStats?.home && typeof saved.playerStats.home === 'object' ? saved.playerStats.home : {},
      away: saved.playerStats?.away && typeof saved.playerStats.away === 'object' ? saved.playerStats.away : {},
    },
    // A saved match only counts as live if we still know which teams played.
    status: saved.status === 'live' && saved.currentMatch ? 'live' : 'idle',
    currentMatch: saved.status === 'live' && saved.currentMatch ? saved.currentMatch : null,
  };
}

// ---------------------------------------------------------------------------
// League data (data/league.json): teams, their squads and their standings.
// This is the single source of truth for team selection and the league table.
// ---------------------------------------------------------------------------
const STAT_FIELDS = ['goals', 'assists', 'fouls'];
const LEAGUE_PATH = path.join(__dirname, '..', 'data', 'league.json');
let league = { teams: [] };

function loadLeague() {
  try {
    const data = JSON.parse(fs.readFileSync(LEAGUE_PATH, 'utf8'));
    if (!Array.isArray(data.teams)) throw new Error('"teams" must be an array');
    // Every player always carries the three stat fields, so the file is uniform.
    data.teams.forEach((t) => {
      t.players = Array.isArray(t.players) ? t.players : [];
      t.players.forEach((p) => STAT_FIELDS.forEach((f) => { p[f] = Number(p[f]) || 0; }));
    });
    league = data;
  } catch (err) {
    // Keep whatever we had before rather than wiping the team list.
    console.error('Could not load data/league.json:', err.message);
  }
}

function saveLeague() {
  try {
    const tmp = LEAGUE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(league, null, 2) + '\n');
    fs.renameSync(tmp, LEAGUE_PATH); // atomic swap, so a crash can't leave a half-written file
  } catch (err) {
    console.error('Could not save data/league.json:', err.message);
  }
}

const findTeam = (id) => league.teams.find((t) => t.id === id);
// A clean copy of a squad for a new match: shirt number + name only. The
// running totals stay in league.json; the match tracks its own numbers.
const clonePlayers = (list) =>
  Array.isArray(list) ? list.map((p) => ({ number: p.number, name: p.name })) : [];

// Gets (or creates) the match-stat record for a player on 'home' / 'away'.
function statEntry(side, number, name) {
  if (!state.playerStats[side] || number === undefined || number === null || number === '') return null;
  const key = String(number);
  let e = state.playerStats[side][key];
  if (!e) {
    e = { number: Number.isFinite(Number(number)) ? Number(number) : key, name: name || '', goals: 0, assists: 0, fouls: 0 };
    state.playerStats[side][key] = e;
  } else if (name && !e.name) {
    e.name = name;
  }
  return e;
}

// Adds this match's player stats onto each player's running totals in league.json.
function recordPlayerStats(side, team) {
  for (const st of Object.values(state.playerStats?.[side] || {})) {
    if (!st.goals && !st.assists && !st.fouls) continue;
    let p = team.players.find((pl) => String(pl.number) === String(st.number));
    if (!p) {
      // e.g. a player added from the control panel during the match
      p = { number: st.number, name: st.name, goals: 0, assists: 0, fouls: 0 };
      team.players.push(p);
    }
    STAT_FIELDS.forEach((f) => { p[f] = (p[f] || 0) + (st[f] || 0); });
  }
}

// Shape matches what tv.js's table overlay reads (pos / team / p / pts);
// the extra fields are there for any future layout.
function buildTable() {
  return league.teams
    .map((t) => {
      const gf = t.gf || 0;
      const ga = t.ga || 0;
      return {
        id: t.id,
        team: t.name,
        p: t.played || 0,
        w: t.won || 0,
        d: t.drawn || 0,
        l: t.lost || 0,
        gf,
        ga,
        gd: gf - ga,
        pts: t.points || 0,
      };
    })
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team))
    .map((row, i) => ({ pos: i + 1, ...row }));
}

// What clients actually receive: persisted match state + live league data.
// The table and team list are derived from league.json, never stored in
// Postgres, so they can't go stale.
function publicState() {
  return {
    ...state,
    table: buildTable(),
    teams: league.teams.map((t) => ({ id: t.id, name: t.name })),
  };
}

// Adds the finished match to both teams' standings and writes league.json.
function recordResult() {
  const home = findTeam(state.currentMatch?.homeId);
  const away = findTeam(state.currentMatch?.awayId);
  if (!home || !away) return;

  const hs = state.match.homeScore;
  const as = state.match.awayScore;
  const add = (t, key, n) => { t[key] = (t[key] || 0) + n; };

  add(home, 'played', 1); add(away, 'played', 1);
  add(home, 'gf', hs);    add(home, 'ga', as);
  add(away, 'gf', as);    add(away, 'ga', hs);

  if (hs > as)      { add(home, 'won', 1);   add(home, 'points', 3); add(away, 'lost', 1); }
  else if (hs < as) { add(away, 'won', 1);   add(away, 'points', 3); add(home, 'lost', 1); }
  else              { add(home, 'drawn', 1); add(home, 'points', 1); add(away, 'drawn', 1); add(away, 'points', 1); }

  recordPlayerStats('home', home);
  recordPlayerStats('away', away);

  saveLeague();
}

function clearAutoHideTimers() {
  Object.values(autoHideTimers).forEach(clearTimeout);
}

async function loadState() {
  loadLeague();
  const result = await pool.query('SELECT data FROM app_state WHERE id = 1');
  if (result.rows.length > 0) {
    state = mergeDefaults(result.rows[0].data);
  } else {
    state = getDefaultState();
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
  const msg = JSON.stringify({ type: 'state', state: publicState() });
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
  // Nothing but starting a match makes sense while no match is running
  // (e.g. a stale control tab still showing the old controls).
  if (state.status !== 'live' && cmd.action !== 'startMatch') return false;

  switch (cmd.action) {
    case 'startMatch': {
      if (state.status === 'live') return false; // never overwrite a running match
      loadLeague();
      const home = findTeam(cmd.homeId);
      const away = findTeam(cmd.awayId);
      if (!home || !away || home.id === away.id) return false;

      clearAutoHideTimers();
      const fresh = getDefaultState();
      fresh.match.homeTeam = home.name;
      fresh.match.awayTeam = away.name;
      fresh.players.home = clonePlayers(home.players);
      fresh.players.away = clonePlayers(away.players);
      fresh.status = 'live';
      fresh.currentMatch = { homeId: home.id, awayId: away.id };
      state = fresh;
      ['home', 'away'].forEach((side) => state.players[side].forEach((p) => statEntry(side, p.number, p.name)));
      break;
    }

    case 'endMatch': {
      if (cmd.saveResult !== false) recordResult();
      clearAutoHideTimers();
      state = getDefaultState(); // idle, clock stopped, overlays/goals/scores cleared
      break;
    }

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
      // Stats are keyed by shirt number, so numbers must be unique within a team.
      if (state.players[cmd.team].some((p) => String(p.number) === String(cmd.number))) return false;
      state.players[cmd.team].push({ name: cmd.name, number: cmd.number });
      statEntry(cmd.team, cmd.number, cmd.name);
      break;

    case 'adjustPlayerStat': {
      if (!state.players[cmd.team] || !STAT_FIELDS.includes(cmd.field)) return false;
      const squadPlayer = state.players[cmd.team].find((p) => String(p.number) === String(cmd.number));
      const entry = statEntry(cmd.team, cmd.number, squadPlayer?.name);
      if (!entry) return false;
      const delta = Number(cmd.delta) < 0 ? -1 : 1;
      const before = entry[cmd.field];
      entry[cmd.field] = Math.max(0, before + delta);
      // A player foul is also a team foul, so keep the team counter in step.
      if (cmd.field === 'fouls' && entry[cmd.field] !== before) {
        const teamKey = cmd.team === 'home' ? 'homeFouls' : 'awayFouls';
        state.match[teamKey] = Math.max(0, (state.match[teamKey] || 0) + delta);
      }
      break;
    }

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
      if (cmd.team === 'home' || cmd.team === 'away') {
        const scorer = statEntry(cmd.team, cmd.scorerNumber, cmd.scorerName);
        if (scorer) scorer.goals += 1;
        const assister = statEntry(cmd.team, cmd.assistNumber, cmd.assistName);
        if (assister) assister.assists += 1;
      }
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
    if (state) {
      if (state.status === 'idle') loadLeague(); // pick up hand-edits to league.json between matches
      ws.send(JSON.stringify({ type: 'state', state: publicState() }));
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg && msg.type === 'command' && state && applyCommand(msg)) {
        scheduleSave();
        broadcast();
      }
    });
  });

  process.on('SIGTERM', () => {
    clearInterval(timerInterval);
    clearAutoHideTimers();
  });
}

module.exports = { setupWebSocket };
