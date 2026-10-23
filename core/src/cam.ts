// Watcher (ESP32-CAM) support: receive snapshots, store on disk + DB, list/serve them, retention
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdirSync, writeFileSync, copyFileSync, unlinkSync, existsSync, rmSync, readdirSync, statSync, renameSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    const tilt = req.headers['x-tilt'] !== undefined ? Number(req.headers['x-tilt']) : null;
    const r = await query<{ id: number }>('INSERT INTO snapshots(ts, node, path, bytes, reason, angle, tilt) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [now, node, rel, buf.length, reason, Number.isFinite(angle as number) ? angle : null, Number.isFinite(tilt as number) ? tilt : null]);
    const n = getNode(node); if (!n.role) n.role = 'cam'; touch(node);
    const url = `/cam/${rel}`;
    bus.live({ type: 'snapshot', node, ts: now.toISOString(), url, bytes: buf.length, id: r.rows[0].id, angle, tilt } as any);
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

  // หัน servo: {angle} หรือ {preset} · {tilt} ก้มเงย (ส่งคู่กับ angle ได้ — หันก่อน แล้วก้มเงย ถ่ายหลังแกนสุดท้าย)
  // snap=true ให้ถ่ายหลังขยับเสร็จ · patrol = ถ่ายทุก preset
  app.post<{ Params: { node: string }; Body: { angle?: number; tilt?: number; preset?: string; snap?: boolean; patrol?: boolean; nudge?: 'pan' | 'tilt'; by?: number } }>('/api/cam/:node/pan', async (req, reply) => {
    const { node } = req.params; const b = req.body || {};
    const n = nodes.get(node);
    if (!n) return reply.code(404).send({ error: 'node not found' });
    if (b.patrol) { await sendCmd(node, 'patrol', '1'); return { ok: true, patrol: true }; }
    // ขยับทีละน้อยจากมุมปัจจุบัน (ปุ่ม ±1° กดค้างได้) — ส่งแบบสัมพัทธ์ "+1"/"-1" ให้ node คำนวณเอง ไม่ต้องรู้มุมล่าสุด
    if (b.nudge === 'pan' || b.nudge === 'tilt') {
      const by = Math.round(Number(b.by)); if (!Number.isFinite(by) || by === 0 || Math.abs(by) > 30) return reply.code(400).send({ error: 'by ต้องเป็น ±1…±30' });
      await sendCmd(node, b.nudge, (by > 0 ? '+' : '-') + Math.abs(by));
      return { ok: true, nudge: b.nudge, by };
    }
    const deg = (v: unknown) => (Number.isFinite(v as number) ? String(Math.max(0, Math.min(180, Math.round(v as number)))) : null);
    const pan = b.preset ? String(b.preset) : deg(b.angle);
    const tilt = deg(b.tilt);
    if (pan === null && tilt === null) return reply.code(400).send({ error: 'ต้องมี angle (0-180), tilt (0-180) หรือ preset' });
    if (pan !== null) await sendCmd(node, 'pan', pan + (b.snap && tilt === null ? ' +snap' : ''));
    if (tilt !== null) await sendCmd(node, 'tilt', tilt + (b.snap ? ' +snap' : ''));
    return { ok: true, target: pan ?? undefined, tilt: tilt ?? undefined };
  });

  // ตั้งค่า servo ของ Watcher ทันที (ไม่รีบูต): ความเร็ว องศา/วิ + ขอบเขตมุมหัน/ก้มเงย → cmd/servo
  app.post<{ Params: { node: string }; Body: { hold_ms?: number; speed?: number; pan_min?: number; pan_max?: number; tilt_min?: number; tilt_max?: number; pan_invert?: boolean; tilt_invert?: boolean; home?: boolean; pan_mode?: string; stop_us?: number; cont_us?: number; cont_ms?: number; cont_limit?: number } }>('/api/cam/:node/servo', async (req, reply) => {
    const { node } = req.params; const b = req.body || {};
    const n = nodes.get(node);
    if (!n) return reply.code(404).send({ error: 'node not found' });
    if (!n.meta?.cam?.servo && !n.meta?.cam?.tilt) return reply.code(400).send({ error: 'กล้องนี้ยังไม่ได้ตั้ง servo pin' });
    const out: Record<string, number | boolean | string> = {};
    if (b.pan_mode !== undefined) { if (b.pan_mode !== 'position' && b.pan_mode !== 'continuous') return reply.code(400).send({ error: 'pan_mode ต้องเป็น position หรือ continuous' }); out.pan_mode = b.pan_mode; }
    for (const k of ['pan_invert', 'tilt_invert', 'home'] as const) if (typeof b[k] === 'boolean') out[k] = b[k] as boolean;
    const lim = { speed: [1, 30], pan_min: [0, 180], pan_max: [0, 180], tilt_min: [0, 180], tilt_max: [0, 180], stop_us: [1300, 1700], cont_us: [5, 150], cont_ms: [20, 300], cont_limit: [0, 500], hold_ms: [500, 30000] } as const;
    for (const [k, [lo, hi]] of Object.entries(lim)) {
      const v = (b as any)[k]; if (v === undefined || v === null || v === '') continue;
      const x = Math.round(Number(v)); if (!Number.isFinite(x) || x < lo || x > hi) return reply.code(400).send({ error: `${k} ต้องอยู่ระหว่าง ${lo}–${hi}` });
      out[k] = x;
    }
    if (out.pan_min !== undefined && out.pan_max !== undefined && (out.pan_min as number) > (out.pan_max as number)) return reply.code(400).send({ error: 'หัน: ต่ำสุดต้องไม่เกินสูงสุด' });
    if (out.tilt_min !== undefined && out.tilt_max !== undefined && (out.tilt_min as number) > (out.tilt_max as number)) return reply.code(400).send({ error: 'ก้มเงย: ต่ำสุดต้องไม่เกินสูงสุด' });
    if (!Object.keys(out).length) return reply.code(400).send({ error: 'ไม่มีค่าที่จะตั้ง' });
    await sendCmd(node, 'servo', JSON.stringify(out));
    return { ok: true, sent: out };
  });

  // list cam nodes with latest snapshot + stream url
  app.get('/api/cam', async () => {
    const latest = await query<{ node: string; ts: Date; path: string; bytes: number; caption: string | null; mood: string | null; cnt: string }>(
      `SELECT DISTINCT ON (node) node, ts, path, bytes, caption, mood, (SELECT count(*) FROM snapshots s2 WHERE s2.node = s.node) AS cnt FROM snapshots s ORDER BY node, ts DESC`);
    // ข้อความล่าสุดที่โหมดคิดสรุปไว้ (ไม่จำเป็นต้องเป็นภาพล่าสุด เพราะเว้นระยะการคิด)
    const glances = await query<{ node: string; ts: Date; caption: string; mood: string }>(
      `SELECT DISTINCT ON (node) node, ts, caption, mood FROM snapshots WHERE caption IS NOT NULL ORDER BY node, ts DESC`);
    const lastGlance = new Map(glances.rows.map((g) => [g.node, { ts: g.ts.toISOString(), caption: g.caption, mood: g.mood }]));
    const angles = await query<{ node: string; angle: number; cnt: string }>(
      `SELECT node, angle, count(*) AS cnt FROM snapshots WHERE angle IS NOT NULL GROUP BY node, angle ORDER BY node, angle`);
    const byNode = new Map<string, { angle: number; count: number }[]>();
    for (const a of angles.rows) { if (!byNode.has(a.node)) byNode.set(a.node, []); byNode.get(a.node)!.push({ angle: a.angle, count: Number(a.cnt) }); }
    const out: any[] = [];
    const seen = new Set<string>();
    for (const r of latest.rows) { seen.add(r.node); const n = nodes.get(r.node); out.push({ node: r.node, online: n?.online ?? false, ip: n?.ip ?? null, cam: n?.meta?.cam ?? null, latest: { ts: r.ts.toISOString(), url: `/cam/${r.path}`, bytes: r.bytes, caption: r.caption, mood: r.mood }, count: Number(r.cnt), angles: byNode.get(r.node) || [], last_glance: lastGlance.get(r.node) || null }); }
    for (const n of nodes.values()) if (n.role === 'cam' && !seen.has(n.node)) out.push({ node: n.node, online: n.online, ip: n.ip, cam: n.meta?.cam ?? null, latest: null, count: 0, angles: [], last_glance: null });
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
    type Row = { id: number; ts: Date; path: string; bytes: number; angle: number | null; tilt: number | null; caption: string | null; mood: string | null };
    if (req.query.day) r = await query<Row>(
      `SELECT id, ts, path, bytes, angle, tilt, caption, mood FROM snapshots WHERE node = $1 AND to_char(ts AT TIME ZONE $3, 'YYYY-MM-DD') = $2 ORDER BY ts ASC LIMIT $4`, [node, req.query.day, config.tz, limit]);
    else r = await query<Row>(
      `SELECT id, ts, path, bytes, angle, tilt, caption, mood FROM snapshots WHERE node = $1 ${req.query.since ? 'AND ts > $3' : ''} ORDER BY ts DESC LIMIT $2`, req.query.since ? [node, limit, req.query.since] : [node, limit]);
    return r.rows.map((x) => ({ id: x.id, ts: x.ts.toISOString(), url: `/cam/${x.path}`, bytes: x.bytes, angle: x.angle, tilt: x.tilt, caption: x.caption, mood: x.mood }));
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

  // time-lapse → mp4 ด้วย ffmpeg: ?day=YYYY-MM-DD · ?from=YYYY-MM-DD&to=YYYY-MM-DD · ?all=1
  //   &hourly=1 เอา 1 ภาพ/ชม. · &angle=N เฉพาะมุม · &fps=10 (1–30)
  // ไฟล์เก็บที่ <camDir>/<node>/_export/ (static plugin เสิร์ฟพร้อม Range → เล่นใน Safari ได้) ชื่อมี hash ของชุดภาพ = cache เอง
  app.get<{ Params: { node: string }; Querystring: { day?: string; from?: string; to?: string; all?: string; hourly?: string; angle?: string; fps?: string } }>('/api/cam/:node/timelapse', async (req, reply) => {
    const { node } = req.params; const q = req.query;
    if (!NODE_RE.test(node)) return reply.code(400).send({ error: 'bad node' });
    const fps = Math.max(1, Math.min(30, Number(q.fps) || 10));
    const DAY = /^\d{4}-\d{2}-\d{2}$/;
    const where: string[] = ['node = $1']; const args: unknown[] = [node];
    let label: string;
    if (q.day) { if (!DAY.test(q.day)) return reply.code(400).send({ error: 'day ต้องเป็น YYYY-MM-DD' }); args.push(q.day); where.push(`to_char(ts AT TIME ZONE '${config.tz}', 'YYYY-MM-DD') = $${args.length}`); label = q.day; }
    else if (q.from || q.to) {
      if ((q.from && !DAY.test(q.from)) || (q.to && !DAY.test(q.to))) return reply.code(400).send({ error: 'from/to ต้องเป็น YYYY-MM-DD' });
      if (q.from) { args.push(q.from); where.push(`to_char(ts AT TIME ZONE '${config.tz}', 'YYYY-MM-DD') >= $${args.length}`); }
      if (q.to) { args.push(q.to); where.push(`to_char(ts AT TIME ZONE '${config.tz}', 'YYYY-MM-DD') <= $${args.length}`); }
      label = `${q.from || 'start'}_${q.to || 'now'}`;
    } else if (q.all) label = 'all';
    else return reply.code(400).send({ error: 'ต้องระบุ day, from/to หรือ all=1' });
    if (q.angle !== undefined && q.angle !== '') { args.push(Number(q.angle)); where.push(`angle = $${args.length}`); label += `-a${Number(q.angle)}`; }
    const hourly = q.hourly === '1' || q.hourly === 'true'; if (hourly) label += '-hourly';
    const sql = hourly
      ? `SELECT DISTINCT ON (date_trunc('hour', ts)) id, path FROM snapshots WHERE ${where.join(' AND ')} ORDER BY date_trunc('hour', ts), ts`
      : `SELECT id, path FROM snapshots WHERE ${where.join(' AND ')} ORDER BY ts`;
    const r = await query<{ id: number; path: string }>(sql, args);
    let frames = r.rows.filter((x) => existsSync(join(config.camDir, x.path)));
    if (frames.length > MAX_FRAMES) { const step = frames.length / MAX_FRAMES; frames = Array.from({ length: MAX_FRAMES }, (_, i) => frames[Math.floor(i * step)]); }
    if (frames.length < 2) return reply.code(404).send({ error: `มีภาพแค่ ${frames.length} ภาพ ทำ time-lapse ไม่ได้` });
    const hash = createHash('sha1').update(frames.map((f) => f.id).join(',') + `@${fps}#2`).digest('hex').slice(0, 8);
    const dir = join(config.camDir, node, '_export'); mkdirSync(dir, { recursive: true });
    const name = `${label}-${fps}fps-${hash}.mp4`; const out = join(dir, name);
    const url = `/cam/${node}/_export/${name}`;
    if (!existsSync(out)) {
      try { await encodeTimelapse(frames.map((f) => join(config.camDir, f.path)), fps, out); }
      catch (e) { log.error(`${node} timelapse ${label}: ${(e as Error).message}`); return reply.code(500).send({ error: 'ffmpeg ล้มเหลว: ' + (e as Error).message }); }
      // ไฟล์เก่าของช่วงเดียวกัน (ชุดภาพเปลี่ยน → hash เปลี่ยน) ทิ้งได้
      for (const f of readdirSync(dir)) if (f.startsWith(`${label}-${fps}fps-`) && f !== name) try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
      log.info(`${node} timelapse ${label}: ${frames.length} frames @${fps}fps -> ${name} (${Math.round(statSync(out).size / 1024)} kB)`);
    }
    return { ok: true, url, frames: frames.length, fps, seconds: Math.round((frames.length / fps) * 10) / 10, bytes: statSync(out).size };
  });

  // ตรวจสอบ DB กับไฟล์จริง (เผื่อลบไฟล์ตรงในโฟลเดอร์): ลบแถวที่ไฟล์หาย
  app.post<{ Params: { node: string } }>('/api/cam/:node/reconcile', async (req) => ({ ok: true, removed: await reconcile(req.params.node) }));
  setTimeout(() => void reconcile().catch(() => {}), 15_000).unref();
}

const MAX_FRAMES = 3000;                 // เกินนี้สุ่มเว้นระยะให้พอดี (3000 @10fps = 5 นาที)
const EXPORT_KEEP_MS = 7 * 86_400_000;   // mp4 ที่ไม่มีใครขอซ้ำเกิน 7 วันลบทิ้ง (สร้างใหม่ได้เสมอ)
const encoding = new Map<string, Promise<void>>();

function probeSize(file: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { timeout: 10_000 }, (err, stdout) => {
      if (err) return reject(new Error('ffprobe: ' + err.message));
      const [w, h] = String(stdout).trim().split(/[,\s]/).map(Number);
      if (!w || !h) return reject(new Error('ffprobe: อ่านขนาดภาพไม่ได้'));
      resolve({ w, h });
    });
  });
}

