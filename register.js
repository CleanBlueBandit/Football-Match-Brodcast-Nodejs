require('dotenv').config();

const { prisma, pool } = require('./db/prisma');
const bcrypt = require('bcryptjs');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

async function main() {
  const rl = readline.createInterface({ input, output });

  try {
    console.log('\n--- Admin User Registration ---');

    const username = await rl.question('Enter username: ');
    if (!username.trim()) {
      console.error('Error: Username cannot be empty.');
      process.exit(1);
    }

    const password = await rl.question('Enter password: ');
    if (!password.trim()) {
      console.error('Error: Password cannot be empty.');
      process.exit(1);
    }

    console.log('\nHashing password and writing to database...');
    const hashedPassword = await bcrypt.hash(password.trim(), 10);

    const user = await prisma.user.upsert({
      where: { username: username.trim() },
      update: {
        passwordHash: hashedPassword,
      },
      create: {
        username: username.trim(),
        passwordHash: hashedPassword,
      },
    });

    console.log(`Successfully created/updated admin user: ${user.username}\n`);
  } catch (err) {
    console.error('Registration error:', err);
    process.exit(1);
  } finally {
    rl.close();
    await prisma.$disconnect();
    await pool.end();
  }
}

main();