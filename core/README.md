# gnome-core

Server side of GNOME (Mac mini): MQTT ingest → PostgreSQL, node health, rules engine, Discord alerts, REST + WebSocket API, and the no-build dashboard in `public/`.
Implements [docs/PROTOCOL.md](../docs/PROTOCOL.md); design in [docs/PLAN.md](../docs/PLAN.md) §2.3–2.5.

Stack: Node ≥ 22.18 (runs on 25), TypeScript → `tsc` → `dist/`, Fastify 5, mqtt.js, `pg` (plain SQL, no ORM), croner. No Docker, no Next.js.

## Run

```sh
cd core
npm install
npm run build          # tsc -> dist/
npm start              # node dist/index.js  (reads env from the shell)
npm run dev            # node --watch src/index.ts (Node type-stripping, no tsx needed)
```

Production runs as a LaunchAgent (`infra/com.gnome.core.plist` → `~/Library/LaunchAgents/`), which execs `core/bin/start.sh`; that script sources `infra/.env` and runs `node dist/index.js`. Logs: `infra/log/core.out.log`, `infra/log/core.err.log`.

```sh
launchctl load ~/Library/LaunchAgents/com.gnome.core.plist       # first time
launchctl kickstart -k gui/$(id -u)/com.gnome.core                # restart after `npm run build`
launchctl list | grep gnome
```

Mosquitto runs as `brew services start mosquitto`; `/opt/homebrew/etc/mosquitto/mosquitto.conf` is a symlink to `infra/mosquitto.conf` (listener 1883 + websockets 9001, password file `infra/mosquitto.passwd`, user `gnome`).

## Env (`infra/.env`, see `infra/.env.example`)

| var | default | meaning |
|---|---|---|
| `MQTT_HOST` / `MQTT_PORT` | `127.0.0.1` / `1883` | broker |
| `MQTT_USER` / `MQTT_PASS` | `gnome` / — | must match `infra/mosquitto.passwd` |
| `DATABASE_URL` | `postgres://pichaya@localhost/gnome` | migrations in `sql/*.sql` are applied at startup (tracked in `schema_migrations`) |
| `PORT` | `8080` | HTTP + WS + dashboard |
| `TZ` | `Asia/Bangkok` | cron rules default tz, daily summary |
| `DISCORD_WEBHOOK_URL` | empty | empty = messages are logged as `[discord]` lines instead |
| `OFFLINE_AFTER_S` | `90` | node with no message for this long → offline |

## What it does

- **MQTT** — LWT on `gnome/server/status` (retained `online`/`offline`), subscribes `gnome/#`. `status` → nodes.online + event; `meta` → upsert node; `sensor/<key>/state` → readings (batched every 2 s) + in-memory latest; `sensor|switch/<key>/meta` → `nodes.meta.sensor_meta|switch_meta`; `switch/<key>/state` → `switch_states` + `switch_log`; `debug` → in-memory + `nodes.ip`; `event` → `events` (+ Discord for `max_on_reached`, `failsafe_off`, `sensor_error`). Retained replays do not count as heartbeats.
- **Health** — no message for > 90 s → offline (`node_offline` event + Discord); any message → online again.
- **Rules** — JSON in `rules`, evaluated every 10 s and on every reading/event (below).
- **Discord** — webhook POST (≤ 1900 chars) or console; daily 07:00 summary (nodes, 24 h min/max, switch runs, events).
- **Retention (hourly)** — readings older than 1 h → `readings_5m` (avg/min/max per 5-min bucket, upsert); raw > 14 d, 5m > 365 d, events > 90 d deleted.
- **Dashboard** — `public/` served at `/` (Thai UI, live over `/ws`).

## REST API (`/api`, JSON)

