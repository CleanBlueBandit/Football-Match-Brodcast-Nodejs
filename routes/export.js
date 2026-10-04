const express = require('express');
const { prisma } = require('../db/prisma');
const { requirePermission } = require('../middleware/auth');
const { getMatchState } = require('../ws');
const { buildReport } = require('../lib/exportReport');

const router = express.Router();

// GET /api/export.xlsx - downloads teams, players, matches (+ the live match) as Excel.
// Statisticians (and admins) only.
router.get('/export.xlsx', requirePermission('stats:manage'), async (req, res) => {
  try {
    const buffer = await buildReport({ prisma, matchState: getMatchState() });
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="broadcast-data-${stamp}.xlsx"`,
      'Cache-Control': 'no-store',
    });
    res.send(buffer);
  } catch (err) {
    console.error('Excel export failed:', err);
    res.status(500).json({ error: 'Could not generate the Excel report' });
  }
});

module.exports = router;
