require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { prisma, pool } = require('./prisma');

const DEFAULT_FILE = path.join(
  __dirname,
  '..',
  'prisma',
  'seed',
  'league.json'
);

const toInt = (value, fallback = 0) => {
  const n = Number(value);

  return Number.isFinite(n) && n >= 0
    ? Math.trunc(n)
    : fallback;
};

function normalizePlayer(raw, teamId, index) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(
      `player #${index + 1} of "${teamId}" is not an object`
    );
  }

  const number = Number(raw.number);

  if (!Number.isInteger(number) || number < 0) {
    throw new Error(
      `player #${index + 1} of "${teamId}" has an invalid "number"`
    );
  }

  const name =
    typeof raw.name === 'string'
      ? raw.name.trim()
      : '';

  if (!name) {
    throw new Error(
      `player #${number} of "${teamId}" is missing "name"`
    );
  }

  return {
    teamId,
    number,
    name: name.slice(0, 100),
    goals: toInt(raw.goals),
    assists: toInt(raw.assists),
    fouls: toInt(raw.fouls),
    yellowCards: toInt(
      raw.yellow_cards ?? raw.yellowCards
    ),
    redCards: toInt(
      raw.red_cards ?? raw.redCards
    ),
  };
}

function normalizeTeam(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(
      `entry #${index + 1} is not an object`
    );
  }

  const id =
    typeof raw.id === 'string'
      ? raw.id.trim()
      : '';

  const name =
    typeof raw.name === 'string'
      ? raw.name.trim()
      : '';

  if (!id) {
    throw new Error(
      `entry #${index + 1} is missing "id"`
    );
  }

  if (!name) {
    throw new Error(
      `team "${id}" is missing "name"`
    );
  }

  const won = toInt(raw.won);
  const drawn = toInt(raw.drawn);
  const lost = toInt(raw.lost);

  const teamId = id.slice(0, 64);

  const players = [];
  const numbers = new Set();

  (
    Array.isArray(raw.players)
      ? raw.players
      : []
  ).forEach((rawPlayer, i) => {
    try {
      const player = normalizePlayer(
        rawPlayer,
        teamId,
        i
      );

      if (numbers.has(player.number)) {
        throw new Error(
          `duplicate shirt number ${player.number} in "${teamId}"`
        );
      }

      numbers.add(player.number);
      players.push(player);
    } catch (err) {
      console.warn(
        `Standings import: skipping player - ${err.message}`
      );
    }
  });

  return {
    id: teamId,
    name: name.slice(0, 100),

    played:
      raw.played == null
        ? won + drawn + lost
        : toInt(raw.played),

    won,
    drawn,
    lost,

    gf: toInt(raw.gf),
    ga: toInt(raw.ga),

    points:
      raw.points == null
        ? won * 3 + drawn
        : toInt(raw.points),

    players,
  };
}

function readTeams(file) {
  const parsed = JSON.parse(
    fs.readFileSync(file, 'utf8')
  );

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && parsed.teams;

  if (!Array.isArray(list)) {
    throw new Error(
      'expected an array of teams or an object with a "teams" array'
    );
  }

  const teams = list.map(normalizeTeam);

  const seenTeams = new Set();

  for (const team of teams) {
    if (seenTeams.has(team.id)) {
      throw new Error(
        `duplicate team id "${team.id}"`
      );
    }

    seenTeams.add(team.id);
  }

  return teams;
}

/**
 * Normal import.
 *
 * Only creates records that don't already exist.
 * Existing teams and players are untouched.
 */
async function importMissing(teams, players) {
  const teamResult = await prisma.team.createMany({
    data: teams,
    skipDuplicates: true,
  });

  const playerResult = await prisma.player.createMany({
    data: players,
    skipDuplicates: true,
  });

  return {
    createdTeams: teamResult.count,
    createdPlayers: playerResult.count,
    updatedTeams: 0,
    updatedPlayers: 0,
    deletedTeams: 0,
    deletedPlayers: 0,
  };
}

/**
 * Overwrite import.
 *
 * The JSON becomes the authoritative state of the
 * teams and players tables.
 *
 * Existing records are updated.
 * Missing records are created.
 * Records not present in the JSON are deleted.
 *
 * No large transaction is used because Prisma's default
 * interactive transaction timeout is only 5 seconds.
 */
