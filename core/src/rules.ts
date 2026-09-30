// Rules engine (docs/PLAN.md 2.4): rules stored as JSON in `rules`, evaluated every 10 s + on each reading/event.
//
// Rule JSON:
// { "name": "...", "cooldown_s": 300,
//   "trigger": { "type": "cron", "expr": "0 6 * * *", "tz": "Asia/Bangkok" }
//            | { "type": "threshold", "sensor": "node.key", "op": "<", "value": 40, "hysteresis": 5 }
//            | { "type": "node_offline", "node": "air" }            (node optional = any)
//            | { "type": "event", "event": "max_on_reached", "node": "water" } (node optional),
//   "conditions": [ { "sensor": "node.key", "op": "<", "value": 45 } ],
//   "actions": [ { "switch": "node.key", "state": "ON", "max_minutes": 8, "until": { "sensor": "node.key", "op": ">=", "value": 60 } },
//                { "discord": "รดน้ำเสร็จ {duration} นาที ดิน {ground.soil1_pct}%" },
//                { "notify": "..." } ] }
import { Cron } from 'croner';
import { config } from './config.ts';
import { logger } from './log.ts';
import { query } from './db.ts';
import { bus } from './bus.ts';
import { latestValue, nodes, recordEvent } from './state.ts';
import { sendSwitch } from './mqtt.ts';
import { discord } from './discord.ts';

const log = logger('rules');

export type Op = '<' | '<=' | '>' | '>=' | '==' | '!=';
export type Cond = { sensor: string; op: Op; value: number };
export type Trigger =
  | { type: 'cron'; expr: string; tz?: string }
  | { type: 'threshold'; sensor: string; op: Op; value: number; hysteresis?: number }
  | { type: 'node_offline'; node?: string }
  | { type: 'event'; event?: string; node?: string };
export type Action =
  | { switch: string; state: 'ON' | 'OFF'; max_minutes?: number; seconds?: number; until?: Cond }
  | { discord: string }
  | { notify: string };
export type RuleJson = {
  name?: string;
  cooldown_s?: number;
  trigger: Trigger;
  conditions?: Cond[];
  actions: Action[];
};
export type Rule = { id: number; name: string; enabled: boolean; json: RuleJson; last_fired: Date | null };

const OPS: Record<Op, (a: number, b: number) => boolean> = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

export function validateRule(j: any): string | null {
  if (!j || typeof j !== 'object') return 'rule json must be an object';
  const t = j.trigger;
  if (!t || typeof t !== 'object') return 'trigger required';
  switch (t.type) {
    case 'cron':
      if (typeof t.expr !== 'string') return 'trigger.expr required';
      try {
        new Cron(t.expr, { timezone: t.tz || config.tz, paused: true }).stop();
      } catch (e) {
        return `bad cron expr: ${(e as Error).message}`;
      }
      break;
    case 'threshold':
      if (typeof t.sensor !== 'string' || !t.sensor.includes('.')) return 'trigger.sensor must be "node.key"';
      if (!(t.op in OPS)) return 'trigger.op must be one of < <= > >= == !=';
      if (typeof t.value !== 'number') return 'trigger.value must be a number';
      break;
    case 'node_offline':
    case 'event':
      break;
    default:
      return `unknown trigger.type "${t.type}"`;
  }
  if (j.conditions !== undefined) {
    if (!Array.isArray(j.conditions)) return 'conditions must be an array';
    for (const c of j.conditions) {
      if (typeof c.sensor !== 'string' || !(c.op in OPS) || typeof c.value !== 'number') return 'bad condition (sensor/op/value)';
    }
  }
  if (!Array.isArray(j.actions) || j.actions.length === 0) return 'actions must be a non-empty array';
  for (const a of j.actions) {
    if ('switch' in a) {
      if (typeof a.switch !== 'string' || !a.switch.includes('.')) return 'action.switch must be "node.key"';
      if (a.state !== 'ON' && a.state !== 'OFF') return 'action.state must be ON or OFF';
      if (a.until && (typeof a.until.sensor !== 'string' || !(a.until.op in OPS) || typeof a.until.value !== 'number')) return 'bad until';
    } else if (!('discord' in a) && !('notify' in a)) return 'action must have switch, discord or notify';
  }
  return null;
}

// ---- runtime state --------------------------------------------------------

let rules: Rule[] = [];
const crons = new Map<number, Cron>();
const armed = new Map<number, boolean>(); // threshold edge state: true = may fire
const lastFired = new Map<number, number>();

type ActiveRun = {
  ruleId: number;
  node: string;
  key: string;
  until?: Cond;
  startedAt: number;
  deadline: number;
  after: Action[]; // discord/notify actions deferred until the run ends
  ctx: Record<string, string>;
};
const activeRuns: ActiveRun[] = [];

