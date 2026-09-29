-- มุม servo ของ Watcher ตอนถ่าย (null = กล้องไม่มี servo) + ให้ plot เลือกดูเฉพาะมุมที่ต้องการ
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS angle integer;
CREATE INDEX IF NOT EXISTS snapshots_node_angle_idx ON snapshots (node, angle, ts DESC);
ALTER TABLE plots ADD COLUMN IF NOT EXISTS cam_angle integer;
