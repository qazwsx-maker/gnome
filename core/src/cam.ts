// Watcher (ESP32-CAM) support: receive snapshots, store on disk + DB, list/serve them, retention
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdirSync, writeFileSync, copyFileSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from './config.ts';
import { logger } from './log.ts';
import { query } from './db.ts';
import { bus } from './bus.ts';
import { nodes, touch, getNode } from './state.ts';

const log = logger('cam');
const NODE_RE = /^[a-z0-9-]+$/;

function stamp(d: Date): { day: string; file: string } {
  const p = (n: number) => String(n).padStart(2, '0');
  // ใช้เวลาท้องถิ่น (TZ ของ process = Asia/Bangkok) ตั้งชื่อโฟลเดอร์/ไฟล์
  return { day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, file: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg` };
}

export async function registerCam(app: FastifyInstance): Promise<void> {
  mkdirSync(config.camDir, { recursive: true });
  await app.register(fastifyStatic, { root: config.camDir, prefix: '/cam/', decorateReply: false, cacheControl: true, maxAge: 3600_000, immutable: false });
  app.addContentTypeParser(['image/jpeg', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 4 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  // node → POST JPEG
  app.post<{ Params: { node: string } }>('/api/cam/:node/snapshot', async (req, reply) => {
    const node = req.params.node;
    if (!NODE_RE.test(node)) return reply.code(400).send({ error: 'bad node' });
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8) return reply.code(400).send({ error: 'not a jpeg' });
    const now = new Date(); const { day, file } = stamp(now);
    const rel = join(node, day, file); const abs = join(config.camDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf); copyFileSync(abs, join(config.camDir, node, 'latest.jpg'));
    const reason = String(req.headers['x-reason'] || '');
    const r = await query<{ id: number }>('INSERT INTO snapshots(ts, node, path, bytes, reason) VALUES ($1,$2,$3,$4,$5) RETURNING id', [now, node, rel, buf.length, reason]);
    const n = getNode(node); if (!n.role) n.role = 'cam'; touch(node);
    const url = `/cam/${rel}`;
    bus.live({ type: 'snapshot', node, ts: now.toISOString(), url, bytes: buf.length, id: r.rows[0].id } as any);
    log.info(`${node} snapshot ${buf.length} B -> ${rel}${reason ? ' (' + reason + ')' : ''}`);
    return { ok: true, id: r.rows[0].id, url, bytes: buf.length };
  });

  // list cam nodes with latest snapshot + stream url
  app.get('/api/cam', async () => {
    const latest = await query<{ node: string; ts: Date; path: string; bytes: number; cnt: string }>(
      `SELECT DISTINCT ON (node) node, ts, path, bytes, (SELECT count(*) FROM snapshots s2 WHERE s2.node = s.node) AS cnt FROM snapshots s ORDER BY node, ts DESC`);
    const out: any[] = [];
    const seen = new Set<string>();
    for (const r of latest.rows) { seen.add(r.node); const n = nodes.get(r.node); out.push({ node: r.node, online: n?.online ?? false, ip: n?.ip ?? null, cam: n?.meta?.cam ?? null, latest: { ts: r.ts.toISOString(), url: `/cam/${r.path}`, bytes: r.bytes }, count: Number(r.cnt) }); }
    for (const n of nodes.values()) if (n.role === 'cam' && !seen.has(n.node)) out.push({ node: n.node, online: n.online, ip: n.ip, cam: n.meta?.cam ?? null, latest: null, count: 0 });
    return out.sort((a, b) => a.node.localeCompare(b.node));
  });

  app.get<{ Params: { node: string } }>('/api/cam/:node/days', async (req) => {
    const r = await query<{ day: string; cnt: string }>(
      `SELECT to_char(ts AT TIME ZONE $2, 'YYYY-MM-DD') AS day, count(*) AS cnt FROM snapshots WHERE node = $1 GROUP BY 1 ORDER BY 1 DESC LIMIT 400`, [req.params.node, config.tz]);
    return r.rows.map((x) => ({ day: x.day, count: Number(x.cnt) }));
  });

  app.get<{ Params: { node: string }; Querystring: { day?: string; limit?: string; since?: string } }>('/api/cam/:node/snapshots', async (req) => {
    const { node } = req.params; const limit = Math.min(2000, Number(req.query.limit) || 500);
    let r;
    if (req.query.day) r = await query<{ id: number; ts: Date; path: string; bytes: number }>(
      `SELECT id, ts, path, bytes FROM snapshots WHERE node = $1 AND to_char(ts AT TIME ZONE $3, 'YYYY-MM-DD') = $2 ORDER BY ts ASC LIMIT $4`, [node, req.query.day, config.tz, limit]);
    else r = await query<{ id: number; ts: Date; path: string; bytes: number }>(
      `SELECT id, ts, path, bytes FROM snapshots WHERE node = $1 ${req.query.since ? 'AND ts > $3' : ''} ORDER BY ts DESC LIMIT $2`, req.query.since ? [node, limit, req.query.since] : [node, limit]);
    return r.rows.map((x) => ({ id: x.id, ts: x.ts.toISOString(), url: `/cam/${x.path}`, bytes: x.bytes }));
  });

  app.delete<{ Params: { node: string } }>('/api/cam/:node/snapshots', async (req) => {
    const r = await query('DELETE FROM snapshots WHERE node = $1', [req.params.node]);
    rmSync(join(config.camDir, req.params.node), { recursive: true, force: true });
    return { ok: true, deleted: r.rowCount };
  });
}

/** retention: > camFullDays เก็บภาพแรกของแต่ละชั่วโมง · > camKeepDays ลบหมด */
export async function camRetention(): Promise<{ thinned: number; expired: number }> {
  const old = await query<{ id: number; path: string }>(
    `DELETE FROM snapshots WHERE ts < now() - ($1 || ' days')::interval RETURNING id, path`, [config.camKeepDays]);
  const thin = await query<{ id: number; path: string }>(
    `DELETE FROM snapshots WHERE id IN (
       SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY node, date_trunc('hour', ts) ORDER BY ts) AS rn
                       FROM snapshots WHERE ts < now() - ($1 || ' days')::interval) x WHERE rn > 1) RETURNING id, path`, [config.camFullDays]);
  for (const r of [...old.rows, ...thin.rows]) { const p = join(config.camDir, r.path); if (existsSync(p)) try { unlinkSync(p); } catch { /* ignore */ } }
  return { thinned: thin.rowCount ?? 0, expired: old.rowCount ?? 0 };
}
