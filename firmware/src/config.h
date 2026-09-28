#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

#if defined(GNOME_ROLE_KEEPER)
#define GNOME_ROLE "keeper"
#define GNOME_FW_NAME "gnomeos-keeper"
#else
#define GNOME_ROLE "scout"
#define GNOME_FW_NAME "gnomeos-scout"
#endif
#ifndef GNOME_VERSION
#define GNOME_VERSION "0.0.0"
#endif

#define GNOME_MAX_SOIL 6
#define GNOME_MAX_SWITCH 4
#define GNOME_AP_PASS "gnome1234"   // รหัส WiFi ของ node ตอนอยู่โหมดตั้งค่า
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
};

extern Config cfg;
String defaultNodeName();
String macTail();          // 4 ตัวท้ายของ MAC (พิมพ์เล็ก) ใช้ได้ก่อน WiFi เริ่ม
void configLoad();
void configSave();
void configToJson(JsonObject o, bool includeSecrets);
bool configApplyJson(JsonObjectConst o);   // merge/patch, returns true if something changed
void configSetDefaults();
