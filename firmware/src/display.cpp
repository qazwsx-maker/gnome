// จอ OLED I2C (SH1106 / SSD1306 128x64) — auto-detect 0x3C/0x3D
// หน้าตาภูต: port จาก Platypus face engine (github.com/qazwsx-maker/platypus — sim/face.js + firmware/src/face)
//   โครงเดียวกัน: Pose ที่ ease เข้าหาเป้าหมาย · ตาโค้งมน · เปลือกตาบน/ล่างเอียงได้ · กระพริบ · saccade + wander · หายใจ
//   ย่อจาก 320x172 สี → 128x64 ขาวดำ (U8g2)
// ลำดับหน้า: ภูต → ค่าเซ็นเซอร์ตัวใหญ่ (วนทีละค่า) → ภูต → … → สถานะเครือข่าย
#include "gnome.h"
#include <Wire.h>
#include <WiFi.h>
#include <U8g2lib.h>
#include <math.h>

static U8G2* u8 = nullptr;
static uint32_t lastDraw = 0;

bool displayPresent() { return u8 != nullptr; }

// ---------------- Pose (มิเรอร์ของ Platypus POSES ย่อส่วน) ----------------
struct Pose {
  float eyeW, eyeH, eyeR, spacing, eyeY;
  float lidTop, lidTopTilt, lidBottom, happyArc;
  float mouthShow, mouthW, mouthCurve, mouthOpen;
  float lookX, lookY;
  uint8_t special;   // 0 none · 1 tears · 2 sweat · 3 rain · 4 wind · 5 water · 6 dead(X)
};

static Pose basePose() {
  Pose p{};
  p.eyeW = 30; p.eyeH = 32; p.eyeR = 12; p.spacing = 40; p.eyeY = 28;
  p.lidTop = 0; p.lidTopTilt = 0; p.lidBottom = 0; p.happyArc = 0;
  p.mouthShow = 0; p.mouthW = 18; p.mouthCurve = 0; p.mouthOpen = 0;
  p.lookX = 0; p.lookY = 0; p.special = 0;
  return p;
}

static Pose poseFor(Mood m) {
  Pose p = basePose();
  switch (m) {
    case MOOD_HAPPY:                                  // ยิ้มตาหยี
      p.happyArc = 1; p.mouthShow = 1; p.mouthCurve = 1; p.mouthW = 22; break;
    case MOOD_HOT:                                    // ร้อน: ตาหรี่ อ้าปากหอบ เหงื่อหยด
      p.eyeH = 22; p.lidTop = 0.24f; p.mouthShow = 1; p.mouthOpen = 0.75f; p.mouthW = 16;
      p.special = 2; break;
    case MOOD_SLEEPY:                                 // ง่วง: เปลือกตาตกครึ่ง
      p.eyeH = 30; p.lidTop = 0.55f; p.mouthShow = 0.5f; p.mouthW = 10; p.eyeY = 30; break;
    case MOOD_THIRSTY:                                // กระหาย: คิ้วตก ปากคว่ำ น้ำตา
      p.eyeH = 26; p.lidTop = 0.28f; p.lidTopTilt = -0.9f;
      p.mouthShow = 1; p.mouthCurve = -0.9f; p.mouthW = 18; p.special = 1; break;
    case MOOD_RAIN:                                   // ฝนตก: ตาโต ยิ้มน้อยๆ ฝนพรำ
      p.eyeW = 32; p.eyeH = 34; p.mouthShow = 0.7f; p.mouthCurve = 0.5f; p.mouthW = 16;
      p.special = 3; break;
    case MOOD_SICK:                                   // ป่วย: ตากากบาท ปากคว่ำ
      p.mouthShow = 1; p.mouthCurve = -0.6f; p.mouthW = 20; p.special = 6; break;
    case MOOD_WATERING:                               // กำลังรดน้ำ: ยิ้ม หยดน้ำ
      p.happyArc = 1; p.mouthShow = 1; p.mouthCurve = 1; p.mouthW = 22; p.special = 5; break;
    case MOOD_FAN:                                    // พัดลมทำงาน: ตาโต ลมพัด
      p.eyeW = 32; p.eyeH = 34; p.mouthShow = 1; p.mouthOpen = 0.35f; p.mouthW = 14;
      p.special = 4; break;
  }
  return p;
}

