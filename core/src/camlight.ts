// โปรไฟล์กล้องตามสถานะบ้าน (house.ts: เซ็นเซอร์ + ตำแหน่งดวงอาทิตย์) — Hut ส่ง cmd/img ให้ทุกกล้อง
//   ภาพ:  มืด (lux < NIGHT_LUX) หรือกลางคืน → โปรไฟล์ "night": xclk 10 MHz รับแสงนานขึ้น + ชดเชยแสง +2 + AEC DSP + สว่าง +1
//         (2026-10-25 ที่ 20 MHz ภาพค่ำมืดสนิท mean 9/255) · สว่าง → "day": xclk 20 MHz สีตรง ไม่มีชมพูกลางแดด
//   รอบถ่าย: ตามช่วงวันของบ้าน (กลางวัน/กลางคืน) ตั้งได้ที่การ์ดกล้อง — settings cam_schedule (ค่าเริ่ม 30 / 60 นาที)
//         firmware ≥ 0.8.19 รับ interval_s ใน cmd/img สดๆ · รุ่นเก่ากว่า → cmd/config (รีบูต 1 ครั้งต่อการสลับ)
// ความสว่างที่ผู้ใช้ปรับ (☀️) บวกทับโปรไฟล์เสมอ · ส่งซ้ำเมื่อกล้องบูตใหม่ · event `cam_profile`
import { bus } from './bus.ts';
import { nodes, recordEvent } from './state.ts';
import { sendCmd } from './mqtt.ts';
import { logger } from './log.ts';
import { camImageOffset, camSchedule } from './settings.ts';
import { houseState, onHouseChange, type House, type Phase } from './house.ts';

const log = logger('camlight');

export const PROFILES = {
  day: { xclk_mhz: 20, ae_level: 0, aec2: false, brightness: 0, gain_ceiling: 6, snap_flash: false },
  night: { xclk_mhz: 10, ae_level: 2, aec2: true, brightness: 1, gain_ceiling: 6, snap_flash: process.env.CAM_NIGHT_FLASH === '1' },
} as const;
export type Profile = keyof typeof PROFILES;

let current: Profile | null = null;
let currentPhase: Phase | null = null;

export function camLightState(): { profile: Profile | null; phase: Phase | null; lux: number | null } {
  return { profile: current, phase: currentPhase, lux: houseState()?.lux ?? null };
}
const clampB = (v: number) => Math.max(-2, Math.min(2, v));
/** ความสว่างที่ส่งให้กล้องจริง = โปรไฟล์ (กลางวัน 0 / กลางคืน +1) + ค่าที่ผู้ใช้ปรับ (จำไว้) · เซนเซอร์รับ −2..2 */
export function effectiveBrightness(node: string, profile: Profile | null = current): number {
  return clampB((profile ? PROFILES[profile].brightness : 0) + camImageOffset(node).brightness);
}
/** รอบถ่าย (วินาที) ตามช่วงวัน */
export function intervalFor(phase: Phase | null = currentPhase): number {
  const s = camSchedule(); return (phase === 'night' ? s.night_interval_min : s.day_interval_min) * 60;
}
/** ส่งความสว่างปัจจุบันให้กล้องทันที (หลังผู้ใช้กด ☀️) */
export async function pushBrightness(node: string): Promise<number> {
  const b = effectiveBrightness(node); await sendCmd(node, 'img', { brightness: b }); return b;
}

function camNodes(): string[] { return [...nodes.values()].filter((n) => n.role === 'cam').map((n) => n.node); }
const fwAtLeast = (fw: unknown, want: [number, number, number]) => {
  const m = String(fw ?? '').match(/(\d+)\.(\d+)\.(\d+)/); if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (v[i] !== want[i]) return v[i] > want[i];
  return true;
};

async function apply(why: string, only?: string): Promise<void> {
  if (!current) return;
  const iv = intervalFor();
  for (const node of only ? [only] : camNodes()) {
    try {
      await sendCmd(node, 'img', { ...PROFILES[current], brightness: effectiveBrightness(node), interval_s: iv });
      const n = nodes.get(node); const fwNew = fwAtLeast(n?.meta?.fw, [0, 8, 19]); const have = Number(n?.meta?.cam?.interval_s);
      if (!fwNew && have !== iv) {   // firmware เก่าไม่รู้จัก interval_s ใน cmd/img → ตั้งผ่าน config (กล้องรีบูต)
        await sendCmd(node, 'config', { interval_s: iv });
        log.info(`${node} interval ${have}→${iv}s via cmd/config (fw ${n?.meta?.fw ?? '?'} < 0.8.19 — reboots)`);
      }
      await recordEvent(node, 'cam_profile', { profile: current, phase: currentPhase, interval_s: iv, lux: houseState()?.lux ?? null, why });
      log.info(`${node} -> ${current} · ${currentPhase} every ${iv / 60} min (${why})`);
    } catch (e) { log.warn(`${node} apply ${current}: ${(e as Error).message}`); }
  }
}
/** เรียกเมื่อผู้ใช้เปลี่ยนรอบถ่ายบนการ์ด */
export function reapplyCamLight(why = 'schedule changed'): Promise<void> { return apply(why); }

function decide(h: House): { profile: Profile; phase: Phase } { return { profile: h.phase === 'night' || h.dark ? 'night' : 'day', phase: h.phase }; }

export function startCamLight(): void {
  const h0 = houseState();
  if (h0) { const d = decide(h0); current = d.profile; currentPhase = d.phase; setTimeout(() => void apply('start'), 15_000).unref(); }
  onHouseChange((h) => {
    const d = decide(h);
    if (d.profile !== current || d.phase !== currentPhase) { current = d.profile; currentPhase = d.phase; void apply(`${h.phase} · ${h.label} · lux ${h.lux ?? '?'} · sun ${h.sun_alt}°`); }
  });
  // กล้องบูตใหม่ → ส่งโปรไฟล์ + รอบถ่ายซ้ำ (หลัง 8 วิ ให้กล้องพร้อม)
  bus.on('live', (m: any) => {
    if (m.type === 'event' && m.type_ === 'boot' && current && nodes.get(m.node)?.role === 'cam') setTimeout(() => void apply('boot', m.node), 8_000).unref();
  });
  log.info(`started — ${current ?? 'undecided'} · ${currentPhase ?? '?'} · day every ${camSchedule().day_interval_min} min · night every ${camSchedule().night_interval_min} min`);
}
