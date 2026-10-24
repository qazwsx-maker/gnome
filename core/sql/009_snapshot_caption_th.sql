-- โหมดคิด: คำบรรยายภาษาไทยสั้นๆ ว่ากล้องเห็นอะไร (ขึ้นเป็นชื่อบนการ์ดกล้องใน dashboard) · caption อังกฤษยังใช้ขึ้นจอ OLED
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS caption_th text;
