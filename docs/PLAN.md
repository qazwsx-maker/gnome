# GNOME — ภูตดูแลสวน (Garden Node Orchestration & Monitoring Environment)

> ระบบ IoT สำหรับสวนดอกไม้เล็กในบ้าน: ESP32 nodes ผ่าน WiFi 2.4G → server กลางบน Mac mini
> เอกสารนี้ = feasibility + แผนงาน + tech stack + รายการอุปกรณ์/งบ (ฉบับ 2026-09-26)

---

## 1. สรุปความเป็นไปได้ (Feasibility)

**ทำได้แน่นอน** ทุก node ที่ระบุมาเป็นของที่ชุมชน ESP32 ทำกันเป็นมาตรฐาน ความเสี่ยงจริงไม่ได้อยู่ที่ซอฟต์แวร์ แต่อยู่ที่ **ฮาร์ดแวร์ในสภาพสวนที่มีพ่นหมอก** และ **ความปลอดภัยของระบบรดน้ำ** ถ้า WiFi หลุด

| หัวข้อ | ระดับความยาก | หมายเหตุ |
|---|---|---|
| Sensor node (อุณหภูมิ/ความชื้น/แสง) | ง่าย | ใช้ ESPHome ได้เลย ไม่ต้องเขียน firmware |
| Ground sensor (ความชื้นดินหลายจุด) | กลาง | ตัวเซ็นเซอร์คือจุดอ่อน ต้อง calibrate ทีละกระถาง |
| Water controller (solenoid 2 ชุด) | กลาง | ต้องมี fail-safe ในตัว node (max-on timer) ห้ามพึ่ง server อย่างเดียว |
| Airflow (พัดลม 220V) | ง่าย แต่ต้องปลอดภัย | ESP32 + relay คุมเต้ารับในกล่องปิด แยกฝั่ง 220V ชัดเจน วงจรต้องมี RCD |
| Camera + AI | กลาง-ยาก | ESP32-CAM ภาพแย่ตอนกลางคืน; YOLO บน M4 CPU ไหว; "หนู" ไม่มีใน COCO ต้องใช้ motion + VLM |
| Server: status/logs/webapp/automation/Discord | กลาง | สแต็คที่มีอยู่แล้วบนเครื่องรองรับหมด |
| Public access + login | ง่าย | Cloudflare Tunnel + Access (มี cloudflared อยู่แล้ว) ไม่ต้อง forward port |

**สิ่งที่พบบนเครื่อง (2026-09-26):** Mac mini M4 / 16GB / macOS 26.4, Docker 28, Node 25, Python 3.14, PlatformIO 6.1.19, cloudflared 2026.6, ollama 0.33, PostgreSQL 17 (Homebrew, รันอยู่แล้ว)
**ข้อจำกัด:** ดิสก์เหลือ **4.6 GB** → ต้องทำ retention/downsample ตั้งแต่วันแรก และเลือกใช้ Postgres ที่มีอยู่แทนเปิด container DB เพิ่ม

---

## 2. สถาปัตยกรรม

```
[ESP32 nodes] --WiFi 2.4G--> [Mosquitto MQTT] --> [gnome-core] --> [PostgreSQL 17]
                                                     |    ^
 ESP32-CAM --HTTP snapshot--> [gnome-vision] --------+    |
                                                     v    |
                                              [Discord webhook]   [gnome-web (Next.js)]
                                                                        ^
                                              internet --> Cloudflare Tunnel + Access (login)
```

### 2.1 Node firmware: **ESPHome** (แนะนำ) หรือ PlatformIO custom
- **ESPHome** ให้ WiFi auto-reconnect, OTA, watchdog, driver ของ SHT3x/BH1750/ADC/relay/RS485 Modbus, MQTT พร้อม LWT (online/offline) และ **`max_on_time`/interlock บน switch** ฟรี → ตอบโจทย์ fail-safe ของ water node ในบรรทัดเดียว
- ยังเป็น "server ของเราเอง" ได้ เพราะ ESPHome คุยผ่าน MQTT ธรรมดา (ไม่ต้องใช้ Home Assistant)
- ใช้ PlatformIO custom เฉพาะที่ ESPHome ไม่พอ (เช่น camera node ถ้าอยากทำ motion detect บนบอร์ด) — จำ gotcha เดิม: pin platform ไปที่ pioarduino URL ไม่ใช่ `espressif32` เปล่า

