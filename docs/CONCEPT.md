# GNOME — Concept v2 (จากของจริง, 2026-09-28)

ปรับจากแพลนแรกตามอุปกรณ์ที่ซื้อมาแล้ว ([INVENTORY.md](INVENTORY.md))

## ตัวละคร

| ชื่อ | ฮาร์ดแวร์ | หน้าที่ | สถานะ |
|---|---|---|---|
| **GNOME Hut** (ระบบกลาง) | Mac mini M4 · Mosquitto + gnome-core + PostgreSQL | สั่งงาน/ตรวจสถานะทุก node, เก็บ log, วิเคราะห์, automation, OTA, รายงานผลให้ webapp/app, Discord | ✅ รันอยู่ (dashboard `http://192.168.1.111:8080/`) |
| **Keeper** | ESP32-Relay-X4 (relay 220V 10A ×4) + OLED 1.3" | relay 1 = ปั๊ม 12V น้ำหยด (ยังไม่มีปั๊ม) · relay 2 = เต้ารับพัดลม 220V · relay 3–4 ว่าง (หมอก/ไฟ/อื่นๆ) · max-on, interlock, failsafe | ✅ firmware `keeper-relayx4` 0.3.0 พร้อม OLED + หน้าอารมณ์ (รดน้ำ/พัดลม) |
| **Scout** | ESP32-S3 UNO + OLED 1.3" | จอแสดงข้อมูล + **หน้าอารมณ์** · BH1750 โดม (แสง) · DHT22 (อุณหภูมิ/ความชื้น) · raindrop · ดิน | ✅ env `scout-s3` 0.3.0 + หน้าอารมณ์ (ยังไม่ทดสอบบนบอร์ด) |
| **Mini Scout** | ESP32 DevKit 30 pin + terminal adapter + OLED 1.3" | จอแสดงข้อมูล + หน้าอารมณ์ · DHT22 · ดิน | ✅ firmware `scout` 0.3.0 จอสถานะ + หน้าอารมณ์ |
| **Watcher** | ESP32-CAM + MB (+ servo SG90 หัน 0–180°) | ถ่ายภาพขึ้น Hut เป็นช่วงเวลา → **time-lapse ดูต้นไม้โต** · **ดูภาพสด** ผ่าน Hut (ได้จากนอกบ้าน) · **หันด้วย servo** ไปตาม preset เพื่อเฝ้าหลายแปลงด้วยกล้องตัวเดียว (ภาพติดมุมไว้ → แปลงของ Sage เลือกเฉพาะมุมของตัวเองได้) | ✅ env `cam` 0.3.3 + Hut: รับ/เก็บภาพ, แท็บกล้อง (ล่าสุด · ถ่ายตอนนี้ · ดูสด · time-lapse รายวัน), retention 30 วันเต็ม → 1 ภาพ/ชม. ถึง 1 ปี |

## Feature ที่ต้องเพิ่มจากที่มี (เรียงตามลำดับที่จะทำ)

