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
import { sendCmd } from './mqtt.ts';
import { Readable } from 'node:stream';
import { glanceOnSnapshot } from './glance.ts';

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
    const angle = req.headers['x-angle'] !== undefined ? Number(req.headers['x-angle']) : null;
    const r = await query<{ id: number }>('INSERT INTO snapshots(ts, node, path, bytes, reason, angle) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [now, node, rel, buf.length, reason, Number.isFinite(angle as number) ? angle : null]);
    const n = getNode(node); if (!n.role) n.role = 'cam'; touch(node);
    const url = `/cam/${rel}`;
    bus.live({ type: 'snapshot', node, ts: now.toISOString(), url, bytes: buf.length, id: r.rows[0].id, angle } as any);
    glanceOnSnapshot(node, r.rows[0].id, rel);     // โหมดคิด — ทำเบื้องหลัง ไม่ให้ node รอ
    log.info(`${node} snapshot ${buf.length} B -> ${rel}${reason ? ' (' + reason + ')' : ''}`);
    return { ok: true, id: r.rows[0].id, url, bytes: buf.length };
  });

  // proxy live MJPEG stream / fresh snapshot from the node (:81) so it works from outside the LAN too
  const camBase = (node: string): string | null => { const n = nodes.get(node); const s = n?.meta?.cam?.stream as string | undefined; if (s) return s.replace(/\/stream$/, ''); return n?.ip ? `http://${n.ip}:81` : null; };
  for (const kind of ['stream', 'snapshot'] as const) {
    app.get<{ Params: { node: string } }>(`/api/cam/:node/${kind === 'stream' ? 'live' : 'live-snapshot'}`, async (req, reply) => {
      const base = camBase(req.params.node);
      if (!base) return reply.code(404).send({ error: 'ไม่รู้ที่อยู่กล้อง (node ยังไม่ส่ง meta)' });
      const ac = new AbortController();
      req.raw.on('close', () => ac.abort());
      let up: Response;
      try { up = await fetch(`${base}/${kind}`, { signal: ac.signal }); } catch (e) { return reply.code(502).send({ error: 'ต่อกล้องไม่ได้: ' + (e as Error).message }); }
      if (!up.ok || !up.body) return reply.code(502).send({ error: `กล้องตอบ ${up.status}` });
      reply.header('Content-Type', up.headers.get('content-type') || (kind === 'stream' ? 'multipart/x-mixed-replace;boundary=gnomeframe' : 'image/jpeg'));
      reply.header('Cache-Control', 'no-store'); reply.header('X-Accel-Buffering', 'no');
      return reply.send(Readable.fromWeb(up.body as any));
    });
  }

  // หัน servo: {angle} หรือ {preset} · snap=true ให้ถ่ายหลังหันเสร็จ · patrol = ถ่ายทุก preset
  app.post<{ Params: { node: string }; Body: { angle?: number; preset?: string; snap?: boolean; patrol?: boolean } }>('/api/cam/:node/pan', async (req, reply) => {
    const { node } = req.params; const b = req.body || {};
    const n = nodes.get(node);
    if (!n) return reply.code(404).send({ error: 'node not found' });
    if (b.patrol) { await sendCmd(node, 'patrol', '1'); return { ok: true, patrol: true }; }
    const target = b.preset ? String(b.preset) : Number.isFinite(b.angle as number) ? String(Math.max(0, Math.min(180, Math.round(b.angle as number)))) : null;
    if (target === null) return reply.code(400).send({ error: 'ต้องมี angle (0-180) หรือ preset' });
    await sendCmd(node, 'pan', target + (b.snap ? ' +snap' : ''));
    return { ok: true, target };
  });

  // list cam nodes with latest snapshot + stream url
  app.get('/api/cam', async () => {
    const latest = await query<{ node: string; ts: Date; path: string; bytes: number; cnt: string }>(
      `SELECT DISTINCT ON (node) node, ts, path, bytes, caption, mood, (SELECT count(*) FROM snapshots s2 WHERE s2.node = s.node) AS cnt FROM snapshots s ORDER BY node, ts DESC`);
    const angles = await query<{ node: string; angle: number; cnt: string }>(
      `SELECT node, angle, count(*) AS cnt FROM snapshots WHERE angle IS NOT NULL GROUP BY node, angle ORDER BY node, angle`);
    const byNode = new Map<string, { angle: number; count: number }[]>();
    for (const a of angles.rows) { if (!byNode.has(a.node)) byNode.set(a.node, []); byNode.get(a.node)!.push({ angle: a.angle, count: Number(a.cnt) }); }
    const out: any[] = [];
    const seen = new Set<string>();
    for (const r of latest.rows) { seen.add(r.node); const n = nodes.get(r.node); out.push({ node: r.node, online: n?.online ?? false, ip: n?.ip ?? null, cam: n?.meta?.cam ?? null, latest: { ts: r.ts.toISOString(), url: `/cam/${r.path}`, bytes: r.bytes }, count: Number(r.cnt), angles: byNode.get(r.node) || [] }); }
    for (const n of nodes.values()) if (n.role === 'cam' && !seen.has(n.node)) out.push({ node: n.node, online: n.online, ip: n.ip, cam: n.meta?.cam ?? null, latest: null, count: 0, angles: [] });
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
    if (req.query.day) r = await query<{ id: number; ts: Date; path: string; bytes: number; angle: number | null }>(
      `SELECT id, ts, path, bytes, angle, caption, mood FROM snapshots WHERE node = $1 AND to_char(ts AT TIME ZONE $3, 'YYYY-MM-DD') = $2 ORDER BY ts ASC LIMIT $4`, [node, req.query.day, config.tz, limit]);
    else r = await query<{ id: number; ts: Date; path: string; bytes: number; angle: number | null }>(
      `SELECT id, ts, path, bytes, angle, caption, mood FROM snapshots WHERE node = $1 ${req.query.since ? 'AND ts > $3' : ''} ORDER BY ts DESC LIMIT $2`, req.query.since ? [node, limit, req.query.since] : [node, limit]);
    return r.rows.map((x) => ({ id: x.id, ts: x.ts.toISOString(), url: `/cam/${x.path}`, bytes: x.bytes, angle: x.angle }));
  });

  // ลบภาพ: ทั้งหมด หรือเฉพาะวัน (?day=YYYY-MM-DD) หรือก่อนเวลา (?before=ISO)
  app.delete<{ Params: { node: string }; Querystring: { day?: string; before?: string } }>('/api/cam/:node/snapshots', async (req) => {
    const { node } = req.params;
    let r;
    if (req.query.day) r = await query<{ path: string }>(`DELETE FROM snapshots WHERE node = $1 AND to_char(ts AT TIME ZONE $3, 'YYYY-MM-DD') = $2 RETURNING path`, [node, req.query.day, config.tz]);
    else if (req.query.before) r = await query<{ path: string }>('DELETE FROM snapshots WHERE node = $1 AND ts < $2 RETURNING path', [node, req.query.before]);
    else r = await query<{ path: string }>('DELETE FROM snapshots WHERE node = $1 RETURNING path', [node]);
    for (const x of r.rows) { const p = join(config.camDir, x.path); if (existsSync(p)) try { unlinkSync(p); } catch { /* ignore */ } }
    if (!req.query.day && !req.query.before) rmSync(join(config.camDir, node), { recursive: true, force: true });
    log.info(`${node}: deleted ${r.rowCount} snapshots${req.query.day ? ' of ' + req.query.day : ''}`);
    return { ok: true, deleted: r.rowCount };
  });

  // ตรวจสอบ DB กับไฟล์จริง (เผื่อลบไฟล์ตรงในโฟลเดอร์): ลบแถวที่ไฟล์หาย
  app.post<{ Params: { node: string } }>('/api/cam/:node/reconcile', async (req) => ({ ok: true, removed: await reconcile(req.params.node) }));
  setTimeout(() => void reconcile().catch(() => {}), 15_000).unref();
}

/** ลบแถว snapshot ที่ไฟล์ไม่มีแล้วบนดิสก์ (ทุก node หรือ node เดียว) */
export async function reconcile(node?: string): Promise<number> {
  const r = await query<{ id: number; path: string }>(`SELECT id, path FROM snapshots ${node ? 'WHERE node = $1' : ''}`, node ? [node] : []);
  const gone = r.rows.filter((x) => !existsSync(join(config.camDir, x.path))).map((x) => x.id);
  if (gone.length) { await query('DELETE FROM snapshots WHERE id = ANY($1)', [gone]); log.info(`reconcile: removed ${gone.length} rows with missing files`); }
  return gone.length;
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
