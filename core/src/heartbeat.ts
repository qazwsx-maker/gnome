// Daily 07:00 (Asia/Bangkok) Discord summary
import { Cron } from 'croner';
import { config } from './config.ts';
import { logger } from './log.ts';
import { query } from './db.ts';
import { nodes } from './state.ts';
import { discord } from './discord.ts';

const log = logger('heartbeat');

const LABELS: Record<string, string> = { temp_c: 'อุณหภูมิ', rh_pct: 'ความชื้นอากาศ', lux: 'แสง', press_hpa: 'ความดัน', dht_temp_c: 'อุณหภูมิ(DHT)', dht_rh_pct: 'ความชื้น(DHT)' };

function label(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const m = key.match(/^soil(\d+)_pct$/);
  if (m) return `ดิน${m[1]}`;
  return key;
}

function unit(key: string): string {
  if (key.endsWith('_c')) return '°C';
  if (key.endsWith('_pct')) return '%';
  if (key === 'lux') return ' lx';
  if (key === 'press_hpa') return ' hPa';
  return '';
}

export async function buildSummary(): Promise<string> {
  const all = [...nodes.values()];
  const on = all.filter((n) => n.online).map((n) => n.node);
  const off = all.filter((n) => !n.online).map((n) => n.node);
  const lines: string[] = [];
  const date = new Date().toLocaleDateString('th-TH', { timeZone: config.tz, day: 'numeric', month: 'short', year: 'numeric' });
  lines.push(`🌱 **GNOME สรุปประจำวัน ${date}**`);
  lines.push(`โหนดออนไลน์ ${on.length}/${all.length}${off.length ? ` — ออฟไลน์: ${off.join(', ')}` : ''}`);

  const stats = await query<{ node: string; key: string; min: number; max: number; avg: number }>(
    `SELECT node, key, min(value) AS min, max(value) AS max, avg(value) AS avg
       FROM readings WHERE ts > now() - interval '24 hours'
        AND (key LIKE '%temp_c' OR key LIKE '%rh_pct' OR key LIKE 'soil%_pct' OR key = 'lux')
      GROUP BY node, key ORDER BY node, key`,
  );
  for (const s of stats.rows) {
    const u = unit(s.key);
    lines.push(`• ${s.node} ${label(s.key)}: ${Number(s.min).toFixed(1)}–${Number(s.max).toFixed(1)}${u} (เฉลี่ย ${Number(s.avg).toFixed(1)}${u})`);
  }

  const runs = await query<{ node: string; key: string; n: string }>(
    `SELECT node, key, count(*) AS n FROM switch_log
      WHERE ts > now() - interval '24 hours' AND state = 'ON' AND source = 'node'
      GROUP BY node, key ORDER BY node, key`,
  );
  if (runs.rows.length) lines.push(`💧 เปิดสวิตช์ 24 ชม.: ${runs.rows.map((r) => `${r.node}.${r.key} ×${r.n}`).join(', ')}`);
  else lines.push('💧 ไม่มีการเปิดสวิตช์ใน 24 ชม.');

  const ev = await query<{ type: string; n: string }>(
    `SELECT type, count(*) AS n FROM events WHERE ts > now() - interval '24 hours'
        AND type IN ('max_on_reached','failsafe_off','sensor_error','node_offline','interlock_blocked')
      GROUP BY type ORDER BY n DESC`,
  );
  if (ev.rows.length) lines.push(`⚠️ เหตุการณ์: ${ev.rows.map((e) => `${e.type} ×${e.n}`).join(', ')}`);
  return lines.join('\n');
}

export function startHeartbeat(): void {
  new Cron('0 7 * * *', { timezone: config.tz }, async () => {
    try {
      await discord(await buildSummary());
    } catch (e) {
      log.error('summary failed', (e as Error).message);
    }
  });
  log.info(`daily summary scheduled 07:00 ${config.tz}`);
}
