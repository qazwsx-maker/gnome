-- Watcher snapshots (ไฟล์อยู่ที่ CAM_DIR/<node>/<YYYY-MM-DD>/<HHMMSS>.jpg)
CREATE TABLE IF NOT EXISTS snapshots (
  id     bigserial PRIMARY KEY,
  ts     timestamptz NOT NULL DEFAULT now(),
  node   text NOT NULL,
  path   text NOT NULL,          -- relative to CAM_DIR
  bytes  integer NOT NULL,
  reason text
);
CREATE INDEX IF NOT EXISTS snapshots_node_ts_idx ON snapshots (node, ts DESC);
