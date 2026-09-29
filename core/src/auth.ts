// Login สำหรับการเข้าจากนอกบ้าน (ผ่าน Cloudflare Tunnel) — ในบ้าน (LAN) ไม่ต้อง login
// session = cookie hut_session ลงนามด้วย HUT_SESSION_SECRET · รหัสผ่านใน HUT_PASSWORD (infra/.env)
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { logger } from './log.ts';

const log = logger('auth');
const COOKIE = 'hut_session';
const SESSION_DAYS = 30;
const fails = new Map<string, { n: number; until: number }>();

const isPrivateIp = (ip: string) => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|::ffff:(127\.|10\.|192\.168\.))/.test(ip);
export function isExternal(req: FastifyRequest): boolean {
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return true;   // มาจาก Cloudflare Tunnel
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return !isPrivateIp(xf || req.ip);
}
const clientIp = (req: FastifyRequest) => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip).split(',')[0].trim();

function sign(exp: number): string { const p = String(exp); return p + '.' + createHmac('sha256', config.hutSessionSecret).update(p).digest('base64url'); }
function verify(token: string | undefined): boolean {
  if (!token || !config.hutSessionSecret) return false;
  const [p, sig] = token.split('.'); if (!p || !sig) return false;
  const good = createHmac('sha256', config.hutSessionSecret).update(p).digest('base64url');
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return false;
  return Number(p) > Date.now();
}
function cookieOf(req: FastifyRequest): string | undefined {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`)); return m?.[1];
}
export function isAuthed(req: FastifyRequest): boolean { return !isExternal(req) || verify(cookieOf(req)); }

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const loginHtml = readFileSync(join(config.publicDir, 'login.html'), 'utf8');
  if (!config.hutPassword) log.warn('HUT_PASSWORD not set — external access will be refused entirely');

  app.addHook('onRequest', async (req, reply) => {
    if (!isExternal(req)) return;                       // LAN: ผ่าน
    const url = req.url.split('?')[0];
    if (url === '/login' || url === '/api/login') return;
    if (verify(cookieOf(req))) return;
    if (url.startsWith('/api/') || url === '/ws') return reply.code(401).send({ error: 'login required' });
    return reply.code(200).type('text/html; charset=utf-8').send(loginHtml);
  });

  app.get('/login', async (_req, reply) => reply.type('text/html; charset=utf-8').send(loginHtml));

  app.post<{ Body: { password?: string } }>('/api/login', async (req, reply) => {
    const ip = clientIp(req); const f = fails.get(ip);
    if (f && f.until > Date.now()) return reply.code(429).send({ error: 'ลองผิดหลายครั้ง รอ 10 นาที' });
    const pw = String(req.body?.password || '');
    const ok = !!config.hutPassword && pw.length === config.hutPassword.length && timingSafeEqual(Buffer.from(pw), Buffer.from(config.hutPassword));
    if (!ok) { const n = (f?.n || 0) + 1; fails.set(ip, { n, until: n >= 5 ? Date.now() + 600_000 : 0 }); log.warn(`login failed from ${ip} (${n})`); return reply.code(401).send({ error: 'รหัสผ่านไม่ถูกต้อง' }); }
    fails.delete(ip);
    const exp = Date.now() + SESSION_DAYS * 86400_000;
    const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') || !!req.headers['cf-visitor'];
    reply.header('Set-Cookie', `${COOKIE}=${sign(exp)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    log.info(`login ok from ${ip}`);
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => { reply.header('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`); return { ok: true }; });
  app.get('/api/me', async (req) => ({ external: isExternal(req), authed: isAuthed(req) }));
}

export function newSecret(): string { return randomBytes(32).toString('base64url'); }