export function listRules(): Rule[] {
  return rules;
}

export function activeRunsJson() {
  return activeRuns.map((r) => ({
    rule_id: r.ruleId,
    switch: `${r.node}.${r.key}`,
    started_at: new Date(r.startedAt).toISOString(),
    deadline: new Date(r.deadline).toISOString(),
    until: r.until ?? null,
  }));
}

export async function reloadRules(): Promise<void> {
  const r = await query<Rule>('SELECT id, name, enabled, json, last_fired FROM rules ORDER BY id');
  rules = r.rows;
  for (const c of crons.values()) c.stop();
  crons.clear();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const t = rule.json.trigger;
    if (t?.type === 'cron') {
      try {
        crons.set(rule.id, new Cron(t.expr, { timezone: t.tz || config.tz }, () => void fire(rule, 'cron', {})));
      } catch (e) {
        log.error(`rule ${rule.id} cron`, (e as Error).message);
      }
    }
    if (!armed.has(rule.id)) armed.set(rule.id, true);
    if (rule.last_fired && !lastFired.has(rule.id)) lastFired.set(rule.id, rule.last_fired.getTime());
  }
  for (const id of [...armed.keys()]) if (!rules.some((r) => r.id === id)) armed.delete(id);
  log.info(`loaded ${rules.length} rules (${crons.size} cron)`);
  bus.live({ type: 'rules', ts: new Date().toISOString() });
}

// ---- evaluation -----------------------------------------------------------

function evalCond(c: Cond): boolean | null {
  const v = latestValue(c.sensor);
  if (!v) return null;
  return OPS[c.op](v.value, c.value);
}

function conditionsOk(rule: Rule): boolean {
  for (const c of rule.json.conditions ?? []) {
    if (evalCond(c) !== true) return false; // unknown sensor => not satisfied
  }
  return true;
}

/** Hysteresis re-arm: value must move back past threshold +/- hysteresis before the rule can fire again. */
function rearmed(t: Extract<Trigger, { type: 'threshold' }>, v: number): boolean {
  const h = Math.abs(t.hysteresis ?? 0);
  switch (t.op) {
    case '<':
    case '<=':
      return v >= t.value + h && (h > 0 || !OPS[t.op](v, t.value));
    case '>':
    case '>=':
      return v <= t.value - h && (h > 0 || !OPS[t.op](v, t.value));
    default:
      return !OPS[t.op](v, t.value);
  }
}

function evalThreshold(rule: Rule): void {
  const t = rule.json.trigger;
  if (t.type !== 'threshold') return;
  const v = latestValue(t.sensor);
  if (!v) return;
  const hit = OPS[t.op](v.value, t.value);
  const isArmed = armed.get(rule.id) ?? true;
  if (hit && isArmed) {
    armed.set(rule.id, false);
    void fire(rule, 'threshold', { [t.sensor]: fmt(v.value) });
  } else if (!hit && !isArmed && rearmed(t, v.value)) {
    armed.set(rule.id, true);
    log.info(`rule ${rule.id} "${rule.name}" re-armed (${t.sensor}=${fmt(v.value)})`);
  }
}

export function evalAll(onlySensor?: string): void {
  for (const rule of rules) {
    if (!rule.enabled || rule.json.trigger?.type !== 'threshold') continue;
    if (onlySensor && rule.json.trigger.sensor !== onlySensor) continue;
    evalThreshold(rule);
  }
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function render(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{([a-z0-9_.-]+)\}/gi, (m, ref: string) => {
    // dotted refs = live sensor values (so a post-run message shows the value now, not at trigger time)
    const v = ref.includes('.') ? latestValue(ref) : undefined;
    if (v) return fmt(v.value);
    if (ref in ctx) return ctx[ref];
    const short = ref.split('.').pop()!;
    for (const n of nodes.values()) {
      const l = n.latest.get(short);
      if (l) return fmt(l.value);
    }
    return m;
  });
}

