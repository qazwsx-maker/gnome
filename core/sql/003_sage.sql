-- Sage (ภูตนักปราชญ์): วิเคราะห์การเจริญเติบโตจากภาพ Watcher + ข้อมูลสิ่งแวดล้อม
CREATE TABLE IF NOT EXISTS plots (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  cam_node    text NOT NULL,
  sensor_node text,
  from_ts     timestamptz,
  to_ts       timestamptz,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analyses (
  id          bigserial PRIMARY KEY,
  plot_id     bigint NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  provider    text,
  model       text,
  progress    jsonb NOT NULL DEFAULT '{}'::jsonb,
  frames      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- per-frame observations
  env         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- daily environment series
  report      jsonb,
  error       text,
  tokens_in   integer NOT NULL DEFAULT 0,
  tokens_out  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS analyses_plot_idx ON analyses (plot_id, created_at DESC);
