# GNOME — ของที่ซื้อมาแล้วจริง (inventory)

บันทึกจากรูปที่เจ้าของส่ง 2026-09-28 · อาจไม่ตรงกับ BOM ในแพลน — ไว้ปรับ firmware/สายไฟตามของจริง

| # | ของ | จำนวน | รายละเอียดจากรูป | ใช้กับ node | สถานะ firmware / หมายเหตุ |
|---|---|---|---|---|---|
| 1 | DHT22 module (AB205) | 2 | breakout 3 ขา `+` `out` `-` มี pull-up บนบอร์ด (PCB V182) + สายจัมเปอร์ F-F 3 เส้น | Scout (air) | รองรับแล้ว: ตั้ง `dht_pin` (แนะนำ GPIO 4) → `dht_temp_c`, `dht_rh_pct` · แทน SHT31 ในแพลน — ทนละอองหมอกได้น้อยกว่า ติดพ้นแนวหมอก มีสำรอง 1 |
| 2 | Soil moisture resistive (YL-69 fork + LM393 module) | 2 | โมดูลขา `VCC` `GND` `DO` `AO` + pot ปรับ threshold DO · หัวส้อม 2 แผ่น | Scout (ground) | ใช้ได้ทันที: VCC → **3V3** (ห้าม 5V), AO → ADC1 (34, 35), DO ไม่ต่อ · raw สูง=แห้ง เหมือน capacitive · **กร่อนเร็ว** → TODO firmware: `soil_power_pin` จ่ายไฟเฉพาะตอนวัด · ใช้ช่วงทดลอง ระยะยาวเปลี่ยนเป็น capacitive/RS485 |
| 3 | BH1750FVI โดมกันน้ำ (โดมตะวัน) | 1 | PCB แดงในโดมขาว JST 5 ขา `1 VCC 2 SCL 3 DAT 4 GND 5 ADDR` + สายหลายสี | Scout (air) | รองรับแล้ว (auto-detect 0x23/0x5C): VCC→3V3, SCL→22, DAT→21, ADDR ลอย/GND · ตรงแพลนระดับทน · เช็คสีสายกับเลขขาก่อนต่อ · ติดหันขึ้นฟ้าใต้สแลน |
| 4 | Raindrop sensor (MH-RD + LM393) | 1 | แผ่นลายทองแดง + โมดูล `VCC` `GND` `DO` `AO` | Scout (air) | ไม่มีในแพลน · ใช้ตรวจฝน (ข้ามรดน้ำ) หรือวางใต้หัวหมอกเช็คว่าหมอกออกจริง · ต่อเหมือนดิน: VCC→3V3, AO→ADC1 (33) · TODO firmware: ช่อง analog ตั้ง `key` เองได้ (`rain_pct`) + power-gating ร่วมกับดิน |
| 5 | OLED 1.3" I2C (JMD1.3A, SH1106) — O.R. AA420 150 ฿ | 2 | ขา `GND VCC SCL SDA` (ระวังลำดับ) addr 0x3C (จัมเปอร์ 0x78) | Scout/Keeper (ตัวไหนก็ได้) | ไม่มีในแพลน · จอสถานะหน้างาน: node/IP/WiFi/MQTT/ค่า · ต่อบัส I2C เดียวกับ BH1750 · TODO firmware: auto-detect 0x3C + หน้าสถานะ (U8g2 SH1106) |
| 6 | ESP32-CAM (AI-Thinker ESP-32S + OV2640) + ESP32-CAM-MB (CH340) | 1 | มี PSRAM, ขั้ว IPEX, MB มีปุ่ม IO0/RST | cam1 | ตรงแพลน option A · flash ผ่าน MB ได้ · **TODO firmware env `cam`** ("Watcher"): board esp32cam, `/snapshot` + `/stream`, MQTT status/meta/debug, LED GPIO33, flash GPIO4 · GPIO ว่างน้อย อย่าต่อเซ็นเซอร์อื่น · ไฟ 5V ≥ 500 mA |
| 7 | ESP32 DevKit 30 pin NA709 (USB-C, CH9102X) ×2 + Terminal adapter CB005 30 pin ×1 | 2+1 | ขั้วสกรู: VIN GND D13 D12 D14 D27 D26 D25 D33 D32 D35 D34 VN VP EN / 3V3 GND D15 D2 D4 RX2 TX2 D5 D18 D19 D21 RX0 TX0 D22 D23 | Scout ตัวแรก | ตรง env `esp32dev` ใช้ได้เลย · ขา default ของ firmware อยู่บนขั้วสกรูครบ · มี 2 ตัว (ตัวที่ 2 = Scout ground แยก หรือสำรอง) · แผนต่อสาย: DHT22→D4, I2C→D21/D22, ดิน→D34/D35, ฝน→D33 |
| 8 | ESP32-S3 UNO (ESP32-S3-WROOM-1 N16R8) | 1 | UNO form · USB-C + DC jack 7–12 V · BOOT · RGB LED · digital: IO12 IO13 IO11 IO10 IO46 IO21 IO14 IO3 IO20 IO19 IO17 IO18 TXD RXD · I2C ข้าง RST: IO8 (SDA) IO9 (SCL) · analog A0–A5: IO2 IO1 IO7 IO6 IO5 IO4 · extra IO35–42, IO45 IO16 IO15 IO47 IO48 | Keeper (water) | **TODO firmware env `keeper-s3`/`scout-s3`**: board esp32-s3-devkitc-1, I2C 8/9, ADC1 = IO1–10, RGB LED, manifest ESP32-S3 (bootloader offset 0x0) · ใช้ DC jack รับ 12 V ร่วมกับ solenoid, 5V pin เลี้ยง relay |
| 9 | ESP32-Relay-X4 (LC Technology, ESP32-WROOM-32E + Songle SRD-05VDC 10A ×4) | 1 | COM/NO/NC ทุกช่อง · ไฟเข้า 220VAC / 7–30VDC / 5VDC · ปุ่ม EN, IO0 · **ไม่มี USB** (header TX/RX/GND) | **Keeper = water node** (drip, mist + 2 ช่องว่าง เช่นพัดลม) | พิน (ยืนยันจาก ESPHome/Tasmota db): relay1–4 = **GPIO 32 33 25 26 active HIGH**, LED GPIO 23 · **TODO firmware env `keeper-relayx4`** (defaults ขา/active-high/LED) · flash ครั้งแรกต้องมี **USB-TTL 3.3V** + กด IO0 ค้างแล้วกด EN, หลังนั้น OTA · จ่าย 12 V เข้าขั้ว 7–30 V ร่วมกับ solenoid |
| 10 | USB-TTL FT232RL Type-C (YP-05, O.R. AA106) | 1 | ขา DTR RXD TXD VCC CTS GND · จัมเปอร์ 3.3V/5V | โปรแกรม Relay-X4 / ESP32-CAM | ✅ ซื้อแล้ว 50 ฿ · ตั้งจัมเปอร์ 3.3V ใช้ GND/TXD/RXD |
| 11 | อะแดปเตอร์ปรับแรงดัน ST-909 (มีจอ) | 1 | แจ็ค DC 5.5×2.1 · ปุ่มหมุน Min–Max | ไฟทดสอบ / 12 V ให้ Relay-X4 + solenoid | ✅ 300 ฿ · ตั้ง 12.0 V ก่อนเสียบทุกครั้ง · ต้องมีตัวแปลงแจ็ค DC→ขั้วสกรู · ตอนติดตั้งจริงล็อกปุ่มหรือใช้อะแดปเตอร์ตายตัว |