// ---------------- runtime state ----------------
static Pose cur = basePose(), tgt = basePose();
static Mood curMood = MOOD_HAPPY;
static float tsec = 0, blink = 0, blinkDir = 8, nextBlink = 1.2f;
static float saccX = 0, saccY = 0, nextSacc = 2.0f, gx = 0, gy = 0;

static inline float frand() { return (float)random(0, 1001) / 1000.0f; }
static inline float flerp(float a, float b, float k) { return a + (b - a) * k; }

static void faceUpdate(float dt) {
  Mood m = roleMood();
  if (m != curMood) { curMood = m; tgt = poseFor(m); }
  tsec += dt;
  const float k = 1.0f - powf(0.001f, dt);
#define L(f) cur.f = flerp(cur.f, tgt.f, k)
  L(eyeW); L(eyeH); L(eyeR); L(spacing); L(eyeY);
  L(lidTop); L(lidTopTilt); L(lidBottom); L(happyArc);
  L(mouthShow); L(mouthW); L(mouthCurve); L(mouthOpen); L(lookX); L(lookY);
#undef L
  cur.special = tgt.special;

  nextBlink -= dt;
  if (nextBlink <= 0 && blink == 0) blink = 0.0001f;
  if (blink > 0) {
    blink += dt * blinkDir;
    if (blink >= 1) { blink = 1; blinkDir = -9; }
    if (blink <= 0) { blink = 0; blinkDir = 8; nextBlink = 2.2f + frand() * 3; }
  }
  nextSacc -= dt;
  if (nextSacc <= 0) { saccX = (frand() * 2 - 1) * 0.6f; saccY = (frand() * 2 - 1) * 0.35f; nextSacc = 0.9f + frand() * 1.8f; }
  gx = flerp(gx, saccX * 0.55f, 9 * dt);
  gy = flerp(gy, saccY * 0.55f, 9 * dt);
}

// ---------------- primitives ----------------
static void thickQuad(float x0, float y0, float cx, float cy, float x1, float y1, float thick) {
  const int steps = 14; const int r = (int)fmaxf(1, thick / 2);
  for (int i = 0; i <= steps; i++) {
    const float t = (float)i / steps, mt = 1 - t;
    u8->drawDisc((int)(mt * mt * x0 + 2 * mt * t * cx + t * t * x1),
                 (int)(mt * mt * y0 + 2 * mt * t * cy + t * t * y1), r);
  }
}

