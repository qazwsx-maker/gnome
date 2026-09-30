import { config } from './config.ts';
import { logger } from './log.ts';
import { discordSettings, inQuietHours } from './settings.ts';

const log = logger('discord');

/** หมวดของข้อความ — ใช้ตัดสินว่าผู้ใช้เปิดรับหมวดนี้ไหม */
export type DiscordCat = 'node' | 'sensor_error' | 'rule' | 'summary' | 'test';

/** หมวดที่เคารพช่วงห้ามรบกวน (สรุปรายวันกับกฎที่ผู้ใช้เขียนเองไม่ถูกกลั้น) */
const QUIETABLE: DiscordCat[] = ['node', 'sensor_error'];

export function webhookUrl(): string {
  return discordSettings().webhook_url || config.discordWebhookUrl || '';
}

/** เช็กว่าจะส่งข้อความหมวดนี้ไหม คืนเหตุผลเมื่อไม่ส่ง */
export function discordAllows(cat: DiscordCat): { ok: boolean; why?: string } {
  const s = discordSettings();
  if (cat !== 'test') {
    if (!s.enabled) return { ok: false, why: 'ปิดการแจ้งเตือนอยู่' };
    if (cat === 'node' && !s.node_status) return { ok: false, why: 'ปิดหมวดสถานะ node' };
    if (cat === 'sensor_error' && !s.sensor_error) return { ok: false, why: 'ปิดหมวดเซ็นเซอร์ผิดพลาด' };
    if (cat === 'rule' && !s.rules) return { ok: false, why: 'ปิดหมวดกฎอัตโนมัติ' };
    if (cat === 'summary' && !s.daily_summary) return { ok: false, why: 'ปิดสรุปประจำวัน' };
    if (QUIETABLE.includes(cat) && inQuietHours(s)) return { ok: false, why: 'อยู่ในช่วงห้ามรบกวน' };
  }
  if (!webhookUrl()) return { ok: false, why: 'ยังไม่ได้ตั้ง webhook' };
  return { ok: true };
}

/** POST ข้อความเข้า Discord webhook; ถ้ายังไม่ตั้งค่าไว้จะลง log เฉยๆ */
export async function discord(content: string, cat: DiscordCat = 'rule'): Promise<boolean> {
  const text = content.length > 1900 ? content.slice(0, 1897) + '...' : content;
  const gate = discordAllows(cat);
  if (!gate.ok) {
    log.info(`[${cat}/${gate.why}] ${text.replace(/\n/g, ' | ')}`);
    return false;
  }
  try {
    const res = await fetch(webhookUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) log.warn(`webhook ${res.status}: ${await res.text()}`);
    return res.ok;
  } catch (e) {
    log.error('webhook failed', (e as Error).message);
    return false;
  }
}
