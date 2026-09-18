const { Pool } = require('pg');
const { config } = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.dbSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DB_POOL_SIZE || 20),
  idleTimeoutMillis: 30000
});

pool.on('error', err => console.error('[postgres] idle client error', err));

async function query(text, params) {
  return pool.query(text, params);
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, transaction };
