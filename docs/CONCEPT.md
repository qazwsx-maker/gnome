# GNOME — Concept v2 (จากของจริง, 2026-09-28)

ปรับจากแพลนแรกตามอุปกรณ์ที่ซื้อมาแล้ว ([INVENTORY.md](INVENTORY.md))

## ตัวละคร

| ชื่อ | ฮาร์ดแวร์ | หน้าที่ | สถานะ |
|---|---|---|---|
| **GNOME Hut** (ระบบกลาง) | Mac mini M4 · Mosquitto + gnome-core + PostgreSQL | สั่งงาน/ตรวจสถานะทุก node, เก็บ log, วิเคราะห์, automation, OTA, รายงานผลให้ webapp/app, Discord | ✅ รันอยู่ (dashboard `http://192.168.1.111:8080/`) |
| **Keeper** | ESP32-Relay-X4 (relay 220V 10A ×4) + OLED 1.3" | relay 1 = ปั๊ม 12V น้ำหยด (ยังไม่มีปั๊ม) · relay 2 = เต้ารับพัดลม 220V · relay 3–4 ว่าง (หมอก/ไฟ/อื่นๆ) · max-on, interlock, failsafe | ✅ firmware `keeper-relayx4` 0.3.0 พร้อม OLED + หน้าอารมณ์ (รดน้ำ/พัดลม) |
| **Scout** | ESP32-S3 UNO + OLED 1.3" | จอแสดงข้อมูล + **หน้าอารมณ์** · BH1750 โดม (แสง) · DHT22 (อุณหภูมิ/ความชื้น) · raindrop · ดิน | ✅ env `scout-s3` 0.3.0 + หน้าอารมณ์ (ยังไม่ทดสอบบนบอร์ด) |
| **Mini Scout** | ESP32 DevKit 30 pin + terminal adapter + OLED 1.3" | จอแสดงข้อมูล + หน้าอารมณ์ · DHT22 · ดิน | ✅ firmware `scout` 0.3.0 จอสถานะ + หน้าอารมณ์ |
| **Watcher** | ESP32-CAM + MB | ถ่ายภาพขึ้น Hut เป็นช่วงเวลา → **time-lapse ดูต้นไม้โต** · กด **ดูภาพสด** จาก app | ⏳ ต้อง env `cam` + ฝั่ง Hut (เก็บภาพ, time-lapse, live) |

## Feature ที่ต้องเพิ่มจากที่มี (เรียงตามลำดับที่จะทำ)

1. ✅ **หน้าอารมณ์บน OLED** (Scout / Mini Scout / Keeper): สลับหน้า "ข้อมูล" ↔ "หน้า" ทุก 5 s · อารมณ์คำนวณจากค่าจริง — 😊 ปกติ · 🥵 ร้อน (> 34 °C) · 🥱 ง่วง (กลางคืน lux < 5) · 😰 กระหาย (ดิน < threshold) · 🌧 ฝนตก (raindrop เปียก) · 😵 ป่วย (เซ็นเซอร์อ่านไม่ได้ / MQTT หลุด) · Keeper: 💧 กำลังรดน้ำ · 🌬 พัดลมทำงาน
2. ✅ **env `scout-s3`** สำหรับ ESP32-S3 UNO: I2C SDA 8 / SCL 9, ADC1 = IO1–IO10 (A0–A5 = IO2 IO1 IO7 IO6 IO5 IO4), DHT ที่ IO10, LED RGB · manifest ESP32-S3 · ต้องดาวน์โหลด toolchain S3
3. **Watcher (`cam` env)**: ถ่าย JPEG ทุก N นาที (ตั้งได้) POST ไป Hut `POST /api/cam/<node>/snapshot` + `/stream` MJPEG สำหรับดูสด + status/meta/debug ทาง MQTT + ไฟแฟลช GPIO4 สั่งได้
4. **Hut ฝั่งกล้อง**: เก็บภาพ `infra/data/cam/<node>/YYYY/MM/DD/`, retention (30 วันเต็ม → เก็บ 1 ภาพ/ชม.), หน้า **time-lapse** (เลื่อนดูตามวัน/สร้าง mp4 ด้วย ffmpeg), หน้า **ดูสด** (proxy `/stream` ของ node ผ่าน Hut เพื่อให้ดูจากนอกบ้านผ่าน Cloudflare Tunnel ได้)
5. **Keeper: ปั๊ม 12V** — relay 1 สลับสาย +12V เข้าปั๊ม · เพิ่ม rule "รดน้ำจนดิน Mini Scout ถึง X% ไม่เกิน N นาที" (มีอยู่แล้วใน rules engine)
6. **app / webapp นอกบ้าน**: Cloudflare Tunnel + Access ไปที่ Hut (Phase 3 เดิม)

## สิ่งที่ยังต้องซื้อ
- ปั๊มน้ำ 12V สำหรับน้ำหยด (ถ้าดึงจากถัง: ปั๊มไดอะแฟรม 12V 60W 5 L/min ที่ O.R. มี หรือปั๊มจุ่ม 12V ถ้าถังอยู่ต่ำกว่าแปลง) + สาย/หัวน้ำหยด
- กล่องกันน้ำ + gland + ฟิวส์ สำหรับกล่อง Keeper 220V · ตัวแปลงแจ็ค DC → ขั้วสกรู
