require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { prisma, pool } = require('./prisma');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Absolute paths are used as-is; bare names are looked up in /data.
function resolveScheduleFile(file) {
  const name = file || process.env.SCHEDULE_FILE || 'schedule.json';
  return path.isAbsolute(name) ? name : path.join(DATA_DIR, name);
}

const norm = (s) => String(s).trim().toLowerCase();

function pick(raw, ...keys) {
  for (const k of keys) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k];
  }
  return undefined;
}

function parseDate(raw) {
  let value = pick(raw, 'scheduledAt', 'scheduled_at', 'datetime');
  if (value === undefined) {
    const date = pick(raw, 'date');
    if (date === undefined) return null;
    const time = pick(raw, 'time');
    value = time === undefined ? String(date) : `${String(date).trim()}T${String(time).trim()}`;
  }
  let text = String(value).trim();
  // "2026-10-10" alone would be read as UTC midnight; use the server's local midnight instead.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T00:00';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date "${value}"`);
  return d;
}

function readFixtures(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.matches;
  if (!Array.isArray(list)) {
    throw new Error('expected an array of matches or an object with a "matches" array');
  }
  return list;
}

// Turns raw JSON entries into { homeTeamId, awayTeamId, scheduledAt } rows.
function normalize(list, teams) {
  const byId = new Map(teams.map((t) => [t.id, t.id]));
  const byName = new Map(teams.map((t) => [norm(t.name), t.id]));
  const resolve = (ref) => {
    if (ref === undefined) return undefined;
    return byId.get(String(ref).trim()) || byName.get(norm(ref));
  };

  const rows = [];
  const seen = new Set();
  list.forEach((raw, i) => {
    try {
      if (!raw || typeof raw !== 'object') throw new Error('not an object');
      const homeRef = pick(raw, 'home', 'homeId', 'homeTeam', 'home_team_id');
      const awayRef = pick(raw, 'away', 'awayId', 'awayTeam', 'away_team_id');
      if (homeRef === undefined || awayRef === undefined) throw new Error('needs "home" and "away"');
      const homeTeamId = resolve(homeRef);
      const awayTeamId = resolve(awayRef);
      if (!homeTeamId) throw new Error(`unknown team "${homeRef}"`);
      if (!awayTeamId) throw new Error(`unknown team "${awayRef}"`);
      if (homeTeamId === awayTeamId) throw new Error('home and away are the same team');

      const scheduledAt = parseDate(raw);
      const key = fixtureKey(homeTeamId, awayTeamId, scheduledAt);
      if (seen.has(key)) throw new Error('duplicate of an earlier entry in the file');
      seen.add(key);
      rows.push({ homeTeamId, awayTeamId, scheduledAt });
    } catch (err) {
      console.warn(`Schedule import: skipping match #${i + 1} - ${err.message}`);
    }
  });
  return rows;
}

function fixtureKey(homeTeamId, awayTeamId, scheduledAt) {
  return `${homeTeamId}|${awayTeamId}|${scheduledAt ? scheduledAt.getTime() : 'none'}`;
}

async function importSchedule({ file, mode } = {}) {
  const resolvedMode = (mode || process.env.SCHEDULE_IMPORT || 'missing').toLowerCase();
  if (resolvedMode === 'off') {
    console.log('Schedule import disabled (SCHEDULE_IMPORT=off).');
    return;
  }
  if (!['missing', 'overwrite'].includes(resolvedMode)) {
    throw new Error(`unknown import mode "${resolvedMode}" (use "missing", "overwrite" or "off")`);
  }

  const resolvedFile = resolveScheduleFile(file);
  if (!fs.existsSync(resolvedFile)) {
    console.warn(`Schedule import skipped: ${resolvedFile} not found.`);
    return;
  }

  const list = readFixtures(resolvedFile);
  const fileName = path.basename(resolvedFile);
  // An empty file means "nothing to import", never "delete the whole schedule".
  if (list.length === 0) {
    console.log(`Schedule import skipped: ${fileName} contains no matches.`);
    return;
  }

  const teams = await prisma.team.findMany({ select: { id: true, name: true } });
  const rows = normalize(list, teams);
  const wanted = new Set(rows.map((r) => fixtureKey(r.homeTeamId, r.awayTeamId, r.scheduledAt)));

  const existing = await prisma.match.findMany({
    select: {
      id: true,
      status: true,
      homeTeamId: true,
      awayTeamId: true,
      scheduledAt: true,
      _count: { select: { playerStats: true } },
    },
  });
  const existingKeys = new Set(existing.map((m) => fixtureKey(m.homeTeamId, m.awayTeamId, m.scheduledAt)));

  const toCreate = rows.filter((r) => !existingKeys.has(fixtureKey(r.homeTeamId, r.awayTeamId, r.scheduledAt)));
  const created = toCreate.length ? (await prisma.match.createMany({ data: toCreate })).count : 0;

  let deleted = 0;
  let kept = 0;
  if (resolvedMode === 'overwrite') {
    // The file becomes the authoritative list of upcoming fixtures. Live and finished
    // matches are never touched, and neither is a scheduled match that already has
    // statistics entered for it.
    for (const m of existing) {
      if (m.status !== 'scheduled') continue;
      if (wanted.has(fixtureKey(m.homeTeamId, m.awayTeamId, m.scheduledAt))) continue;
      if (m._count.playerStats > 0) {
        kept++;
        continue;
      }
      await prisma.match.delete({ where: { id: m.id } });
      deleted++;
    }
  }

  console.log(`Schedule ${resolvedMode === 'overwrite' ? 'synchronized' : 'imported'} from ${fileName}:`);
  console.log(
    `  Matches: ${created} created, ${rows.length - created} already existed` +
      (resolvedMode === 'overwrite' ? `, ${deleted} removed` : '') +
      '.'
  );
  if (kept) console.log(`  ${kept} scheduled match(es) not in the file were kept because they have stats entered.`);
  return { created, existed: rows.length - created, deleted, kept };
}

module.exports = { importSchedule };

/*
 * CLI:
 *   node db/importSchedule.js
 *   node db/importSchedule.js schedule.json
 *   node db/importSchedule.js schedule.json --overwrite
 *
 * Bare file names are looked up in /data.
 */
if (require.main === module) {
  const args = process.argv.slice(2);
  const overwrite = args.includes('--overwrite');
  const file = args.find((a) => !a.startsWith('--'));

  importSchedule({ file, mode: overwrite ? 'overwrite' : undefined })
    .catch((err) => {
      console.error('Schedule import failed:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
      await pool.end();
    });
}