### 2.2 MQTT topic contract
```
gnome/<node>/status                    retained: online|offline  (LWT)
gnome/<node>/sensor/<name>/state       ค่า sensor (float) ทุก 30 s (ดิน: ทุก 60 s)
gnome/<node>/switch/<name>/command     ON|OFF          ← server สั่ง
gnome/<node>/switch/<name>/state       ON|OFF          → node ยืนยัน
gnome/<node>/debug                     rssi, uptime, free heap, ip
```
ชื่อ node: `water`, `airflow`, `air`, `ground`, `cam1`

### 2.3 Server บน Mac mini (Docker Compose + Postgres ที่มีอยู่)
| ส่วน | เทคโนโลยี | เหตุผล |
|---|---|---|
| Broker | Eclipse Mosquitto 2 (Docker) + user/password | เบา, LWT, retained |
| DB | PostgreSQL 17 ที่รันอยู่แล้ว (+ TimescaleDB ถ้าอยาก, ไม่จำเป็น) | ไม่กินดิสก์เพิ่ม; ข้อมูล ~10k แถว/วัน เล็กมาก |
| gnome-core | **TypeScript (Node 25) + Fastify + mqtt.js + Drizzle** | ingest → DB, node health (heartbeat 90 s → offline), rules engine, Discord, REST + WebSocket |
| gnome-web | **Next.js** (สแต็คเดิมจาก meesook-web) + Recharts | หน้า status, กราฟ, ควบคุมมือ, ตั้ง rule, ดูกล้อง |
| gnome-vision | **Python 3.14 + ultralytics YOLO11n (CPU) + ollama VLM** | ดึง snapshot ทุก 3–5 s → motion diff → YOLO (person/bird/cat/dog) → ถ้าแปลกให้ VLM (qwen3.5 vision ที่มีอยู่) บรรยาย → Discord พร้อมรูป |
| Auth/Remote | **Cloudflare Tunnel + Cloudflare Access** (Google login, ฟรี ≤50 users) | ไม่เปิด port; ไม่ต้องเขียน login เอง (ทำ session ในแอปเพิ่มภายหลังได้) |
| Process | LaunchAgents (แบบเดียวกับ socialpulse/vibeflows ที่มี) หรือ `docker compose --restart unless-stopped` | เครื่องมี pmset sleep=1 แต่ถูก caffeinate ค้างไว้ → ตั้ง `sudo pmset -a sleep 0` ให้ชัด |

**ทางลัดถ้าเปลี่ยนใจ:** Home Assistant (Docker) + ESPHome + Frigate ให้ฟีเจอร์ 5 ข้อของ server ครบใน 1 วัน แต่ปรับแต่ง UI/logic ยากกว่าและ Frigate บน Apple Silicon ไม่มี Coral ใช้ CPU detector — ถ้าเป้าหมายคือ "ใช้งานได้เร็วที่สุด" เลือกทางนี้; ถ้าเป้าหมายคือทำเองเป็นโปรเจค เลือกสแต็คข้างบน (node firmware เหมือนกัน เปลี่ยนใจได้ทีหลัง)