async function fire(rule: Rule, via: string, ctx: Record<string, string>): Promise<void> {
  const now = Date.now();
  const cooldown = (rule.json.cooldown_s ?? config.defaultCooldownS) * 1000;
  const last = lastFired.get(rule.id) ?? 0;
  if (now - last < cooldown) {
    log.info(`rule ${rule.id} "${rule.name}" skipped (cooldown ${Math.round((cooldown - (now - last)) / 1000)} s left)`);
    return;
  }
  if (!conditionsOk(rule)) {
    log.info(`rule ${rule.id} "${rule.name}" trigger ${via} but conditions not met`);
    return;
  }
  lastFired.set(rule.id, now);
  await query('UPDATE rules SET last_fired = now() WHERE id = $1', [rule.id]).catch(() => {});
  log.info(`rule ${rule.id} "${rule.name}" fired via ${via}`);
  await recordEvent(null, 'rule_fired', { rule_id: rule.id, name: rule.name, via, ctx });
  ctx = { rule: rule.name, ...ctx };

  const deferred: Action[] = [];
  let run: ActiveRun | null = null;
  for (const a of rule.json.actions) {
    if ('switch' in a) {
      const [node, key] = a.switch.split('.');
      const seconds = a.seconds ?? (a.max_minutes ? a.max_minutes * 60 : undefined);
      try {
        await sendSwitch(node, key, a.state, a.state === 'ON' ? seconds : undefined, `rule:${rule.id}`);
      } catch (e) {
        log.error(`rule ${rule.id} switch`, (e as Error).message);
      }
      if (a.state === 'ON' && a.until) {
        // stop-point polling: OFF when `until` becomes true, or when the max time passes
        run = {
          ruleId: rule.id,
          node,
          key,
          until: a.until,
          startedAt: now,
          deadline: now + (seconds ?? 3600) * 1000,
          after: [],
          ctx,
        };
        activeRuns.push(run);
      } else {
        ctx.duration = a.max_minutes ? String(a.max_minutes) : seconds ? fmt(seconds / 60) : '';
      }
    } else {
      const text = 'discord' in a ? a.discord : a.notify;
      if (run) run.after.push(a);
      else deferred.push({ discord: text });
    }
  }
  for (const a of deferred) if ('discord' in a) await discord(render(a.discord, ctx), 'rule');
}

async function finishRun(run: ActiveRun, reason: string): Promise<void> {
  const idx = activeRuns.indexOf(run);
  if (idx >= 0) activeRuns.splice(idx, 1);
  const minutes = (Date.now() - run.startedAt) / 60000;
  const ctx = { ...run.ctx, duration: minutes < 1 ? minutes.toFixed(1) : fmt(Math.round(minutes * 10) / 10) };
  if (reason === 'until') {
    try {
      await sendSwitch(run.node, run.key, 'OFF', undefined, `rule:${run.ruleId}`);
    } catch (e) {
      log.error('finishRun OFF', (e as Error).message);
    }
  }
  log.info(`rule ${run.ruleId} run ${run.node}.${run.key} ended (${reason}, ${ctx.duration} min)`);
  await recordEvent(run.node, 'rule_run_end', { rule_id: run.ruleId, switch: run.key, reason, minutes: Number(ctx.duration) });
  for (const a of run.after) {
    const text = 'discord' in a ? a.discord : 'notify' in a ? a.notify : null;
    if (text) await discord(render(text, ctx), 'rule');
  }
}

/** Every 10 s: check `until` stop points and deadlines of active switch runs. */
async function pollRuns(): Promise<void> {
  const now = Date.now();
  for (const run of [...activeRuns]) {
    const sw = nodes.get(run.node)?.switches.get(run.key);
    if (sw && sw.state === 'OFF' && sw.ts > run.startedAt + 3000) {
      await finishRun(run, 'switched_off');
      continue;
    }
    if (run.until && evalCond(run.until) === true) {
      await finishRun(run, 'until');
      continue;
    }
    if (now >= run.deadline) await finishRun(run, 'max_time');
  }
}

// ---- wiring -----------------------------------------------------------------

export function startRules(): void {
  bus.on('reading', (m: { node: string; key: string }) => {
    const ref = `${m.node}.${m.key}`;
    evalAll(ref);
    // stop points react immediately to the sensor they watch
    for (const run of [...activeRuns]) if (run.until?.sensor === ref && evalCond(run.until) === true) void finishRun(run, 'until');
  });
  bus.on('node_offline', (node: string) => {
    for (const rule of rules) {
      const t = rule.json.trigger;
      if (rule.enabled && t?.type === 'node_offline' && (!t.node || t.node === node)) void fire(rule, 'node_offline', { node });
    }
  });
  bus.on('event', (ev: { node: string | null; type: string; payload: unknown }) => {
    for (const rule of rules) {
      const t = rule.json.trigger;
      if (!rule.enabled || t?.type !== 'event') continue;
      if (t.event && t.event !== ev.type) continue;
      if (t.node && t.node !== ev.node) continue;
      void fire(rule, 'event', { node: ev.node ?? '', event: ev.type });
    }
  });
  setInterval(() => {
    evalAll();
    void pollRuns();
  }, config.rulesTickMs).unref();
  log.info('engine started');
}
