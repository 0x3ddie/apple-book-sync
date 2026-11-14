import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { configuration } from './config.mjs';
import { createAuth } from './auth.mjs';

const config = configuration();
if (!config.ready) {
  console.error(`Configure these environment variables before migrating: ${config.missing.join(', ')}`);
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: config.databaseURL, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const auth = createAuth(config, pool);
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    console.log('Authentication and private Books tables are ready.');
  } finally { await pool.end(); }
}