static void drawEye(float cx, float cy, int dir) {
  const float squash = 1 - blink;
  const float h = fmaxf(3, cur.eyeH * squash), w = cur.eyeW;
  const float r = fminf(cur.eyeR, fminf(w / 2, h / 2));
  const int x = (int)(cx - w / 2), y = (int)(cy - h / 2);

  if (cur.special == 6) {                       // ตากากบาท (ป่วย)
    const int s = (int)(w * 0.34f);
    for (int o = -1; o <= 1; o++) {
      u8->drawLine(cx - s, cy - s + o, cx + s, cy + s + o);
      u8->drawLine(cx - s, cy + s + o, cx + s, cy - s + o);
    }
    return;
  }
  if (cur.happyArc > 0.5f && blink < 0.5f) {    // ตาโค้งยิ้ม
    const float span = w * 0.5f;
    thickQuad(cx - span, cy + h * 0.16f, cx, cy - h * 0.34f, cx + span, cy + h * 0.16f, fmaxf(4, h * 0.28f));
    return;
  }

  u8->drawRBox(x, y, (int)w, (int)h, (int)fmaxf(1, r));
  if (h > 12) {                                  // ประกายตา
    u8->setDrawColor(0);
    u8->drawDisc((int)(cx - w * 0.22f), (int)(cy - h * 0.24f), (int)fmaxf(1, w * 0.12f));
    u8->setDrawColor(1);
  }
  const float tiltPx = cur.lidTopTilt * h * 0.5f * dir;   // เปลือกตาบน (เอียงได้)
  const float lidBase = cur.lidTop * h;
  if (lidBase > 0.5f || fabsf(tiltPx) > 0.5f) {
    const float innerX = dir > 0 ? x + w : x, outerX = dir > 0 ? x : x + w;
    const float yInner = y + lidBase + tiltPx, yOuter = y + lidBase - tiltPx;
    u8->setDrawColor(0);
    u8->drawTriangle(outerX, y - 2, innerX, y - 2, innerX, yInner);
    u8->drawTriangle(outerX, y - 2, innerX, yInner, outerX, yOuter);
    u8->setDrawColor(1);
  }
  if (cur.lidBottom > 0.01f) {
    u8->setDrawColor(0);
    u8->drawBox(x - 2, (int)(y + h - cur.lidBottom * h), (int)w + 4, (int)(cur.lidBottom * h) + 3);
    u8->setDrawColor(1);
  }
}

static void drawMouth(float cx, float cy) {
  if (cur.mouthShow < 0.05f) return;
  const float w = cur.mouthW;
  if (cur.mouthOpen > 0.15f)
    u8->drawFilledEllipse((int)cx, (int)cy, (int)fmaxf(2, w * 0.42f), (int)fmaxf(2, 2 + cur.mouthOpen * 7));
  else
    thickQuad(cx - w / 2, cy, cx, cy + cur.mouthCurve * 7, cx + w / 2, cy, 3);
}

static void drawSpecial(float lx, float rx, float cy) {
  switch (cur.special) {
    case 1:                                     // น้ำตา
      for (int s = 0; s < 2; s++) {
        float x = s ? rx : lx, d = fmodf(tsec * 22 + s * 9, 26);
        u8->drawDisc((int)x, (int)(cy + cur.eyeH * 0.45f + d), d > 18 ? 1 : 2);
      }
      break;
    case 2: {                                   // เหงื่อ
      float d = fmodf(tsec * 16, 22);
      u8->drawDisc(112, (int)(12 + d), d > 15 ? 1 : 2);
      break; }
    case 3:                                     // ฝน
      for (int i = 0; i < 7; i++) u8->drawVLine(6 + i * 19, (int)fmodf(tsec * 46 + i * 11, 64), 4);
      break;
    case 4:                                     // ลม
      for (int i = 0; i < 3; i++) {
        int y = 12 + i * 20, x0 = (int)fmodf(tsec * 55 + i * 26, 150) - 22;
        u8->drawHLine(x0, y, 14); u8->drawHLine(x0 + 18, y + 2, 7);
      }
      break;
    case 5:                                     // หยดน้ำ
      for (int i = 0; i < 5; i++) {
        int x = 10 + i * 27, y = (int)fmodf(tsec * 38 + i * 13, 60);
        u8->drawDisc(x, y, 1); u8->drawPixel(x, y - 2);
      }
      break;
  }
}

static void drawFace() {
  const float breathe = sinf(tsec * 1.6f) * 1.6f;
  const float cy = cur.eyeY + breathe;
  const float wanderX = sinf(tsec * 0.63f) * 2.6f + sinf(tsec * 1.7f) * 0.8f;
  const float wanderY = sinf(tsec * 0.47f) * 1.5f;
  const float ox = gx * 7 + cur.lookX * 6 + wanderX;
  const float oy = gy * 4 + cur.lookY * 4 + wanderY;
  const float lx = 64 - cur.spacing / 2 + ox, rx = 64 + cur.spacing / 2 + ox;

  drawEye(lx, cy + oy, +1);
  drawEye(rx, cy + oy, -1);
  drawMouth(64 + ox, 52 + breathe);
  drawSpecial(lx, rx, cy + oy);
}

