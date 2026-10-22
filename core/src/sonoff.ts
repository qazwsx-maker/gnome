// Sonoff DIY mode bridge — ให้สวิตช์ Sonoff (BASICR3/RFR3/MINI/MINIR2/MINIR3) ที่เปิด DIY mode
// โผล่ในระบบเป็น node role keeper ตามสัญญา MQTT เดิม: Hut ค้นหาด้วย mDNS (_ewelink._tcp),
// สั่งงานผ่าน HTTP :8081 และ publish status/meta/switch state แทนตัวอุปกรณ์
// ไม่ต้องผ่านคลาวด์ eWeLink · ไม่ต้องแฟลช · กฎอัตโนมัติ/การ์ด/Discord ใช้ได้ทันที
import mdns from 'multicast-dns';
import { logger } from './log.ts';
import { publish } from './mqtt.ts';
import { recordEvent } from './state.ts';

const log = logger('sonoff');
const SERVICE = '_ewelink._tcp.local';
const POLL_MS = 30_000;          // ถาม /zeroconf/info ทุก 30 วิ (สถานะอาจถูกเปลี่ยนจากปุ่ม/แอป)
const EXPIRE_MS = 150_000;       // ไม่เห็นใน mDNS และ info ไม่ตอบนานเท่านี้ = offline
const MIN_GAP_MS = 250;          // สเปก Sonoff: เว้นอย่างน้อย 200 ms ระหว่างคำขอ
const PULSE_MIN = 500, PULSE_MAX = 36_000_000;   // ms, ต้องเป็นทวีคูณของ 500

type Device = {
  id: string; node: string; type: string; ip: string; port: number;
  diy: boolean;                  // data1 อ่านเป็น JSON ได้ = DIY mode (ไม่เข้ารหัส)
  state: 'ON' | 'OFF' | null; rssi: number | null; fw: string;
  startup: string | null; pulse: string | null; pulseWidth: number | null;
  lastSeen: number; online: boolean; announced: boolean;
  busyUntil: number; offTimer: ReturnType<typeof setTimeout> | null;
};

const devices = new Map<string, Device>();     // key = node name
const byId = new Map<string, string>();        // deviceid -> node
let m: ReturnType<typeof mdns> | null = null;

export const nodeNameFor = (id: string) => `sonoff-${id.slice(-4).toLowerCase()}`;
export function isSonoffNode(node: string): boolean { return devices.has(node); }
export function listSonoff() { return [...devices.values()].map(({ offTimer: _t, ...d }) => d); }

// ---------- mDNS ----------
function parseTxt(data: any): Record<string, string> {
  const out: Record<string, string> = {};
  const items: Buffer[] = Array.isArray(data) ? data : [data];
  for (const b of items) { const s = Buffer.isBuffer(b) ? b.toString('utf8') : String(b); const i = s.indexOf('='); if (i > 0) out[s.slice(0, i)] = s.slice(i + 1); }
  return out;
}

function onResponse(res: any): void {
  const rr = [...(res.answers || []), ...(res.additionals || [])];
  const ptrs = rr.filter((r) => r.type === 'PTR' && r.name === SERVICE).map((r) => r.data as string);
  const names = new Set<string>(ptrs);
  // บางเครื่องตอบ SRV/TXT โดยไม่มี PTR ในแพ็กเก็ตเดียวกัน
  for (const r of rr) if ((r.type === 'SRV' || r.type === 'TXT') && String(r.name).endsWith(SERVICE)) names.add(r.name);
  for (const inst of names) {
    const srv = rr.find((r) => r.type === 'SRV' && r.name === inst);
    const txt = rr.find((r) => r.type === 'TXT' && r.name === inst);
    if (!txt) continue;
    const t = parseTxt(txt.data);
    const id = (t.id || '').toLowerCase(); if (!id) continue;
    const target = srv?.data?.target as string | undefined;
    const a = rr.find((r) => r.type === 'A' && (!target || r.name === target));
    const ip = a?.data as string | undefined;
    const port = Number(srv?.data?.port) || 8081;
    let data1: any = null; try { data1 = t.data1 ? JSON.parse(t.data1) : null; } catch { data1 = null; }
    const diy = !!data1 && typeof data1 === 'object' && t.encrypt !== 'true';
    upsert(id, { type: t.type || 'diy_plug', ip: ip || '', port, diy, data1 });
  }
}

