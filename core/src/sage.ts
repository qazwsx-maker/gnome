// Sage — ภูตนักปราชญ์: agent วิเคราะห์การเจริญเติบโตของต้นไม้จากภาพ Watcher + ข้อมูลสิ่งแวดล้อมที่ Hut เก็บ
//   plot  = ชื่อแปลง/กระถาง + กล้อง + node เซ็นเซอร์ + ช่วงเวลา
//   analysis = job: เลือกภาพ (≤ SAGE_MAX_FRAMES กระจายตามวัน) → ให้โมเดลดูทีละภาพพร้อมบริบทวัน/สภาพแวดล้อม → สังเคราะห์รายงาน
import type { FastifyInstance } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { logger } from './log.ts';
import { query } from './db.ts';
import { bus } from './bus.ts';

const log = logger('sage');

// ---------- schemas ----------
const Observation = z.object({
  stage: z.enum(['empty_soil', 'germinating', 'seedling', 'vegetative', 'budding', 'flowering', 'fruiting', 'declining', 'unknown']),
  plant_visible: z.boolean(),
  leaf_count: z.number().int().nullable().describe('จำนวนใบที่นับได้ (null ถ้านับไม่ได้)'),
  height_cm_est: z.number().nullable().describe('ความสูงโดยประมาณ (cm) เทียบกับกระถาง/วัตถุอ้างอิง'),
  bud_count: z.number().int(),
  flower_count: z.number().int(),
  health: z.enum(['good', 'mild_stress', 'wilting', 'pest_or_disease', 'unknown']),
  change_from_previous: z.string().describe('สิ่งที่เปลี่ยนจากภาพก่อนหน้า (สั้นๆ ภาษาไทย)'),
  notes: z.string().describe('ข้อสังเกตสั้นๆ ภาษาไทย'),
  confidence: z.number().min(0).max(1),
});
export type ObservationT = z.infer<typeof Observation>;

const Report = z.object({
  summary: z.string().describe('สรุปภาพรวมการเจริญเติบโตเป็นภาษาไทย 3-6 ประโยค'),
  milestones: z.array(z.object({
    date: z.string().describe('YYYY-MM-DD'),
    type: z.enum(['planted', 'germinated', 'first_true_leaves', 'leaf_count', 'first_bud', 'first_flower', 'peak_bloom', 'stress', 'recovery', 'other']),
    label: z.string().describe('ป้ายสั้นๆ ภาษาไทย เช่น "งอกแล้ว" "ใบจริงคู่แรก" "ใบ 6 ใบ"'),
    evidence: z.string().describe('หลักฐานจากภาพ/ข้อมูล'),
  })),
  growth_series: z.array(z.object({ date: z.string(), leaf_count: z.number().nullable(), height_cm: z.number().nullable() })),
  env_insights: z.array(z.string()).describe('ข้อสังเกตว่าอุณหภูมิ/ความชื้น/แสง/ดิน มีผลต่อการเติบโตอย่างไร (ภาษาไทย)'),
  recommendations: z.array(z.string()).describe('คำแนะนำการดูแลจากข้อมูล (ภาษาไทย)'),
  data_quality: z.string().describe('ข้อจำกัดของข้อมูล เช่น มุมกล้อง ภาพมืด ไม่มีเซ็นเซอร์'),
});
export type ReportT = z.infer<typeof Report>;

// ---------- providers ----------
type Provider = {
  observe(imageB64: string, prompt: string): Promise<{ obs: ObservationT; usage: [number, number] }>;
  synthesize(prompt: string): Promise<{ report: ReportT; usage: [number, number] }>;
  name: string; model: string;
};

