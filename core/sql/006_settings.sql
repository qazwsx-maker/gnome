-- ค่าตั้งของระบบที่แก้ได้จากหน้าเว็บ (ไม่ต้องแก้ .env แล้วรีสตาร์ท)
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
