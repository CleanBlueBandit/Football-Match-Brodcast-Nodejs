require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

// Initialize pg pool using DATABASE_URL from .env
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Configure Prisma v7 driver adapter
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

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