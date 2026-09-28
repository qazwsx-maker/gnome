// จอ OLED I2C (SH1106 / SSD1306 128x64) แสดงสถานะ node หน้างาน — auto-detect ที่ 0x3C/0x3D
#include "gnome.h"
#include <Wire.h>
#include <WiFi.h>
#include <U8g2lib.h>

static U8G2* u8 = nullptr;
static uint32_t lastDraw = 0;
static uint8_t page = 0;

bool displayPresent() { return u8 != nullptr; }

void displaySetup() {
  if (u8) { delete u8; u8 = nullptr; }
  if (cfg.oled == "none") return;
  Wire.begin(cfg.i2cSda, cfg.i2cScl);
  uint8_t addr = 0;
  for (uint8_t a : {0x3C, 0x3D}) { Wire.beginTransmission(a); if (Wire.endTransmission() == 0) { addr = a; break; } }
  if (!addr) { Serial.println("[oled] not found"); return; }
  if (cfg.oled == "ssd1306") u8 = new U8G2_SSD1306_128X64_NONAME_F_HW_I2C(U8G2_R0, U8X8_PIN_NONE, cfg.i2cScl, cfg.i2cSda);
  else                       u8 = new U8G2_SH1106_128X64_NONAME_F_HW_I2C(U8G2_R0, U8X8_PIN_NONE, cfg.i2cScl, cfg.i2cSda);
  u8->setI2CAddress(addr << 1);
  u8->begin(); u8->setContrast(160);
  u8->clearBuffer(); u8->setFont(u8g2_font_7x13B_tf); u8->drawStr(0, 14, "GnomeOS"); u8->setFont(u8g2_font_6x12_tf);
  u8->drawStr(0, 30, (String(GNOME_FW_NAME) + " " + GNOME_VERSION).c_str()); u8->drawStr(0, 46, cfg.node.c_str()); u8->sendBuffer();
  Serial.printf("[oled] %s at 0x%02X\n", cfg.oled.c_str(), addr);
  lastDraw = millis();
}

void displayLoop() {
  if (!u8 || millis() - lastDraw < 1000) return;
  lastDraw = millis();
  u8->clearBuffer();
  // บรรทัด 1: ชื่อ node + role
  u8->setFont(u8g2_font_7x13B_tf); u8->drawStr(0, 11, cfg.node.c_str());
  u8->setFont(u8g2_font_6x12_tf);
  String r = String(GNOME_ROLE); r.toUpperCase(); u8->drawStr(128 - 6 * r.length(), 11, r.c_str());
  u8->drawHLine(0, 13, 128);
  // บรรทัด 2: เครือข่าย
  String net;
  if (netPortalActive() && !netWifiConnected()) net = "AP " + String(WiFi.softAPIP().toString());
  else if (netWifiConnected()) net = netIp() + " " + String(netRssi()) + "dB";
  else net = "WiFi ...";
  u8->drawStr(0, 24, net.c_str());
  // บรรทัด 3: MQTT
  String mq = mqttIsConnected() ? (mqttServerOnline() ? "MQTT ok  server ok" : "MQTT ok  server ?") : (cfg.mqttHost.length() ? "MQTT connecting..." : "MQTT not set");
  u8->drawStr(0, 35, mq.c_str());
  // บรรทัด 4-6: ของ role
  String lines[3]; int n = roleDisplayLines(lines, 3, page);
  for (int i = 0; i < n; i++) u8->drawStr(0, 46 + i * 9, lines[i].c_str());
  // มุมล่างขวา: uptime
  char up[16]; uint32_t s = millis() / 1000; snprintf(up, sizeof up, "%lud%02lu:%02lu", (unsigned long)(s / 86400), (unsigned long)((s / 3600) % 24), (unsigned long)((s / 60) % 60));
  u8->setFont(u8g2_font_4x6_tf); u8->drawStr(128 - 4 * strlen(up), 64, up);
  u8->sendBuffer();
  if ((millis() / 5000) % 2 == 0) page = 0; else page = 1;
}
