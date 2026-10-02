// Imports league standings (the `teams` table) from a JSON file into Postgres via Prisma.
//
// Runs automatically when the server starts (see server.js) and can also be run by hand:
//   npm run import:standings
//   node db/importStandings.js path/to/standings.json --overwrite
//
// Accepted JSON shapes:
//   { "teams": [ { "id": "red-lions", "name": "Red Lions", "played": 0, "won": 0,
//                  "drawn": 0, "lost": 0, "gf": 0, "ga": 0, "points": 0 }, ... ] }
//   [ { ...same team objects... } ]
// (Any "players" arrays in the file are ignored here; squads are loaded by `npm run seed`.)
//
// Modes:
//   missing   (default) only creates teams that don't exist yet. Existing rows are left
//             alone, so results recorded during live matches survive a restart.
//   overwrite replaces the standings of every team in the file with the file's values.
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

function normalizeTeam(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`entry #${index + 1} is not an object`);
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id) throw new Error(`entry #${index + 1} is missing "id"`);
  if (!name) throw new Error(`team "${id}" is missing "name"`);

  const won = toInt(raw.won);
  const drawn = toInt(raw.drawn);
  const lost = toInt(raw.lost);
  return {
    id: id.slice(0, 64),
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
    return { created: 0, updated: 0, skipped: 0 };
  }
  if (!['missing', 'overwrite'].includes(resolvedMode)) {
    throw new Error(`unknown import mode "${resolvedMode}" (use "missing", "overwrite" or "off")`);
  }

  const resolvedFile = path.resolve(file || process.env.STANDINGS_FILE || DEFAULT_FILE);
  if (!fs.existsSync(resolvedFile)) {
    console.warn(`Standings import skipped: ${resolvedFile} not found.`);
    return { created: 0, updated: 0, skipped: 0 };
  }

  const teams = readTeams(resolvedFile);
  if (teams.length === 0) return { created: 0, updated: 0, skipped: 0 };

  if (resolvedMode === 'overwrite') {
    const existing = await prisma.team.count({ where: { id: { in: teams.map((t) => t.id) } } });
    await prisma.$transaction(
      teams.map(({ id, ...data }) =>
        prisma.team.upsert({ where: { id }, update: data, create: { id, ...data } })
      )
    );
    const result = { created: teams.length - existing, updated: existing, skipped: 0 };
    console.log(
      `Standings imported from ${path.basename(resolvedFile)} (overwrite): ` +
        `${result.created} created, ${result.updated} updated.`
    );
    return result;
  }

  const { count } = await prisma.team.createMany({ data: teams, skipDuplicates: true });
  const result = { created: count, updated: 0, skipped: teams.length - count };
  console.log(
    `Standings imported from ${path.basename(resolvedFile)}: ` +
      `${result.created} created, ${result.skipped} already present.`
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
