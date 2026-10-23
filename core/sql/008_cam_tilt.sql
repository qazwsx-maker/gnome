-- มุมก้มเงย (tilt) ของ Watcher ตอนถ่าย — ขาตั้ง pan-tilt SG90 ×2 (null = ไม่มี servo ก้มเงย) · angle = มุมหัน (pan) เหมือนเดิม
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS tilt integer;
