// Runtime config from environment (see infra/.env / infra/.env.example)

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
