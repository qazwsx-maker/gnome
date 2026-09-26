# GNOME — ภูตดูแลสวน

ระบบ IoT สำหรับสวนดอกไม้เล็กในบ้าน: ESP32 nodes (น้ำหยด/พ่นหมอก, พัดลม, อุณหภูมิ/ความชื้น/แสง, ความชื้นดิน, กล้อง) ผ่าน WiFi 2.4G เข้า server กลางบน Mac mini

- **แพลนแบบ interactive:** https://qazwsx-maker.github.io/gnome/
- **เอกสารแพลนฉบับเต็ม:** [docs/PLAN.md](docs/PLAN.md) — ความเป็นไปได้, สถาปัตยกรรม, MQTT contract, รายการอุปกรณ์ + งบ, แผน 8 สัปดาห์, ความเสี่ยง

## โครงสร้าง repo (แผน)

```
docs/       แพลน + GitHub Pages (index.html เป็น single-file, ไม่มี build step)
firmware/   ESPHome YAML ต่อ node (water, airflow, air, ground, cam1)
core/       gnome-core — TypeScript · Fastify · mqtt.js · Drizzle → PostgreSQL
web/        gnome-web — Next.js dashboard
vision/     gnome-vision — Python · YOLO11n · ollama VLM
infra/      docker-compose (Mosquitto), LaunchAgents, Cloudflare Tunnel config
```

ตอนนี้มีเฉพาะ `docs/` — โค้ดจะเริ่มใน Phase 0 ตามแพลน

## แก้หน้าเว็บ

ข้อมูลทั้งหมด (nodes, phases, BOM, risks) อยู่ใน `<script>` ท้าย `docs/index.html` แก้ตัวเลขในอาร์เรย์ `BOM` แล้วยอดรวม/กราฟจะคำนวณใหม่เอง
