// In-process event bus: MQTT ingest -> rules engine / websocket broadcast
import { EventEmitter } from 'node:events';

export type LiveMessage =
  | { type: 'reading'; node: string; key: string; value: number; ts: string }
  | { type: 'switch'; node: string; key: string; state: string; ts: string }
  | { type: 'status'; node: string; online: boolean; ts: string }
  | { type: 'event'; id?: number; node: string | null; type_: string; payload: unknown; ts: string }
  | { type: 'debug'; node: string; debug: Record<string, unknown>; ts: string }
  | { type: 'node'; node: string; ts: string }
  | { type: 'rules'; ts: string };

class Bus extends EventEmitter {
  live(msg: LiveMessage) {
    this.emit('live', msg);
  }
}

export const bus = new Bus();
bus.setMaxListeners(50);
