// โปรไฟล์ภาพกล้องตามแสงจริง (lux จาก sky) — Hut เลือก "กลางวัน" / "กลางคืน" แล้วส่ง cmd/img ให้ทุกกล้อง
//   กลางวัน (lux สูง): xclk 20 MHz สีตรง ไม่มีชมพูกลางแดด · ชดเชยแสง 0
//   กลางคืน (lux ต่ำ): xclk 10 MHz เปิดรับแสงได้นานขึ้น + ชดเชยแสง +2 + AEC DSP + สว่าง +1 (2026-10-25 ที่ 20 MHz ภาพค่ำมืดสนิท mean 9/255)
// hysteresis: มืด < NIGHT_LUX → กลางคืน · สว่าง > DAY_LUX → กลางวัน · ระหว่างนั้นคงโปรไฟล์เดิม (ไม่สลับไปมาตอนโพล้เพล้)
// ส่งซ้ำเมื่อกล้องบูตใหม่ (ค่าจำใน NVS อยู่แล้ว แต่กันกรณีแฟลชใหม่) · บันทึกเป็น event `cam_profile` ให้เห็นในแท็บเหตุการณ์
import { bus } from './bus.ts';
import { nodes, recordEvent } from './state.ts';
import { sendCmd } from './mqtt.ts';
import { logger } from './log.ts';

const log = logger('camlight');

export const NIGHT_LUX = Number(process.env.CAM_NIGHT_LUX ?? 30);
export const DAY_LUX = Number(process.env.CAM_DAY_LUX ?? 80);
export const PROFILES = {
  day: { xclk_mhz: 20, ae_level: 0, aec2: false, brightness: 0, gain_ceiling: 6, snap_flash: false },
  night: { xclk_mhz: 10, ae_level: 2, aec2: true, brightness: 1, gain_ceiling: 6, snap_flash: process.env.CAM_NIGHT_FLASH === '1' },
} as const;
export type Profile = keyof typeof PROFILES;

let current: Profile | null = null;
let lastLux: number | null = null;

export function camLightState(): { profile: Profile | null; lux: number | null } { return { profile: current, lux: lastLux }; }

function camNodes(): string[] { return [...nodes.values()].filter((n) => n.role === 'cam').map((n) => n.node); }

async function apply(profile: Profile, why: string, only?: string): Promise<void> {
  const targets = only ? [only] : camNodes();
  for (const node of targets) {
    try {
      await sendCmd(node, 'img', { ...PROFILES[profile] });
      await recordEvent(node, 'cam_profile', { profile, lux: lastLux, why });
      log.info(`${node} -> ${profile} (${why}, lux ${lastLux ?? '?'})`);
    } catch (e) { log.warn(`${node} apply ${profile}: ${(e as Error).message}`); }
  }
}

function decide(lux: number): Profile | null {
  if (lux < NIGHT_LUX) return 'night';
  if (lux > DAY_LUX) return 'day';
  return null;   // โซนกลาง: คงเดิม
}

export function startCamLight(): void {
  // lux ล่าสุดที่มีอยู่แล้วตอนเริ่ม (Hut รีสตาร์ทกลางคืน)
  for (const n of nodes.values()) { const v = n.latest.get('lux'); if (v && Number.isFinite(v.value)) lastLux = v.value; }
  if (lastLux !== null) { const p = decide(lastLux); if (p) { current = p; setTimeout(() => void apply(p, 'start'), 15_000).unref(); } }
  bus.on('live', (m: any) => {
    if (m.type === 'reading' && m.key === 'lux' && Number.isFinite(m.value)) {
      lastLux = m.value; const p = decide(m.value);
      if (p && p !== current) { current = p; void apply(p, `lux ${Math.round(m.value)}`); }
    }
    // กล้องบูตใหม่ → ส่งโปรไฟล์ปัจจุบันซ้ำ (หลัง 8 วิ ให้กล้องพร้อม)
    if (m.type === 'event' && m.type_ === 'boot' && current && nodes.get(m.node)?.role === 'cam') { const p = current; setTimeout(() => void apply(p, 'boot', m.node), 8_000).unref(); }
  });
  log.info(`started — night < ${NIGHT_LUX} lx · day > ${DAY_LUX} lx · now ${current ?? 'undecided'} (lux ${lastLux ?? '?'})`);
}
