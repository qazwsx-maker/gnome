-- แปลงหนึ่งดึงข้อมูลแวดล้อมได้จากหลาย node/หลายค่า เช่น อุณหภูมิจาก earth + แสงจาก sky
ALTER TABLE plots ADD COLUMN IF NOT EXISTS env_sources jsonb NOT NULL DEFAULT '[]'::jsonb;
