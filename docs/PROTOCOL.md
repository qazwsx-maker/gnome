# GNOME MQTT protocol v1 (GnomeOS ↔ gnome-core)

ทุก node และ server คุยกันผ่าน Mosquitto บน Mac mini (`mqtt://<macmini>:1883`, user/password เดียวกันทุก node, ดู `infra/.env`).
ชื่อ node (`<node>`) = ตัวพิมพ์เล็ก `[a-z0-9-]` ตั้งได้ตอน setup ค่าเริ่มต้นคือ `<role>-<mac4>` เช่น `scout-3f2a`

## Roles (firmware)
| Role | ชื่อ firmware | หน้าที่ |
|---|---|---|
| `scout` | **GnomeOS Scout** | sensor node: I2C auto-detect (SHT3x, BH1750, BME280), DHT22 (optional), analog soil ×N (ADC1) |
| `keeper` | **GnomeOS Keeper** | controller node: relay/switch ×1–4 พร้อม max_on_time, interlock, failsafe |
| `cam` | **GnomeOS Watcher** | camera node (ESP32-CAM): node **POST** JPEG ไป `{hut_url}/api/cam/<node>/snapshot` ทุก `interval_s` (ส่ง header `X-Angle` ถ้ามี servo) · ดูสด `http://<ip>:81/stream`, `http://<ip>:81/snapshot` · `cmd/snap` ถ่ายทันที · `cmd/flash` ON/OFF · meta มี `cam:{stream,snapshot,interval_s,size}` |

## Topics (prefix `gnome/<node>/`)

| Topic | Retained | QoS | Direction | Payload |
|---|---|---|---|---|
| `status` | yes | 1 | node→ | `online` / `offline` (LWT = `offline`) |
| `meta` | yes | 1 | node→ | JSON (ด้านล่าง) ส่งตอน connect และเมื่อ config เปลี่ยน |
| `sensor/<key>/state` | no | 0 | node→ | ตัวเลข เช่น `31.4` ทุก `interval_s` (default 30) |
| `sensor/<key>/meta` | yes | 1 | node→ | JSON `{"unit":"°C","src":"sht3x"}` |
| `switch/<key>/state` | yes | 1 | node→ | `ON` / `OFF` (ส่งทุกครั้งที่เปลี่ยน + ตอน connect) |
| `switch/<key>/command` | no | 1 | →node | `ON` · `OFF` · `ON <seconds>` (เปิดตามเวลาแล้วปิดเอง ไม่เกิน max_on_s) |
| `switch/<key>/meta` | yes | 1 | node→ | JSON `{"pin":26,"active_low":true,"max_on_s":600,"exclusive":["mist"]}` |
| `debug` | no | 0 | node→ | JSON `{"rssi":-61,"uptime_s":1234,"heap":180000,"ip":"192.168.1.50"}` ทุก 60 s |
| `event` | no | 1 | node→ | JSON `{"type":"boot"\|"max_on_reached"\|"failsafe_off"\|"interlock_blocked"\|"config_changed"\|"sensor_error", ...}` |
| `cmd/reboot` | no | 1 | →node | อะไรก็ได้ |
| `cmd/config` | no | 1 | →node | JSON patch ของ config (node บันทึกลง NVS แล้ว reboot ถ้าจำเป็น) |
| `cmd/ota` | no | 1 | →node | URL ของไฟล์ .bin (HTTP) — server ส่ง `http://<core>/firmware/<env>/firmware.bin` (`POST /api/nodes/<node>/ota`, `POST /api/ota`) node ตอบ event `ota_start` / `ota_failed` แล้วรีบูตพร้อม `meta.fw` ใหม่ |
| `cmd/identify` | no | 1 | →node | กระพริบ LED 10 วินาที |
| `cmd/snap` | no | 1 | →node (cam) | ถ่ายและส่งภาพทันที |
| `cmd/flash` | no | 1 | →node (cam) | `ON` / `OFF` ไฟแฟลช GPIO4 |
| `cmd/pan` | no | 1 | →node (cam) | มุม `0`–`180` หรือชื่อ preset · เติม ` +snap` เพื่อถ่ายหลังหันเสร็จ |
| `cmd/patrol` | no | 1 | →node (cam) | หันไปทุก preset แล้วถ่ายทีละมุม กลับมุมเดิมเมื่อจบ |
| `cmd/flip` | no | 1 | →node (cam) | JSON `{"vflip":bool,"mirror":bool}` ใส่เฉพาะคีย์ที่จะเปลี่ยน · มีผลทันทีและจำลง NVS ไม่รีบูต · config เทียบเท่า `cam_vflip`/`cam_mirror` (`cam_flip` เก่า = ตั้งทั้งคู่) · meta/status มี `cam.vflip`, `cam.mirror` |

