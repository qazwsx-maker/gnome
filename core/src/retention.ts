// Retention (docs/PLAN.md 2.5): raw -> 5-min rollup after 1 h, raw 14 d, 5m 365 d, events 90 d.
import { config } from './config.ts';
import { logger } from './log.ts';
import { camRetention } from './cam.ts';
import { query } from './db.ts';

const log = logger('retention');

export async function rollup(): Promise<number> {
  // Only complete 5-min buckets older than 1 h; re-processing the latest bucket is harmless (upsert).
  const r = await query(
    `WITH bounds AS (
       SELECT coalesce((SELECT max(ts) FROM readings_5m), '-infinity'::timestamptz) - interval '5 minutes' AS lo,
              date_bin('5 minutes', now() - interval '1 hour', '2000-01-01'::timestamptz) AS hi)
     INSERT INTO readings_5m (ts, node, key, avg, min, max, n)
     SELECT date_bin('5 minutes', r.ts, '2000-01-01'::timestamptz) AS b, r.node, r.key,
            avg(r.value), min(r.value), max(r.value), count(*)
       FROM readings r, bounds
      WHERE r.ts >= bounds.lo AND r.ts < bounds.hi
      GROUP BY 1, 2, 3
     ON CONFLICT (node, key, ts) DO UPDATE
        SET avg = EXCLUDED.avg, min = EXCLUDED.min, max = EXCLUDED.max, n = EXCLUDED.n`,
  );
  return r.rowCount ?? 0;
}

export async function retentionJob(): Promise<void> {
  try {
    const n = await rollup();
    const a = await query(`DELETE FROM readings WHERE ts < now() - ($1 || ' days')::interval`, [config.retentionRawDays]);
    const b = await query(`DELETE FROM readings_5m WHERE ts < now() - ($1 || ' days')::interval`, [config.retention5mDays]);
    const c = await query(`DELETE FROM events WHERE ts < now() - ($1 || ' days')::interval`, [config.retentionEventsDays]);
    const d = await query(`DELETE FROM switch_log WHERE ts < now() - interval '365 days'`);
    const cam = await camRetention();
    log.info(`rollup ${n} buckets; deleted raw=${a.rowCount} 5m=${b.rowCount} events=${c.rowCount} switch_log=${d.rowCount}; cam thinned=${cam.thinned} expired=${cam.expired}`);
  } catch (e) {
    log.error('job failed', (e as Error).message);
  }
}

export function startRetention(): void {
  setTimeout(() => void retentionJob(), 60_000).unref(); // first pass 1 min after boot
  setInterval(() => void retentionJob(), 3_600_000).unref();
}
