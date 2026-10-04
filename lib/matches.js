// Match persistence shared by the REST API (scheduled / finished matches,
// edited from the statistician page) and the WebSocket layer (the live match).
const { STAT_FIELDS, zeroStats, contribution, difference, deltaOps } = require('./leagueTotals');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_STAT = 999;

const matchInclude = { homeTeam: { select: { id: true, name: true } }, awayTeam: { select: { id: true, name: true } } };

function serializeMatch(m) {
  return {
    id: m.id,
    status: m.status,
    home: m.homeTeam ? { id: m.homeTeam.id, name: m.homeTeam.name } : { id: m.homeTeamId },
    away: m.awayTeam ? { id: m.awayTeam.id, name: m.awayTeam.name } : { id: m.awayTeamId },
    scheduledAt: m.scheduledAt,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    homeFouls: m.homeFouls,
    awayFouls: m.awayFouls,
    homePossession: m.homePossession,
    awayPossession: m.awayPossession,
    countsInLeague: m.countsInLeague,
  };
}

async function listMatches(prisma, { status } = {}) {
  const rows = await prisma.match.findMany({
    where: status ? { status } : undefined,
    include: matchInclude,
  });
  // live first, then upcoming (soonest first), then finished (latest first)
  const rank = { live: 0, scheduled: 1, finished: 2 };
  const time = (m) => (m.scheduledAt || m.startedAt || m.createdAt).getTime();
  rows.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return a.status === 'scheduled' ? time(a) - time(b) : time(b) - time(a);
  });
  return rows.map(serializeMatch);
}

// Match + both squads + the saved per-player numbers, in the shape the stats
// editor uses: stats.home['7'] = { number, name, goals, ... }.
async function getMatchDetail(prisma, id) {
  const m = await prisma.match.findUnique({
    where: { id },
    include: { ...matchInclude, playerStats: true },
  });
  if (!m) throw new HttpError(404, 'Match not found');

  const squads = {};
  const stats = {};
  for (const [side, teamId] of [['home', m.homeTeamId], ['away', m.awayTeamId]]) {
    squads[side] = await prisma.player.findMany({
      where: { teamId },
      orderBy: { number: 'asc' },
      select: { number: true, name: true },
    });
    stats[side] = {};
    for (const p of squads[side]) stats[side][String(p.number)] = { number: p.number, name: p.name, ...zeroStats() };
    for (const s of m.playerStats.filter((r) => r.teamId === teamId)) {
      // Someone who has stats but isn't in the squad any more still shows up.
      if (!squads[side].some((p) => p.number === s.number)) squads[side].push({ number: s.number, name: s.name });
      stats[side][String(s.number)] = {
        number: s.number,
        name: s.name,
        goals: s.goals,
        assists: s.assists,
        fouls: s.fouls,
        yellow_cards: s.yellowCards,
        red_cards: s.redCards,
      };
    }
    squads[side].sort((a, b) => a.number - b.number);
  }
  return { match: serializeMatch(m), squads, stats };
}

function intIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
}

// Validates a stats editor payload:
// { match: { homeScore, awayScore, homeFouls, awayFouls, homePossession, countsInLeague? },
//   players: { home: [{ number, name, goals, ... }], away: [...] } }
function parseStatsPayload(body) {
  if (!body || typeof body !== 'object' || !body.match || typeof body.match !== 'object') {
    throw new HttpError(400, 'Missing match stats');
  }
  const m = body.match;
  const homePossession = intIn(m.homePossession, 0, 100, 'Possession');
  const match = {
    homeScore: intIn(m.homeScore, 0, MAX_STAT, 'Home score'),
    awayScore: intIn(m.awayScore, 0, MAX_STAT, 'Away score'),
    homeFouls: intIn(m.homeFouls, 0, MAX_STAT, 'Home fouls'),
    awayFouls: intIn(m.awayFouls, 0, MAX_STAT, 'Away fouls'),
    homePossession,
    awayPossession: 100 - homePossession,
  };
  if (m.countsInLeague !== undefined) match.countsInLeague = m.countsInLeague === true;

  const players = { home: [], away: [] };
  for (const side of ['home', 'away']) {
    const list = body.players?.[side] ?? [];
    if (!Array.isArray(list)) throw new HttpError(400, 'players must be a list');
    const seen = new Set();
    for (const p of list) {
      const number = intIn(p?.number, 0, 999, 'Shirt number');
      if (seen.has(number)) throw new HttpError(400, `Shirt number ${number} appears twice`);
      seen.add(number);
      const row = { number, name: String(p.name ?? '').slice(0, 100) || `Player ${number}` };
      for (const f of STAT_FIELDS) row[f] = intIn(p[f] ?? 0, 0, MAX_STAT, f.replace('_', ' '));
      players[side].push(row);
    }
  }
  return { match, players };
}