// ---------------- หน้าโชว์ค่า ----------------
static void iconThermo(int x, int y) {
  u8->drawRFrame(x + 6, y, 10, 20, 5);
  u8->drawBox(x + 9, y + 8, 4, 14);
  u8->drawDisc(x + 11, y + 23, 5);
  for (int i = 0; i < 3; i++) u8->drawHLine(x + 17, y + 4 + i * 5, 4);
}
static void iconDrop(int x, int y) {
  u8->drawDisc(x + 11, y + 19, 8);
  u8->drawTriangle(x + 3, y + 19, x + 19, y + 19, x + 11, y + 1);
  u8->setDrawColor(0); u8->drawDisc(x + 8, y + 20, 2); u8->setDrawColor(1);
}
static void iconSun(int x, int y) {
  u8->drawDisc(x + 11, y + 14, 6);
  for (int i = 0; i < 8; i++) {
    float a = i * 0.7854f;
    u8->drawLine(x + 11 + cosf(a) * 9, y + 14 + sinf(a) * 9, x + 11 + cosf(a) * 12, y + 14 + sinf(a) * 12);
  }
}
static void iconSprout(int x, int y) {
  u8->drawHLine(x + 1, y + 26, 21);
  for (int i = 0; i < 21; i += 4) u8->drawPixel(x + 1 + i, y + 28);
  u8->drawVLine(x + 11, y + 10, 16);
  u8->drawFilledEllipse(x + 6, y + 12, 5, 3);
  u8->drawFilledEllipse(x + 16, y + 8, 5, 3);
}
static void iconCloud(int x, int y) {
  u8->drawDisc(x + 7, y + 10, 5); u8->drawDisc(x + 15, y + 10, 6); u8->drawBox(x + 5, y + 10, 12, 4);
  for (int i = 0; i < 3; i++) u8->drawVLine(x + 5 + i * 6, y + 18 + (int)fmodf(tsec * 30 + i * 5, 8), 3);
}
static void iconPlug(int x, int y) {
  u8->drawRFrame(x + 4, y + 8, 15, 16, 3);
  u8->drawVLine(x + 8, y + 2, 7); u8->drawVLine(x + 14, y + 2, 7);
}
static void iconCam(int x, int y) {
  u8->drawRFrame(x + 1, y + 8, 21, 15, 3);
  u8->drawBox(x + 7, y + 5, 8, 4);
  u8->drawCircle(x + 11, y + 15, 5); u8->drawDisc(x + 11, y + 15, 2);
}

static void drawStat(const StatItem& s) {
  switch (s.icon) {
    case 2: iconDrop(6, 16); break;
    case 3: iconSun(6, 16); break;
    case 4: iconSprout(6, 16); break;
    case 5: iconCloud(6, 16); break;
    case 6: iconPlug(6, 16); break;
    case 7: iconCam(6, 16); break;
    default: iconThermo(6, 16); break;
  }
  u8->setFont(u8g2_font_6x12_tf);
  u8->drawStr(34, 20, s.label.c_str());

  bool numeric = s.value.length() > 0;
  for (size_t i = 0; i < s.value.length(); i++) { char c = s.value[i]; if (!(isdigit((int)c) || c == '.' || c == '-')) { numeric = false; break; } }
  if (numeric) {
    u8->setFont(u8g2_font_logisoso24_tn);
    u8->drawStr(34, 54, s.value.c_str());
    int w = u8->getStrWidth(s.value.c_str());
    u8->setFont(u8g2_font_6x12_tf);
    u8->drawStr(36 + w, 54, s.unit.c_str());
  } else {
    u8->setFont(u8g2_font_7x13B_tf);
    u8->drawStr(36, 46, s.value.c_str());
    u8->setFont(u8g2_font_6x12_tf);
    if (s.unit.length()) u8->drawStr(36, 60, s.unit.c_str());
  }
  // ตาเล็กๆ มุมขวาบน ให้รู้ว่ายังเป็นภูตตัวเดิม (กระพริบด้วย)
  if ((millis() % 4000) < 160) { u8->drawHLine(106, 8, 7); u8->drawHLine(117, 8, 7); }
  else { u8->drawRBox(106, 3, 7, 9, 3); u8->drawRBox(117, 3, 7, 9, 3); }
}

