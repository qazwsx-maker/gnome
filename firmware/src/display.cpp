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
  if (cfg.oled == "none" || cfg.i2cSda < 0) return;
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

// ---------- หน้าอารมณ์ ----------
static void drawFace(Mood m) {
  uint32_t t = millis();
  bool blink = (t % 4000) < 150;                  // กะพริบตาทุก 4 s
  int ex1 = 44, ex2 = 84, ey = 26;                 // ตำแหน่งตา
  // ตา
  if (m == MOOD_SLEEPY) { u8->drawHLine(ex1 - 9, ey, 18); u8->drawHLine(ex2 - 9, ey, 18); }
  else if (m == MOOD_SICK) { for (int d = -6; d <= 6; d++) { u8->drawPixel(ex1 + d, ey + d); u8->drawPixel(ex1 + d, ey - d); u8->drawPixel(ex2 + d, ey + d); u8->drawPixel(ex2 + d, ey - d); }
    u8->drawLine(ex1 - 7, ey - 7, ex1 + 7, ey + 7); u8->drawLine(ex1 - 7, ey + 7, ex1 + 7, ey - 7); u8->drawLine(ex2 - 7, ey - 7, ex2 + 7, ey + 7); u8->drawLine(ex2 - 7, ey + 7, ex2 + 7, ey - 7); }
  else if (blink) { u8->drawHLine(ex1 - 8, ey, 16); u8->drawHLine(ex2 - 8, ey, 16); }
  else {
    int r = (m == MOOD_HOT || m == MOOD_THIRSTY) ? 7 : 9;
    u8->drawDisc(ex1, ey, r); u8->drawDisc(ex2, ey, r);
    u8->setDrawColor(0); u8->drawDisc(ex1 + 3, ey - 3, 2); u8->drawDisc(ex2 + 3, ey - 3, 2); u8->setDrawColor(1);   // ประกายตา
    if (m == MOOD_THIRSTY) { u8->drawLine(ex1 - 10, ey - 12, ex1 + 4, ey - 9); u8->drawLine(ex2 + 10, ey - 12, ex2 - 4, ey - 9); }   // คิ้วตก
  }
  // ปาก
  int my = 44;
  switch (m) {
    case MOOD_HAPPY: case MOOD_WATERING: case MOOD_FAN:
      for (int x = -14; x <= 14; x++) u8->drawPixel(64 + x, my - (x * x) / 20 + 6); u8->drawPixel(64 - 14, my + 1 - 9 + 6); break;   // ยิ้ม
    case MOOD_HOT: u8->drawEllipse(64, my + 2, 6, 5); break;                                        // อ้าปากหอบ
    case MOOD_SLEEPY: u8->drawEllipse(64, my + 2, 3, 4); break;                                     // หาว
    case MOOD_THIRSTY: for (int x = -12; x <= 12; x++) u8->drawPixel(64 + x, my + 2 + (x * x) / 24); break;   // ปากคว่ำ
    case MOOD_RAIN: u8->drawHLine(56, my + 2, 16); break;
    case MOOD_SICK: for (int x = -12; x <= 12; x++) u8->drawPixel(64 + x, my + 2 + ((x / 4) % 2 ? 1 : -1)); break;   // ปากหยัก
  }
  // ของประกอบ
  int ph = (t / 150) % 8;
  if (m == MOOD_HOT) { u8->drawDisc(104, 16 + ph, 2); u8->drawLine(104, 11 + ph, 102, 15 + ph); u8->drawLine(104, 11 + ph, 106, 15 + ph); }    // เหงื่อ
  if (m == MOOD_SLEEPY) { u8->setFont(u8g2_font_6x12_tf); u8->drawStr(100, 14 + (ph > 3 ? -1 : 0), "z"); u8->setFont(u8g2_font_7x13B_tf); u8->drawStr(108, 10, "Z"); }
  if (m == MOOD_RAIN) for (int i = 0; i < 6; i++) { int x = 6 + i * 22, y = (t / 60 + i * 9) % 56; u8->drawVLine(x, y, 4); }                   // ฝน
  if (m == MOOD_WATERING) for (int i = 0; i < 4; i++) { int x = 12 + i * 8, y = 8 + (t / 80 + i * 5) % 40; u8->drawDisc(x, y, 1); u8->drawPixel(x, y - 2); }   // หยดน้ำ
  if (m == MOOD_FAN) for (int i = 0; i < 3; i++) { int y = 10 + i * 8; int x0 = (t / 40 + i * 10) % 40; u8->drawHLine(x0, y, 8); u8->drawHLine(x0 + 12, y + 2, 5); }   // ลม
  if (m == MOOD_THIRSTY) { u8->drawDisc(104, 22 + ph / 2, 2); }   // น้ำตา
  // คำบรรยาย
  static const char* cap[] = { "happy :)", "so hot..", "zzz", "thirsty!", "rain!", "help?!", "watering~", "breezy~" };
  u8->setFont(u8g2_font_6x12_tf); const char* c = cap[m]; u8->drawStr(64 - 3 * strlen(c), 63, c);
}

void displayLoop() {
  if (!u8) return;
  bool facePage = (millis() % 10000) < 6000;   // หน้า 6 s · ข้อมูล 4 s
  if (facePage) { if (millis() - lastDraw < 100) return; }   // หน้ามี animation → วาดถี่
  else if (millis() - lastDraw < 1000) return;
  lastDraw = millis();
  u8->clearBuffer();
  if (facePage) { drawFace(roleMood()); u8->sendBuffer(); return; }
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
