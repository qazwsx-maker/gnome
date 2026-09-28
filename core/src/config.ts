// Runtime config from environment (see infra/.env / infra/.env.example)
import os from 'node:os';

function lanIp(): string {
  for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : d;
}

export const config = {
  mqttHost: process.env.MQTT_HOST || '127.0.0.1',
  mqttPort: num(process.env.MQTT_PORT, 1883),
  mqttUser: process.env.MQTT_USER || 'gnome',
  mqttPass: process.env.MQTT_PASS || '',
  databaseUrl: process.env.DATABASE_URL || 'postgres://pichaya@localhost/gnome',
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',
  tz: process.env.TZ || 'Asia/Bangkok',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  publicDir: process.env.PUBLIC_DIR || new URL('../public/', import.meta.url).pathname,
  sqlDir: process.env.SQL_DIR || new URL('../sql/', import.meta.url).pathname,
  // Watcher snapshots on disk
  camDir: process.env.CAM_DIR || new URL('../../infra/data/cam/', import.meta.url).pathname,
  camFullDays: num(process.env.CAM_FULL_DAYS, 30),   // เก็บทุกภาพกี่วัน
  camKeepDays: num(process.env.CAM_KEEP_DAYS, 365),  // หลังจากนั้นเหลือ 1 ภาพ/ชม. จนถึงกี่วัน
  // OTA: firmware binaries served at /firmware/<env>/firmware.bin (default = docs/firmware in the repo)
  firmwareDir: process.env.FIRMWARE_DIR || new URL('../../docs/firmware/', import.meta.url).pathname,
  // URL nodes use to reach this server on the LAN
  publicUrl: (process.env.CORE_PUBLIC_URL || `http://${lanIp()}:${num(process.env.PORT, 8080)}`).replace(/\/$/, ''),

  // behaviour
  offlineAfterMs: num(process.env.OFFLINE_AFTER_S, 90) * 1000,
  healthTickMs: 10_000,
  rulesTickMs: 10_000,
  readingsFlushMs: 2_000,
  defaultCooldownS: 300,
  retentionRawDays: 14,
  retention5mDays: 365,
  retentionEventsDays: 90,
};
