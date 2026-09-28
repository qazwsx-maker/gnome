import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.ts';
import { logger } from './log.ts';

const log = logger('db');

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });

pool.on('error', (e) => log.error('pool error', e.message));

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as any[]);
}

/** Wait for Postgres (LaunchAgent may start before the brew service on login). */
export async function waitForDb(attempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('select 1');
      return;
    } catch (e) {
      log.warn(`postgres not ready (${i}/${attempts}): ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('postgres unreachable');
}

/** Apply core/sql/*.sql in name order, once each (tracked in schema_migrations). */
export async function migrate(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const files = (await readdir(config.sqlDir)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(config.sqlDir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      log.info(`applied ${f}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
}