### 2.4 Rules engine (automation flows)
เก็บ rule เป็น JSON ใน Postgres ประเมินทุก 10 s + on-event
```json
{ "name": "รดน้ำเช้า",
  "trigger": { "type": "cron", "expr": "0 6 * * *", "tz": "Asia/Bangkok" },
  "conditions": [ { "sensor": "ground.soil_median", "op": "<", "value": 45 } ],
  "actions": [ { "switch": "water.drip", "state": "ON", "until": { "sensor": "ground.soil_median", "op": ">=", "value": 60 }, "max_minutes": 8 },
               { "discord": "รดน้ำเสร็จ {duration} นาที ดิน {soil}%" } ] }
```
- trigger: cron / threshold (มี hysteresis) / node offline / camera event
- "until + max_minutes" คือ **feedback stop point จากความชื้นดิน** พร้อมเพดานเวลา
- interlock: drip กับ mist ห้ามเปิดพร้อมกัน (แรงดันน้ำตก); mist ห้ามเปิดถ้าความชื้นอากาศ > 85 %
- UI ระยะแรกเป็นฟอร์ม; ถ้าอยาก drag-and-drop จริงค่อยฝัง Node-RED เฉพาะส่วน flow

### 2.5 Data retention (สำคัญเพราะดิสก์เต็ม)
- raw 30 s เก็บ 14 วัน → downsample เป็นค่าเฉลี่ย 5 นาที เก็บ 1 ปี → รายวันเก็บตลอด
- ภาพจากกล้อง: เก็บเฉพาะเฟรมที่มี event, จำกัด 500 MB แบบ FIFO
- `pg_dump` รายวันไป Google Drive mount ที่มีอยู่

---

## 3. รายละเอียด node และการทนทาน (ruggedization)

หลักการทั่วไปทุก node
- กล่อง **IP65 ABS** พร้อม cable gland; ติดตั้งให้ **พ้นแนวละอองหมอก** และสูงจากพื้น
- ใส่ **ซองซิลิกาเจล** + เจาะ **breather vent** (หรือรูระบายด้านล่างมีตะแกรง) กันน้ำกลั่นตัว
- เคลือบบอร์ดด้วย conformal coating / สเปรย์ PCB lacquer; สายทุกเส้นทำ **drip loop**
- ไฟ 12 V DC จ่ายจากในบ้านออกไปสวน (ปลอดภัยกว่าเดินไฟ 220 V) ยกเว้นพัดลม
- router อยู่ใกล้สวนมาก ไม่ต้อง mesh node (ยังเก็บ RSSI ลง debug topic ไว้ดู)

### Node 1 — `water` (drip + mist)
- ESP32-DevKitC · relay 2 ch optocoupled (หรือ MOSFET module) · solenoid **12 V DC NC** ½" ×2 (NC = ไฟดับ → วาล์วปิด = ปลอดภัย)
- PSU 12 V 3–5 A (Mean Well LRS-50-12) + buck 12→5 V; flyback diode/TVS คร่อมคอยล์
- firmware: `max_on_time: 10min` ทั้งสองสวิตช์, interlock drip↔mist, ถ้า MQTT หลุด > 2 นาที ปิดทุกอย่าง
- น้ำต่อจากก๊อกตรง (2–3 bar) **ไม่มีปั๊ม** ตามโจทย์: หัวพ่นหมอกไมโครใช้แรงดันก๊อกได้; ใส่ inline filter 120 mesh + pressure regulator หน้าวาล์วเสมอกันหัวตัน
- สำหรับกระถาง 10 ใบ: น้ำหยด 10 หัว (1 หัว/กระถาง, ชุด 20 หัวเหลือสำรอง) + หัวหมอก 6–8 หัวเดินตามแนวซุ้มโค้ง

