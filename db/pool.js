const { Pool } = require('pg');

// Shared pg pool. Prisma (via the pg driver adapter) and the
// connect-pg-simple session store both use it, so the app opens one set of
// connections instead of two.
// Set DB_SSL=false for a local Postgres without SSL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.db_POSTGRES_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error:', err);
});

module.exports = pool;
