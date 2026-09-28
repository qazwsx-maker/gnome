# GNOME — ภูตดูแลสวน

ระบบ IoT สำหรับสวนดอกไม้เล็กในบ้าน: ESP32 nodes (น้ำหยด/พ่นหมอก, พัดลม, อุณหภูมิ/ความชื้น/แสง, ความชื้นดิน, กล้อง) ผ่าน WiFi 2.4G เข้า server กลางบน Mac mini

- **แพลนแบบ interactive:** https://qazwsx-maker.github.io/gnome/
- **เอกสารแพลนฉบับเต็ม:** [docs/PLAN.md](docs/PLAN.md) — ความเป็นไปได้, สถาปัตยกรรม, MQTT contract, รายการอุปกรณ์ + งบ, แผน 8 สัปดาห์, ความเสี่ยง

- **Flash firmware ลง ESP32 จากเบราว์เซอร์:** https://qazwsx-maker.github.io/gnome/flash/
- **Concept v2 (จากของจริง):** [docs/CONCEPT.md](docs/CONCEPT.md)
- **โปรโตคอล MQTT:** [docs/PROTOCOL.md](docs/PROTOCOL.md)

## โครงสร้าง repo

```
docs/         แพลน + GitHub Pages (index.html single-file) · flash/ หน้า ESP Web Tools · firmware/<role>/ binaries + manifest
firmware/     GnomeOS (PlatformIO, ESP32 DevKit) — env `scout` = sensor node, `keeper` = controller node  → firmware/README.md
core/         gnome-core — TypeScript · Fastify · mqtt · PostgreSQL 17 · rules engine · Discord · dashboard (core/public)  → core/README.md
infra/        mosquitto.conf, .env (ไม่ commit), LaunchAgent com.gnome.core
vision/       (ยังไม่เริ่ม) gnome-vision — Python · YOLO11n · ollama VLM
```

## เริ่มใช้งาน (สั้น)
1. Mac mini: Mosquitto (`brew services`) + gnome-core (LaunchAgent) รันอยู่ → dashboard `http://<macmini>:8080/`
2. Flash ESP32 ที่ https://qazwsx-maker.github.io/gnome/flash/ → ตั้ง WiFi ตอน flash (Improv) หรือผ่าน AP `GNOME-Scout-xxxx` รหัส `gnome1234`
3. เปิด `http://<node>.local/` ตั้งชื่อ node + MQTT host (IP ของ Mac mini) + user `gnome` + password จาก `infra/.env`
4. node โผล่บน dashboard เอง (auto-register จาก `meta`)

## แก้หน้าเว็บ

ข้อมูลทั้งหมด (nodes, phases, BOM, risks) อยู่ใน `<script>` ท้าย `docs/index.html` แก้ตัวเลขในอาร์เรย์ `BOM` แล้วยอดรวม/กราฟจะคำนวณใหม่เอง
