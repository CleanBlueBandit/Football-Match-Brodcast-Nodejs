// Fixtures and their statistics.
//   broadcaster+: list matches (to start a scheduled one)
//   statistician: schedule / reschedule / delete fixtures, read and correct the
//                 stats of any scheduled or finished match
// The live match is corrected through the WebSocket (see ws/index.js), not here.
const express = require('express');
const { prisma } = require('../db/prisma');
const { requirePermission } = require('../middleware/auth');
const {
  HttpError,
  serializeMatch,
  matchInclude,
  listMatches,
  getMatchDetail,
  saveMatchStats,
} = require('../lib/matches');

const router = express.Router();
const canRead = requirePermission('matches:read');
const canManage = requirePermission('stats:manage');

function parseId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Invalid match id');
  return id;
}

function parseScheduledAt(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Invalid date');
  return d;
}

async function requireTeams(homeId, awayId) {
  if (!homeId || !awayId || homeId === awayId) throw new HttpError(400, 'Pick two different teams');
  const found = await prisma.team.count({ where: { id: { in: [homeId, awayId] } } });
  if (found !== 2) throw new HttpError(400, 'Unknown team');
}

// Wraps a handler so thrown HttpErrors become JSON responses.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
    res.status(500).json({ error: 'Server error' });
  }
};

router.get(
  '/teams',
  canManage,
  handle(async (req, res) => {
    const teams = await prisma.team.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
    res.json({ teams });
  })
);

router.get(
  '/matches',
  canRead,
  handle(async (req, res) => {
    const status = ['scheduled', 'live', 'finished'].includes(req.query.status) ? req.query.status : undefined;
    res.json({ matches: await listMatches(prisma, { status }) });
  })
);

router.post(
  '/matches',
  canManage,
  handle(async (req, res) => {
    const { homeId, awayId } = req.body || {};
    await requireTeams(homeId, awayId);
    const scheduledAt = parseScheduledAt(req.body.scheduledAt);
    const created = await prisma.match.create({
      data: { homeTeamId: homeId, awayTeamId: awayId, scheduledAt: scheduledAt ?? null },
      include: matchInclude,
    });
    res.status(201).json({ match: serializeMatch(created) });
  })
);

router.get(
  '/matches/:id',
  canManage,
  handle(async (req, res) => {
    res.json(await getMatchDetail(prisma, parseId(req)));
  })
);

router.put(
  '/matches/:id/stats',
  canManage,
  handle(async (req, res) => {
    res.json(await saveMatchStats(prisma, parseId(req), req.body));
  })
);

// Reschedule / change the teams of a fixture that hasn't started.
router.patch(
  '/matches/:id',
  canManage,
  handle(async (req, res) => {
    const id = parseId(req);
    const existing = await prisma.match.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, 'Match not found');
    if (existing.status !== 'scheduled') throw new HttpError(409, 'Only a match that has not started can be changed');

    const data = {};
    const homeId = req.body?.homeId ?? existing.homeTeamId;
    const awayId = req.body?.awayId ?? existing.awayTeamId;
    if (homeId !== existing.homeTeamId || awayId !== existing.awayTeamId) {
      await requireTeams(homeId, awayId);
      data.homeTeamId = homeId;
      data.awayTeamId = awayId;
    }
    const scheduledAt = parseScheduledAt(req.body?.scheduledAt);
    if (scheduledAt !== undefined) data.scheduledAt = scheduledAt;

    // Stats entered for the old teams don't belong to the new ones.
    const updated = await prisma.$transaction(async (tx) => {
      if (data.homeTeamId) await tx.matchPlayerStat.deleteMany({ where: { matchId: id } });
      return tx.match.update({ where: { id }, data: { ...data, updatedAt: new Date() }, include: matchInclude });
    });
    res.json({ match: serializeMatch(updated) });
  })
);

router.delete(
  '/matches/:id',
  canManage,
  handle(async (req, res) => {
    const { count } = await prisma.match.deleteMany({ where: { id: parseId(req), status: 'scheduled' } });
    if (!count) throw new HttpError(409, 'Only a scheduled match can be deleted');
    res.json({ status: 'ok' });
  })
);

module.exports = router;