async function importOverwrite(teams, players) {
  const teamIds = teams.map(
    (team) => team.id
  );

  const playerKeys = players.map(
    (player) => ({
      teamId: player.teamId,
      number: player.number,
    })
  );

  let createdTeams = 0;
  let updatedTeams = 0;

  let createdPlayers = 0;
  let updatedPlayers = 0;

  let deletedPlayers = 0;
  let deletedTeams = 0;

  /*
   * Delete players that aren't present in the JSON.
   *
   * This must happen before deleting teams because
   * players reference teams through a foreign key.
   */

  const existingPlayers =
    await prisma.player.findMany({
      select: {
        teamId: true,
        number: true,
      },
    });

  const desiredPlayerKeys = new Set(
    playerKeys.map(
      ({ teamId, number }) =>
        `${teamId}:${number}`
    )
  );

  const playersToDelete =
    existingPlayers.filter(
      ({ teamId, number }) =>
        !desiredPlayerKeys.has(
          `${teamId}:${number}`
        )
    );

  for (const player of playersToDelete) {
    await prisma.player.delete({
      where: {
        teamId_number: {
          teamId: player.teamId,
          number: player.number,
        },
      },
    });

    deletedPlayers++;
  }

  /*
   * Update existing players or create missing ones.
   */
  for (const {
    teamId,
    number,
    ...data
  } of players) {
    const existing =
      await prisma.player.findUnique({
        where: {
          teamId_number: {
            teamId,
            number,
          },
        },
        select: {
          teamId: true,
          number: true,
        },
      });

    if (existing) {
      await prisma.player.update({
        where: {
          teamId_number: {
            teamId,
            number,
          },
        },
        data,
      });

      updatedPlayers++;
    } else {
      await prisma.player.create({
        data: {
          teamId,
          number,
          ...data,
        },
      });

      createdPlayers++;
    }
  }

  /*
   * Find and delete teams that aren't in the JSON.
   *
   * Players belonging to those teams have already
   * been removed above.
   */
  const existingTeams =
    await prisma.team.findMany({
      select: {
        id: true,
      },
    });

  const desiredTeamIds =
    new Set(teamIds);

  const teamsToDelete =
    existingTeams.filter(
      ({ id }) =>
        !desiredTeamIds.has(id)
    );

  for (const team of teamsToDelete) {
    await prisma.team.delete({
      where: {
        id: team.id,
      },
    });

    deletedTeams++;
  }

  /*
   * Update existing teams or create missing ones.
   */
  for (const {
    id,
    ...data
  } of teams) {
    const existing =
      await prisma.team.findUnique({
        where: { id },
        select: { id: true },
      });

    if (existing) {
      await prisma.team.update({
        where: { id },
        data,
      });

      updatedTeams++;
    } else {
      await prisma.team.create({
        data: {
          id,
          ...data,
        },
      });

      createdTeams++;
    }
  }

  return {
    createdTeams,
    createdPlayers,
    updatedTeams,
    updatedPlayers,
    deletedTeams,
    deletedPlayers,
  };
}

async function importStandings({
  file,
  mode,
} = {}) {
  const resolvedMode = (
    mode ||
    process.env.STANDINGS_IMPORT ||
    'missing'
  ).toLowerCase();

  if (resolvedMode === 'off') {
    console.log(
      'Standings import disabled (STANDINGS_IMPORT=off).'
    );

    return;
  }

  if (
    !['missing', 'overwrite'].includes(
      resolvedMode
    )
  ) {
    throw new Error(
      `unknown import mode "${resolvedMode}" ` +
      '(use "missing", "overwrite" or "off")'
    );
  }

  const resolvedFile = path.resolve(
    file ||
    process.env.STANDINGS_FILE ||
    DEFAULT_FILE
  );

  if (!fs.existsSync(resolvedFile)) {
    console.warn(
      `Standings import skipped: ${resolvedFile} not found.`
    );

    return;
  }

  const parsedTeams =
    readTeams(resolvedFile);

  if (parsedTeams.length === 0) {
    console.log(
      'Standings import skipped: file contains no teams.'
    );

    return;
  }

  const teams = parsedTeams.map(
    ({ players, ...team }) => team
  );

  const players =
    parsedTeams.flatMap(
      (team) => team.players
    );

  const fileName =
    path.basename(resolvedFile);

  let result;

  if (resolvedMode === 'overwrite') {
    result =
      await importOverwrite(
        teams,
        players
      );

    console.log(
      `Standings synchronized from ${fileName}:`
    );

    console.log(
      `  Teams: ${result.createdTeams} created, ` +
      `${result.updatedTeams} updated, ` +
      `${result.deletedTeams} deleted.`
    );

    console.log(
      `  Players: ${result.createdPlayers} created, ` +
      `${result.updatedPlayers} updated, ` +
      `${result.deletedPlayers} deleted.`
    );
  } else {
    result =
      await importMissing(
        teams,
        players
      );

    console.log(
      `Standings imported from ${fileName}:`
    );

    console.log(
      `  Teams: ${result.createdTeams} created.`
    );

    console.log(
      `  Players: ${result.createdPlayers} created.`
    );
  }

  await logTotals();

  return result;
}

async function logTotals() {
  const [
    teamCount,
    playerCount,
  ] = await Promise.all([
    prisma.team.count(),
    prisma.player.count(),
  ]);

  console.log(
    `Database now has ${teamCount} teams and ` +
    `${playerCount} players.`
  );
}

module.exports = {
  importStandings,
};

/*
 * CLI:
 *
 *   node db/importStandings.js
 *   node db/importStandings.js path/to/standings.json
 *   node db/importStandings.js path/to/standings.json --overwrite
 */
if (require.main === module) {
  const args =
    process.argv.slice(2);

  const overwrite =
    args.includes('--overwrite');

  const file =
    args.find(
      (arg) =>
        !arg.startsWith('--')
    );

  importStandings({
    file,
    mode: overwrite
      ? 'overwrite'
      : undefined,
  })
    .catch((err) => {
      console.error(
        'Standings import failed:',
        err
      );

      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
      await pool.end();
    });
}