### Node 2 — `airflow` (พัดลมบ้าน 220 V ผ่านเต้ารับที่ relay คุม) — ตามที่เจ้าของเลือก
- ESP32-C3 SuperMini · relay 1 ch **10 A/250 V** optocoupled ขั้วสกรู (ระดับทน: relay module 30 A) · AC-DC 5 V module (HLK-PM01) จ่ายไฟ ESP32 จากสาย 220 V เส้นเดียวกัน · เต้ารับติดกล่อง + ฝาครอบกันน้ำ · ฟิวส์ 5 A
- กติกาความปลอดภัย: ฝั่ง 220 V กับฝั่ง 3.3/5 V **แยกโซนในกล่อง** เว้นระยะ ≥ 6 mm; relay ตัดสาย **L** ไม่ใช่ N; ฟิวส์ก่อน relay; ปิดฝากล่องก่อนจ่ายไฟทุกครั้ง; วงจรต้องมี **RCD/เบรกเกอร์กันดูด** (ถ้าปลั๊กเดิมไม่มี ให้ใช้ปลั๊กกันดูดแบบเสียบ ≈ 400–600 ฿)
- พัดลมบ้านมอเตอร์ ~50–70 W กระแสสตาร์ทต่ำ relay 10 A พอ; ถ้าเปลี่ยนเป็นพัดลมอุตสาหกรรม > 150 W ให้ใช้ relay 30 A
- ทางเลือกถ้าไม่อยากประกอบ 220 V เอง: Sonoff S26R2 flash ESPHome (~400 ฿)

### Node 3 — `air` (อุณหภูมิ/ความชื้น/แสง)
- ESP32-C3 SuperMini · **SHT31** (ทน ชื้นได้ดีกว่า DHT22 มาก, ควรใส่ PTFE cap หรือซื้อรุ่น probe กันน้ำ) · **BH1750** lux
- ทำ radiation shield (จานซ้อน/ท่อ PVC เจาะรู) กันแดดตรงเพื่อให้อุณหภูมิไม่เพี้ยน; BH1750 ต้องมีช่องใสหันขึ้นฟ้า

### Node 4 — `ground` (ความชื้นดินหลายจุด)
- ESP32-DevKitC (ใช้ **ADC1 เท่านั้น**: GPIO 32,33,34,35,36,39 = 6 หัว) เฉลี่ย 32 sample
- กระถาง 10 ใบ → สุ่มปัก 3–5 ใบ (ริม/กลาง/ใต้หัวหมอก)
- ทางเลือก A (งบ): capacitive soil v2.0 ×5 → เคลือบขอบบอร์ดด้วยอีพ็อกซี่, ปักเฉพาะแผ่นทองแดง, อายุ ~1 ปี, ค่า relative ต้อง calibrate แห้ง/เปียกทีละหัว
- ทางเลือก B (ทน): **RS485 soil sensor** (ชื้น+อุณหภูมิ, บางรุ่น +EC) ×3 → กันน้ำสนิท, ค่า absolute %, ต่อพ่วงบัสเดียวผ่าน MAX485 — แนะนำถ้าอยาก "ไม่พังง่าย"
- server ใช้ **median** ของทุกหัว + hysteresis เป็น stop point

### Node 5 — `cam1`
- ทางเลือก A: ESP32-CAM AI-Thinker + บอร์ด MB (ถูก แต่กลางคืนมองไม่เห็น, ร้อน, WiFi อ่อน) → ESPHome `esp32_camera` + snapshot endpoint
- ทางเลือก B: XIAO ESP32S3 Sense (ภาพ/WiFi ดีกว่า, ยังเป็น ESP32 ตามธีม)
- ทางเลือก C (ใช้งานได้จริงที่สุด): กล้อง IP RTSP outdoor (Tapo C310/ C120 ราคา ~1,200–1,700) ให้ gnome-vision ดึง RTSP — night vision + IP66 ในตัว
- แนะนำเริ่ม A/B เพื่อความสนุก แล้วมี C เป็นแผนสำรอง

---

## 4. รายการอุปกรณ์และงบประมาณ (THB, ราคาประเมินจาก Shopee/Lazada/Arduitronics ก.ย. 2026 — เช็คก่อนซื้อ)

### 4.1 ตามโหนด

