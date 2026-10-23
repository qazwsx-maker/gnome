// "อารมณ์/สรุปสภาพแวดล้อม" ของแต่ละ node — Hut คำนวณที่เดียวจากค่าล่าสุด แล้วแจกให้ dashboard (WS `vibe`), /api/nodes, กฎ, Discord
//   sky   (มี lux)        → ☀️ แดดจัด · ⛅ แดดครึ้ม · 🌥 รำไร · 🌙 กลางคืน · 🌧 ฝนตก (raindrop)
//   earth (temp + rh)     → 🔥 ร้อนแห้ง · 🥵 ร้อนชื้น · 🍃 เย็นแห้ง · 💧 เย็นชื้น (+ 🥀 ดินแห้ง ถ้ามีหัววัดดิน)
//   watcher (role cam)    → 👁 กำลังเฝ้ามอง <ชื่อแปลงจาก Sage> + ประโยคล่าสุดจากโหมดคิด (ไอคอนตามอารมณ์ที่กล้องเห็น)
//   keeper (มีสวิตช์)     → 💧 กำลังรดน้ำ · 🌬 พัดลมทำงาน · 😌 พักอยู่
//   ทุกตัว: offline → 😵 ขาดการติดต่อ
// เกณฑ์ปรับได้ที่ T ด้านล่าง (ค่าเดียวกับที่ firmware ใช้วาดหน้าบน OLED เท่าที่ทำได้: hot > 34 °C, lux < 5 = กลางคืนสนิท)
import { bus } from './bus.ts';
import { nodes, type NodeState } from './state.ts';
import { query } from './db.ts';
import { logger } from './log.ts';

const log = logger('vibe');

export const T = {
  lux: { bright: 20000, cloudy: 3000, dim: 50 },   // ≥ bright แดดจัด · ≥ cloudy แดดครึ้ม · ≥ dim รำไร · ต่ำกว่า = กลางคืน
  hotC: 30,                                         // ≥ ร้อน, ต่ำกว่า เย็น
  humidPct: 65,                                     // ≥ ชื้น, ต่ำกว่า แห้ง
  rainPct: 50,                                      // raindrop เปียก
  soilDryPct: 35,                                   // ดินแห้ง
};

export type Vibe = { icon: string; label: string; detail: string; mood: string; ts: string };

const MOOD_ICON: Record<string, string> = { happy: '🙂', hot: '🥵', sleepy: '😴', thirsty: '🥀', rain: '🌧', sick: '🤒' };
const vibes = new Map<string, Vibe>();
const plotOf = new Map<string, string>();                                            // cam node -> ชื่อแปลงล่าสุดที่ยังเปิดอยู่
const glanceOf = new Map<string, { caption: string; mood: string; ts: string }>();   // cam node -> ประโยคล่าสุดจากโหมดคิด

export function getVibe(node: string): Vibe | null { return vibes.get(node) ?? null; }
export function allVibes(): Record<string, Vibe> { return Object.fromEntries(vibes); }

const num = (n: NodeState, ...keys: string[]): number | null => { for (const k of keys) { const v = n.latest.get(k); if (v && Number.isFinite(v.value)) return v.value; } return null; };
const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

