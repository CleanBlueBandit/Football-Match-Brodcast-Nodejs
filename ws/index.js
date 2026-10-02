const { WebSocketServer, WebSocket } = require('ws');
const { prisma } = require('../db/prisma');

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
// League data (Postgres: `teams` + `players` tables via Prisma).
// The DB is the source of truth. `leagueTeams` is a small in-memory copy of
// the standings so publicState() (called on every clock tick) never hits the
// database; it is refreshed whenever the standings could have changed.
// ---------------------------------------------------------------------------
const STAT_FIELDS = ['goals', 'assists', 'fouls', 'yellow_cards', 'red_cards'];
// match-state stat name -> Prisma Player column
const STAT_COLUMNS = {
  goals: 'goals',
  assists: 'assists',
  fouls: 'fouls',
  yellow_cards: 'yellowCards',
  red_cards: 'redCards',
};
const zeroStats = () => Object.fromEntries(STAT_FIELDS.map((f) => [f, 0]));
let leagueTeams = [];

async function loadLeague() {
  try {
    leagueTeams = await prisma.team.findMany({ orderBy: { name: 'asc' } });
  } catch (err) {
    // Keep whatever we had before rather than wiping the team list.
    console.error('Could not load teams from database:', err.message);
  }
}

// A clean copy of a squad for a new match: shirt number + name only. The
// running totals stay in the database; the match tracks its own numbers.
async function loadSquad(teamId) {
  const players = await prisma.player.findMany({
    where: { teamId },
    orderBy: { number: 'asc' },
    select: { number: true, name: true },
  });
  return players;
}

// Gets (or creates) the match-stat record for a player on 'home' / 'away'.
function statEntry(side, number, name) {
  if (!state.playerStats[side] || number === undefined || number === null || number === '') return null;
  const key = String(number);
  let e = state.playerStats[side][key];
  if (!e) {
    e = { number: Number.isFinite(Number(number)) ? Number(number) : key, name: name || '', ...zeroStats() };
    state.playerStats[side][key] = e;
  } else if (name && !e.name) {
    e.name = name;
  }
  return e;
}

// Changes a player's foul count and keeps the team's foul counter in step
// (a player foul is also a team foul). Never goes below zero.
function changePlayerFouls(side, entry, delta) {
  const before = entry.fouls || 0;
  entry.fouls = Math.max(0, before + delta);
  if (entry.fouls !== before) {
    const teamKey = side === 'home' ? 'homeFouls' : 'awayFouls';
    state.match[teamKey] = Math.max(0, (state.match[teamKey] || 0) + delta);
  }
}

// Builds the DB operations that add this match's player stats onto each
// player's running totals. Players that don't exist yet (e.g. added from the
// control panel during the match) are created.
function playerStatOps(side, teamId) {
  const ops = [];
  for (const st of Object.values(state.playerStats?.[side] || {})) {
    if (!STAT_FIELDS.some((f) => st[f])) continue;
    const number = Number(st.number);
    if (!Number.isInteger(number)) continue; // shirt numbers are integers in the DB

    const increments = {};
    const initial = {};
    for (const f of STAT_FIELDS) {
      increments[STAT_COLUMNS[f]] = { increment: st[f] || 0 };
      initial[STAT_COLUMNS[f]] = st[f] || 0;
    }
    ops.push(
      prisma.player.upsert({
        where: { teamId_number: { teamId, number } },
        update: increments,
        create: { teamId, number, name: st.name || `Player ${number}`, ...initial },
      })
    );
  }
  return ops;
}

// Shape matches what tv.js's table overlay reads (pos / team / p / pts);
// the extra fields are there for any future layout.
function buildTable() {
  return leagueTeams
    .map((t) => ({
      id: t.id,
      team: t.name,
      p: t.played,
      w: t.won,
      d: t.drawn,
      l: t.lost,
      gf: t.gf,
      ga: t.ga,
      gd: t.gf - t.ga,
      pts: t.points,
    }))
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team))
    .map((row, i) => ({ pos: i + 1, ...row }));
}

// What clients actually receive: persisted match state + live league data.
// The table and team list come from the teams table, never from app_state,
// so they can't go stale.
function publicState() {
  return {
    ...state,
    table: buildTable(),
    teams: leagueTeams.map((t) => ({ id: t.id, name: t.name })),
  };
}

// Adds the finished match to both teams' standings and player totals, in one
// transaction so a failure can't leave half a result saved.
async function recordResult() {
  const homeId = state.currentMatch?.homeId;
  const awayId = state.currentMatch?.awayId;
  if (!homeId || !awayId) return;

  const hs = state.match.homeScore;
  const as = state.match.awayScore;
  const standing = (gf, ga) => ({
    played: { increment: 1 },
    gf: { increment: gf },
    ga: { increment: ga },
    won: { increment: gf > ga ? 1 : 0 },
    drawn: { increment: gf === ga ? 1 : 0 },
    lost: { increment: gf < ga ? 1 : 0 },
    points: { increment: gf > ga ? 3 : gf === ga ? 1 : 0 },
  });

  await prisma.$transaction([
    prisma.team.update({ where: { id: homeId }, data: standing(hs, as) }),
    prisma.team.update({ where: { id: awayId }, data: standing(as, hs) }),
    ...playerStatOps('home', homeId),
    ...playerStatOps('away', awayId),
  ]);
  await loadLeague();
}