| Node | รายการ | จำนวน | ราคา/หน่วย | รวม (งบ) | รวม (ทน) |
|---|---|---|---|---|---|
| water | ESP32-DevKitC 38 pin | 1 | 180 | 180 | 180 |
| | Relay 2 ch 5 V optocoupled | 1 | 80 | 80 | 80 |
| | Solenoid 12 V NC ½" (พลาสติก / ทองเหลือง) | 2 | 180 / 350 | 360 | 700 |
| | Mean Well LRS-50-12 | 1 | 400 | 400 | 400 |
| | Buck 12→5 V (MP1584) | 1 | 50 | 50 | 50 |
| | กล่อง IP65 + gland + terminal | 1 | 350 | 350 | 350 |
| | inline filter + pressure regulator + ข้อต่อ ½" | 1 | 350 | 350 | 350 |
| | ชุดน้ำหยด (สาย 4/7 + หัว 20 จุด) | 1 | 350 | 350 | 350 |
| | หัวพ่นหมอก ×10 + สาย | 1 | 200 | 200 | 200 |
| | **รวม water** | | | **2,320** | **2,660** |
| airflow | ESP32-C3 SuperMini | 1 | 90 | 90 | 90 |
| | Relay 1 ch 10 A/250 V optocoupled ขั้วสกรู / relay module 30 A | 1 | 60 / 150 | 60 | 150 |
| | AC-DC 5 V module (HLK-PM01) | 1 | 100 | 100 | 100 |
| | เต้ารับติดกล่อง + ฝาครอบกันน้ำ | 1 | 150 | 150 | 150 |
| | กล่องกันน้ำสำหรับงาน 220 V + gland (ทน: IP66 หนา + รางแยกโซน) | 1 | 200 / 350 | 200 | 350 |
| | ฟิวส์ 5 A + ขั้ว + สาย VCT 2×1.5 | 1 | 100 | 100 | 100 |
| | พัดลมบ้าน — *มีแล้ว* | | | | |
| | **รวม airflow** | | | **700** | **940** |
| air | ESP32-C3 SuperMini | 1 | 90 | 90 | 90 |
| | SHT31 breakout / SHT30 waterproof probe | 1 | 180 / 350 | 180 | 350 |
| | BH1750 | 1 | 70 | 70 | 70 |
| | กล่อง IP65 เล็ก + gland + วัสดุทำ radiation shield | 1 | 250 | 250 | 250 |
| | อะแดปเตอร์ 5 V 2 A + สาย | 1 | 120 | 120 | 120 |
| | **รวม air** | | | **710** | **880** |
| ground | ESP32-DevKitC | 1 | 180 | 180 | 180 |
| | (A) capacitive soil v2.0 ×5 + อีพ็อกซี่ | 5 | 60 | 350 | – |
| | (B) RS485 soil moisture+temp ×3 + MAX485 | 3 | 500 | – | 1,550 |
| | สายเคเบิล 4 core กันน้ำ + ขั้วต่อ DC กันน้ำ | 1 | 300 | 300 | 300 |
| | กล่อง IP65 + gland | 1 | 250 | 250 | 250 |
| | อะแดปเตอร์ 12 V 2 A + buck | 1 | 200 | 200 | 200 |
| | **รวม ground** | | | **1,280** | **2,480** |
| cam1 | (A) ESP32-CAM + MB + เคสกันน้ำ / (B) XIAO ESP32S3 Sense + เคส | 1 | 400 / 900 | 400 | 900 |
| | อะแดปเตอร์ 5 V 2 A | 1 | 120 | 120 | 120 |
| | (C สำรอง) Tapo outdoor RTSP ≈ 1,500 | | | | |
| | **รวม cam1** | | | **520** | **1,020** |
| ส่วนกลาง | Mac mini — *มีแล้ว* | | | 0 | 0 |
| | UPS 600–800 VA (Mac mini + router) | 1 | 1,800 | – | 1,800 |
| | สายไฟ/สายสัญญาณ/Wago/heat shrink/สเปรย์เคลือบ PCB/ซิลิกาเจล | ชุด | 600 | 600 | 600 |
| | ESP32 สำรอง 1 ตัว + sensor สำรอง | ชุด | 400 | 400 | 400 |
| | **รวมส่วนกลาง** | | | **1,000** | **2,800** |

