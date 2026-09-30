// MQTT client: subscribes gnome/#, parses topics per docs/PROTOCOL.md, writes DB + in-memory state.
import mqtt, { type MqttClient } from 'mqtt';
import { config } from './config.ts';
import { logger } from './log.ts';
import { query } from './db.ts';
import { bus } from './bus.ts';
import { getNode, setOnline, touch, recordEvent, nodes, forgetNode } from './state.ts';
import { discord } from './discord.ts';

const log = logger('mqtt');
const SERVER_STATUS = 'gnome/server/status';
const DISCORD_EVENTS = new Set(['max_on_reached', 'failsafe_off', 'sensor_error']);

let client: MqttClient | null = null;

export function mqttConnected(): boolean {
  return !!client?.connected;
}

export function publish(topic: string, payload: string, opts: { qos?: 0 | 1; retain?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!client) return reject(new Error('mqtt not started'));
    client.publish(topic, payload, { qos: opts.qos ?? 1, retain: opts.retain ?? false }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Send `ON`, `ON <seconds>` or `OFF` to gnome/<node>/switch/<key>/command and log it. */
export async function sendSwitch(node: string, key: string, state: 'ON' | 'OFF', seconds?: number, source = 'api'): Promise<string> {
  const payload = state === 'ON' && seconds && seconds > 0 ? `ON ${Math.round(seconds)}` : state;
  await publish(`gnome/${node}/switch/${key}/command`, payload, { qos: 1 });
  await query('INSERT INTO switch_log(node, key, state, source) VALUES ($1,$2,$3,$4)', [node, key, payload, source]).catch((e) =>
    log.error('switch_log', e.message),
  );
  log.info(`command ${node}/${key} <- ${payload} (${source})`);
  return payload;
}

export async function sendCmd(node: string, cmd: string, payload: unknown): Promise<string> {
  const body = payload === undefined || payload === null ? '1' : typeof payload === 'string' ? payload : JSON.stringify(payload);
  await publish(`gnome/${node}/cmd/${cmd}`, body, { qos: 1 });
  log.info(`cmd ${node}/${cmd} <- ${body.slice(0, 120)}`);
  return body;
}

// ---- readings batch -----------------------------------------------------

type Pending = { ts: Date; node: string; key: string; value: number };
let pending: Pending[] = [];

async function flushReadings(): Promise<void> {
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  try {
    await query(
      `INSERT INTO readings(ts, node, key, value)
         SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::float8[])`,
      [batch.map((b) => b.ts), batch.map((b) => b.node), batch.map((b) => b.key), batch.map((b) => b.value)],
    );
  } catch (e) {
    log.error(`flush ${batch.length} readings failed`, (e as Error).message);
  }
}

// ---- topic handlers -----------------------------------------------------

function parseJson(buf: Buffer): any | null {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

async function onStatus(node: string, payload: string): Promise<void> {
  if (payload === 'online') await setOnline(node, true, 'status');
  else if (payload === 'offline') await setOnline(node, false, 'lwt');
  else log.warn(`${node} status unknown payload "${payload}"`);
}

async function onMeta(node: string, meta: any, retained = false): Promise<void> {
  const n = getNode(node);
  n.role = meta.role ?? n.role;
  n.fw = meta.fw ?? n.fw;
  n.ip = meta.ip ?? n.ip;
  n.mac = meta.mac ?? n.mac;
  n.meta = { ...n.meta, ...meta };
  // บอร์ดเดิมเปลี่ยนชื่อ (MAC เดียวกัน ชื่อต่างกัน) → ลบชื่อเก่าให้อัตโนมัติ — เชื่อเฉพาะ meta สด (ไม่ใช่ retained replay ตอน Hut เริ่ม)
  if (!retained && n.mac) for (const other of [...nodes.values()]) if (other.node !== node && other.mac === n.mac) {
    log.info(`node ${other.node} renamed to ${node} (same MAC ${n.mac}) — forgetting old name`);
    await recordEvent(node, 'renamed', { from: other.node, mac: n.mac });
    await clearRetained(other);
    await forgetNode(other.node);
  }
  await query(
    `INSERT INTO nodes(node, role, fw, ip, mac, meta) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (node) DO UPDATE SET role = coalesce(EXCLUDED.role, nodes.role), fw = coalesce(EXCLUDED.fw, nodes.fw),
       ip = coalesce(EXCLUDED.ip, nodes.ip), mac = coalesce(EXCLUDED.mac, nodes.mac), meta = nodes.meta || EXCLUDED.meta`,
    [node, n.role, n.fw, n.ip, n.mac, JSON.stringify(meta)],
  ).catch((e) => log.error('meta upsert', e.message));
  bus.live({ type: 'node', node, ts: new Date().toISOString() });
}

/** ล้าง retained topics ของ node ที่ถูกลืม ไม่ให้ broker replay กลับมาปลุกมันอีก */
export async function clearRetained(n: { node: string; meta: any; switches: Map<string, any>; latest: Map<string, any> }): Promise<void> {
  const topics = [`gnome/${n.node}/status`, `gnome/${n.node}/meta`];
  for (const k of Object.keys(n.meta?.sensor_meta || {})) topics.push(`gnome/${n.node}/sensor/${k}/meta`);
  for (const s of (n.meta?.sensors || [])) if (s?.key) topics.push(`gnome/${n.node}/sensor/${s.key}/meta`);
  for (const k of new Set([...n.switches.keys(), ...Object.keys(n.meta?.switch_meta || {})])) topics.push(`gnome/${n.node}/switch/${k}/state`, `gnome/${n.node}/switch/${k}/meta`);
  for (const t of new Set(topics)) await publish(t, '', { qos: 1, retain: true }).catch(() => {});
}

async function onSensorMeta(node: string, key: string, meta: any): Promise<void> {
  const n = getNode(node);
  const sm = { ...(n.meta.sensor_meta || {}), [key]: meta };
  n.meta = { ...n.meta, sensor_meta: sm };
  await query(
    `INSERT INTO nodes(node, meta) VALUES ($1, $2)
       ON CONFLICT (node) DO UPDATE SET meta = nodes.meta || EXCLUDED.meta`,
    [node, JSON.stringify({ sensor_meta: sm })],
  ).catch((e) => log.error('sensor meta', e.message));
}

async function onSwitchMeta(node: string, key: string, meta: any): Promise<void> {
  const n = getNode(node);
  const sm = { ...(n.meta.switch_meta || {}), [key]: meta };
  n.meta = { ...n.meta, switch_meta: sm };
  await query(
    `INSERT INTO nodes(node, meta) VALUES ($1, $2)
       ON CONFLICT (node) DO UPDATE SET meta = nodes.meta || EXCLUDED.meta`,
    [node, JSON.stringify({ switch_meta: sm })],
  ).catch((e) => log.error('switch meta', e.message));
}

function onSensorState(node: string, key: string, payload: string): void {
  const value = Number(payload.trim());
  if (!Number.isFinite(value)) {
    log.warn(`${node}/${key} non-numeric "${payload.slice(0, 40)}"`);
    return;
  }
  const now = Date.now();
  getNode(node).latest.set(key, { value, ts: now });
  pending.push({ ts: new Date(now), node, key, value });
  const msg = { type: 'reading' as const, node, key, value, ts: new Date(now).toISOString() };
  bus.live(msg);
  bus.emit('reading', msg);
}

async function onSwitchState(node: string, key: string, payload: string, retained: boolean): Promise<void> {
  const state = payload.trim().toUpperCase();
  const n = getNode(node);
  const prev = n.switches.get(key);
  const now = Date.now();
  n.switches.set(key, { state, ts: now });
  await query(
    `INSERT INTO switch_states(node, key, state, ts) VALUES ($1,$2,$3,$4)
       ON CONFLICT (node, key) DO UPDATE SET state = EXCLUDED.state, ts = EXCLUDED.ts`,
    [node, key, state, new Date(now)],
  ).catch((e) => log.error('switch_states', e.message));
  // retained replay at startup only logs if it differs from what we knew
  if (!retained || !prev || prev.state !== state) {
    await query('INSERT INTO switch_log(node, key, state, source) VALUES ($1,$2,$3,$4)', [node, key, state, 'node']).catch((e) =>
      log.error('switch_log', e.message),
    );
    const msg = { type: 'switch' as const, node, key, state, ts: new Date(now).toISOString() };
    bus.live(msg);
    bus.emit('switch', msg);
  }
}

async function onDebug(node: string, dbg: any): Promise<void> {
  const n = getNode(node);
  n.debug = { ...dbg, ts: Date.now() };
  if (dbg.ip && dbg.ip !== n.ip) {
    n.ip = dbg.ip;
    await query(`INSERT INTO nodes(node, ip) VALUES ($1,$2) ON CONFLICT (node) DO UPDATE SET ip = EXCLUDED.ip`, [node, dbg.ip]).catch(
      (e) => log.error('debug ip', e.message),
    );
  }
  bus.live({ type: 'debug', node, debug: dbg, ts: new Date().toISOString() });
}

async function onEvent(node: string, ev: any): Promise<void> {
  const type = String(ev.type || 'unknown');
  await recordEvent(node, type, ev);
  if (DISCORD_EVENTS.has(type)) {
    const extra = Object.entries(ev)
      .filter(([k]) => k !== 'type')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    await discord(`⚠️ **${node}** ${type}${extra ? ' — ' + extra : ''}`, 'sensor_error');
  }
}

async function handle(topic: string, buf: Buffer, retained: boolean): Promise<void> {
  const parts = topic.split('/');
  if (parts[0] !== 'gnome' || parts.length < 3) return;
  const node = parts[1];
  if (node === 'server') return;
  if (!/^[a-z0-9-]+$/.test(node)) {
    log.warn(`ignoring topic with invalid node name: ${topic}`);
    return;
  }
  const payload = buf.toString('utf8');
  const kind = parts[2];

  // liveness: retained replays (meta / switch state / sensor meta) are not heartbeats
  if (!retained && kind !== 'status' && kind !== 'cmd') touch(node);

  switch (kind) {
    case 'status':
      if (parts.length === 3) return onStatus(node, payload.trim());
      break;
    case 'meta': {
      const j = parseJson(buf);
      if (j && parts.length === 3) return onMeta(node, j, retained);
      break;
    }
    case 'sensor': {
      if (parts.length !== 5) break;
      const key = parts[3];
      if (parts[4] === 'state') return onSensorState(node, key, payload);
      if (parts[4] === 'meta') {
        const j = parseJson(buf);
        if (j) return onSensorMeta(node, key, j);
      }
      break;
    }
    case 'switch': {
      if (parts.length !== 5) break;
      const key = parts[3];
      if (parts[4] === 'state') return onSwitchState(node, key, payload, retained);
      if (parts[4] === 'meta') {
        const j = parseJson(buf);
        if (j) return onSwitchMeta(node, key, j);
      }
      if (parts[4] === 'command') return; // our own outgoing commands
      break;
    }
    case 'debug': {
      const j = parseJson(buf);
      if (j && typeof j === 'object') return onDebug(node, j);
      break;
    }
    case 'event': {
      const j = parseJson(buf);
      if (j && typeof j === 'object') return onEvent(node, j);
      break;
    }
    case 'cmd':
      return; // outgoing
  }
  log.warn(`unhandled ${topic} ${payload.slice(0, 60)}`);
}

// ---- lifecycle ----------------------------------------------------------

export function startMqtt(): MqttClient {
  const url = `mqtt://${config.mqttHost}:${config.mqttPort}`;
  client = mqtt.connect(url, {
    clientId: `gnome-core-${process.pid}`,
    username: config.mqttUser,
    password: config.mqttPass,
    clean: true,
    reconnectPeriod: 3000,
    keepalive: 30,
    will: { topic: SERVER_STATUS, payload: Buffer.from('offline'), qos: 1, retain: true },
  });
  client.on('connect', () => {
    log.info(`connected ${url} as ${config.mqttUser}`);
    client!.publish(SERVER_STATUS, 'online', { qos: 1, retain: true });
    client!.subscribe('gnome/#', { qos: 1 }, (err) => err && log.error('subscribe', err.message));
  });
  client.on('reconnect', () => log.warn('reconnecting'));
  client.on('close', () => log.warn('connection closed'));
  client.on('error', (e) => log.error(e.message));
  client.on('message', (topic, buf, packet) => {
    handle(topic, buf, !!packet.retain).catch((e) => log.error(`handle ${topic}`, (e as Error).message));
  });

  setInterval(() => void flushReadings(), config.readingsFlushMs).unref();
  return client;
}

export async function stopMqtt(): Promise<void> {
  await flushReadings();
  if (!client) return;
  await new Promise<void>((res) => client!.publish(SERVER_STATUS, 'offline', { qos: 1, retain: true }, () => res()));
  await new Promise<void>((res) => client!.end(false, {}, () => res()));
}

/** Health tick: nodes silent for > offlineAfterMs go offline even without LWT. */
export async function healthTick(): Promise<void> {
  const cutoff = Date.now() - config.offlineAfterMs;
  for (const n of nodes.values()) {
    if (n.online && n.last_seen !== null && n.last_seen < cutoff) await setOnline(n.node, false, 'timeout');
  }
}