Server: `gnome/server/status` retained `online`/`offline` (LWT) — Keeper ใช้ร่วมกับการขาด MQTT เพื่อ failsafe

## `meta` JSON
```json
{ "node":"air", "role":"scout", "fw":"gnomeos-scout 0.1.0", "board":"esp32dev",
  "mac":"A4:CF:12:3F:2A:10", "ip":"192.168.1.50",
  "sensors":[ {"key":"temp_c","unit":"°C","src":"sht3x"}, {"key":"rh_pct","unit":"%","src":"sht3x"},
              {"key":"lux","unit":"lx","src":"bh1750"}, {"key":"soil1_pct","unit":"%","src":"adc","pin":34} ],
  "switches":[] }
```
Keeper: `"switches":[{"key":"drip","pin":26,"active_low":true,"max_on_s":600,"exclusive":["mist"]}, ...]`, `"sensors":[]`

## Sensor keys (Scout)
`temp_c`, `rh_pct`, `lux`, `press_hpa`, `<key>_pct` / `<key>_raw` ต่อช่อง analog (key ตั้งเอง ค่าเริ่มต้น `soil1..6`; แผ่นวัดฝนใช้ `rain`), `dht_temp_c`, `dht_rh_pct`
soil `_pct` = map(raw, dry→0, wet→100) clamp; calibration `dry`/`wet` ต่อช่องอยู่ใน config

## Node config (NVS, แก้ผ่าน captive portal · หน้าเว็บบน node `http://<ip>/` · `cmd/config`)
```json
{ "node":"air", "role":"scout", "wifi_ssid":"...", "wifi_pass":"...",
  "mqtt_host":"192.168.1.10", "mqtt_port":1883, "mqtt_user":"gnome", "mqtt_pass":"...",
  "interval_s":30, "i2c_sda":21, "i2c_scl":22, "dht_pin":-1,
  "soil_power_pin":-1, "soil":[{"pin":34,"key":"soil1","dry":3100,"wet":1300},{"pin":33,"key":"rain","dry":3000,"wet":1500}],
  "switches":[{"key":"drip","pin":26,"active_low":true,"max_on_s":600,"exclusive":["mist"]}],
  "failsafe_s":120 }
```

## Failsafe (Keeper)
- boot → ทุก switch OFF
- ทุก ON มี timer ≤ `max_on_s` (default 600) ครบแล้วปิดเอง + `event max_on_reached`
- MQTT หลุดต่อเนื่อง > `failsafe_s` (default 120) → ทุก switch OFF + `event failsafe_off` เมื่อกลับมา
- `exclusive`: สั่ง ON ตัวหนึ่ง จะปิดตัวที่อยู่ในกลุ่ม exclusive ก่อน (และส่ง `event interlock_blocked` ถ้าถูกปิด)

## Server (gnome-core) เก็บอะไร
- `nodes` (node, role, fw, ip, mac, meta JSON, online, last_seen)
- `readings` (ts, node, key, value) raw 14 วัน → `readings_5m` (ts, node, key, avg, min, max) 1 ปี
- `switch_states` (node, key, state, ts) + `switch_log`
- `events` (ts, node, type, payload)
- `rules` (id, name, enabled, json)
