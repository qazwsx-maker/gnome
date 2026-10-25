#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

#if defined(GNOME_ROLE_KEEPER)
#define GNOME_ROLE "keeper"
#define GNOME_FW_NAME "gnomeos-keeper"
#elif defined(GNOME_ROLE_CAM)
#define GNOME_ROLE "cam"
#define GNOME_FW_NAME "gnomeos-watcher"
#else
#define GNOME_ROLE "scout"
#define GNOME_FW_NAME "gnomeos-scout"
#endif
#include "version.h"

#define GNOME_MAX_SOIL 6
#define GNOME_MAX_SWITCH 4
#define GNOME_MAX_PRESET 4
#define CONT_MIN_US 5       // โหมด 360°: แรงหมุนต่ำสุด (SG90 360° ไวมาก 30 µs ยังเร็ว)
#define CONT_MAX_US 150     // โหมด 360°: แรงหมุนสูงสุด (ห้ามหมุนเร็ว)
#define CONT_MAX_MS 300
#define SERVO_MAX_SPEED 30   // องศา/วิ สูงสุดที่ยอมให้ตั้ง (ความเร็ว "ยอดคลื่น" ของการหมุน ไม่ใช่ค่าเฉลี่ย)
#define GNOME_AP_PASS "gnome1234"   // รหัส WiFi ของ node ตอนอยู่โหมดตั้งค่า
#if defined(GNOME_ROLE_CAM)
  // ESP32-CAM: LED แดงหลังบอร์ด GPIO33 (active-low), ไม่มี I2C ว่าง (ขา 21/22 เป็นของกล้อง)
  #define GNOME_LED_PIN 33
  #define GNOME_LED_INVERT 1
  #define GNOME_I2C_SDA -1
  #define GNOME_I2C_SCL -1
#endif
#if defined(GNOME_BOARD_S3UNO)
  // ESP32-S3 UNO: RGB WS2812 ที่ IO48, ไม่มี LED ธรรมดา, I2C ที่ IO8/IO9 (ตำแหน่ง SDA/SCL ของ UNO)
  #define GNOME_RGB_PIN 48
  #define GNOME_LED_PIN -1
  #define GNOME_I2C_SDA 8
  #define GNOME_I2C_SCL 9
#endif
#if defined(GNOME_BOARD_C6LCD)
  // Waveshare ESP32-C6-LCD-1.47: RGB WS2812 ที่ GPIO8, ไม่มี LED ธรรมดา, I2C ว่างที่ 18/19 (LCD/SD ใช้ 4-7,14,15,21,22)
  #define GNOME_RGB_PIN 8
  #define GNOME_LED_PIN -1
  #define GNOME_I2C_SDA 19
  #define GNOME_I2C_SCL 18
#endif
#ifndef GNOME_LED_PIN
#define GNOME_LED_PIN 2
#endif
#ifndef GNOME_I2C_SDA
#define GNOME_I2C_SDA 21
#define GNOME_I2C_SCL 22
#endif
#ifndef GNOME_BOARD
#define GNOME_BOARD "esp32dev"
#endif

struct SoilCfg { int pin = -1; int dry = 3100; int wet = 1300; String key; };  // key ว่าง = soilN
struct PresetCfg { String name; int angle = 90; int tilt = -1; };   // tilt -1 = ไม่เปลี่ยนแกนก้มเงย

struct SwitchCfg {
  String key; int pin = -1; bool activeLow = true; int maxOnS = 600; String exclusive; // comma-separated keys
};

