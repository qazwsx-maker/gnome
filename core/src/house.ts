// สถานะของบ้าน — ตัดสินที่เดียวจากเซ็นเซอร์ + ตำแหน่งดวงอาทิตย์ (เวลา) แล้วแจกให้ทั้งระบบ (กล้อง, การ์ด, กฎ)
//
// ช่วงวัน (phase):
//   ดวงอาทิตย์สูง ≥ +6°  → กลางวัน (แม้พายุทำให้มืด — เวลาเป็นตัวตัดสิน)
//   ดวงอาทิตย์ต่ำ < −6°  → กลางคืน (แม้มีไฟส่องเซ็นเซอร์)
//   ระหว่างนั้น (รุ่งเช้า/โพล้เพล้) → ใช้ lux ตัดสิน: > DAY_LUX กลางวัน · < NIGHT_LUX กลางคืน · กลางๆ คงเดิม
// สภาพฟ้า (sky) เฉพาะกลางวัน: เทียบ lux กับ "ฟ้าใส" ของเซ็นเซอร์ตัวนี้ที่มุมดวงอาทิตย์เดียวกัน
//   ฟ้าใส = เปอร์เซ็นไทล์ 95 ของ lux / sin(มุมสูง) ย้อนหลัง 14 วัน (เรียนรู้เอง — sky อยู่ในโดม/ร่มเงา ค่าสูงสุดแค่ ~3,000 lx)
//   r = lux / (ฟ้าใส × sin(มุมสูง)):  ≥ 0.6 แดดออก · ≥ 0.3 แดดอ่อน · < 0.3 แดดร่ม/ครึ้ม
//   ฝน: มีเซ็นเซอร์ rain_pct ≥ 50 → ฝนตก · ไม่มี → ครึ้มมาก (r < 0.2) + ความชื้น ≥ 90 % → "อาจมีฝน"
// ประกาศ WS `house` + event `house` เมื่อช่วงวันหรือสภาพฟ้าเปลี่ยน · GET /api/house
import { bus } from './bus.ts';
import { nodes, recordEvent } from './state.ts';
import { query } from './db.ts';
import { config } from './config.ts';
import { logger } from './log.ts';

const log = logger('house');

export const LAT = Number(process.env.HOUSE_LAT ?? 13.7563);     // กรุงเทพฯ (ตั้งเองได้ใน infra/.env)
export const LON = Number(process.env.HOUSE_LON ?? 100.5018);
export const NIGHT_LUX = Number(process.env.CAM_NIGHT_LUX ?? 30);
export const DAY_LUX = Number(process.env.CAM_DAY_LUX ?? 80);

export type Phase = 'day' | 'night';
export type Sky = 'sunny' | 'partly' | 'shade' | 'maybe_rain' | 'rain' | 'night' | 'twilight' | 'unknown';
export type House = {
  phase: Phase; sky: Sky; icon: string; label: string;
  sun_alt: number; lux: number | null; lux_10min: number | null; clear_lux: number | null; ratio: number | null; rain_pct: number | null; rh: number | null;
  sunrise: string | null; sunset: string | null; dark: boolean; ts: string;
};

const SKY_TH: Record<Sky, [string, string]> = {
  sunny: ['☀️', 'แดดออก'], partly: ['⛅', 'แดดอ่อน'], shade: ['🌥', 'แดดร่ม/ครึ้ม'], maybe_rain: ['🌦', 'ครึ้ม อาจมีฝน'], rain: ['🌧', 'ฝนตก'],
  night: ['🌙', 'กลางคืน'], twilight: ['🌆', 'โพล้เพล้'], unknown: ['❔', 'ไม่ทราบ'],
};