function anthropicProvider(): Provider {
  const client = new Anthropic();   // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN จาก env (infra/.env)
  const model = config.sageModel;
  const effortOk = !/haiku/i.test(model);   // Haiku 4.5 ไม่รองรับ output_config.effort
  const system = 'คุณคือ Sage ภูตนักปราชญ์ของสวน GNOME ผู้เชี่ยวชาญด้านพืชสวน ตอบเป็นภาษาไทยที่กระชับ ตรงหลักฐานในภาพ ถ้าไม่แน่ใจให้บอกว่าไม่แน่ใจและลด confidence';
  return {
    name: 'anthropic', model,
    async observe(imageB64, prompt) {
      const r = await client.messages.parse({
        model, max_tokens: 2000,
        system,
        output_config: { format: zodOutputFormat(Observation), ...(effortOk ? { effort: 'medium' as const } : {}) },
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } }, { type: 'text', text: prompt }] }],
      });
      if (!r.parsed_output) throw new Error('observe: no parsed output (' + r.stop_reason + ')');
      return { obs: r.parsed_output, usage: [r.usage.input_tokens, r.usage.output_tokens] };
    },
    async synthesize(prompt) {
      const r = await client.messages.parse({
        model, max_tokens: 8000,
        system,
        output_config: { format: zodOutputFormat(Report), ...(effortOk ? { effort: 'high' as const } : {}) },
        messages: [{ role: 'user', content: prompt }],
      });
      if (!r.parsed_output) throw new Error('synthesize: no parsed output (' + r.stop_reason + ')');
      return { report: r.parsed_output, usage: [r.usage.input_tokens, r.usage.output_tokens] };
    },
  };
}

