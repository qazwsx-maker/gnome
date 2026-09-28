# คืนแรก: flash 3 บอร์ด → ต่อเน็ต → ขึ้น dashboard → ลอง OTA

**เตรียม**: เสียบบอร์ดกับ **Mac mini** (ถ้าทำได้) ผมจะเห็นพอร์ต flash และอ่าน serial log ให้ · หรือใช้ MacBook เปิด Chrome ที่หน้า flash เอง
**ข้อมูลที่ต้องใส่**: WiFi บ้าน 2.4G · MQTT host `192.168.1.111` · user `gnome` · password จาก `infra/.env` บน Mac mini

| ลำดับ | บอร์ด | firmware | ชื่อ node ที่แนะนำ | หมายเหตุ |
|---|---|---|---|---|
| 1 | ESP32 DevKit 30 ขา (ในเทอร์มินัล) | **Mini Scout** (`scout`) | `mini` | เสียบ USB-C · ไม่มีเซ็นเซอร์ก็ขึ้น dashboard ได้ (จะเห็น RSSI/uptime) · ต่อ OLED ที่ D21/D22 ถ้าอยากเห็นหน้า |
| 2 | ESP32-S3 UNO | **Scout** (`scout-s3`) | `scout` | เสียบ USB-C · ครั้งแรกอาจต้องกด BOOT ค้างแล้วเสียบ · ไฟ RGB: น้ำเงิน=ตั้งค่า เหลือง=WiFi ได้ เขียว=MQTT ได้ |
| 3 | Waveshare ESP32-C6-LCD | **Scout C6** (`scout-c6`) | `buddy` | ต้อง build ด้วย toolchain แยกก่อน (กำลังเตรียม) · จอ LCD ยังไม่ใช้ในคืนนี้ แค่ต่อเน็ต + OTA |

## ขั้นตอนต่อบอร์ด
1. เสียบ USB → เปิด https://qazwsx-maker.github.io/gnome/flash/ (Chrome) → กดปุ่มของบอร์ด → เลือกพอร์ต → **Install** (ติ๊ก Erase) 
2. เสร็จแล้วหน้าจะถาม WiFi → เลือก SSID ใส่รหัส → ได้ลิงก์ `http://<ip>/`
3. เปิดลิงก์ → ตั้ง **ชื่อ node**, **MQTT host / user / password** → บันทึกและรีบูต
4. ดู http://192.168.1.111:8080/ → node ต้องขึ้นเป็นออนไลน์ภายใน ~10 วิ (มี boot event ในแท็บเหตุการณ์)
5. **ทดสอบ OTA**: บน Mac mini รัน `tools/release.sh 0.3.1` → dashboard จะโชว์ปุ่ม "อัปเดต OTA → 0.3.1" ที่ node → กด → node รีบูตกลับมาพร้อม fw 0.3.1 (ดูในการ์ด node)

## ถ้าติด
- ไม่เห็นพอร์ต: บอร์ด S3/C6 ใช้ USB ในตัว ไม่ต้องไดรเวอร์ · DevKit ใช้ CH9102X ถ้าไม่ขึ้นให้ลงไดรเวอร์ CH34x
- "Failed to initialize": กด BOOT ค้าง → กด RST → ปล่อย BOOT แล้วกด Install ใหม่
- ต่อ WiFi ไม่ได้: ใช้มือถือต่อ WiFi `GNOME-Scout-xxxx` รหัส `gnome1234` แล้วตั้งจากหน้าที่เด้งขึ้น
- ขึ้น dashboard แต่ offline ทันที: เช็ค MQTT host/password (ดูหน้าเว็บ node จะบอกว่า MQTT ต่อไม่ได้)
- อ่าน log: `tools/monitor.sh` บน Mac mini (115200)
