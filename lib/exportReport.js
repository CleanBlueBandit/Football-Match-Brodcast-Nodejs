// Builds the Excel report: league standings and player totals from Postgres, plus the
// live match (score, clock, per-player match stats) when one is running.
const { buildWorkbook } = require('./xlsx');

const mmss = (sec) => {
  const s = Math.max(0, Number(sec) || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const gd = (t) => t.gf - t.ga;

// Same ordering as the table overlay: points, goal difference, goals for, name.
const byStanding = (a, b) => b.points - a.points || gd(b) - gd(a) || b.gf - a.gf || a.name.localeCompare(b.name);

async function buildReport({ prisma, matchState }) {
  const teams = (
    await prisma.team.findMany({ include: { players: { orderBy: { number: 'asc' } } } })
  ).sort(byStanding);

  const sheets = [
    {
      name: 'Teams',
      columns: [
        { header: 'Pos', width: 6 },
        { header: 'Team', width: 26 },
        { header: 'Played', width: 9 },
        { header: 'Won', width: 7 },
        { header: 'Drawn', width: 8 },
        { header: 'Lost', width: 7 },
        { header: 'GF', width: 7 },
        { header: 'GA', width: 7 },
        { header: 'GD', width: 7 },
        { header: 'Points', width: 9 },
        { header: 'Squad Size', width: 12 },
      ],
      rows: teams.map((t, i) => [i + 1, t.name, t.played, t.won, t.drawn, t.lost, t.gf, t.ga, gd(t), t.points, t.players.length]),
    },
    {
      name: 'Players',
      columns: [
        { header: 'Team', width: 26 },
        { header: 'Number', width: 9 },
        { header: 'Name', width: 28 },
        { header: 'Goals', width: 8 },
        { header: 'Assists', width: 9 },
        { header: 'Fouls', width: 8 },
        { header: 'Yellow Cards', width: 14 },
        { header: 'Red Cards', width: 11 },
      ],
      rows: teams.flatMap((t) =>
        t.players.map((p) => [t.name, p.number, p.name, p.goals, p.assists, p.fouls, p.yellowCards, p.redCards])
      ),
    },
  ];

  if (matchState && matchState.status === 'live') {
    const m = matchState.match;
    sheets.push({
      name: 'Current Match',
      header: false,
      boldFirstColumn: true,
      columns: [{ width: 22 }, { width: 28 }],
      rows: [
        ['Home team', m.homeTeam],
        ['Away team', m.awayTeam],
        ['Score', `${m.homeScore} - ${m.awayScore}`],
        ['Match time', mmss(m.time)],
        ['Clock running', m.isRunning ? 'Yes' : 'No'],
        ['Added time (min)', m.addedTime],
        ['Home fouls', m.homeFouls],
        ['Away fouls', m.awayFouls],
        ['Home possession (%)', m.homePossession],
        ['Away possession (%)', m.awayPossession],
        ['Home formation', m.homeFormation],
        ['Away formation', m.awayFormation],
      ],
    });

    const matchRows = [];
    for (const side of ['home', 'away']) {
      const teamName = side === 'home' ? m.homeTeam : m.awayTeam;
      const entries = Object.values(matchState.playerStats?.[side] || {}).sort(
        (a, b) => Number(a.number) - Number(b.number)
      );
      for (const e of entries) {
        matchRows.push([
          side === 'home' ? 'Home' : 'Away',
          teamName,
          e.number,
          e.name,
          e.goals || 0,
          e.assists || 0,
          e.fouls || 0,
          e.yellow_cards || 0,
          e.red_cards || 0,
        ]);
      }
    }
    sheets.push({
      name: 'Match Player Stats',
      columns: [
        { header: 'Side', width: 8 },
        { header: 'Team', width: 26 },
        { header: 'Number', width: 9 },
        { header: 'Name', width: 28 },
        { header: 'Goals', width: 8 },
        { header: 'Assists', width: 9 },
        { header: 'Fouls', width: 8 },
        { header: 'Yellow Cards', width: 14 },
        { header: 'Red Cards', width: 11 },
      ],
      rows: matchRows,
    });
  }

  return buildWorkbook(sheets);
}

module.exports = { buildReport };
