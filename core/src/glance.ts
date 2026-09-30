// โหมดคิดของ Watcher: ทุกครั้งที่ภาพใหม่เข้ามา ให้โมเดลดูภาพแล้วบอกสั้นๆ ว่าเห็นอะไร
// ส่งข้อความกลับไปขึ้นจอ OLED ของ node พร้อมกำหนดอารมณ์บนหน้าภูต
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config } from './config.ts';
import { logger } from './log.ts';
import { query } from './db.ts';
import { bus } from './bus.ts';
import { sendCmd } from './mqtt.ts';
import { glanceSettings } from './settings.ts';

const log = logger('glance');

/** อารมณ์ที่จอของ node รองรับ (ตรงกับ moodFromName ใน firmware) */
export const MOODS = ['happy', 'hot', 'sleepy', 'thirsty', 'rain', 'sick'] as const;

const Glance = z.object({
  caption: z.string().describe('One short English line describing what is visible, at most 8 words, no trailing period. Example: "gerbera buds opening, leaves look healthy"'),
  mood: z.enum(MOODS).describe('happy = plant looks fine · hot = harsh sun/scorched · sleepy = dark or night · thirsty = wilting or dry soil · rain = wet, raindrops · sick = pest, disease, dying'),
});
export type GlanceT = z.infer<typeof Glance>;

const SYSTEM = [
  'You are the eye of GNOME, a home flower-garden camera in Bangkok.',
  'You look at one photo from the garden and report what you see in one short English line.',
  'Write plainly, like a note to the gardener. No preamble, no punctuation at the end.',
  'The caption is shown on a tiny 128x64 monochrome screen, so keep it under 60 characters.',
  'If the photo is too dark or blurred to judge, say so and use mood "sleepy".',
].join(' ');

const lastAt = new Map<string, number>();   // node -> เวลาที่คิดครั้งล่าสุด
let busy = false;                            // ทำทีละใบ ไม่ต่อคิว ภาพใหม่มาระหว่างคิดก็ข้ามไป

export function glanceReady(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** node นี้ควรคิดกับภาพใบนี้ไหม (ดูทั้งการตั้งค่า เวลาที่เว้น และคิวที่ว่าง) */
function shouldGlance(node: string): boolean {
  const s = glanceSettings();
  if (!s.enabled || !s.nodes.includes(node)) return false;
  if (!glanceReady()) return false;
  if (busy) return false;
  const prev = lastAt.get(node) || 0;
  return Date.now() - prev >= s.min_gap_s * 1000;
}

async function ask(imageB64: string): Promise<{ g: GlanceT; usage: [number, number] }> {
  const client = new Anthropic();
  const model = config.sageModel;
  const effortOk = !/haiku/i.test(model);    // Haiku 4.5 ไม่รองรับ output_config.effort
  const r = await client.messages.parse({
    model, max_tokens: 300,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(Glance), ...(effortOk ? { effort: 'low' as const } : {}) },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
        { type: 'text', text: 'What do you see in the garden right now?' },
      ],
    }],
  });
  if (!r.parsed_output) throw new Error('no parsed output (' + r.stop_reason + ')');
  return { g: r.parsed_output, usage: [r.usage.input_tokens, r.usage.output_tokens] };
}

/**
 * เรียกหลังบันทึกภาพใหม่ — ไม่ await ตรงจุดเรียก เพราะกินเวลาหลายวินาที
 * ผลลัพธ์: เขียน caption/mood ลง DB, ส่ง cmd/glance ให้ node, แจ้งหน้าเว็บ
 */
export function glanceOnSnapshot(node: string, id: number, relPath: string): void {
  if (!shouldGlance(node)) return;
  busy = true;
  lastAt.set(node, Date.now());
  void (async () => {
    const t0 = Date.now();
    try {
      const abs = join(config.camDir, relPath);
      if (!existsSync(abs)) throw new Error('ไม่พบไฟล์ภาพ');
      const { g, usage } = await ask(readFileSync(abs).toString('base64'));
      const caption = g.caption.trim().slice(0, 60);
      await query('UPDATE snapshots SET caption = $2, mood = $3 WHERE id = $1', [id, caption, g.mood]);
      const ttl = glanceSettings().ttl_s;
      await sendCmd(node, 'glance', { text: caption, mood: g.mood, ttl_s: ttl });
      bus.live({ type: 'glance', node, id, caption, mood: g.mood } as any);
      log.info(`${node} #${id} "${caption}" (${g.mood}) · ${usage[0]}+${usage[1]} tok · ${Date.now() - t0}ms`);
    } catch (e) {
      const msg = e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : (e as Error).message;
      log.warn(`${node} #${id} ล้มเหลว: ${msg}`);
    } finally {
      busy = false;
    }
  })();
}

/** ล้างข้อความบนจอของ node (ใช้ตอนปิดโหมดคิด) */
export async function clearGlance(node: string): Promise<void> {
  await sendCmd(node, 'glance', { text: '', ttl_s: 0 });
}