/** ป้อน JPEG ทีละไฟล์เข้า stdin ของ ffmpeg (image2pipe) → H.264 mp4 · ภาพต่างขนาดถูก scale+pad ให้เท่าภาพแรก */
function encodeTimelapse(files: string[], fps: number, out: string): Promise<void> {
  const inflight = encoding.get(out); if (inflight) return inflight;   // ขอซ้ำระหว่างกำลังเข้ารหัส → รอตัวเดิม
  const p = (async () => {
    const { w, h } = await probeSize(files[0]);
    const W = Math.floor(w / 2) * 2, H = Math.floor(h / 2) * 2;      // yuv420p ต้องเป็นเลขคู่
    const tmp = out + '.tmp';
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
        '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:-1:-1,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart', '-f', 'mp4', tmp], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = ''; ff.stderr.on('data', (d) => { err += d; });
      ff.on('error', reject);
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(-300)}`))));
      (async () => {
        try {
          for (const f of files) {
            if (ff.stdin.destroyed) break;
            // OV2640 บางครั้งให้ JPEG สองเฟรมต่อกันในไฟล์เดียว → ตัดที่ EOI (FF D9) แรก ไม่งั้น ffmpeg นับเป็น 2 เฟรม
            let buf = readFileSync(f); const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), 2); if (eoi > 0 && eoi + 2 < buf.length) buf = buf.subarray(0, eoi + 2);
            if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
          }
          ff.stdin.end();
        }
        catch (e) { ff.kill('SIGKILL'); reject(e as Error); }
      })();
    });
    renameSync(tmp, out);
  })().finally(() => encoding.delete(out));
  encoding.set(out, p);
  return p;
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
  // mp4 ที่ export ไว้: ไม่ได้เปิด (atime) / ไม่ได้สร้าง (mtime) เกิน 7 วัน → ลบ
  if (existsSync(config.camDir)) for (const node of readdirSync(config.camDir)) {
    const dir = join(config.camDir, node, '_export'); if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) { try { const st = statSync(join(dir, f)); if (Date.now() - Math.max(st.atimeMs, st.mtimeMs) > EXPORT_KEEP_MS) unlinkSync(join(dir, f)); } catch { /* ignore */ } }
  }
  return { thinned: thin.rowCount ?? 0, expired: old.rowCount ?? 0 };
}