### 4.2 สรุป

| ระดับ | รวมโดยประมาณ | ได้อะไร |
|---|---|---|
| **งบประหยัด** | **≈ 6,500 ฿** | ทุก node ครบ, capacitive soil, ESP32-CAM, ไม่มี UPS |
| **ระดับทน (แนะนำ)** | **≈ 10,800 ฿** | RS485 soil, วาล์วทองเหลือง, relay 30 A, XIAO S3 cam, UPS |
| ไม่รวม | พัดลมบ้าน (มีแล้ว), โครงซุ้มโค้งยกพื้น + สแลนพรางแดด (งานโครงสร้าง), กล้อง IP สำรอง, ค่าติดตั้งท่อ | |

จุดที่ **คุ้มจ่ายเพิ่ม** เรียงตามลำดับ: (1) RS485 soil sensor (2) SHT31 ตัวกันน้ำ (3) UPS (4) วาล์วทองเหลือง — เพราะเป็นของที่ "พังในสวน" บ่อยสุด
จุดที่ **ไม่ต้องจ่ายเพิ่ม**: บอร์ด ESP32 (ของถูกใช้ได้ดี ซื้อสำรองแทน), relay module

---

## 5. แผนงาน (8 สัปดาห์ ทำเสาร์-อาทิตย์)

| Phase | สัปดาห์ | งาน | Definition of done |
|---|---|---|---|
| 0 Foundation | 1 | repo `~/gnome` (monorepo: `firmware/`, `core/`, `web/`, `vision/`, `infra/`), Mosquitto (Docker), schema Postgres, gnome-core ingest MQTT→DB, Discord webhook, ESP32 ตัวเดียวบนโต๊ะ + SHT31 ส่งค่า | เห็นกราฟอุณหภูมิบนโต๊ะ + Discord แจ้ง "node online" |
| 1 Sense | 2–3 | ประกอบ `air` + `ground` ลงกล่อง ติดตั้งจริง, calibrate soil ทุกหัว, หน้า **Status** (online/offline/RSSI/last seen) + กราฟ 24 h/7 d, retention job | ข้อมูลไหลจากสวนต่อเนื่อง 7 วันไม่หลุด |
| 2 Act | 4–5 | `water` node พร้อม max_on_time/interlock ทดสอบด้วยถัง, ปุ่มสั่งมือบนเว็บ, `airflow` (ประกอบกล่อง relay + เต้ารับ, ทดสอบด้วยหลอดไฟก่อนพัดลม), automation ตัวแรก: cron เช้า-เย็น + soil stop point | รดน้ำอัตโนมัติ 1 สัปดาห์ ไม่มี over-water; ถอด WiFi แล้ววาล์วปิดเองใน ≤10 นาที |
| 3 Reach | 6 | Cloudflare Tunnel + Access (Google login), หน้าตั้ง rule (ฟอร์ม), Discord: node offline > 5 min, ค่าเกินเกณฑ์, สรุปรดน้ำรายวัน | เปิดจากมือถือนอกบ้านได้ผ่าน login |
| 4 Watch | 7–8 | `cam1` + gnome-vision: motion diff → YOLO11n → VLM (ollama) บรรยาย → Discord แนบรูป; หน้าดูกล้อง/เหตุการณ์ | ได้แจ้งเตือน "มีคน/นก" พร้อมรูป; false positive < 3/วัน |
| 5 Harden | ต่อเนื่อง | รีวิว 1 เดือน: ตัวไหนพัง/ชื้น, ปรับ threshold ตามฤดู, backup pg_dump → Drive, ชื่อโหนดตามธีมภูต | รายงานสรุปหลังใช้งานจริง 30 วัน |