function ollamaProvider(): Provider {
  const model = config.ollamaModel;
  const chat = async (content: string, images?: string[]) => {
    const res = await fetch(`${config.ollamaUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, format: 'json', messages: [{ role: 'user', content, images }] }) });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    return { text: String(j.message?.content || ''), usage: [Number(j.prompt_eval_count || 0), Number(j.eval_count || 0)] as [number, number] };
  };
  return {
    name: 'ollama', model,
    async observe(imageB64, prompt) {
      const { text, usage } = await chat(prompt + '\n\nตอบเป็น JSON ตาม schema นี้เท่านั้น: ' + JSON.stringify(zodOutputFormat(Observation).schema), [imageB64]);
      return { obs: Observation.parse(JSON.parse(text)), usage };
    },
    async synthesize(prompt) {
      const { text, usage } = await chat(prompt + '\n\nตอบเป็น JSON ตาม schema นี้เท่านั้น: ' + JSON.stringify(zodOutputFormat(Report).schema));
      return { report: Report.parse(JSON.parse(text)), usage };
    },
  };
}

function provider(): Provider { return config.sageProvider === 'ollama' ? ollamaProvider() : anthropicProvider(); }
export function sageConfig() {
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return { provider: config.sageProvider, model: config.sageProvider === 'ollama' ? config.ollamaModel : config.sageModel, ready: config.sageProvider === 'ollama' || hasKey, maxFrames: config.sageMaxFrames };
}

// ---------- data ----------
type Frame = { id: number; ts: Date; path: string };
const fmtDay = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: config.tz }).format(d);   // YYYY-MM-DD
const fmtTime = (d: Date) => new Intl.DateTimeFormat('th-TH', { timeZone: config.tz, hour: '2-digit', minute: '2-digit' }).format(d);

/** เลือกภาพ: 1 ภาพ/วัน ใกล้เที่ยงที่สุด แล้วถ้ายังเกิน max ให้กระจายเท่าๆ กัน */
async function selectFrames(plot: any, max: number): Promise<Frame[]> {
  const r = await query<Frame>(
    `SELECT id, ts, path FROM snapshots WHERE node = $1 AND ($2::timestamptz IS NULL OR ts >= $2) AND ($3::timestamptz IS NULL OR ts <= $3)
       AND ($4::int IS NULL OR (angle IS NOT NULL AND abs(angle - $4) <= 5)) ORDER BY ts`,
    [plot.cam_node, plot.from_ts, plot.to_ts, plot.cam_angle]);
  const byDay = new Map<string, Frame[]>();
  for (const f of r.rows) { const d = fmtDay(f.ts); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d)!.push(f); }
  let picked: Frame[] = [];
  for (const [, fs] of byDay) {
    const noon = fs.map((f) => ({ f, d: Math.abs(((f.ts.getTime() / 3600000) % 24 + (config.tz === 'Asia/Bangkok' ? 7 : 0)) % 24 - 12.5) })).sort((a, b) => a.d - b.d)[0];
    picked.push(noon.f);
  }
  if (picked.length > max) { const step = picked.length / max; picked = Array.from({ length: max }, (_, i) => picked[Math.floor(i * step)]); }
  // ช่วงสั้น (วันน้อยกว่า max): กระจายภาพทั้งหมดเท่าๆ กันจนครบ max เพื่อให้เห็นการเปลี่ยนแปลงระหว่างวัน
  if (picked.length < Math.min(max, r.rows.length)) { const n = Math.min(max, r.rows.length); const step = r.rows.length / n; picked = Array.from({ length: n }, (_, i) => r.rows[Math.floor(i * step)]); }
  return picked;
}

/** สรุปสิ่งแวดล้อมรายวัน (avg/min/max) จาก readings_5m + readings (วันล่าสุด) */
async function envDaily(plot: any): Promise<any[]> {
  if (!plot.sensor_node) return [];
  const keys = ['temp_c', 'dht_temp_c', 'rh_pct', 'dht_rh_pct', 'lux', 'soil1_pct', 'soil2_pct', 'soil3_pct', 'rain_pct'];
  const r = await query<{ day: string; key: string; avg: number; min: number; max: number }>(
    `SELECT day, key, avg(avg) AS avg, min(min) AS min, max(max) AS max FROM (
       SELECT to_char(ts AT TIME ZONE $2, 'YYYY-MM-DD') AS day, key, avg, min, max FROM readings_5m WHERE node = $1 AND key = ANY($3)
       UNION ALL
       SELECT to_char(ts AT TIME ZONE $2, 'YYYY-MM-DD') AS day, key, value, value, value FROM readings WHERE node = $1 AND key = ANY($3) AND ts > now() - interval '2 days'
     ) x WHERE ($4::timestamptz IS NULL OR day >= to_char($4 AT TIME ZONE $2, 'YYYY-MM-DD')) AND ($5::timestamptz IS NULL OR day <= to_char($5 AT TIME ZONE $2, 'YYYY-MM-DD'))
     GROUP BY day, key ORDER BY day`, [plot.sensor_node, config.tz, keys, plot.from_ts, plot.to_ts]);
  const days = new Map<string, any>();
  for (const x of r.rows) {
    const d = days.get(x.day) || { date: x.day };
    const k = x.key === 'dht_temp_c' && d.temp_c !== undefined ? null : x.key === 'dht_rh_pct' && d.rh_pct !== undefined ? null : x.key.replace('dht_', '');
    if (k) d[k] = { avg: +Number(x.avg).toFixed(1), min: +Number(x.min).toFixed(1), max: +Number(x.max).toFixed(1) };
    days.set(x.day, d);
  }
  return [...days.values()];
}

const envLine = (e: any) => !e ? 'ไม่มีข้อมูลเซ็นเซอร์ของวันนี้' : [
  e.temp_c && `อุณหภูมิ ${e.temp_c.min}–${e.temp_c.max} °C (เฉลี่ย ${e.temp_c.avg})`,
  e.rh_pct && `ความชื้นอากาศ ${e.rh_pct.min}–${e.rh_pct.max} % (เฉลี่ย ${e.rh_pct.avg})`,
  e.lux && `แสงสูงสุด ${e.lux.max} lx (เฉลี่ย ${e.lux.avg})`,
  e.soil1_pct && `ความชื้นดิน ${e.soil1_pct.min}–${e.soil1_pct.max} %`,
  e.rain_pct && `ฝน/เปียก สูงสุด ${e.rain_pct.max} %`,
].filter(Boolean).join(' · ');

// ---------- job ----------
let running = false; const queue: number[] = [];

async function setProgress(id: number, patch: any, status?: string) {
  await query(`UPDATE analyses SET progress = progress || $2::jsonb ${status ? ', status = $3' : ''} WHERE id = $1`, status ? [id, JSON.stringify(patch), status] : [id, JSON.stringify(patch)]);
  bus.live({ type: 'sage', id, status, ...patch } as any);
}

async function runAnalysis(id: number): Promise<void> {
  const a = (await query<any>('SELECT a.*, p.name, p.cam_node, p.sensor_node, p.from_ts, p.to_ts, p.notes FROM analyses a JOIN plots p ON p.id = a.plot_id WHERE a.id = $1', [id])).rows[0];
  if (!a) return;
  const prov = provider();
  let tin = 0, tout = 0;
  try {
    await query('UPDATE analyses SET status = $2, provider = $3, model = $4 WHERE id = $1', [id, 'running', prov.name, prov.model]);
    const frames = await selectFrames(a, config.sageMaxFrames);
    const env = await envDaily(a);
    const envByDay = new Map(env.map((e: any) => [e.date, e]));
    await query('UPDATE analyses SET env = $2 WHERE id = $1', [id, JSON.stringify(env)]);
    if (frames.length === 0) throw new Error('ไม่มีภาพในช่วงเวลาที่เลือก');
    await setProgress(id, { step: 'observe', done: 0, total: frames.length }, 'running');
    const observations: any[] = [];
    let prev: ObservationT | null = null;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]; const abs = join(config.camDir, f.path);
      if (!existsSync(abs)) continue;
      const b64 = readFileSync(abs).toString('base64');
      const day = fmtDay(f.ts);
      const prompt = [
        `แปลง: "${a.name}"${a.notes ? ` (${a.notes})` : ''}`,
        `ภาพที่ ${i + 1}/${frames.length} ถ่ายวันที่ ${day} เวลา ${fmtTime(f.ts)}`,
        `สภาพแวดล้อมของวันนี้: ${envLine(envByDay.get(day))}`,
        prev ? `ภาพก่อนหน้า (${observations[observations.length - 1].date}): stage=${prev.stage}, ใบ=${prev.leaf_count ?? '?'}, สูง≈${prev.height_cm_est ?? '?'} cm, ดอก=${prev.flower_count}, health=${prev.health}` : 'นี่คือภาพแรกของชุด',
        'สังเกตต้นไม้ในภาพ (ถ้ามีหลายต้นให้ดูต้นหลักที่ใหญ่/ใกล้กล้องที่สุด) แล้วรายงานตาม schema นับใบเฉพาะที่เห็นชัด ประเมินความสูงจากสัดส่วนกับกระถาง',
      ].join('\n');
      const { obs, usage } = await prov.observe(b64, prompt);
      tin += usage[0]; tout += usage[1];
      observations.push({ snapshot_id: f.id, ts: f.ts.toISOString(), date: day, time: fmtTime(f.ts), url: `/cam/${f.path}`, ...obs });
      prev = obs;
      await query('UPDATE analyses SET frames = $2, tokens_in = $3, tokens_out = $4 WHERE id = $1', [id, JSON.stringify(observations), tin, tout]);
      await setProgress(id, { step: 'observe', done: i + 1, total: frames.length, last: { date: day, stage: obs.stage, leaf_count: obs.leaf_count } });
    }
    await setProgress(id, { step: 'synthesize' });
    const synthPrompt = [
      `แปลง "${a.name}" กล้อง ${a.cam_node}${a.sensor_node ? ` เซ็นเซอร์ ${a.sensor_node}` : ' (ไม่มีเซ็นเซอร์)'} ช่วง ${observations[0].date} ถึง ${observations[observations.length - 1].date} (${observations.length} ภาพ)${a.notes ? `\nโน้ตจากเจ้าของ: ${a.notes}` : ''}`,
      '', '## ข้อสังเกตรายภาพ (จากการดูภาพจริง)',
      ...observations.map((o) => `- ${o.date} ${o.time}: stage=${o.stage} plant=${o.plant_visible} leaves=${o.leaf_count ?? '?'} height≈${o.height_cm_est ?? '?'}cm buds=${o.bud_count} flowers=${o.flower_count} health=${o.health} conf=${o.confidence} | ${o.change_from_previous} | ${o.notes}`),
      '', '## สภาพแวดล้อมรายวัน',
      ...(env.length ? env.map((e: any) => `- ${e.date}: ${envLine(e)}`) : ['(ไม่มีข้อมูลเซ็นเซอร์)']),
      '', 'สร้างรายงานตาม schema: milestones ระบุวันที่จากข้อสังเกต (เช่น วันแรกที่ plant_visible, วันแรกที่มีใบจริง, วันที่จำนวนใบเพิ่ม, ดอกแรก) growth_series ให้ 1 จุดต่อวันที่มีภาพ env_insights เชื่อมโยงค่าสิ่งแวดล้อมกับการเปลี่ยนแปลง (ถ้าไม่มีข้อมูลให้บอกตรงๆ) recommendations เป็นสิ่งที่ทำได้จริงในสวนเล็ก',
    ].join('\n');
    const { report, usage } = await prov.synthesize(synthPrompt);
    tin += usage[0]; tout += usage[1];
    await query('UPDATE analyses SET status = $2, report = $3, tokens_in = $4, tokens_out = $5, finished_at = now() WHERE id = $1', [id, 'done', JSON.stringify(report), tin, tout]);
    await setProgress(id, { step: 'done', done: observations.length, total: observations.length }, 'done');
    log.info(`analysis ${id} done: ${observations.length} frames, tokens in=${tin} out=${tout}`);
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : (e as Error).message;
    log.error(`analysis ${id} failed`, msg);
    await query('UPDATE analyses SET status = $2, error = $3, finished_at = now() WHERE id = $1', [id, 'failed', msg]);
    await setProgress(id, { step: 'failed', error: msg }, 'failed');
  }
}

function pump() {
  if (running) return;
  const id = queue.shift(); if (id === undefined) return;
  running = true;
  runAnalysis(id).finally(() => { running = false; pump(); });
}

// ---------- routes ----------
export async function registerSage(app: FastifyInstance): Promise<void> {
  app.get('/api/sage/config', async () => sageConfig());

  app.get('/api/plots', async () => (await query<any>(
    `SELECT p.*, (SELECT count(*) FROM snapshots s WHERE s.node = p.cam_node AND (p.from_ts IS NULL OR s.ts >= p.from_ts) AND (p.to_ts IS NULL OR s.ts <= p.to_ts)
                    AND (p.cam_angle IS NULL OR (s.angle IS NOT NULL AND abs(s.angle - p.cam_angle) <= 5))) AS snapshots,
            (SELECT json_build_object('id', a.id, 'status', a.status, 'created_at', a.created_at, 'progress', a.progress) FROM analyses a WHERE a.plot_id = p.id ORDER BY a.created_at DESC LIMIT 1) AS last_analysis
       FROM plots p ORDER BY p.created_at DESC`)).rows);

  app.post<{ Body: { name?: string; cam_node?: string; sensor_node?: string; from?: string; to?: string; notes?: string; cam_angle?: number | string } }>('/api/plots', async (req, reply) => {
    const b = req.body || {};
    if (!b.name || !b.cam_node) return reply.code(400).send({ error: 'name และ cam_node จำเป็น' });
    const ang = b.cam_angle === '' || b.cam_angle === undefined || b.cam_angle === null ? null : Number(b.cam_angle);
    const r = await query<any>('INSERT INTO plots(name, cam_node, sensor_node, from_ts, to_ts, notes, cam_angle) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [b.name.trim(), b.cam_node, b.sensor_node || null, b.from || null, b.to || null, b.notes || null, Number.isFinite(ang as number) ? ang : null]);
    return r.rows[0];
  });

  app.delete<{ Params: { id: string } }>('/api/plots/:id', async (req) => { await query('DELETE FROM plots WHERE id = $1', [Number(req.params.id)]); return { ok: true }; });

  app.post<{ Params: { id: string } }>('/api/plots/:id/analyze', async (req, reply) => {
    const cfg = sageConfig();
    if (!cfg.ready) return reply.code(400).send({ error: 'ยังไม่ได้ตั้ง ANTHROPIC_API_KEY (หรือ SAGE_PROVIDER=ollama) ใน infra/.env' });
    const plot = (await query<any>('SELECT * FROM plots WHERE id = $1', [Number(req.params.id)])).rows[0];
    if (!plot) return reply.code(404).send({ error: 'plot not found' });
    const r = await query<any>('INSERT INTO analyses(plot_id, status) VALUES ($1, $2) RETURNING id', [plot.id, 'queued']);
    queue.push(r.rows[0].id); pump();
    return { ok: true, analysis_id: r.rows[0].id, queued: queue.length };
  });

  app.get<{ Params: { id: string } }>('/api/plots/:id/analyses', async (req) => (await query<any>(
    'SELECT id, status, provider, model, progress, created_at, finished_at, tokens_in, tokens_out, error FROM analyses WHERE plot_id = $1 ORDER BY created_at DESC', [Number(req.params.id)])).rows);

  app.get<{ Params: { id: string } }>('/api/analyses/:id', async (req, reply) => {
    const r = await query<any>('SELECT a.*, p.name, p.cam_node, p.sensor_node FROM analyses a JOIN plots p ON p.id = a.plot_id WHERE a.id = $1', [Number(req.params.id)]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'not found' });
    return r.rows[0];
  });

  app.delete<{ Params: { id: string } }>('/api/analyses/:id', async (req) => { await query('DELETE FROM analyses WHERE id = $1', [Number(req.params.id)]); return { ok: true }; });
}