## การตัดสินใจจากของจริง (2026-09-28)

1. **Controller node เหลือตัวเดียว = ESP32-Relay-X4** รับ 220VAC ตรง · relay 1 drip · 2 mist · 3 fan 220V · 4 ว่าง → **airflow node ยุบรวม** ไม่ต้องทำกล่อง relay+เต้ารับแยก
2. **OLED 1.3" ×2: Keeper + Scout** ที่ GPIO 21 (SDA) / 22 (SCL) ผ่าน header 10×2 (บัดกรี pin header ก่อน) โชว์ node/IP/MQTT/สถานะ relay
3. Solenoid ยังใช้ 12V DC (ต้องมีอะแดปเตอร์ 12V ในกล่อง, COM→+12V, NO→วาล์ว) — ทางเลือก 220VAC solenoid ไม่ต้องมี 12V แต่สายในที่เปียกอันตรายกว่า
4. ESP32 DevKit 30 pin + terminal adapter = **Scout ตัวแรก** (DHT22 D4, BH1750 I2C 21/22, ดิน D34/D35, ฝน D33)
5. ESP32-S3 UNO = สำรอง / node เพิ่มในอนาคต · ESP32-CAM = cam1 (รอ firmware env `cam`)

## Firmware TODO (เรียงตามลำดับ)
1. ~~env `keeper-relayx4` + OLED~~ ✅ 2026-09-28
2. ~~Scout: `soil_power_pin` + analog `key`~~ ✅ 2026-09-28 — ต่อ VCC ของโมดูลดิน/ฝนเข้าขาที่ตั้ง (เช่น GPIO 25) แทน 3V3 แล้วใส่ `soil_power_pin` = 25
3. env `cam` = **GnomeOS Watcher** (ESP32-CAM, ชื่อยืนยันแล้ว 2026-09-28): `/snapshot` `/stream` + MQTT status/meta/debug, LED 33, flash 4
4. env `*-s3` (ESP32-S3 UNO): I2C 8/9, ADC1 = IO1–10, RGB LED, manifest ESP32-S3