// Prisma rows for a set of per-player numbers (rows with all zeros are not stored).
function statRows(matchId, homeTeamId, awayTeamId, players) {
  const rows = [];
  for (const [side, teamId] of [['home', homeTeamId], ['away', awayTeamId]]) {
    for (const p of players[side] || []) {
      if (!STAT_FIELDS.some((f) => p[f])) continue;
      rows.push({
        matchId,
        teamId,
        number: p.number,
        name: p.name,
        goals: p.goals,
        assists: p.assists,
        fouls: p.fouls,
        yellowCards: p.yellow_cards,
        redCards: p.red_cards,
      });
    }
  }
  return rows;
}

// Applies (new contribution - old contribution) inside the caller's transaction.
async function adjustLeague(tx, prevMatch, prevStats, nextMatch, nextStats) {
  const prev = prevMatch && prevMatch.status === 'finished' ? contribution(prevMatch, prevStats) : { teams: {}, players: {} };
  const next = nextMatch && nextMatch.status === 'finished' ? contribution(nextMatch, nextStats) : { teams: {}, players: {} };
  for (const op of deltaOps(tx, difference(next, prev))) await op;
}

// Saves a statistician's correction to a scheduled or finished match. For a
// finished match that counts in the league, the league table and player totals
// are corrected by the difference, in the same transaction.
async function saveMatchStats(prisma, id, body) {
  const { match: fields, players } = parseStatsPayload(body);

  await prisma.$transaction(async (tx) => {
    const current = await tx.match.findUnique({ where: { id } });
    if (!current) throw new HttpError(404, 'Match not found');
    if (current.status === 'live') {
      throw new HttpError(409, 'This match is live. Use the live match controls instead.');
    }
    const prevStats = await tx.matchPlayerStat.findMany({ where: { matchId: id } });

    await tx.matchPlayerStat.deleteMany({ where: { matchId: id } });
    const rows = statRows(id, current.homeTeamId, current.awayTeamId, players);
    if (rows.length) await tx.matchPlayerStat.createMany({ data: rows });
    const updated = await tx.match.update({ where: { id }, data: { ...fields, updatedAt: new Date() } });

    await adjustLeague(tx, current, prevStats, updated, rows);
  });
  return getMatchDetail(prisma, id);
}

// Writes the live match's final numbers to its row when it ends. With
// saveResult the match also counts towards the league table and player totals.
async function finishLiveMatch(prisma, matchId, liveState, saveResult) {
  const { homeId, awayId } = liveState.currentMatch;
  const m = liveState.match;
  const players = { home: [], away: [] };
  for (const side of ['home', 'away']) {
    for (const st of Object.values(liveState.playerStats?.[side] || {})) {
      const number = Number(st.number);
      if (!Number.isInteger(number)) continue; // shirt numbers are integers in the DB
      const row = { number, name: st.name || `Player ${number}` };
      for (const f of STAT_FIELDS) row[f] = Math.max(0, Number(st[f]) || 0);
      players[side].push(row);
    }
  }

  await prisma.$transaction(async (tx) => {
    const rows = statRows(matchId, homeId, awayId, players);
    await tx.matchPlayerStat.deleteMany({ where: { matchId } });
    if (rows.length) await tx.matchPlayerStat.createMany({ data: rows });
    const finished = await tx.match.update({
      where: { id: matchId },
      data: {
        status: 'finished',
        endedAt: new Date(),
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        homeFouls: m.homeFouls,
        awayFouls: m.awayFouls,
        homePossession: m.homePossession,
        awayPossession: m.awayPossession,
        countsInLeague: saveResult,
        updatedAt: new Date(),
      },
    });
    // The match was never 'finished' before, so its previous contribution is nothing.
    await adjustLeague(tx, null, [], finished, rows);
  });
}

module.exports = {
  HttpError,
  serializeMatch,
  matchInclude,
  listMatches,
  getMatchDetail,
  saveMatchStats,
  finishLiveMatch,
};
