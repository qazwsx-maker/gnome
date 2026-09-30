// ค่าตั้งที่แก้ได้จากหน้าเว็บ เก็บในตาราง settings และ cache ไว้ในหน่วยความจำ
import { query } from './db.ts';
import { config } from './config.ts';
import { logger } from './log.ts';

const log = logger('settings');

export type DiscordSettings = {
  enabled: boolean;
  webhook_url: string;
  node_status: boolean;
  /** รอให้สถานะนิ่งกี่วินาทีก่อนแจ้ง — กันสแปมตอน node กระพริบ (0 = แจ้งทันที) */
  node_debounce_s: number;
  sensor_error: boolean;
  rules: boolean;
  daily_summary: boolean;
  /** เวลาสรุปประจำวัน HH:MM ตามโซนเวลาของ Hut */
  summary_time: string;
  /** ช่วงเวลาที่ไม่อยากถูกรบกวน (เฉพาะ node/sensor_error) — null = ไม่ตั้ง */
  quiet_start: string | null;
  quiet_end: string | null;
};

const DISCORD_DEFAULTS: DiscordSettings = {
  enabled: false,
  webhook_url: config.discordWebhookUrl,
  node_status: true,
  node_debounce_s: 180,
  sensor_error: true,
  rules: true,
  daily_summary: true,
  summary_time: '07:00',
  quiet_start: null,
  quiet_end: null,
};

const cache = new Map<string, any>();

export async function loadSettings(): Promise<void> {
  try {
    const r = await query<{ key: string; value: any }>('SELECT key, value FROM settings');
    cache.clear();
    for (const row of r.rows) cache.set(row.key, row.value);
    log.info(`loaded ${cache.size} key(s)`);
  } catch (e) {
    log.error('load failed', (e as Error).message);
  }
}

export function discordSettings(): DiscordSettings {
  const s = { ...DISCORD_DEFAULTS, ...(cache.get('discord') || {}) } as DiscordSettings;
  // เผื่อค่าเพี้ยนจาก client
  if (!Number.isFinite(s.node_debounce_s) || s.node_debounce_s < 0) s.node_debounce_s = 0;
  s.node_debounce_s = Math.min(3600, Math.floor(s.node_debounce_s));
  if (!/^\d{1,2}:\d{2}$/.test(s.summary_time)) s.summary_time = '07:00';
  return s;
}

export async function saveDiscordSettings(patch: Partial<DiscordSettings>): Promise<DiscordSettings> {
  const next = { ...discordSettings(), ...patch };
  await query(
    `INSERT INTO settings(key, value) VALUES ('discord', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(next)],
  );
  cache.set('discord', next);
  return next;
}

/** true เมื่ออยู่ในช่วงห้ามรบกวน (รองรับช่วงที่คร่อมเที่ยงคืน) */
export function inQuietHours(s: DiscordSettings, now = new Date()): boolean {
  if (!s.quiet_start || !s.quiet_end) return false;
  const hhmm = now.toLocaleTimeString('en-GB', { timeZone: config.tz, hour: '2-digit', minute: '2-digit' });
  const a = s.quiet_start, b = s.quiet_end;
  return a <= b ? hhmm >= a && hhmm < b : hhmm >= a || hhmm < b;
}

// ---- โหมดคิดของ Watcher ----------------------------------------------------
export type GlanceSettings = {
  enabled: boolean;
  /** node กล้องที่เปิดโหมดคิด (ว่าง = ไม่เปิดกับใครเลย) */
  nodes: string[];
  /** เว้นอย่างน้อยกี่วินาทีระหว่างการคิดสองครั้งของ node เดียวกัน — คุมค่าโมเดล */
  min_gap_s: number;
  /** ข้อความอยู่บนจอได้นานแค่ไหน */
  ttl_s: number;
};

const GLANCE_DEFAULTS: GlanceSettings = { enabled: false, nodes: [], min_gap_s: 900, ttl_s: 1800 };

export function glanceSettings(): GlanceSettings {
  const s = { ...GLANCE_DEFAULTS, ...(cache.get('glance') || {}) } as GlanceSettings;
  if (!Array.isArray(s.nodes)) s.nodes = [];
  s.nodes = s.nodes.filter((n) => typeof n === 'string').slice(0, 8);
  for (const k of ['min_gap_s', 'ttl_s'] as const) {
    const v = Number(s[k]);
    s[k] = Number.isFinite(v) && v > 0 ? Math.floor(v) : GLANCE_DEFAULTS[k];
  }
  s.min_gap_s = Math.min(86400, Math.max(30, s.min_gap_s));
  s.ttl_s = Math.min(86400, Math.max(60, s.ttl_s));
  return s;
}

export async function saveGlanceSettings(patch: Partial<GlanceSettings>): Promise<GlanceSettings> {
  const next = { ...glanceSettings(), ...patch };
  await query(
    `INSERT INTO settings(key, value) VALUES ('glance', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(next)],
  );
  cache.set('glance', next);
  return next;
}