1. ✅ **หน้าอารมณ์บน OLED** (v0.4.0 port จาก [Platypus face engine](https://qazwsx-maker.github.io/platypus/): Pose ที่ ease เข้าหาเป้าหมาย, ตาโค้งมนมีประกาย, เปลือกตาบนเอียงได้, กระพริบ, saccade + wander, หายใจ · สลับกับหน้าโชว์ค่าเซ็นเซอร์ตัวใหญ่พร้อมไอคอน และหน้าสถานะเครือข่าย) (Scout / Mini Scout / Keeper): สลับหน้า "ข้อมูล" ↔ "หน้า" ทุก 5 s · อารมณ์คำนวณจากค่าจริง — 😊 ปกติ · 🥵 ร้อน (> 34 °C) · 🥱 ง่วง (กลางคืน lux < 5) · 😰 กระหาย (ดิน < threshold) · 🌧 ฝนตก (raindrop เปียก) · 😵 ป่วย (เซ็นเซอร์อ่านไม่ได้ / MQTT หลุด) · Keeper: 💧 กำลังรดน้ำ · 🌬 พัดลมทำงาน
2. ✅ **env `scout-s3`** สำหรับ ESP32-S3 UNO: I2C SDA 8 / SCL 9, ADC1 = IO1–IO10 (A0–A5 = IO2 IO1 IO7 IO6 IO5 IO4), DHT ที่ IO10, LED RGB · manifest ESP32-S3 · ต้องดาวน์โหลด toolchain S3
3. ✅ **Watcher (`cam` env)**: ถ่าย JPEG ทุก N นาที (ตั้งได้) POST ไป Hut `POST /api/cam/<node>/snapshot` + `/stream` MJPEG สำหรับดูสด + status/meta/debug ทาง MQTT + ไฟแฟลช GPIO4 สั่งได้
4. ✅ **Hut ฝั่งกล้อง** (ยังไม่มี mp4 export และ proxy stream ผ่าน Hut — ดูสดตรงจาก node ใน LAN): เก็บภาพ `infra/data/cam/<node>/YYYY/MM/DD/`, retention (30 วันเต็ม → เก็บ 1 ภาพ/ชม.), หน้า **time-lapse** (เลื่อนดูตามวัน/สร้าง mp4 ด้วย ffmpeg), หน้า **ดูสด** (proxy `/stream` ของ node ผ่าน Hut เพื่อให้ดูจากนอกบ้านผ่าน Cloudflare Tunnel ได้)
5. **Keeper: ปั๊ม 12V** — relay 1 สลับสาย +12V เข้าปั๊ม · เพิ่ม rule "รดน้ำจนดิน Mini Scout ถึง X% ไม่เกิน N นาที" (มีอยู่แล้วใน rules engine)
6. ✅ **Sage — ภูตนักปราชญ์** (AI วิเคราะห์การเจริญเติบโต): สร้าง "แปลง" (กล้อง + node เซ็นเซอร์ + ช่วงเวลา + โน้ต) → กด วิเคราะห์ → Sage เลือกภาพ (1/วัน ใกล้เที่ยง สูงสุด SAGE_MAX_FRAMES) ดูทีละภาพพร้อมวัน/เวลา/สภาพแวดล้อมของวันนั้น (readings_5m ของ node เซ็นเซอร์) → สังเคราะห์รายงาน: สรุป, milestones (ปลูก/งอก/ใบจริง/จำนวนใบ/ตุ่มดอก/ดอกแรก), กราฟใบ-ความสูง, กราฟอุณหภูมิ/ความชื้น/ดิน/แสง, insight สิ่งแวดล้อม, คำแนะนำ · **timeline interactive** เลื่อนดูภาพ+ค่าสังเกตทีละภาพ · โมเดล Claude (`SAGE_MODEL`, ค่าเริ่มต้น claude-opus-5) หรือ ollama ในเครื่อง (`SAGE_PROVIDER=ollama`) · ต้องใส่ `ANTHROPIC_API_KEY` ใน infra/.env
7. **app / webapp นอกบ้าน**: Cloudflare Tunnel + Access ไปที่ Hut (Phase 3 เดิม)

## สิ่งที่ยังต้องซื้อ
- ปั๊มน้ำ 12V สำหรับน้ำหยด (ถ้าดึงจากถัง: ปั๊มไดอะแฟรม 12V 60W 5 L/min ที่ O.R. มี หรือปั๊มจุ่ม 12V ถ้าถังอยู่ต่ำกว่าแปลง) + สาย/หัวน้ำหยด
- กล่องกันน้ำ + gland + ฟิวส์ สำหรับกล่อง Keeper 220V · ตัวแปลงแจ็ค DC → ขั้วสกรู

## พลังงาน (ตัดสินใจ 2026-09-28)
| ตัว | ไฟ | วิธี |
|---|---|---|
| Hut | 220V | Mac mini (UPS ภายหลัง) |
| Keeper | 220V ตรงเข้าบอร์ด Relay-X4 | ปั๊ม 12V ใช้อะแดปเตอร์ 12V แยก (ST-909 ตอนทดสอบ) |
| Scout (S3 UNO) | USB-C 5V 1A | อะแดปเตอร์มือถือ |
| Mini Scout + Watcher | **อะแดปเตอร์ USB 5V 2A แบบ 2 ช่อง ตัวเดียว** — Mini Scout ทาง USB-C, CAM ทาง micro USB ของบอร์ด MB | ติดตั้งคู่กันจุดเดียว (CAM กินถึง 600 mA พีค) · ห้ามดึง 5V ให้ CAM ผ่านขาของ DevKit · ทางเลือก: 5V เข้าขั้วสกรู VIN แล้วพ่วงขนานไป CAM, หรือ buck 12→5V จากสาย 12V ของ Keeper |
