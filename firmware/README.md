# GnomeOS — firmware ของ node ใน GNOME

| env | role | หน้าที่ |
|---|---|---|
| `scout` | sensor node | I2C auto-detect SHT3x (0x44/45) · BH1750 (0x23/5C) · BME280 (0x76/77), DHT22 (ตั้ง pin), ความชื้นดิน analog สูงสุด 6 หัว (ADC1: 32 33 34 35 36 39) |
| `keeper` | controller node | ESP32 DevKit + relay module: relay/สวิตช์ สูงสุด 4 ตัว, `max_on_s` ต่อตัว, `exclusive` interlock, failsafe ปิดทุกตัวเมื่อขาด MQTT/server เกิน `failsafe_s` |
| `keeper-relayx4` | controller node | เหมือน keeper แต่ค่าเริ่มต้นสำหรับบอร์ด **LC ESP32-Relay-X4**: drip/mist/fan/aux = GPIO32/33/25/26 active-high, LED 23 · ไม่มี USB flash ผ่าน USB-TTL |

ทุก env รองรับ **จอ OLED** SH1106/SSD1306 128×64 บน I2C (auto-detect 0x3C/0x3D, ตั้งชนิด/ปิดได้ในหน้าเว็บ) แสดง node · IP/RSSI · MQTT · ค่าเซ็นเซอร์หรือสถานะ relay

บอร์ดเป้าหมาย: ESP32 DevKit (ESP32-WROOM-32) · โปรโตคอล: [docs/PROTOCOL.md](../docs/PROTOCOL.md)

## วงจรชีวิตของ firmware (flash ครั้งเดียว แล้ว OTA ตลอด)
1. **ครั้งแรก**: flash ผ่าน USB จากหน้า flash → ตั้ง WiFi (Improv) → ตั้ง MQTT ในหน้าเว็บ node — จบ ไม่ต้องต่อสายอีก
2. **อัปเดต**: `tools/release.sh <version>` build ทุก env + วาง bin ที่ `docs/firmware/<env>/` (gnome-core เสิร์ฟที่ `http://<macmini>:8080/firmware/<env>/firmware.bin`) → บน dashboard node ที่เวอร์ชันเก่าจะมีปุ่ม **"อัปเดต OTA → x.y.z"** หรือกด "อัปเดต OTA ทุก node" → node ดาวน์โหลด, เขียน slot สำรอง, รีบูต, รายงาน `meta` เวอร์ชันใหม่ (config ใน NVS คงเดิม)
3. ถ้า OTA ล้มเหลว node ส่ง event `ota_failed` และยังรัน firmware เดิม (partition `min_spiffs`: app slot ×2 ขนาด 1.9 MB — เปลี่ยนตาราง partition ต้อง flash USB เท่านั้น)
4. ทางอื่นที่ยังใช้ได้: อัปโหลด .bin ในหน้าเว็บ node · `pio run -e scout -t upload --upload-port <node>.local` (ArduinoOTA รหัส `gnome1234`) · MQTT `cmd/ota` + URL

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
src/display.cpp   OLED สถานะ (U8g2)
src/web_ui.h      หน้าเว็บบน node (PROGMEM)
```
Build: `pio run` (ทั้งสอง env) — binaries สำหรับหน้า flash ถูกคัดลอกไป `docs/firmware/<role>/`
