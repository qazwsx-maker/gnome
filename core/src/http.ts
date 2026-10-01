// Fastify: REST under /api, WebSocket /ws, static dashboard from core/public
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.ts';
import { logger } from './log.ts';
import { pool, query } from './db.ts';
import { bus, type LiveMessage } from './bus.ts';
import { nodes, nodeToJson, forgetNode } from './state.ts';
import { mqttConnected, sendSwitch, sendCmd, clearRetained } from './mqtt.ts';
import { listRules, reloadRules, validateRule, activeRunsJson } from './rules.ts';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { registerCam } from './cam.ts';
import { registerSage } from './sage.ts';
import { registerAuth } from './auth.ts';
import { discordSettings, saveDiscordSettings, glanceSettings, saveGlanceSettings } from './settings.ts';
import { glanceReady, clearGlance } from './glance.ts';
import { discord, webhookUrl } from './discord.ts';
import { startHeartbeat } from './heartbeat.ts';
import { join } from 'node:path';

const log = logger('http');
const started = Date.now();

type Q = Record<string, string | undefined>;

function bad(reply: any, msg: string, code = 400) {
  return reply.code(code).send({ error: msg });
}

const NODE_RE = /^[a-z0-9-]+$/;
const KEY_RE = /^[a-z0-9_]+$/i;