async function upsert(id: string, info: { type: string; ip: string; port: number; diy: boolean; data1: any }): Promise<void> {
  const node = byId.get(id) || nodeNameFor(id);
  let d = devices.get(node);
  const fresh = !d;
  if (!d) {
    d = { id, node, type: info.type, ip: info.ip, port: info.port, diy: info.diy, state: null, rssi: null, fw: '', startup: null, pulse: null, pulseWidth: null,
          lastSeen: 0, online: false, announced: false, busyUntil: 0, offTimer: null };
    devices.set(node, d); byId.set(id, node);
  }
  if (info.ip) d.ip = info.ip;
  d.port = info.port; d.type = info.type; d.diy = info.diy; d.lastSeen = Date.now();
  if (info.data1) applyInfo(d, info.data1);
  if (fresh) {
    log.info(`found ${node} (${id}) ${d.type} at ${d.ip}:${d.port} ${d.diy ? 'DIY mode' : 'ENCRYPTED — ต้องเปิด DIY mode ในแอป eWeLink ก่อน'}`);
    await recordEvent(node, 'sonoff_found', { id, type: d.type, ip: d.ip, diy: d.diy });
    if (d.diy) await ensureSafeStartup(d);
  }
  await announce(d);
}

function applyInfo(d: Device, j: any): void {
  if (j.switch === 'on' || j.switch === 'off') d.state = j.switch === 'on' ? 'ON' : 'OFF';
  if (typeof j.rssi === 'number') d.rssi = j.rssi;
  if (typeof j.signalStrength === 'number') d.rssi = j.signalStrength;
  if (typeof j.fwVersion === 'string') d.fw = j.fwVersion;
  if (typeof j.startup === 'string') d.startup = j.startup;
  if (typeof j.pulse === 'string') d.pulse = j.pulse;
  if (typeof j.pulseWidth === 'number') d.pulseWidth = j.pulseWidth;
}

// ---------- MQTT ตัวแทน ----------
async function announce(d: Device): Promise<void> {
  const base = `gnome/${d.node}/`;
  const meta = {
    node: d.node, role: 'keeper', fw: `sonoff-diy ${d.fw || '?'}`, board: d.type, ip: d.ip, mac: '', bridge: 'sonoff',
    sonoff_id: d.id, diy: d.diy,
    switches: d.diy ? [{ key: 'relay', max_on_s: 0 }] : [],
    sensors: [],
  };
  await publish(base + 'meta', JSON.stringify(meta), { qos: 1, retain: true }).catch(() => {});
  if (!d.announced) { await publish(base + 'switch/relay/meta', JSON.stringify({ unit: '', src: 'sonoff' }), { qos: 1, retain: true }).catch(() => {}); d.announced = true; }
  if (!d.online) { d.online = true; await publish(base + 'status', 'online', { qos: 1, retain: true }).catch(() => {}); }
  if (d.state) await publish(base + 'switch/relay/state', d.state, { qos: 1, retain: true }).catch(() => {});
  await publish(base + 'debug', JSON.stringify({ rssi: d.rssi, ip: d.ip, diy: d.diy, startup: d.startup, pulse: d.pulse, pulse_width_ms: d.pulseWidth }), { qos: 0 }).catch(() => {});
}

async function markOffline(d: Device): Promise<void> {
  if (!d.online) return;
  d.online = false;
  await publish(`gnome/${d.node}/status`, 'offline', { qos: 1, retain: true }).catch(() => {});
  log.warn(`${d.node} offline (no mDNS/info for ${EXPIRE_MS / 1000}s)`);
}