| method + path | body / query | notes |
|---|---|---|
| `GET /health` | | `{ok, db, mqtt, uptime_s, nodes:{total,online}, active_runs}` |
| `GET /nodes` | | all nodes with `latest`, `switches`, `debug`, `online`, `last_seen` |
| `GET /nodes/:node` | | one node |
| `DELETE /nodes/:node` | | forget a node (its readings stay) |
| `POST /nodes/:node/cmd` | `{cmd:"reboot"\|"identify"\|"config"\|"ota", payload?}` | publishes `gnome/<node>/cmd/<cmd>` |
| `GET /latest` | | `{node:{key:{value,ts}}}` |
| `GET /readings` | `node, key, since=ISO, until=ISO, res=raw\|5m, limit` | default last 24 h; `5m` auto when span > 2 days (5m rows include `min`/`max`) |
| `GET /switches` | | every known switch with state + meta |
| `GET /firmware` | | firmware envs served from `FIRMWARE_DIR` (docs/firmware) with version + URL, and per-node `update` flag |
| `POST /nodes/:node/ota` | `{env?}` | publish `cmd/ota` with the server's firmware URL (env auto-picked from role/board) |
| `POST /ota` | | OTA every online node whose version differs |
| `GET /firmware/<env>/firmware.bin` | | static binaries for nodes (`CORE_PUBLIC_URL` = how nodes reach this server) |
| `POST /switch` | `{node, key, state:"ON"\|"OFF", seconds?}` | publishes `ON`, `ON <seconds>` or `OFF` to `switch/<key>/command` |
| `GET /switch-log` | `limit` | |
| `GET /events` | `limit (≤1000), node, type` | newest first |
| `GET /rules` · `POST /rules` · `PUT /rules/:id` · `DELETE /rules/:id` | `{name, enabled, json}` or the bare rule JSON | POST/PUT validate the JSON |

WebSocket `/ws`: first message `{type:"hello", nodes:[...]}`, then `{type:"reading"|"switch"|"status"|"event"|"debug"|"node"|"rules", ...}`.

## Rule JSON

```jsonc
{
  "name": "รดน้ำเช้า",
  "cooldown_s": 300,                                   // fires at most once per cooldown (default 300)
  "trigger": { "type": "cron", "expr": "0 6 * * *", "tz": "Asia/Bangkok" },
  "conditions": [ { "sensor": "ground.soil1_pct", "op": "<", "value": 45 } ],   // all must hold (unknown sensor = false)
  "actions": [
    { "switch": "water.drip", "state": "ON", "max_minutes": 8,
      "until": { "sensor": "ground.soil1_pct", "op": ">=", "value": 60 } },     // ON 480 → OFF when until is true
    { "discord": "รดน้ำเสร็จ {duration} นาที ดิน {ground.soil1_pct}%" }        // sent when the run ends
  ]
}
```

Trigger types:

```jsonc
{ "type": "threshold", "sensor": "air.temp_c", "op": ">", "value": 35, "hysteresis": 2 }  // edge-triggered; re-arms at <= 33
{ "type": "node_offline", "node": "water" }                                             // node optional (any)
{ "type": "event", "event": "failsafe_off", "node": "water" }                           // both optional
```

Actions: `{switch:"node.key", state:"ON"|"OFF", max_minutes?, seconds?, until?}` (publishes `ON <seconds>` where seconds = max_minutes·60; with `until` the server polls latest values and sends `OFF` when it becomes true, also reacting immediately on that sensor's readings), `{discord:"..."}` / `{notify:"..."}` (same thing). Templates: `{node.key}` = live value, `{duration}` = minutes, `{rule}`, `{node}`, `{event}`.

Example — overheating fan:

```json
{ "name": "ร้อน → เปิดพัดลม", "cooldown_s": 600,
  "trigger": { "type": "threshold", "sensor": "air.temp_c", "op": ">", "value": 34, "hysteresis": 1.5 },
  "conditions": [ { "sensor": "air.rh_pct", "op": "<", "value": 85 } ],
  "actions": [ { "switch": "airflow.fan", "state": "ON", "max_minutes": 20 },
               { "notify": "อากาศร้อน {air.temp_c}°C เปิดพัดลม {duration} นาที" } ] }
```

## Manual test with mosquitto

```sh
set -a; source ../infra/.env; set +a
mosquitto_pub -u gnome -P "$MQTT_PASS" -t gnome/test-scout/status -m online -r
mosquitto_pub -u gnome -P "$MQTT_PASS" -t gnome/test-scout/sensor/temp_c/state -m 31.2
mosquitto_sub -u gnome -P "$MQTT_PASS" -t 'gnome/#' -v
# forget the test node: publish empty retained payloads, then DELETE /api/nodes/test-scout
```
