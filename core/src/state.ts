// In-memory "latest" state mirrored from MQTT. DB is the durable copy.
import { query } from './db.ts';
import { config } from './config.ts';
import { discord } from './discord.ts';
import { bus } from './bus.ts';
import { logger } from './log.ts';

const log = logger('state');

export type Latest = { value: number; ts: number };
export type DebugInfo = { rssi?: number; uptime_s?: number; heap?: number; ip?: string; ts: number; [k: string]: unknown };

export type NodeState = {
  node: string;
  role: string | null;
  fw: string | null;
  ip: string | null;
  mac: string | null;
  meta: Record<string, any>;
  online: boolean;
  last_seen: number | null; // epoch ms
  latest: Map<string, Latest>;
  switches: Map<string, { state: string; ts: number }>;
  debug: DebugInfo | null;
};

export const nodes = new Map<string, NodeState>();

export function getNode(name: string): NodeState {
  let n = nodes.get(name);
  if (!n) {
    n = {
      node: name,
      role: null,
      fw: null,
      ip: null,
      mac: null,
      meta: {},
      online: false,
      last_seen: null,
      latest: new Map(),
      switches: new Map(),
      debug: null,
    };
    nodes.set(name, n);
  }
  return n;
}

/** "node.key" -> latest value (undefined if unknown) */
export function latestValue(ref: string): Latest | undefined {
  const i = ref.indexOf('.');
  if (i < 0) return undefined;
  return nodes.get(ref.slice(0, i))?.latest.get(ref.slice(i + 1));
}

export function nodeToJson(n: NodeState) {
  const latest: Record<string, { value: number; ts: string }> = {};
  for (const [k, v] of n.latest) latest[k] = { value: v.value, ts: new Date(v.ts).toISOString() };
  const switches: Record<string, { state: string; ts: string }> = {};
  for (const [k, v] of n.switches) switches[k] = { state: v.state, ts: new Date(v.ts).toISOString() };
  return {
    node: n.node,
    role: n.role,
    fw: n.fw,
    ip: n.ip,
    mac: n.mac,
    meta: n.meta,
    online: n.online,
    last_seen: n.last_seen ? new Date(n.last_seen).toISOString() : null,
    latest,
    switches,
    debug: n.debug ? { ...n.debug, ts: new Date(n.debug.ts).toISOString() } : null,
  };
}

/** Load nodes + last switch states + most recent readings into memory at startup. */
export async function loadState(): Promise<void> {
  const rows = await query<{
    node: string; role: string | null; fw: string | null; ip: string | null; mac: string | null;
    meta: any; online: boolean; last_seen: Date | null;
  }>('SELECT node, role, fw, ip, mac, meta, online, last_seen FROM nodes');
  for (const r of rows.rows) {
    const n = getNode(r.node);
    n.role = r.role; n.fw = r.fw; n.ip = r.ip; n.mac = r.mac; n.meta = r.meta || {};
    n.online = r.online; n.last_seen = r.last_seen ? r.last_seen.getTime() : null;
  }
  const sw = await query<{ node: string; key: string; state: string; ts: Date }>('SELECT node, key, state, ts FROM switch_states');
  for (const r of sw.rows) if (nodes.has(r.node)) getNode(r.node).switches.set(r.key, { state: r.state, ts: r.ts.getTime() });   // ไม่สร้าง node ที่ถูกลบไปแล้วขึ้นมาใหม่
  const last = await query<{ node: string; key: string; value: number; ts: Date }>(
    `SELECT DISTINCT ON (node, key) node, key, value, ts FROM readings
      WHERE ts > now() - interval '1 day' ORDER BY node, key, ts DESC`,
  );
  for (const r of last.rows) if (nodes.has(r.node)) getNode(r.node).latest.set(r.key, { value: Number(r.value), ts: r.ts.getTime() });
  log.info(`loaded ${nodes.size} nodes, ${sw.rows.length} switches, ${last.rows.length} latest readings`);
}

// ---- events -------------------------------------------------------------

export async function recordEvent(node: string | null, type: string, payload: unknown = null): Promise<number | null> {
  try {
    const r = await query<{ id: number; ts: Date }>(
      'INSERT INTO events(node, type, payload) VALUES ($1,$2,$3) RETURNING id, ts',
      [node, type, payload === undefined ? null : JSON.stringify(payload)],
    );
    const row = r.rows[0];
    bus.live({ type: 'event', id: row.id, node, type_: type, payload, ts: row.ts.toISOString() });
    bus.emit('event', { node, type, payload });
    return row.id;
  } catch (e) {
    log.error('recordEvent', (e as Error).message);
    return null;
  }
}

// ---- online / offline -------------------------------------------------

export async function setOnline(name: string, online: boolean, via: string): Promise<void> {
  const n = getNode(name);
  const changed = n.online !== online;
  n.online = online;
  const now = Date.now();
  if (online) n.last_seen = now;
  await query(
    `INSERT INTO nodes(node, online, last_seen) VALUES ($1,$2,$3)
       ON CONFLICT (node) DO UPDATE SET online = EXCLUDED.online,
       last_seen = CASE WHEN EXCLUDED.online THEN EXCLUDED.last_seen ELSE nodes.last_seen END`,
    [name, online, new Date(now)],
  ).catch((e) => log.error('setOnline', e.message));
  if (changed) {
    log.info(`${name} -> ${online ? 'online' : 'offline'} (${via})`);
    bus.live({ type: 'status', node: name, online, ts: new Date(now).toISOString() });
    await recordEvent(name, online ? 'node_online' : 'node_offline', { via });
    bus.emit(online ? 'node_online' : 'node_offline', name);
    const why = via === 'timeout' ? `ไม่มีข้อมูล > ${config.offlineAfterMs / 1000} s` : via === 'lwt' ? 'หลุดจาก MQTT (LWT)' : via;
    await discord(online ? `🟢 **${name}** กลับมาออนไลน์` : `🔴 **${name}** ออฟไลน์ (${why})`);
  }
}

/** Any live (non-retained) message from a node counts as a heartbeat. */
export function touch(name: string): void {
  const n = getNode(name);
  n.last_seen = Date.now();
  if (!n.online) void setOnline(name, true, 'message');
}

/** Persist last_seen for all nodes (called periodically, not on every message). */
export async function persistLastSeen(): Promise<void> {
  for (const n of nodes.values()) {
    if (!n.last_seen) continue;
    await query('UPDATE nodes SET last_seen = GREATEST(coalesce(last_seen, $2), $2) WHERE node = $1', [n.node, new Date(n.last_seen)])
      .catch((e) => log.error('persistLastSeen', e.message));
  }
}
