// Imports teams + squads from prisma/seed/league.json.
// Safe to re-run: existing teams/players keep their standings and stats,
// only missing rows are created (and names are refreshed).
//   npm run seed
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { prisma, pool } = require('../db/prisma');

async function main() {
  const file = path.join(__dirname, 'seed', 'league.json');
  const { teams } = JSON.parse(fs.readFileSync(file, 'utf8'));

  for (const t of teams) {
    await prisma.team.upsert({
      where: { id: t.id },
      update: { name: t.name },
      create: {
        id: t.id,
        name: t.name,
        played: t.played || 0,
        won: t.won || 0,
        drawn: t.drawn || 0,
        lost: t.lost || 0,
        gf: t.gf || 0,
        ga: t.ga || 0,
        points: t.points || 0,
      },
    });

    for (const p of t.players || []) {
      await prisma.player.upsert({
        where: { teamId_number: { teamId: t.id, number: Number(p.number) } },
        update: { name: p.name },
        create: {
          teamId: t.id,
          number: Number(p.number),
          name: p.name,
          goals: p.goals || 0,
          assists: p.assists || 0,
          fouls: p.fouls || 0,
          yellowCards: p.yellow_cards || 0,
          redCards: p.red_cards || 0,
        },
      });
    }
  }
  console.log(`Seeded ${teams.length} teams.`);
}

main()
  .catch((err) => { console.error('Seed failed:', err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
