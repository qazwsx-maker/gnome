-- GNOME core schema v1 (see docs/PROTOCOL.md "Server (gnome-core) เก็บอะไร")
-- Applied idempotently by src/db.ts; keep every statement IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS nodes (
  node        text PRIMARY KEY,
  role        text,
  fw          text,
  ip          text,
  mac         text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  online      boolean NOT NULL DEFAULT false,
  last_seen   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- raw sensor readings, kept 14 days
CREATE TABLE IF NOT EXISTS readings (
  ts     timestamptz NOT NULL,
  node   text NOT NULL,
  key    text NOT NULL,
  value  double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS readings_node_key_ts_idx ON readings (node, key, ts);
CREATE INDEX IF NOT EXISTS readings_ts_idx ON readings (ts);

-- 5-minute rollups, kept 365 days
CREATE TABLE IF NOT EXISTS readings_5m (
  ts    timestamptz NOT NULL,
  node  text NOT NULL,
  key   text NOT NULL,
  avg   double precision NOT NULL,
  min   double precision NOT NULL,
  max   double precision NOT NULL,
  n     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (node, key, ts)
);

CREATE TABLE IF NOT EXISTS switch_states (
  node   text NOT NULL,
  key    text NOT NULL,
  state  text NOT NULL,
  ts     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node, key)
);

CREATE TABLE IF NOT EXISTS switch_log (
  id      bigserial PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  node    text NOT NULL,
  key     text NOT NULL,
  state   text NOT NULL,          -- ON / OFF / "ON 30" (command)
  source  text NOT NULL DEFAULT 'node'  -- node | api | rule:<id>
);
CREATE INDEX IF NOT EXISTS switch_log_ts_idx ON switch_log (ts);

CREATE TABLE IF NOT EXISTS events (
  id       bigserial PRIMARY KEY,
  ts       timestamptz NOT NULL DEFAULT now(),
  node     text,
  type     text NOT NULL,
  payload  jsonb
);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);

CREATE TABLE IF NOT EXISTS rules (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  json        jsonb NOT NULL,
  last_fired  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
