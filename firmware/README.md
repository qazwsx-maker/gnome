# GnomeOS — firmware ของ node ใน GNOME

| env | role | หน้าที่ |
|---|---|---|
| `scout` | sensor node | I2C auto-detect SHT3x (0x44/45) · BH1750 (0x23/5C) · BME280 (0x76/77), DHT22 (ตั้ง pin), ความชื้นดิน analog สูงสุด 6 หัว (ADC1: 32 33 34 35 36 39) |
| `keeper` | controller node | relay/สวิตช์ สูงสุด 4 ตัว, `max_on_s` ต่อตัว, `exclusive` interlock, failsafe ปิดทุกตัวเมื่อขาด MQTT/server เกิน `failsafe_s` |

บอร์ดเป้าหมาย: ESP32 DevKit (ESP32-WROOM-32) · โปรโตคอล: [docs/PROTOCOL.md](../docs/PROTOCOL.md)

## ติดตั้ง
- **จากเบราว์เซอร์ (แนะนำ):** https://qazwsx-maker.github.io/gnome/flash/ (Chrome/Edge + USB) → ตั้ง WiFi ได้ทันทีผ่าน Improv
- **PlatformIO:** `pio run -e scout -t upload` / `pio run -e keeper -t upload`
- **OTA ทาง LAN:** เปิด `http://<node>.local/` → อัปโหลด `firmware.bin` (หรือ `pio run -e scout -t upload --upload-port <node>.local` รหัส `gnome1234`)

## การตั้งค่า (ทั้งหมดอยู่ใน NVS แก้ได้ 3 ทาง)
1. **Improv** ตอน flash (WiFi อย่างเดียว) → แล้วไปหน้าเว็บ node
2. **Captive portal**: ถ้ายังไม่มี WiFi node เปิด AP `GNOME-Scout-xxxx` / `GNOME-Keeper-xxxx` รหัส `gnome1234` → หน้าเว็บเด้งเอง (`http://192.168.4.1/`)
3. **หน้าเว็บบน node** `http://<node>.local/` — ชื่อ node, WiFi, MQTT host/user/pass, interval, ขา I2C/DHT, หัววัดดิน + dry/wet, สวิตช์ + pin + max_on + exclusive, ปุ่ม ON/OFF ทดสอบ, กระพริบไฟ, OTA
   หรือส่ง JSON patch ไปที่ MQTT `gnome/<node>/cmd/config`

## LED (GPIO 2)
กระพริบเร็ว = โหมดตั้งค่า (AP) · กระพริบช้า = WiFi ได้ ยังไม่ถึง MQTT · วูบสั้นทุก 5 s = ปกติ · กระพริบถี่ 10 s = identify

## ความปลอดภัย (Keeper)
- boot → ทุกขา OFF ก่อนต่อเน็ต
- ON ทุกครั้งมี timer ≤ `max_on_s` (default 600 s) · `ON 120` = เปิด 120 s
- ขาด MQTT หรือ `gnome/server/status` = offline นานเกิน `failsafe_s` (default 120 s) ขณะมีตัวเปิดอยู่ → ปิดหมด แล้วรายงาน `failsafe_off` เมื่อกลับมา
- `exclusive`: สั่งเปิดตัวหนึ่ง จะปิดตัวในกลุ่มก่อน (drip ↔ mist)

## โครงสร้าง
```
src/main.cpp      setup/loop
src/config.*      Config struct + NVS (Preferences) + JSON patch
src/net.cpp       WiFi STA/AP, captive portal (DNSServer), WebServer + /api/*, mDNS, ArduinoOTA, /update
src/improv.*      Improv Wi-Fi serial (ESP Web Tools)
src/mqttc.cpp     PubSubClient, LWT, meta, cmd/*, ota
src/scout.cpp     sensors (compiled only for scout)
src/keeper.cpp    switches (compiled only for keeper)
src/web_ui.h      หน้าเว็บบน node (PROGMEM)
```
Build: `pio run` (ทั้งสอง env) — binaries สำหรับหน้า flash ถูกคัดลอกไป `docs/firmware/<role>/`