static void drawStatus() {
  u8->setFont(u8g2_font_7x13B_tf); u8->drawStr(0, 11, cfg.node.c_str());
  u8->setFont(u8g2_font_6x12_tf);
  String r = String(GNOME_ROLE); r.toUpperCase();
  u8->drawStr(128 - 6 * r.length(), 11, r.c_str());
  u8->drawHLine(0, 13, 128);
  String net;
  if (netPortalActive() && !netWifiConnected()) net = "AP " + WiFi.softAPIP().toString();
  else if (netWifiConnected()) net = netIp();
  else net = "WiFi ...";
  u8->drawStr(0, 25, net.c_str());
  if (netWifiConnected()) { String d = String(netRssi()) + "dB"; u8->drawStr(128 - 6 * d.length(), 25, d.c_str()); }
  u8->drawStr(0, 36, mqttIsConnected() ? (mqttServerOnline() ? "MQTT ok  hut ok" : "MQTT ok  hut ?") : (cfg.mqttHost.length() ? "MQTT connecting..." : "MQTT not set"));
  String lines[2]; int n = roleDisplayLines(lines, 2, 0);
  for (int i = 0; i < n && i < 2; i++) u8->drawStr(0, 47 + i * 9, lines[i].c_str());
  char up[16]; uint32_t s = millis() / 1000;
  snprintf(up, sizeof up, "%lud%02lu:%02lu", (unsigned long)(s / 86400), (unsigned long)((s / 3600) % 24), (unsigned long)((s / 60) % 60));
  u8->setFont(u8g2_font_4x6_tf); u8->drawStr(128 - 4 * strlen(up), 64, up);
}

// ---------------- setup / loop ----------------
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
  u8->begin(); u8->setContrast(180);
  cur = basePose(); curMood = roleMood(); tgt = poseFor(curMood);
  u8->clearBuffer(); u8->setFont(u8g2_font_7x13B_tf); u8->drawStr(24, 28, "GnomeOS");
  u8->setFont(u8g2_font_6x12_tf); u8->drawStr(24, 44, cfg.node.c_str()); u8->sendBuffer();
  Serial.printf("[oled] %s at 0x%02X\n", cfg.oled.c_str(), addr);
  lastDraw = millis();
}

void displayLoop() {
  if (!u8) return;
  const uint32_t now = millis();
  if (now - lastDraw < 66) return;             // ~15 fps
  const float dt = (now - lastDraw) / 1000.0f;
  lastDraw = now;

  static uint8_t step = 0; static uint32_t pageAt = 0;
  StatItem stats[8]; const int nStat = roleStats(stats, 8);
  const bool facePage = (step % 2) == 0;
  if (pageAt == 0) pageAt = now;
  if (now - pageAt > (uint32_t)(facePage ? 5000 : 3500)) { pageAt = now; step = (step + 1) % (uint8_t)(2 * (nStat + 1)); }

  faceUpdate(dt);
  u8->clearBuffer();
  u8->setDrawColor(1);
  if (facePage) drawFace();
  else {
    const int idx = (step / 2) % (nStat + 1);
    if (idx < nStat) drawStat(stats[idx]); else drawStatus();
  }
  u8->sendBuffer();
}
