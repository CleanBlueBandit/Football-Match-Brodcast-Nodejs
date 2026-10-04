// How a finished match feeds the league table (`teams`) and the running player
// totals (`players`).
//
// A match used to be added onto those totals exactly once, when it ended. Now a
// finished match can be corrected later, so instead of "add", we work with
// *contributions*: what the match currently adds to the totals. Saving a
// correction applies (new contribution - old contribution), so the totals end up
// exactly as if the corrected numbers had been entered the first time.
const STAT_FIELDS = ['goals', 'assists', 'fouls', 'yellow_cards', 'red_cards'];
// match-stat name -> Prisma column
const STAT_COLUMNS = {
  goals: 'goals',
  assists: 'assists',
  fouls: 'fouls',
  yellow_cards: 'yellowCards',
  red_cards: 'redCards',
};
const STANDING_FIELDS = ['played', 'won', 'drawn', 'lost', 'gf', 'ga', 'points'];

const zeroStats = () => Object.fromEntries(STAT_FIELDS.map((f) => [f, 0]));

function standingFor(gf, ga) {
  return {
    played: 1,
    won: gf > ga ? 1 : 0,
    drawn: gf === ga ? 1 : 0,
    lost: gf < ga ? 1 : 0,
    gf,
    ga,
    points: gf > ga ? 3 : gf === ga ? 1 : 0,
  };
}

// match:  { homeTeamId, awayTeamId, homeScore, awayScore, countsInLeague }
// stats:  rows with { teamId, number, name, goals, assists, fouls, yellowCards, redCards }
//         (MatchPlayerStat rows)
// -> { teams: { [teamId]: standingDelta }, players: { ['teamId:number']: { teamId, number, name, ...stats } } }
function contribution(match, stats = []) {
  const out = { teams: {}, players: {} };
  if (!match || match.countsInLeague === false) return out;
  out.teams[match.homeTeamId] = standingFor(match.homeScore, match.awayScore);
  out.teams[match.awayTeamId] = standingFor(match.awayScore, match.homeScore);
  for (const s of stats) {
    const row = {
      teamId: s.teamId,
      number: s.number,
      name: s.name,
      goals: s.goals || 0,
      assists: s.assists || 0,
      fouls: s.fouls || 0,
      yellow_cards: s.yellowCards ?? s.yellow_cards ?? 0,
      red_cards: s.redCards ?? s.red_cards ?? 0,
    };
    if (!STAT_FIELDS.some((f) => row[f])) continue;
    out.players[`${s.teamId}:${s.number}`] = row;
  }
  return out;
}

// next - prev, per team and per player. Entries that net to zero are dropped.
function difference(next, prev) {
  const delta = { teams: {}, players: {} };

  for (const id of new Set([...Object.keys(next.teams), ...Object.keys(prev.teams)])) {
    const a = next.teams[id] || {};
    const b = prev.teams[id] || {};
    const d = Object.fromEntries(STANDING_FIELDS.map((f) => [f, (a[f] || 0) - (b[f] || 0)]));
    if (STANDING_FIELDS.some((f) => d[f])) delta.teams[id] = d;
  }

  for (const key of new Set([...Object.keys(next.players), ...Object.keys(prev.players)])) {
    const a = next.players[key];
    const b = prev.players[key];
    const base = a || b;
    const d = { teamId: base.teamId, number: base.number, name: (a || b).name };
    for (const f of STAT_FIELDS) d[f] = ((a && a[f]) || 0) - ((b && b[f]) || 0);
    if (STAT_FIELDS.some((f) => d[f])) delta.players[key] = d;
  }
  return delta;
}

// Prisma operations (run them inside prisma.$transaction) that apply a delta.
function deltaOps(prisma, delta) {
  const ops = [];
  for (const [teamId, d] of Object.entries(delta.teams)) {
    ops.push(
      prisma.team.update({
        where: { id: teamId },
        data: Object.fromEntries(STANDING_FIELDS.map((f) => [f, { increment: d[f] }])),
      })
    );
  }
  for (const d of Object.values(delta.players)) {
    const number = Number(d.number);
    if (!Number.isInteger(number)) continue; // shirt numbers are integers in the DB
    const increments = {};
    const initial = {};
    for (const f of STAT_FIELDS) {
      increments[STAT_COLUMNS[f]] = { increment: d[f] };
      initial[STAT_COLUMNS[f]] = Math.max(0, d[f]);
    }
    ops.push(
      prisma.player.upsert({
        where: { teamId_number: { teamId: d.teamId, number } },
        update: increments,
        // A player who isn't in the squad yet (e.g. added during the match) is created.
        create: { teamId: d.teamId, number, name: d.name || `Player ${number}`, ...initial },
      })
    );
  }
  return ops;
}

module.exports = { STAT_FIELDS, STAT_COLUMNS, zeroStats, contribution, difference, deltaOps };