function clearAutoHideTimers() {
  Object.values(autoHideTimers).forEach(clearTimeout);
}

// A match that was started while a team had no players in the database keeps an
// empty squad (squads are copied in when the match starts). If such a match is still
// live after a restart, fill any empty squad from the database so the player
// dropdowns and stat corrections work without having to end the match.
async function refillEmptySquads() {
  if (state.status !== 'live' || !state.currentMatch) return;
  const ids = { home: state.currentMatch.homeId, away: state.currentMatch.awayId };
  let changed = false;
  for (const side of ['home', 'away']) {
    if (state.players[side].length > 0 || !ids[side]) continue;
    const squad = await loadSquad(ids[side]);
    if (squad.length === 0) continue;
    state.players[side] = squad;
    squad.forEach((p) => statEntry(side, p.number, p.name));
    changed = true;
  }
  console.log(
    `Live match restored: ${state.match.homeTeam} (${state.players.home.length} players) vs ${state.match.awayTeam} (${state.players.away.length} players)`
  );
  if (changed) {
    console.log('Filled empty squad(s) of the live match from the database.');
    scheduleSave();
  }
}

async function loadState() {
  await loadLeague();
  const row = await prisma.appState.findUnique({ where: { id: 1 } });
  if (row) {
    state = mergeDefaults(row.data);
    await refillEmptySquads();
  } else {
    state = getDefaultState();
    await prisma.appState.create({ data: { id: 1, data: state } });
  }
}

function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      await prisma.appState.upsert({
        where: { id: 1 },
        update: { data: state, updatedAt: new Date() },
        create: { id: 1, data: state },
      });
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
async function applyCommand(cmd) {
  // Nothing but starting a match makes sense while no match is running
  // (e.g. a stale control tab still showing the old controls).
  if (state.status !== 'live' && cmd.action !== 'startMatch') return false;

  switch (cmd.action) {
    case 'startMatch': {
      if (state.status === 'live') return false; // never overwrite a running match
      if (!cmd.homeId || !cmd.awayId || cmd.homeId === cmd.awayId) return false;
      await loadLeague();
      const home = leagueTeams.find((t) => t.id === cmd.homeId);
      const away = leagueTeams.find((t) => t.id === cmd.awayId);
      if (!home || !away) return false;
      const [homeSquad, awaySquad] = await Promise.all([loadSquad(home.id), loadSquad(away.id)]);
      if (state.status === 'live') return false; // another start won the race while we awaited
      console.log(
        `Match started: ${home.name} (${homeSquad.length} players loaded) vs ${away.name} (${awaySquad.length} players loaded)`
      );

      clearAutoHideTimers();
      const fresh = getDefaultState();
      fresh.match.homeTeam = home.name;
      fresh.match.awayTeam = away.name;
      fresh.players.home = homeSquad;
      fresh.players.away = awaySquad;
      fresh.status = 'live';
      fresh.currentMatch = { homeId: home.id, awayId: away.id };
      state = fresh;
      ['home', 'away'].forEach((side) => state.players[side].forEach((p) => statEntry(side, p.number, p.name)));
      break;
    }

    case 'endMatch': {
      if (cmd.saveResult !== false) {
        try {
          await recordResult();
        } catch (err) {
          // Keep the match running so the operator can retry instead of losing the result.
          console.error('Could not save match result:', err.message);
          return false;
        }
      }
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
      if (cmd.field === 'fouls') changePlayerFouls(cmd.team, entry, delta);
      else entry[cmd.field] = Math.max(0, (entry[cmd.field] || 0) + delta);
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
      // Record the card against the player. A card is the result of a foul, so it
      // also adds one foul to the player and to the team's foul count.
      const cardField = cmd.cardType === 'yellow' ? 'yellow_cards' : cmd.cardType === 'red' ? 'red_cards' : null;
      if (cardField && (cmd.team === 'home' || cmd.team === 'away')) {
        const carded = statEntry(cmd.team, cmd.playerNumber, cmd.playerName);
        if (carded) {
          carded[cardField] = (carded[cardField] || 0) + 1;
          changePlayerFouls(cmd.team, carded, 1);
        }
      }
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

// Commands are handled one at a time so the async ones (start/end match,
// which talk to the database) can't interleave with each other.
let commandQueue = Promise.resolve();

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
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || msg.type !== 'command') return;

      commandQueue = commandQueue
        .then(async () => {
          if (state && (await applyCommand(msg))) {
            scheduleSave();
            broadcast();
          }
        })
        .catch((err) => console.error('Command error:', err.message));
    });

    // Every new connection - control panel tab or tv.html output - gets
    // an immediate snapshot, same as the old initial GET of state.json.
    (async () => {
      if (!state) return;
      if (state.status === 'idle') await loadLeague(); // pick up team edits made between matches
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'state', state: publicState() }));
    })().catch((err) => console.error('Connection error:', err.message));
  });

  process.on('SIGTERM', () => {
    clearInterval(timerInterval);
    clearAutoHideTimers();
  });
}

module.exports = { setupWebSocket };
