// Anthropic client ตัวเดียวสำหรับ Sage + โหมดคิด (glance)
// credential จาก env (infra/.env): ANTHROPIC_API_KEY (คีย์ sk-ant-api…/sk-ant-usr…) หรือ ANTHROPIC_AUTH_TOKEN (OAuth token)
// คีย์แบบ "user key" (sk-ant-usr…) ไม่ผูก workspace → API บังคับให้ส่ง header anthropic-workspace-id ทุกคำขอ
// ตั้ง ANTHROPIC_WORKSPACE_ID=wrkspc_… ใน infra/.env (ดูได้ที่ Console → Settings → Workspaces) · คีย์ที่สร้างในworkspace ไม่ต้องตั้ง
import Anthropic from '@anthropic-ai/sdk';

export function anthropicClient(): Anthropic {
  const ws = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  return new Anthropic(ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {});
}