// ---- ตำแหน่งดวงอาทิตย์ (NOAA แบบย่อ — แม่นระดับ ±0.5° พอสำหรับงานนี้) ----
const rad = (d: number) => (d * Math.PI) / 180, deg = (r: number) => (r * 180) / Math.PI;
function solar(date: Date): { alt: number; declination: number; eqTime: number } {
  const jd = date.getTime() / 86400000 + 2440587.5, n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360, g = rad((357.528 + 0.9856003 * n) % 360);
  const lambda = rad(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)), eps = rad(23.439 - 0.0000004 * n);
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  let eqTime = 4 * deg(rad(L) - ra); eqTime = ((eqTime + 720) % 1440 + 1440) % 1440 - 720;   // นาที
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const ha = rad((utcMin + eqTime + 4 * LON) / 4 - 180);
  const alt = deg(Math.asin(Math.sin(rad(LAT)) * Math.sin(decl) + Math.cos(rad(LAT)) * Math.cos(decl) * Math.cos(ha)));
  return { alt, declination: decl, eqTime };
}
export function sunAltitude(date = new Date()): number { return solar(date).alt; }
/** เวลาขึ้น/ตก (มุม −0.833°) ของวันนี้ตามโซนเวลา Hut */
export function sunTimes(date = new Date()): { sunrise: Date; sunset: Date } | null {
  const { declination, eqTime } = solar(date);
  const cosH = (Math.sin(rad(-0.833)) - Math.sin(rad(LAT)) * Math.sin(declination)) / (Math.cos(rad(LAT)) * Math.cos(declination));
  if (cosH < -1 || cosH > 1) return null;
  const H = deg(Math.acos(cosH)), noonUtcMin = 720 - 4 * LON - eqTime;
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return { sunrise: new Date(day.getTime() + (noonUtcMin - 4 * H) * 60000), sunset: new Date(day.getTime() + (noonUtcMin + 4 * H) * 60000) };
}

// ---- ฟ้าใสของเซ็นเซอร์ตัวนี้ (เรียนรู้จากประวัติ) ----
let clearK: number | null = null;   // lux ที่ sin(alt) = 1 ตอนฟ้าใส
async function learnClearSky(): Promise<void> {
  try {
    const r = await query<{ ts: Date; value: number }>(`SELECT ts, value FROM readings WHERE key = 'lux' AND ts > now() - interval '14 days' AND value > 0`);
    const ks = r.rows.map((x) => ({ s: Math.sin(rad(sunAltitude(x.ts))), v: x.value })).filter((x) => x.s > Math.sin(rad(15))).map((x) => x.v / x.s).sort((a, b) => a - b);
    if (ks.length >= 100) { clearK = ks[Math.floor(ks.length * 0.95)]; log.info(`clear-sky reference ${Math.round(clearK)} lx × sin(alt) from ${ks.length} samples`); }
  } catch (e) { log.warn('learn clear sky', (e as Error).message); }
}

// ---- อ่านค่าล่าสุดจากทุก node (ไม่ผูกกับชื่อ node) ----
const FRESH_MS = 15 * 60_000;
function latest(...keys: string[]): number | null {
  let best: { v: number; ts: number } | null = null;
  for (const n of nodes.values()) for (const k of keys) {
    const v = n.latest.get(k); if (!v || !Number.isFinite(v.value)) continue;
    const ts = typeof v.ts === 'number' ? v.ts : Date.parse(String(v.ts));
    if (Date.now() - ts > FRESH_MS) continue;
    if (!best || ts > best.ts) best = { v: v.value, ts };
  }
  return best ? best.v : null;
}

let state: House | null = null;
let phase: Phase | null = null;
// ทำให้นิ่ง: เมฆลอยผ่านทำให้ lux แกว่งทุกนาที → ใช้มัธยฐาน lux 10 นาทีล่าสุด + ขอบเข้า/ออกห่างกัน (hysteresis)
// (2026-11-02 11:34–11:58 สลับ แดดออก⇄แดดอ่อน 8 ครั้งใน 25 นาที)
const SMOOTH_MS = 10 * 60_000;
const luxWin: { ts: number; v: number }[] = [];
function smoothLux(raw: number | null): number | null {
  const now = Date.now();
  if (raw !== null && (!luxWin.length || luxWin[luxWin.length - 1].v !== raw || now - luxWin[luxWin.length - 1].ts > 30_000)) luxWin.push({ ts: now, v: raw });
  while (luxWin.length && now - luxWin[0].ts > SMOOTH_MS) luxWin.shift();
  if (!luxWin.length) return raw;
  const a = luxWin.map((x) => x.v).sort((x, y) => x - y); return a[Math.floor(a.length / 2)];
}
// ขอบของแต่ละระดับ: [เข้าเมื่อ ≥, ออกเมื่อ <]
const BAND = { sunny: [0.65, 0.55], partly: [0.33, 0.27] } as const;
function skyFromRatio(r: number, prev: Sky | undefined): Sky {
  if (prev === 'sunny') return r >= BAND.sunny[1] ? 'sunny' : r >= BAND.partly[0] ? 'partly' : 'shade';
  if (prev === 'partly') return r >= BAND.sunny[0] ? 'sunny' : r >= BAND.partly[1] ? 'partly' : 'shade';
  if (prev === 'shade' || prev === 'maybe_rain') return r >= BAND.sunny[0] ? 'sunny' : r >= BAND.partly[0] ? 'partly' : 'shade';
  return r >= 0.6 ? 'sunny' : r >= 0.3 ? 'partly' : 'shade';
}
export function houseState(): House | null { return state; }

