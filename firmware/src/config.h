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
#ifndef GNOME_LED_PIN
#define GNOME_LED_PIN 2
#endif
#ifndef GNOME_BOARD
#define GNOME_BOARD "esp32dev"
#endif

struct SoilCfg { int pin = -1; int dry = 3100; int wet = 1300; };
struct SwitchCfg {
  String key; int pin = -1; bool activeLow = true; int maxOnS = 600; String exclusive; // comma-separated keys
};

struct Config {
  String node;          // ชื่อ node (a-z0-9-)
  String wifiSsid, wifiPass;
  String mqttHost = ""; int mqttPort = 1883; String mqttUser = "gnome", mqttPass = "";
  int intervalS = 30;
  int i2cSda = 21, i2cScl = 22;
  int dhtPin = -1;
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
