import { config } from './config.ts';
import { logger } from './log.ts';

const log = logger('discord');

/** POST a message to the Discord webhook; logs to console with [discord] when no URL configured. */
export async function discord(content: string): Promise<boolean> {
  const text = content.length > 1900 ? content.slice(0, 1897) + '...' : content;
  if (!config.discordWebhookUrl) {
    log.info(text.replace(/\n/g, ' | '));
    return false;
  }
  try {
    const res = await fetch(config.discordWebhookUrl, {
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
