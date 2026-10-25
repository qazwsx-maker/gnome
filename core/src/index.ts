// gnome-core entrypoint
import { config } from './config.ts';
import { logger } from './log.ts';
import { waitForDb, migrate, pool } from './db.ts';
import { loadState, persistLastSeen } from './state.ts';
import { startMqtt, stopMqtt, healthTick } from './mqtt.ts';
import { reloadRules, startRules } from './rules.ts';
import { startRetention } from './retention.ts';
import { startHeartbeat } from './heartbeat.ts';
import { loadSettings } from './settings.ts';
import { startSonoff } from './sonoff.ts';
import { startVibe } from './vibe.ts';
import { startCamLight } from './camlight.ts';
import { startHttp } from './http.ts';

const log = logger('core');

async function main() {
  log.info(`gnome-core starting (node ${process.version}, tz ${config.tz})`);
  await waitForDb();
  await migrate();
  await loadSettings();
  await loadState();
  startMqtt();
  startSonoff();
  await reloadRules();
  startRules();
  startRetention();
  startHeartbeat();
  await startVibe();
  startCamLight();
  const app = await startHttp();

  setInterval(() => void healthTick(), config.healthTickMs).unref();
  setInterval(() => void persistLastSeen(), 30_000).unref();

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig} received, shutting down`);
    try {
      await persistLastSeen();
      await stopMqtt();
      await app.close();
      await pool.end();
    } catch (e) {
      log.error('shutdown', (e as Error).message);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (e) => log.error('unhandledRejection', e instanceof Error ? e.message : String(e)));

main().catch((e) => {
  log.error('fatal', e);
  process.exit(1);
});