export function computeVibe(n: NodeState): Vibe {
  const ts = new Date().toISOString();
  if (!n.online) return { icon: '😵', label: 'ขาดการติดต่อ', detail: n.last_seen ? `เห็นล่าสุด ${new Date(n.last_seen).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}` : 'ยังไม่เคยเห็น', mood: 'sick', ts };

  if (n.role === 'cam') {
    const plot = plotOf.get(n.node); const g = glanceOf.get(n.node);
    const iv = Number(n.meta?.cam?.interval_s);
    return { icon: g ? MOOD_ICON[g.mood] || '👁' : '👁', label: plot ? `กำลังเฝ้ามอง ${plot}` : 'กำลังเฝ้ามอง', detail: g?.caption || (Number.isFinite(iv) ? `ถ่ายทุก ${Math.round(iv / 60)} นาที` : ''), mood: g?.mood || 'happy', ts };
  }

  // keeper / สวิตช์: ดูว่ามีอะไรเปิดอยู่
  const on = [...n.switches.entries()].filter(([, s]) => s.state === 'ON').map(([k]) => k);
  if (n.switches.size && n.latest.size === 0) {
    if (!on.length) return { icon: '😌', label: 'พักอยู่', detail: `สวิตช์ ${[...n.switches.keys()].join(', ')} ปิดหมด`, mood: 'happy', ts };
    const k = on[0];
    if (/fan|air|wind|blow/i.test(k)) return { icon: '🌬', label: 'พัดลมทำงาน', detail: on.join(', '), mood: 'fan', ts };
    if (/drip|water|pump|valve|mist|relay/i.test(k)) return { icon: '💧', label: 'กำลังรดน้ำ', detail: on.join(', '), mood: 'watering', ts };
    return { icon: '🔛', label: `${k} เปิดอยู่`, detail: on.join(', '), mood: 'happy', ts };
  }

  const lux = num(n, 'lux'); const temp = num(n, 'temp_c', 'dht_temp_c', 'bme_temp_c'); const rh = num(n, 'rh_pct', 'dht_rh_pct', 'bme_rh_pct');
  const rain = num(n, 'rain_pct');
  const soil = [...n.latest.entries()].filter(([k]) => k.endsWith('_pct') && !/^(rh|dht|bme|rain)/.test(k)).map(([k, v]) => ({ k, v: v.value }));
  const bits: string[] = [];
  if (temp !== null) bits.push(`${f1(temp)} °C`); if (rh !== null) bits.push(`ชื้น ${Math.round(rh)} %`); if (lux !== null) bits.push(`${Math.round(lux).toLocaleString('en-US')} lx`);
  for (const s of soil) bits.push(`ดิน ${Math.round(s.v)} %`);
  const detail = bits.join(' · ');

  if (rain !== null && rain >= T.rainPct) return { icon: '🌧', label: 'ฝนตก', detail, mood: 'rain', ts };
  const dry = soil.find((s) => s.v < T.soilDryPct);
  if (dry) return { icon: '🥀', label: 'ดินแห้ง กระหายน้ำ', detail, mood: 'thirsty', ts };

  if (lux !== null) {
    const sky = lux >= T.lux.bright ? ['☀️', 'แดดจัด'] : lux >= T.lux.cloudy ? ['⛅', 'แดดครึ้ม'] : lux >= T.lux.dim ? ['🌥', 'รำไร'] : ['🌙', 'กลางคืน'];
    const mood = lux < T.lux.dim ? 'sleepy' : temp !== null && temp >= T.hotC ? 'hot' : 'happy';
    return { icon: sky[0], label: sky[1] + (temp !== null && temp >= T.hotC ? ' ร้อน' : ''), detail, mood, ts };
  }
  if (temp !== null || rh !== null) {
    const hot = temp !== null ? temp >= T.hotC : null; const humid = rh !== null ? rh >= T.humidPct : null;
    const label = (hot === null ? '' : hot ? 'ร้อน' : 'เย็น') + (humid === null ? '' : humid ? 'ชื้น' : 'แห้ง');
    const icon = hot && humid ? '🥵' : hot ? '🔥' : humid ? '💧' : hot === false ? '🍃' : humid === false ? '🌵' : '🙂';
    return { icon, label: label || 'ปกติ', detail, mood: hot ? 'hot' : 'happy', ts };
  }
  return { icon: '🙂', label: 'ปกติ', detail: n.latest.size ? detail : 'ยังไม่มีเซ็นเซอร์', mood: 'happy', ts };
}

/** คำนวณใหม่ ถ้าเปลี่ยน (ไอคอน/คำ/รายละเอียด) → เก็บ + ประกาศทาง WS */
export function refreshVibe(node: string): void {
  const n = nodes.get(node); if (!n) { vibes.delete(node); return; }
  const v = computeVibe(n); const prev = vibes.get(node);
  if (prev && prev.icon === v.icon && prev.label === v.label && prev.detail === v.detail) return;
  vibes.set(node, v);
  bus.live({ type: 'vibe', node, ...v } as any);
}

async function loadPlots(): Promise<void> {
  try {
    const r = await query<{ cam_node: string; name: string }>(
      `SELECT DISTINCT ON (cam_node) cam_node, name FROM plots WHERE to_ts IS NULL OR to_ts > now() ORDER BY cam_node, created_at DESC`);
    plotOf.clear(); for (const p of r.rows) plotOf.set(p.cam_node, p.name);
  } catch (e) { log.warn('load plots', (e as Error).message); }
}

export async function startVibe(): Promise<void> {
  await loadPlots();
  try {
    const g = await query<{ node: string; caption: string; mood: string; ts: Date }>(`SELECT DISTINCT ON (node) node, caption, mood, ts FROM snapshots WHERE caption IS NOT NULL ORDER BY node, ts DESC`);
    for (const x of g.rows) glanceOf.set(x.node, { caption: x.caption, mood: x.mood, ts: x.ts.toISOString() });
  } catch (e) { log.warn('load glance', (e as Error).message); }
  for (const n of nodes.keys()) refreshVibe(n);
  bus.on('live', (m: any) => {
    switch (m.type) {
      case 'reading': case 'switch': case 'status': case 'debug': case 'node': refreshVibe(m.node); break;
      case 'glance': glanceOf.set(m.node, { caption: m.caption, mood: m.mood, ts: new Date().toISOString() }); refreshVibe(m.node); break;
      case 'plots': void loadPlots().then(() => { for (const n of nodes.values()) if (n.role === 'cam') refreshVibe(n.node); }); break;
    }
  });
  setInterval(() => { void loadPlots().then(() => { for (const n of nodes.keys()) refreshVibe(n); }); }, 60_000).unref();   // เผื่อ offline/timeout ที่ไม่มี event
  log.info(`started — ${vibes.size} nodes`);
}