// ---------- HTTP ไปหาอุปกรณ์ ----------
async function call(d: Device, path: string, data: Record<string, unknown>): Promise<any> {
  const wait = d.busyUntil - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  d.busyUntil = Date.now() + MIN_GAP_MS;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(`http://${d.ip}:${d.port}/zeroconf/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceid: d.id, data }), signal: ctl.signal });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || (j && j.error && j.error !== 0)) throw new Error(`${path} -> http ${res.status} error ${j?.error ?? '?'}`);
    d.lastSeen = Date.now();
    return j?.data ?? {};
  } finally { clearTimeout(t); }
}

async function refresh(d: Device): Promise<void> {
  if (!d.diy || !d.ip) return;
  try { const info = await call(d, 'info', {}); applyInfo(d, info); await announce(d); }
  catch (e) { log.warn(`${d.node} info: ${(e as Error).message}`); }
}

/** วาล์ว/ปั๊มต้องไม่เปิดเองหลังไฟดับ-ไฟมา → ตั้ง startup=off ครั้งแรกที่เจอ */
async function ensureSafeStartup(d: Device): Promise<void> {
  try { if (d.startup !== 'off') { await call(d, 'startup', { startup: 'off' }); d.startup = 'off'; log.info(`${d.node} startup policy -> off`); } }
  catch (e) { log.warn(`${d.node} startup: ${(e as Error).message}`); }
}

/** รับ ON / ON <วินาที> / OFF จาก gnome/<node>/switch/relay/command (ที่ Hut เองหรือกฎส่ง) */
export async function sonoffCommand(node: string, key: string, payload: string): Promise<boolean> {
  const d = devices.get(node); if (!d) return false;
  if (key !== 'relay') { log.warn(`${node}: unknown switch ${key}`); return true; }
  if (!d.diy) { log.warn(`${node}: ยังไม่ได้เปิด DIY mode สั่งไม่ได้`); await recordEvent(node, 'sonoff_needs_diy', {}); return true; }
  const m2 = payload.trim().toUpperCase().match(/^(ON|OFF)(?:\s+(\d+))?$/);
  if (!m2) { log.warn(`${node}: bad payload ${payload}`); return true; }
  const on = m2[1] === 'ON'; const secs = m2[2] ? Number(m2[2]) : 0;
  if (d.offTimer) { clearTimeout(d.offTimer); d.offTimer = null; }
  try {
    if (on && secs > 0) {
      // ให้ตัวอุปกรณ์ตัดเองด้วย pulse (ถึง Hut ตายกลางทางวาล์วก็ปิด) + Hut ตั้งเวลาซ้ำอีกชั้น
      const ms = Math.min(PULSE_MAX, Math.max(PULSE_MIN, Math.round((secs * 1000) / 500) * 500));
      await call(d, 'pulse', { pulse: 'on', pulseWidth: ms });
      await call(d, 'switch', { switch: 'on' });
      d.offTimer = setTimeout(() => { d.offTimer = null; void refresh(d); }, ms + 1500);
      d.offTimer.unref?.();
    } else if (on) {
      if (d.pulse === 'on') await call(d, 'pulse', { pulse: 'off', pulseWidth: 500 });
      await call(d, 'switch', { switch: 'on' });
    } else {
      await call(d, 'switch', { switch: 'off' });
    }
    d.state = on ? 'ON' : 'OFF';
    await announce(d);
    log.info(`${node}/relay <- ${payload.trim()} ok`);
  } catch (e) {
    log.error(`${node}/relay <- ${payload.trim()} failed: ${(e as Error).message}`);
    await recordEvent(node, 'switch_failed', { key, payload, msg: (e as Error).message });
    await refresh(d);
  }
  return true;
}

// ---------- lifecycle ----------
export function startSonoff(): void {
  try { m = mdns(); } catch (e) { log.error('mdns start failed', (e as Error).message); return; }
  m.on('response', (res: any) => { try { onResponse(res); } catch (e) { log.warn('parse', (e as Error).message); } });
  m.on('error', (e: Error) => log.warn('mdns', e.message));
  const query = () => m?.query({ questions: [{ name: SERVICE, type: 'PTR' }] });
  query(); setTimeout(query, 3000).unref();
  setInterval(query, POLL_MS).unref();
  setInterval(() => { for (const d of devices.values()) { void refresh(d); if (Date.now() - d.lastSeen > EXPIRE_MS) void markOffline(d); } }, POLL_MS).unref();
  log.info(`bridge started — looking for ${SERVICE}`);
}
