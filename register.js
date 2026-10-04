require('dotenv').config();

const { prisma, pool } = require('./db/prisma');
const bcrypt = require('bcryptjs');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { ROLES } = require('./lib/roles');

const ROLE_INFO = {
  admin: 'everything (/control and /stats)',
  broadcaster: 'live broadcast control panel (/control)',
  statistician: 'stats page + Excel export (/stats)',
  viewer: 'broadcast output only (/tv.html)',
};

const rl = readline.createInterface({ input, output });

// Accepts the role name ("broadcaster") or its menu number ("2").
// Empty answer = viewer (the least-privileged role).
function parseRole(answer) {
  const a = answer.trim().toLowerCase();
  if (!a) return 'viewer';
  if (/^\d+$/.test(a)) return ROLES[Number(a) - 1] || null;
  return ROLES.includes(a) ? a : null;
}

async function askRole() {
  console.log('\nRoles:');
  ROLES.forEach((r, i) => console.log(`  ${i + 1}. ${r.padEnd(13)} ${ROLE_INFO[r] || ''}`));

  while (true) {
    const role = parseRole(await rl.question('Role (name or number) [viewer]: '));
    if (role) return role;
    console.error(`Invalid role. Choose one of: ${ROLES.join(', ')} (or 1-${ROLES.length}).`);
  }
}

async function askPassword() {
  while (true) {
    const password = (await rl.question('Enter password: ')).trim();

    if (!password) {
      console.error('Password cannot be empty.');
      continue;
    }

    const confirm = (await rl.question('Confirm password: ')).trim();

    if (password !== confirm) {
      console.error('Passwords do not match, try again.');
      continue;
    }

    return password;
  }
}

async function registerOne() {
  const username = (await rl.question('\nEnter username: ')).trim();

  if (!username) {
    console.error('Username cannot be empty.');
    return;
  }

  const existing = await prisma.user.findUnique({ where: { username } });

  if (existing) {
    const ok = (await rl.question(
      `User "${username}" already exists (${existing.role}). Reset password and role? [y/N]: `
    ))
      .trim()
      .toLowerCase();

    if (ok !== 'y' && ok !== 'yes') {
      console.log('Skipped.');
      return;
    }
  }

  const password = await askPassword();
  const role = await askRole();

  console.log('\nHashing password and writing to database...');
  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { username },
    update: { passwordHash, role },
    create: { username, passwordHash, role },
  });

  console.log(
    `Successfully ${existing ? 'updated' : 'created'} user: ${user.username} (${user.role})`
  );
}

async function main() {
  console.log('\n--- User Registration ---');
  console.log('You can register as many users as you like (any role). Ctrl+C to quit.');

  try {
    while (true) {
      await registerOne();

      const again = (await rl.question('\nRegister another user? [Y/n]: '))
        .trim()
        .toLowerCase();

      if (again === 'n' || again === 'no') break;
    }
  } catch (err) {
    // Ctrl+C / closed input should exit quietly; anything else is a real error.
    if (err && (err.code === 'ABORT_ERR' || err.code === 'ERR_USE_AFTER_CLOSE')) {
      console.log('\nCancelled.');
    } else {
      console.error('Registration error:', err);
      process.exitCode = 1;
    }
  } finally {
    rl.close();
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
