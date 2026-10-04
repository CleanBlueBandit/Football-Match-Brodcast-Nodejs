const { Pool } = require('pg');


const pool = new Pool({
  connectionString: process.env.db_POSTGRES_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error:', err);
});

module.exports = pool;
