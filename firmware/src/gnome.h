#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include "config.h"

// ---- LED (สถานะ) ----
enum LedMode { LED_PORTAL, LED_WIFI_ONLY, LED_OK, LED_IDENTIFY };
void ledSetMode(LedMode m);
void ledLoop();

// ---- network / web ----
void netSetup();
void netLoop();
bool netPortalActive();
String netIp();
int netRssi();
bool netWifiConnected();
void netRequestReboot(uint32_t delayMs = 600);

// ---- mqtt ----
void mqttSetup();
void mqttLoop();
bool mqttIsConnected();
uint32_t mqttLastOkMs();          // millis() ครั้งล่าสุดที่ MQTT ปกติ (0 = ไม่เคย)
bool mqttServerOnline();          // gnome/server/status
void mqttPublish(const String& sub, const String& payload, bool retained = false, int qos = 0);
void mqttEvent(const char* type, const String& extraJsonFields = "");   // extraJsonFields เช่น "\"key\":\"drip\""
void mqttPublishMeta();

// ---- role hooks (scout.cpp / keeper.cpp) ----
void roleSetup();
void roleLoop();
void roleOnMqttConnect();
void roleMeta(JsonObject meta);            // เติม sensors/switches ลง meta
void roleStatus(JsonObject st);            // สำหรับ /api/status
bool roleCommand(const String& sub, const String& payload);  // sub = หลัง gnome/<node>/ ; return true ถ้าจัดการแล้ว
bool roleWebSwitch(const String& key, bool on, int seconds);  // จากหน้าเว็บ (keeper)
void roleRescan();                          // scout: สแกน I2C ใหม่
int  roleDisplayLines(String* lines, int max, int page);  // ข้อความ 1-3 บรรทัดสำหรับจอ OLED

// ---- อารมณ์ของภูต (หน้าบนจอ OLED) ----
enum Mood { MOOD_HAPPY, MOOD_HOT, MOOD_SLEEPY, MOOD_THIRSTY, MOOD_RAIN, MOOD_SICK, MOOD_WATERING, MOOD_FAN };
Mood roleMood();

// ---- display (OLED) ----
void displaySetup();
void displayLoop();
bool displayPresent();