**ซื้อของรอบแรก (สัปดาห์ 1):** ESP32-DevKitC ×2, ESP32-C3 ×1, SHT31, BH1750, soil sensor ตามทางเลือกที่ตัดสินใจ, relay 2 ch, solenoid ×2, PSU 12 V, กล่อง IP65 ×3, gland, buck ×2 — ของเหล่านี้ใช้ถึง Phase 2 (ส่วน camera/UPS สั่งช้าลงได้)

---

## 6. ความเสี่ยงหลักและวิธีรับมือ

| ความเสี่ยง | ผล | รับมือ |
|---|---|---|
| WiFi หลุดตอนวาล์วเปิด | น้ำท่วมกระถาง | `max_on_time` ใน firmware + ปิดเมื่อ MQTT หลุด + วาล์ว NC |
| ความชื้นเข้ากล่อง | บอร์ดพัง/ค่าเพี้ยน | IP65 + gland + ซิลิกาเจล + เคลือบบอร์ด + ติดพ้นแนวหมอก |
| soil sensor drift/สนิม | รดน้ำผิดเวลา | RS485 หรือเคลือบอีพ็อกซี่; median หลายหัว; เพดานเวลาเสมอ |
| ESP32 ADC ไม่เป็นเชิงเส้น | ค่าดินกระโดด | ADC1 เท่านั้น, attenuation 11 dB, เฉลี่ย 32 sample, calibrate ต่อหัว |
| 220 V ในที่ชื้น | อันตรายถึงชีวิต | smart plug สำเร็จรูป + RCD + ปลั๊กกันน้ำ; ห้ามต่อ relay 220 V ลอย |
| Mac mini หลับ/ดับ | ระบบมืดทั้งสวน | `pmset sleep 0`, UPS, LaunchAgent restart, Discord heartbeat ทุกเช้า |
| ดิสก์เต็ม (เหลือ 4.6 GB) | DB หยุดเขียน | retention 14 วัน raw, ภาพเก็บเฉพาะ event ≤500 MB, ล้างดิสก์ก่อนเริ่ม |
| ESP32-CAM ภาพแย่กลางคืน | AI มองไม่เห็น | IR LED เสริม หรือสลับเป็น IP cam RTSP (แผน C) |
| Cloudflare Tunnel ล่ม | เข้าจากนอกไม่ได้ | automation อยู่ใน LAN ทั้งหมด ไม่พึ่งอินเทอร์เน็ต; Discord ยังส่งได้เมื่อเน็ตกลับ |

---

## 7. โจทย์จากเจ้าของสวน (ตอบ 2026-09-26) และผลต่อแพลน
1. **น้ำต่อจากก๊อกตรง ไม่ต้องมีปั๊ม** → ตัดปั๊มหมอกออก ใช้หัวหมอกไมโครแรงดันก๊อก ต้องมี filter + regulator หน้าวาล์ว
2. **กระถาง 10 ใบ บนซุ้มโค้งยกพื้น + สแลนพรางแดด** → น้ำหยด 10 หัว, หมอก 6–8 หัวตามแนวซุ้ม, soil probe สุ่ม 3–5 ใบ; เดินสาย/ท่อตามโครงซุ้ม กล่องทุกใบยกสูงพ้นแนวหมอก; สแลนลดอุณหภูมิและ BH1750 จะอ่านค่าแสงหลังพราง (ใช้เป็นตัวตัดสินใจเปิดหมอก/พัดลมได้ตรงกว่า)
3. **มีปลั๊ก 220 V ใกล้สวนแล้ว** → ตัดปลั๊กพ่วง outdoor ออก; **ต้องเช็คว่าวงจรนั้นมี RCD** ถ้าไม่มีให้ใช้ปลั๊กกันดูดแบบเสียบก่อนต่ออะไรทั้งสิ้น
4. **router ใกล้มาก** → ตัด mesh node ออก
5. **พัดลมบ้าน 220 V ใช้ relay คุมเต้ารับ** → airflow node เป็น ESP32-C3 + relay 10 A + เต้ารับติดกล่อง ตามรายละเอียดใน §3 Node 2
