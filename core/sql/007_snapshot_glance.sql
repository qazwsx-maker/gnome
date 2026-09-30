-- โหมดคิด: ข้อความสั้นและอารมณ์ที่ได้จากการดูภาพแต่ละใบ
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS caption text;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS mood text;