struct Config {
  String node;          // ชื่อ node (a-z0-9-)
  String wifiSsid, wifiPass;
  String mqttHost = ""; int mqttPort = 1883; String mqttUser = "gnome", mqttPass = "";
  int intervalS = 30;
  int i2cSda = GNOME_I2C_SDA, i2cScl = GNOME_I2C_SCL;
  int thirstyPct = 35;     // ดินต่ำกว่านี้ = หน้ากระหาย (json: thirsty_pct)
  int hotC = 34;           // ร้อนกว่านี้ = หน้าร้อน (json: hot_c)
  int dhtPin = -1;
  int soilPowerPin = -1;   // จ่ายไฟหัววัด analog เฉพาะตอนวัด (ลดการกร่อนของหัว resistive) -1 = ไม่ใช้
  SoilCfg soil[GNOME_MAX_SOIL]; int soilCount = 0;
  SwitchCfg sw[GNOME_MAX_SWITCH]; int swCount = 0;
  int failsafeS = 120;
  String oled = "sh1106";   // sh1106 | ssd1306 | none (auto-detect 0x3C/0x3D บน I2C)
  // Watcher (cam)
  String hutUrl;            // ว่าง = http://<mqtt_host>:8080
  String camSize = "svga";  // vga | svga | xga | uxga
  bool camFlash = false;    // เปิดไฟแฟลช GPIO4 ตอนถ่าย
  bool camVflip = false;    // กลับบน-ล่าง
  bool camMirror = false;   // กลับซ้าย-ขวา (กระจก)
  // ภาพ (OV2640) — ปรับสดด้วย cmd/img ไม่ต้องรีบูต (ยกเว้น xclk) · ค่าเริ่มคือค่าเดิมของไดรเวอร์
  int camAeLevel = 0;       // -2..2 ชดเชยแสง: ลบ = มืดลง กันขาวโพลนกลางแดด
  int camGainCeil = 6;      // 0..6 = 2x..128x เพดาน gain ตอนมืด (ต่ำ = noise น้อย)
  bool camAec2 = false;     // AEC แบบ DSP (เหมาะกลางคืน)
  int camBrightness = 0, camContrast = 0, camSaturation = 0;   // -2..2
  int camWbMode = 0;        // 0 auto · 1 แดด · 2 เมฆ · 3 ออฟฟิศ · 4 บ้าน
  int camXclkMhz = 20;      // 20 = สีตรง · 10 ทำให้ส่วนสว่างกลางแดดเป็นสีชมพูทึบ (2026-10-25) แต่ WiFi นิ่งกว่า · ต้องรีบูต
  // servo หัน (pan) ของ Watcher — ESP32-CAM ใช้ขาว่าง 13/14/15 ได้ (เมื่อไม่ใช้ SD card)
  int servoPin = -1;        // -1 = ไม่มี servo
  int servoMinUs = 500, servoMaxUs = 2400;
  int servoAngle = 90;      // มุมล่าสุด (จำไว้ใน NVS)
  bool servoInvert = false;
  int servoHoldMs = 5000;   // ค้างแรงหลังพัลส์สุดท้ายนานเท่าไร (ms) ก่อนปล่อย — สั้นไป = สั่งครั้งต่อไปกระชากกลับเข้าตำแหน่ง, ยาวไป = เสี่ยงส่าย/ร้อน
  int servoSpeed = 10;      // ความเร็วหมุน องศา/วิ ทั้งสองแกน · จำกัด 1–SERVO_MAX_SPEED (ห้ามหมุนเร็ว: สายหลุด / bracket พัง)
  // servo ก้มเงย (tilt) — ขาที่สอง (แนะนำ pan 14 / tilt 15) · tiltMin/Max กันกล้องชนขาตั้ง
  int tiltPin = -1; int tiltAngle = 90; bool tiltInvert = false; int tiltMin = 0, tiltMax = 180;
  int panMin = 0, panMax = 180;   // ขอบเขตมุมหัน (ตั้งจาก dashboard ได้ทันทีผ่าน cmd/servo)
  // pan แบบ servo หมุนรอบตัว (360° continuous): พัลส์ = ความเร็ว ไม่ใช่มุม → ขยับเป็น "ก้าว" = หมุนช้าๆ contMs แล้วปล่อยสัญญาณ (หยุด)
  bool panCont = false;     // true = โหมดหมุนรอบตัว
  int stopUs = 1500;        // พัลส์ที่ servo หยุดนิ่ง (จุดกลาง ปรับได้ถ้าคืบเอง)
  int contUs = 15;          // ห่างจากจุดหยุดกี่ µs ตอนหมุน (มาก = เร็ว) จำกัด CONT_MIN_US–CONT_MAX_US
  int contMs = 20;          // หมุนนานเท่าไรต่อ 1 ก้าว (ms) จำกัด 20–CONT_MAX_MS (20 ms = 1 พัลส์)
  int contLimit = 20;       // ก้าวสุทธิสูงสุดจากหน้าตรงต่อฝั่ง (กันสายพัน) 0 = ไม่จำกัด
  int contPos = 0;          // ก้าวสุทธิจากหน้าตรง (ประมาณการ ไม่มี feedback)
  PresetCfg preset[GNOME_MAX_PRESET]; int presetCount = 0;
};

extern Config cfg;
String defaultNodeName();
String macTail();          // 4 ตัวท้ายของ MAC (พิมพ์เล็ก) ใช้ได้ก่อน WiFi เริ่ม
void configLoad();
void configSave();
void configToJson(JsonObject o, bool includeSecrets);
bool configApplyJson(JsonObjectConst o);   // merge/patch, returns true if something changed
void configSetDefaults();
