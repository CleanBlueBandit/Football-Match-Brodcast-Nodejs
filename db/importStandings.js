// Imports league standings (`teams`) and squads (`players`) from a JSON file into Postgres via Prisma.
//
// Runs automatically when the server starts (see server.js) and can also be run by hand:
//   npm run import:standings
//   node db/importStandings.js path/to/standings.json --overwrite
//
// Accepted JSON shapes:
//   { "teams": [ { "id": "red-lions", "name": "Red Lions", "played": 0, "won": 0,
//                  "drawn": 0, "lost": 0, "gf": 0, "ga": 0, "points": 0 }, ... ] }
//   [ { ...same team objects... } ]
// Each team may have a "players" array:
//   { "number": 7, "name": "Red Player 7", "goals": 0, "assists": 0, "fouls": 0,
//     "yellow_cards": 0, "red_cards": 0 }
//
// Modes:
//   missing   (default) only creates teams/players that don't exist yet. Existing rows are
//             left alone, so results recorded during live matches survive a restart.
//   overwrite replaces the standings and player stats of everything in the file with the
//             file's values.
//
// Environment:
//   STANDINGS_FILE    path to the JSON file (default: prisma/seed/league.json)
//   STANDINGS_IMPORT  "missing" (default), "overwrite" or "off"
const fs = require('fs');
const path = require('path');
const { prisma } = require('./prisma');

const DEFAULT_FILE = path.join(__dirname, '..', 'prisma', 'seed', 'league.json');

const toInt = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
};

function normalizePlayer(raw, teamId, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`player #${index + 1} of "${teamId}" is not an object`);
  const number = Number(raw.number);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`player #${index + 1} of "${teamId}" has an invalid "number"`);
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new Error(`player #${number} of "${teamId}" is missing "name"`);
  return {
    teamId,
    number,
    name: name.slice(0, 100),
    goals: toInt(raw.goals),
    assists: toInt(raw.assists),
    fouls: toInt(raw.fouls),
    yellowCards: toInt(raw.yellow_cards ?? raw.yellowCards),
    redCards: toInt(raw.red_cards ?? raw.redCards),
  };
}

function normalizeTeam(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`entry #${index + 1} is not an object`);
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id) throw new Error(`entry #${index + 1} is missing "id"`);
  if (!name) throw new Error(`team "${id}" is missing "name"`);

  const won = toInt(raw.won);
  const drawn = toInt(raw.drawn);
  const lost = toInt(raw.lost);
  const teamId = id.slice(0, 64);
  const players = (Array.isArray(raw.players) ? raw.players : []).map((p, i) => normalizePlayer(p, teamId, i));
  const numbers = new Set();
  for (const p of players) {
    if (numbers.has(p.number)) throw new Error(`duplicate shirt number ${p.number} in "${teamId}"`);
    numbers.add(p.number);
  }
  return {
    players,
    id: teamId,
    name: name.slice(0, 100),
    played: raw.played == null ? won + drawn + lost : toInt(raw.played),
    won,
    drawn,
    lost,
    gf: toInt(raw.gf),
    ga: toInt(raw.ga),
    points: raw.points == null ? won * 3 + drawn : toInt(raw.points),
  };
}

function readTeams(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.teams;
  if (!Array.isArray(list)) throw new Error('expected an array of teams or an object with a "teams" array');

  const teams = list.map(normalizeTeam);
  const seen = new Set();
  for (const t of teams) {
    if (seen.has(t.id)) throw new Error(`duplicate team id "${t.id}"`);
    seen.add(t.id);
  }
  return teams;
}

async function importStandings({ file, mode } = {}) {
  const resolvedMode = (mode || process.env.STANDINGS_IMPORT || 'missing').toLowerCase();
  if (resolvedMode === 'off') {
    console.log('Standings import disabled (STANDINGS_IMPORT=off).');
    return { created: 0, updated: 0, skipped: 0, players: 0 };
  }
  if (!['missing', 'overwrite'].includes(resolvedMode)) {
    throw new Error(`unknown import mode "${resolvedMode}" (use "missing", "overwrite" or "off")`);
  }

  const resolvedFile = path.resolve(file || process.env.STANDINGS_FILE || DEFAULT_FILE);
  if (!fs.existsSync(resolvedFile)) {
    console.warn(`Standings import skipped: ${resolvedFile} not found.`);
    return { created: 0, updated: 0, skipped: 0, players: 0 };
  }

  const parsedTeams = readTeams(resolvedFile);
  if (parsedTeams.length === 0) return { created: 0, updated: 0, skipped: 0, players: 0 };

  const teams = parsedTeams.map(({ players, ...team }) => team);
  const players = parsedTeams.flatMap((t) => t.players);
  const fileName = path.basename(resolvedFile);

  if (resolvedMode === 'overwrite') {
    const existing = await prisma.team.count({ where: { id: { in: teams.map((t) => t.id) } } });
    // Teams first (players reference them), all in one transaction.
    await prisma.$transaction([
      ...teams.map(({ id, ...data }) =>
        prisma.team.upsert({ where: { id }, update: data, create: { id, ...data } })
      ),
      ...players.map(({ teamId, number, ...data }) =>
        prisma.player.upsert({
          where: { teamId_number: { teamId, number } },
          update: data,
          create: { teamId, number, ...data },
        })
      ),
    ]);
    const result = { created: teams.length - existing, updated: existing, skipped: 0, players: players.length };
    console.log(
      `Standings imported from ${fileName} (overwrite): ` +
        `${result.created} teams created, ${result.updated} updated, ${result.players} players written.`
    );
    return result;
  }

  const [teamRes, playerRes] = await prisma.$transaction([
    prisma.team.createMany({ data: teams, skipDuplicates: true }),
    prisma.player.createMany({ data: players, skipDuplicates: true }),
  ]);
  const result = {
    created: teamRes.count,
    updated: 0,
    skipped: teams.length - teamRes.count,
    players: playerRes.count,
  };
  console.log(
    `Standings imported from ${fileName}: ${result.created} teams created ` +
      `(${result.skipped} already present), ${result.players} players created ` +
      `(${players.length - result.players} already present).`
  );
  return result;
}

module.exports = { importStandings };

// CLI: node db/importStandings.js [file] [--overwrite]
if (require.main === module) {
  require('dotenv').config();
  const args = process.argv.slice(2);
  const overwrite = args.includes('--overwrite');
  const file = args.find((a) => !a.startsWith('--'));
  const { pool } = require('./prisma');

  importStandings({ file, mode: overwrite ? 'overwrite' : undefined })
    .catch((err) => {
      console.error('Standings import failed:', err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
      await pool.end();
    });
}