export async function startHttp() {
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } });

  await registerAuth(app);   // ต้องมาก่อน static/routes เพื่อให้ hook คุมทุก path
  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });
  // Cloudflare เขียนทับ Cache-Control เป็น max-age=14400 กับไฟล์ static
  // → มือถือค้างอยู่กับ app.js ตัวเก่าได้หลายชั่วโมง แก้โดยติดเลขเวอร์ชันท้าย URL
  // index.html ไม่ถูกแคชที่ edge (DYNAMIC) เลยเป็นจุดที่ปล่อยเวอร์ชันใหม่ได้เสมอ
  const assetStamp = () => {
    let m = 0;
    for (const f of ['app.js', 'style.css', 'index.html']) {
      try { m = Math.max(m, statSync(join(config.publicDir, f)).mtimeMs); } catch { /* ไม่มีไฟล์ก็ข้าม */ }
    }
    return Math.floor(m).toString(36);
  };
  const sendIndex = (reply: any) => {
    const v = assetStamp();
    const html = readFileSync(join(config.publicDir, 'index.html'), 'utf8')
      .replace('href="style.css"', `href="style.css?v=${v}"`)
      .replace('src="app.js"', `src="app.js?v=${v}"`);
    return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(html);
  };
  app.get('/', async (_req, reply) => sendIndex(reply));
  app.get('/index.html', async (_req, reply) => sendIndex(reply));
  await app.register(fastifyStatic, { root: config.publicDir, prefix: '/', index: false, cacheControl: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); } });
  if (existsSync(config.firmwareDir)) await app.register(fastifyStatic, { root: config.firmwareDir, prefix: '/firmware/', decorateReply: false, cacheControl: false });
  await registerCam(app);
  await registerSage(app);

  app.addHook('onResponse', (req, reply, done) => {
    if (req.url.startsWith('/api/')) log.info(`${req.method} ${req.url} ${reply.statusCode} ${reply.elapsedTime.toFixed(0)}ms`);
    done();
  });

  // ---- websocket ---------------------------------------------------------
  const sockets = new Set<any>();
  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ type: 'hello', ts: new Date().toISOString(), nodes: [...nodes.values()].map(nodeToJson) }));
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  bus.on('live', (m: LiveMessage) => {
    if (sockets.size === 0) return;
    const out = m.type === 'event' ? { ...m, type: 'event', event: m.type_ } : m;
    const s = JSON.stringify(out);
    for (const ws of sockets) {
      try {
        if (ws.readyState === 1) ws.send(s);
      } catch {
        sockets.delete(ws);
      }
    }
  });

  // ---- health --------------------------------------------------------------
  app.get('/api/health', async () => {
    let db = false;
    try {
      await pool.query('select 1');
      db = true;
    } catch {}
    const all = [...nodes.values()];
    return {
      ok: db && mqttConnected(),
      db,
      mqtt: mqttConnected(),
      uptime_s: Math.round((Date.now() - started) / 1000),
      nodes: { total: all.length, online: all.filter((n) => n.online).length },
      ws_clients: sockets.size,
      active_runs: activeRunsJson(),
      ts: new Date().toISOString(),
    };
  });

  // ---- nodes -------------------------------------------------------------
  app.get('/api/nodes', async () => [...nodes.values()].map(nodeToJson).sort((a, b) => a.node.localeCompare(b.node)));

  app.get<{ Params: { node: string } }>('/api/nodes/:node', async (req, reply) => {
    const n = nodes.get(req.params.node);
    if (!n) return bad(reply, 'node not found', 404);
    return nodeToJson(n);
  });

  app.post<{ Params: { node: string }; Body: { cmd?: string; payload?: unknown } }>('/api/nodes/:node/cmd', async (req, reply) => {
    const { node } = req.params;
    const cmd = req.body?.cmd;
    if (!NODE_RE.test(node)) return bad(reply, 'bad node');
    if (!cmd || !['reboot', 'identify', 'config', 'ota', 'snap', 'flash', 'rescan', 'flip'].includes(cmd)) return bad(reply, 'cmd must be reboot|identify|config|ota|snap|flash|rescan|flip');
    if (cmd === 'flip') {
      const pl = req.body.payload as any;
      if (typeof pl !== 'object' || pl === null || (pl.vflip !== undefined && typeof pl.vflip !== 'boolean') || (pl.mirror !== undefined && typeof pl.mirror !== 'boolean'))
        return bad(reply, 'flip payload ต้องเป็น {vflip?: boolean, mirror?: boolean}');
    }
    if (cmd === 'ota' && typeof req.body.payload !== 'string') return bad(reply, 'ota payload must be a URL string');
    if (cmd === 'config' && (typeof req.body.payload !== 'object' || req.body.payload === null)) return bad(reply, 'config payload must be JSON');
    const body = await sendCmd(node, cmd, req.body.payload);
    return { ok: true, topic: `gnome/${node}/cmd/${cmd}`, payload: body };
  });

  app.delete<{ Params: { node: string } }>('/api/nodes/:node', async (req, reply) => {
    const { node } = req.params;
    if (!nodes.has(node)) return bad(reply, 'node not found', 404);
    // ลืม node: ลบทั้งข้อมูลย้อนหลัง (readings/rollup/switch log/events) ไม่งั้น loadState จะปลุกมันขึ้นมาใหม่
    await clearRetained(nodes.get(node)!);
    await forgetNode(node);
    return { ok: true };
  });

  // ---- firmware / OTA ----------------------------------------------------
  // env ที่มีใน docs/firmware/<env>/manifest.json (version) → node เลือก env ตาม role + board
  function firmwareList(): Record<string, { version: string; url: string }> {
    const out: Record<string, { version: string; url: string }> = {};
    if (!existsSync(config.firmwareDir)) return out;
    for (const env of readdirSync(config.firmwareDir, { withFileTypes: true })) {
      if (!env.isDirectory()) continue;
      const mf = join(config.firmwareDir, env.name, 'manifest.json');
      if (!existsSync(mf) || !existsSync(join(config.firmwareDir, env.name, 'firmware.bin'))) continue;
      try { const m = JSON.parse(readFileSync(mf, 'utf8')); out[env.name] = { version: String(m.version || '?'), url: `${config.publicUrl}/firmware/${env.name}/firmware.bin` }; } catch { /* ignore */ }
    }
    return out;
  }
  function envForNode(n: { role: string | null; meta: any; fw: string | null }): string | null {
    const board = String(n.meta?.board || '');
    const fw = String(n.fw || '');
    if (n.role === 'keeper') return board.includes('relay-x4') || fw.includes('relayx4') ? 'keeper-relayx4' : 'keeper';
    if (n.role === 'scout') return board.includes('s3') ? 'scout-s3' : board.includes('c6') ? 'scout-c6' : 'scout';
    if (n.role === 'cam') return 'cam';   // ESP32-CAM (AI-Thinker)
    return null;
  }
  const fwVersion = (fw: string | null) => (fw || '').trim().split(/\s+/).pop() || '';

  app.get('/api/firmware', async () => {
    const list = firmwareList();
    const per = [...nodes.values()].map((n) => { const env = envForNode(n); const avail = env ? list[env] : undefined; const cur = fwVersion(n.fw);
      return { node: n.node, env, current: cur, available: avail?.version || null, update: !!(avail && cur && avail.version !== cur), online: n.online }; });
    return { publicUrl: config.publicUrl, firmware: list, nodes: per };
  });

  app.post<{ Params: { node: string }; Body: { env?: string } }>('/api/nodes/:node/ota', async (req, reply) => {
    const n = nodes.get(req.params.node);
    if (!n) return bad(reply, 'node not found', 404);
    const list = firmwareList();
    const env = req.body?.env || envForNode(n);
    if (!env || !list[env]) return bad(reply, `no firmware for env ${env}`);
    const url = list[env].url;
    await sendCmd(n.node, 'ota', url);
    await query('INSERT INTO events (ts, node, type, payload) VALUES (now(), $1, $2, $3)', [n.node, 'ota_sent', JSON.stringify({ env, version: list[env].version, url })]).catch(() => {});
    return { ok: true, node: n.node, env, version: list[env].version, url };
  });

  app.post('/api/ota', async () => {
    const list = firmwareList(); const sent: any[] = [];
    for (const n of nodes.values()) { const env = envForNode(n); if (!env || !list[env] || !n.online) continue; if (fwVersion(n.fw) === list[env].version) continue;
      await sendCmd(n.node, 'ota', list[env].url); sent.push({ node: n.node, env, version: list[env].version }); }
    return { ok: true, sent };
  });

  // ---- latest / switches -------------------------------------------------
  app.get('/api/latest', async () => {
    const out: Record<string, Record<string, { value: number; ts: string }>> = {};
    for (const n of nodes.values()) {
      out[n.node] = {};
      for (const [k, v] of n.latest) out[n.node][k] = { value: v.value, ts: new Date(v.ts).toISOString() };
    }
    return out;
  });

  app.get('/api/switches', async () => {
    const out: { node: string; key: string; state: string; ts: string; meta: unknown; online: boolean }[] = [];
    for (const n of nodes.values()) {
      const metaSw: any[] = Array.isArray(n.meta.switches) ? n.meta.switches : [];
      const keys = new Set<string>([...n.switches.keys(), ...metaSw.map((s) => s.key)]);
      for (const k of keys) {
        const st = n.switches.get(k);
        out.push({
          node: n.node,
          key: k,
          state: st?.state ?? 'UNKNOWN',
          ts: st ? new Date(st.ts).toISOString() : '',
          meta: metaSw.find((s) => s.key === k) ?? n.meta.switch_meta?.[k] ?? null,
          online: n.online,
        });
      }
    }
    return out;
  });

  app.post<{ Body: { node?: string; key?: string; state?: string; seconds?: number } }>('/api/switch', async (req, reply) => {
    const { node, key, state, seconds } = req.body ?? {};
    if (!node || !NODE_RE.test(node)) return bad(reply, 'bad node');
    if (!key || !KEY_RE.test(key)) return bad(reply, 'bad key');
    const st = String(state).toUpperCase();
    if (st !== 'ON' && st !== 'OFF') return bad(reply, 'state must be ON or OFF');
    if (seconds !== undefined && (!Number.isFinite(Number(seconds)) || Number(seconds) < 0)) return bad(reply, 'bad seconds');
    const payload = await sendSwitch(node, key, st, seconds ? Number(seconds) : undefined, 'api');
    return { ok: true, topic: `gnome/${node}/switch/${key}/command`, payload };
  });

  // ---- readings ----------------------------------------------------------
  app.get<{ Querystring: Q }>('/api/readings', async (req, reply) => {
    const { node, key } = req.query;
    if (!node || !key) return bad(reply, 'node and key required');
    const until = req.query.until ? new Date(req.query.until) : new Date();
    const since = req.query.since ? new Date(req.query.since) : new Date(until.getTime() - 24 * 3600e3);
    if (isNaN(since.getTime()) || isNaN(until.getTime())) return bad(reply, 'bad since/until');
    const spanMs = until.getTime() - since.getTime();
    let res = req.query.res;
    if (res !== 'raw' && res !== '5m') res = spanMs > 2 * 86400e3 ? '5m' : 'raw';
    const limit = Math.min(Number(req.query.limit) || 20000, 50000);
    if (res === 'raw') {
      const r = await query<{ ts: Date; value: number }>(
        `SELECT ts, value FROM readings WHERE node=$1 AND key=$2 AND ts >= $3 AND ts <= $4 ORDER BY ts LIMIT $5`,
        [node, key, since, until, limit],
      );
      return { node, key, res, since: since.toISOString(), until: until.toISOString(), rows: r.rows.map((x) => ({ ts: x.ts.toISOString(), value: Number(x.value) })) };
    }
    // 5m: union rolled-up buckets with a live rollup of raw rows not yet rolled up
    const r = await query<{ ts: Date; avg: number; min: number; max: number }>(
      `SELECT ts, avg, min, max FROM readings_5m WHERE node=$1 AND key=$2 AND ts >= $3 AND ts <= $4
       UNION ALL
       SELECT date_bin('5 minutes', ts, '2000-01-01'::timestamptz) AS ts, avg(value), min(value), max(value)
         FROM readings WHERE node=$1 AND key=$2 AND ts >= $3 AND ts <= $4
          AND ts >= coalesce((SELECT max(ts) + interval '5 minutes' FROM readings_5m WHERE node=$1 AND key=$2), '-infinity')
        GROUP BY 1
       ORDER BY ts LIMIT $5`,
      [node, key, since, until, limit],
    );
    return {
      node, key, res, since: since.toISOString(), until: until.toISOString(),
      rows: r.rows.map((x) => ({ ts: x.ts.toISOString(), value: Number(x.avg), min: Number(x.min), max: Number(x.max) })),
    };
  });

  // ---- events ------------------------------------------------------------
  app.get<{ Querystring: Q }>('/api/events', async (req) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const params: unknown[] = [limit];
    let where = '';
    if (req.query.node) {
      params.push(req.query.node);
      where += ` AND node = $${params.length}`;
    }
    if (req.query.type) {
      params.push(req.query.type);
      where += ` AND type = $${params.length}`;
    }
    const r = await query(`SELECT id, ts, node, type, payload FROM events WHERE true ${where} ORDER BY id DESC LIMIT $1`, params);
    return r.rows;
  });

  app.get<{ Querystring: Q }>('/api/switch-log', async (req) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const r = await query(`SELECT id, ts, node, key, state, source FROM switch_log ORDER BY id DESC LIMIT $1`, [limit]);
    return r.rows;
  });

  // ---- rules -------------------------------------------------------------
  // ---- ตั้งค่า Discord ----------------------------------------------------
  // webhook เป็นความลับ (ใครถือ URL ก็โพสต์เข้าห้องได้) จึงไม่ส่งกลับไปหน้าเว็บ
  // ส่งกลับแค่ id ของ webhook พอให้ผู้ใช้รู้ว่าผูกกับตัวไหนอยู่
  const WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
  const webhookId = (url: string) => url.match(/\/api\/webhooks\/(\d+)\//)?.[1] || '';
  const publicDiscord = () => {
    const s = discordSettings();
    const url = webhookUrl();
    const { webhook_url: _omit, ...rest } = s;
    return { ...rest, webhook_set: !!url, webhook_id: webhookId(url), from_env: !s.webhook_url && !!config.discordWebhookUrl };
  };

  app.get('/api/settings/discord', async () => publicDiscord());

  app.put<{ Body: Record<string, unknown> }>('/api/settings/discord', async (req, reply) => {
    const b = req.body || {};
    const patch: Record<string, unknown> = {};
    const bools = ['enabled', 'node_status', 'sensor_error', 'rules', 'daily_summary'];
    for (const k of bools) if (typeof b[k] === 'boolean') patch[k] = b[k];
    if (b.node_debounce_s !== undefined) {
      const n = Number(b.node_debounce_s);
      if (!Number.isFinite(n) || n < 0 || n > 3600) return bad(reply, 'node_debounce_s ต้องอยู่ระหว่าง 0–3600 วินาที');
      patch.node_debounce_s = Math.floor(n);
    }
    for (const k of ['summary_time', 'quiet_start', 'quiet_end']) {
      if (b[k] === undefined) continue;
      const v = b[k];
      if (v === null || v === '') { patch[k] = k === 'summary_time' ? '07:00' : null; continue; }
      if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return bad(reply, `${k} ต้องเป็นเวลารูปแบบ HH:MM`);
      patch[k] = v;
    }
    if (b.clear_webhook === true) patch.webhook_url = '';
    else if (typeof b.webhook_url === 'string' && b.webhook_url.trim()) {
      const raw = b.webhook_url.trim();
      let u: URL;
      try { u = new URL(raw); } catch { return bad(reply, 'webhook URL ไม่ถูกต้อง'); }
      if (u.protocol !== 'https:' || !WEBHOOK_HOSTS.has(u.hostname) || !u.pathname.startsWith('/api/webhooks/')) {
        return bad(reply, 'ต้องเป็น Discord webhook เช่น https://discord.com/api/webhooks/...');
      }
      patch.webhook_url = raw;
    }
    const before = discordSettings();
    const next = await saveDiscordSettings(patch);
    if (next.summary_time !== before.summary_time) startHeartbeat();   // ตั้งตารางสรุปใหม่ทันที
    log.info(`discord settings updated (${Object.keys(patch).join(', ') || 'ไม่มีการเปลี่ยน'})`);
    return publicDiscord();
  });

  app.post('/api/settings/discord/test', async (_req, reply) => {
    if (!webhookUrl()) return bad(reply, 'ยังไม่ได้ตั้ง webhook');
    const ok = await discord(`🧪 ทดสอบจาก **GNOME Hut** — ${new Date().toLocaleString('th-TH', { timeZone: config.tz })}`, 'test');
    return ok ? { ok: true } : reply.code(502).send({ error: 'ส่งไม่สำเร็จ — ตรวจว่า webhook ยังใช้ได้อยู่' });
  });

  // ---- โหมดคิดของ Watcher --------------------------------------------------
  app.get('/api/settings/glance', async () => ({
    ...glanceSettings(),
    ready: glanceReady(),
    model: config.sageModel,
    cam_nodes: [...nodes.values()].filter((n) => n.role === 'cam').map((n) => n.node).sort(),
  }));

  app.put<{ Body: Record<string, unknown> }>('/api/settings/glance', async (req, reply) => {
    const b = req.body || {};
    const patch: Record<string, unknown> = {};
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (b.nodes !== undefined) {
      if (!Array.isArray(b.nodes) || b.nodes.some((n) => typeof n !== 'string' || !NODE_RE.test(n))) return bad(reply, 'nodes ไม่ถูกต้อง');
      patch.nodes = (b.nodes as string[]).slice(0, 8);
    }
    for (const [k, lo, hi] of [['min_gap_s', 30, 86400], ['ttl_s', 60, 86400]] as const) {
      if (b[k] === undefined) continue;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < lo || v > hi) return bad(reply, `${k} ต้องอยู่ระหว่าง ${lo}–${hi} วินาที`);
      patch[k] = Math.floor(v);
    }
    const before = glanceSettings();
    const next = await saveGlanceSettings(patch);
    // node ที่ถูกปิดไป ให้ล้างข้อความบนจอทิ้ง จะได้ไม่ค้างคำเก่า
    const off = before.nodes.filter((n) => !next.enabled || !next.nodes.includes(n));
    for (const n of off) await clearGlance(n).catch(() => {});
    log.info(`glance settings updated (enabled=${next.enabled}, nodes=${next.nodes.join(',') || '-'})`);
    return next;
  });

  app.get('/api/rules', async () => listRules());

  app.post<{ Body: any }>('/api/rules', async (req, reply) => {
    const body: any = req.body ?? {};
    const json = body.json ?? body; // accept {name, enabled, json} or the bare rule json
    const name = body.name ?? json.name;
    if (!name || typeof name !== 'string') return bad(reply, 'name required');
    const err = validateRule(json);
    if (err) return bad(reply, err);
    const enabled = body.enabled ?? json.enabled ?? true;
    const r = await query('INSERT INTO rules(name, enabled, json) VALUES ($1,$2,$3) RETURNING *', [name, !!enabled, JSON.stringify({ ...json, name })]);
    await reloadRules();
    return reply.code(201).send(r.rows[0]);
  });

  app.put<{ Params: { id: string }; Body: any }>('/api/rules/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const cur = await query<{ id: number; name: string; enabled: boolean; json: any }>('SELECT * FROM rules WHERE id=$1', [id]);
    if (!cur.rows[0]) return bad(reply, 'rule not found', 404);
    const body: any = req.body ?? {};
    const json = body.json ?? (body.trigger ? body : cur.rows[0].json);
    const name = body.name ?? json.name ?? cur.rows[0].name;
    const enabled = body.enabled ?? cur.rows[0].enabled;
    const err = validateRule(json);
    if (err) return bad(reply, err);
    const r = await query('UPDATE rules SET name=$2, enabled=$3, json=$4, updated_at=now() WHERE id=$1 RETURNING *', [
      id, name, !!enabled, JSON.stringify({ ...json, name }),
    ]);
    await reloadRules();
    return r.rows[0];
  });

  app.delete<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    const r = await query('DELETE FROM rules WHERE id=$1', [Number(req.params.id)]);
    if (!r.rowCount) return bad(reply, 'rule not found', 404);
    await reloadRules();
    return { ok: true };
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.code(404).type('text/plain').send('not found');
  });
  app.setErrorHandler((err: any, req, reply) => {
    log.error(`${req.method} ${req.url}`, err.message);
    reply.code((err as any).statusCode || 500).send({ error: err.message });
  });

  await app.listen({ port: config.port, host: config.host });
  log.info(`listening on http://${config.host}:${config.port} (public: ${config.publicDir})`);
  return app;
}