export function computeHouse(now = new Date()): House {
  const alt = sunAltitude(now), rawLux = latest('lux'), lux = smoothLux(rawLux), rain = latest('rain_pct'), rh = latest('rh_pct', 'dht_rh_pct', 'bme_rh_pct');
  // ช่วงวัน: เวลาเป็นหลัก แสงตัดสินช่วงรอยต่อ (hysteresis)
  let p: Phase;
  if (alt >= 6) p = 'day';
  else if (alt < -6) p = 'night';
  else if (lux !== null && lux > DAY_LUX) p = 'day';
  else if (lux !== null && lux < NIGHT_LUX) p = 'night';
  else p = phase ?? (alt >= 0 ? 'day' : 'night');
  const clear = clearK && alt > 0 ? clearK * Math.sin(rad(alt)) : null;
  const ratio = lux !== null && clear ? lux / clear : null;
  let sky: Sky;
  if (rain !== null && rain >= 50) sky = 'rain';
  else if (p === 'night') sky = 'night';
  else if (alt < 6) sky = 'twilight';
  else if (ratio === null) sky = 'unknown';
  else if (ratio < 0.2 && rh !== null && rh >= 90) sky = 'maybe_rain';
  else sky = skyFromRatio(ratio, state?.sky);
  const t = sunTimes(now), fmt = (d?: Date) => (d ? d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: config.tz }) : null);
  return {
    phase: p, sky, icon: SKY_TH[sky][0], label: SKY_TH[sky][1],
    sun_alt: Math.round(alt * 10) / 10, lux: rawLux, lux_10min: lux, clear_lux: clear ? Math.round(clear) : null, ratio: ratio !== null ? Math.round(ratio * 100) / 100 : null,
    rain_pct: rain, rh, sunrise: fmt(t?.sunrise), sunset: fmt(t?.sunset), dark: lux !== null ? lux < NIGHT_LUX : p === 'night', ts: now.toISOString(),
  };
}

type Listener = (h: House, prev: House | null) => void;
const listeners: Listener[] = [];
/** ฟังเมื่อช่วงวัน/สภาพฟ้า/ความมืดเปลี่ยน (camlight ใช้สลับโปรไฟล์ภาพและรอบถ่าย) */
export function onHouseChange(fn: Listener): void { listeners.push(fn); }

function refresh(why: string): void {
  const h = computeHouse(); const prev = state;
  state = h; phase = h.phase;
  if (prev && prev.phase === h.phase && prev.sky === h.sky && prev.dark === h.dark) return;
  log.info(`${h.phase} · ${h.label} · sun ${h.sun_alt}° · lux ${h.lux ?? '?'}${h.ratio !== null ? ` (r ${h.ratio})` : ''} — ${why}`);
  bus.live({ type: 'house', ...h } as any);
  if (prev) void recordEvent(null, 'house', { phase: h.phase, sky: h.sky, label: h.label, sun_alt: h.sun_alt, lux: h.lux, ratio: h.ratio, why });
  for (const fn of listeners) { try { fn(h, prev); } catch (e) { log.warn('listener', (e as Error).message); } }
}

export async function startHouse(): Promise<void> {
  await learnClearSky();
  try {   // เติมหน้าต่าง 10 นาทีจากฐานข้อมูล ไม่ให้เริ่มจากค่าเดียวหลัง Hut รีสตาร์ท
    const r = await query<{ ts: Date; value: number }>(`SELECT ts, value FROM readings WHERE key = 'lux' AND ts > now() - interval '10 minutes' ORDER BY ts`);
    for (const x of r.rows) luxWin.push({ ts: x.ts.getTime(), v: x.value });
  } catch (e) { log.warn('seed lux window', (e as Error).message); }
  refresh('start');
  bus.on('live', (m: any) => { if (m.type === 'reading' && ['lux', 'rain_pct', 'rh_pct', 'dht_rh_pct', 'bme_rh_pct'].includes(m.key)) refresh(`${m.key} ${Math.round(m.value)}`); });
  setInterval(() => refresh('clock'), 60_000).unref();                 // ดวงอาทิตย์เคลื่อนแม้ไม่มีค่าใหม่
  setInterval(() => void learnClearSky(), 6 * 3600_000).unref();
  const t = sunTimes();
  log.info(`started — ${LAT},${LON} · sunrise ${state?.sunrise} sunset ${state?.sunset}${t ? '' : ' (polar?)'} · now ${state?.phase} ${state?.label}`);
}