## ยังต้องซื้อ/หา
- ~~USB-to-TTL~~ ✅ ได้แล้ว (ข้อ 10) · ~~อะแดปเตอร์ 12V~~ ✅ ได้แล้ว (ข้อ 11, ปรับได้)
- **ตัวแปลงแจ็ค DC ตัวเมีย → ขั้วสกรู** (10–20 ฿) สำหรับต่ออะแดปเตอร์เข้าขั้ว 7–30V ของ Relay-X4
- อะแดปเตอร์ 12V (ถ้าใช้ solenoid 12V DC) · ฟิวส์ + ขั้ว · กล่องกันน้ำสำหรับงาน 220V

## บิลซื้อจริง — O.R. Technology 28/9/2569 (map รหัสร้านจากเว็บ)

**บิล 1 — รวม 1,930 ฿**

| รหัสร้าน | ของ | จำนวน | ราคา | inventory # |
|---|---|---|---|---|
| สายแพ 40 cm | สายจัมเปอร์ | 1 | 45 | — |
| ESP32-Relay-X4 | บอร์ด relay 4 ช่อง (LC) | 1 | 490 | 9 |
| CB006 | ESP32-CAM + MB | 1 | 380 | 6 |
| CB205 | ESP32-S3 UNO N16R8 | 1 | 300 | 8 |
| XS217 | BH1750FVI โดมกันน้ำ | 1 | 100 | 3 |
| AB205 | DHT22 module | 2 | 70 ×2 = 140 | 1 |
| AB054 | Soil moisture resistive (LM393) | 2 | 30 ×2 = 60 | 2 |
| AB055 | Raindrop sensor | 1 | 40 | 4 |
| CB005 | Terminal adapter ESP32 30 pin | 1 | 65 | 7 |
| NA709 | **ESP32 Type-C NodeMCU (CH9102X, 30 pin)** | **2** | 155 ×2 = 310 | 7 (+1 ตัวสำรอง — มี DevKit 2 ตัว) |

**บิล 2 — รวม 400 ฿**

| รหัสร้าน | ของ | จำนวน | ราคา | หมายเหตุ |
|---|---|---|---|---|
| AA420 | **OLED 1.3" ขาว (JMD1.3A, SH1106)** | 2 | 150 ×2 = 300 | inventory #5 — มี 2 จอ: Keeper 1 + Scout 1 |
| ปอก VR | ลูกบิด/ป๊อก | 1 | 20 | |
| ขั้วต่อสายไฟ 2-2C | ขั้วต่อสาย 2 ช่อง | 5 | 50 | ใช้ต่อวาล์ว/เซ็นเซอร์ |
| ขั้วต่อสายไฟ 6-6 | ขั้วต่อสาย 6 ช่อง | 1 | 30 | |

**ไม่อยู่ในบิล 2 ใบนี้ (บิลแยก):** FT232RL AA106 50 ฿ · อะแดปเตอร์ปรับแรงดัน ST-909 300 ฿ · สายไฟ 15 เมตร 150 ฿ · ชุดท่อหด 60 ฿

**รวมที่จ่ายแล้ว = 2,890 ฿** (1,930 + 400 + 300 + 50 + 150 + 60) · เทียบ BOM ระดับทน 13,020 ฿ — ส่วนที่ซื้อแล้วครอบคลุม node ทั้งหมดยกเว้น: solenoid, ชุดน้ำหยด/หมอก, กล่อง IP65 + gland + ฟิวส์, UPS
