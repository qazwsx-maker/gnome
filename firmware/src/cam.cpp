#if defined(GNOME_ROLE_CAM)
// GnomeOS Watcher — ESP32-CAM (AI-Thinker, OV2640)
//   - ถ่าย JPEG ทุก interval_s แล้ว POST ไป Hut  {hut_url}/api/cam/<node>/snapshot
//   - เว็บสตรีมสดที่พอร์ต 81: /stream (MJPEG) และ /snapshot (JPEG) — รันใน task แยก ไม่บล็อก MQTT
//   - cmd/snap = ถ่ายทันที · cmd/flash ON|OFF = ไฟแฟลช GPIO4
//   - servo pan (หัน) + tilt (ก้มเงย) บนขาตั้ง pan-tilt SG90 ×2: cmd/pan <มุม|preset> · cmd/tilt <มุม> · cmd/patrol
//     ขาแนะนำ pan 14 / tilt 15 (ขา SD ที่ว่าง; ห้าม 12 = strapping pin) · ภาพที่ส่งติด header X-Angle / X-Tilt
#include "gnome.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <esp_camera.h>
#include <esp_http_server.h>

// AI-Thinker ESP32-CAM pin map
#define CAM_PIN_PWDN 32
#define CAM_PIN_RESET -1
#define CAM_PIN_XCLK 0
#define CAM_PIN_SIOD 26
#define CAM_PIN_SIOC 27
#define CAM_PIN_D7 35
#define CAM_PIN_D6 34
#define CAM_PIN_D5 39
#define CAM_PIN_D4 36
#define CAM_PIN_D3 21
#define CAM_PIN_D2 19
#define CAM_PIN_D1 18
#define CAM_PIN_D0 5
#define CAM_PIN_VSYNC 25
#define CAM_PIN_HREF 23
#define CAM_PIN_PCLK 22
#define CAM_FLASH_PIN 4

// ---------- servo: หัน (pan) + ก้มเงย (tilt) ----------
// LEDC: กล้องใช้ channel 0 / timer 0 อยู่แล้ว → pan ใช้ channel 2 (timer 1), tilt ใช้ channel 4 (timer 2) เพื่อไม่ชนกัน
// ทั้งสองแกนใช้ pulse min/max เดียวกัน (SG90 ทั้งคู่) · หลังหมุนถึงแล้วปล่อยสัญญาณเพื่อลดเสียงสั่น/ความร้อน
struct ServoAxis { const char* name; int ch; bool on; uint32_t idleAt; ServoAxis(const char* n, int c) : name(n), ch(c), on(false), idleAt(0) {} };
static ServoAxis panAx  = { "pan",  2 };
static ServoAxis tiltAx = { "tilt", 4 };
static int axisPin(const ServoAxis& ax) { return &ax == &panAx ? cfg.servoPin : cfg.tiltPin; }

static void servoWrite(ServoAxis& ax, float angle, bool invert) {
  int pin = axisPin(ax); if (pin < 0) return;
  angle = constrain(angle, 0.0f, 180.0f);
  float a = invert ? 180.0f - angle : angle;
  float us = cfg.servoMinUs + (cfg.servoMaxUs - cfg.servoMinUs) * a / 180.0f;   // ทศนิยม → ขยับทีละน้อยได้เนียน
  uint32_t duty = (uint32_t)(us * 65536.0f / 20000.0f);   // 50 Hz, 16-bit
  if (!ax.on) { ledcSetup(ax.ch, 50, 16); ledcWrite(ax.ch, duty); ledcAttachPin(pin, ax.ch); ax.on = true; }   // ตั้งพัลส์ก่อนต่อขา กันพัลส์แรกเพี้ยน
  else ledcWrite(ax.ch, duty);
  // ปล่อยสัญญาณ 0.8 วิหลังพัลส์สุดท้าย — ห้ามล็อกค้าง: 2026-10-23 (0.7.8) ล็อกตลอดแล้ว SG90 ส่ายไปมา ±30° กับโหลดหนัก
  // (hunting) เสี่ยง bracket พัง/สายหลุด · ตอนไม่มีสัญญาณ เฟืองของ SG90 ยังต้านไว้เองพอสมควร
  ax.idleAt = millis() + (uint32_t)cfg.servoHoldMs;
}
static void servoWriteUs(ServoAxis& ax, int us) {
  int pin = axisPin(ax); if (pin < 0) return;
  uint32_t duty = (uint32_t)((float)us * 65536.0f / 20000.0f);
  if (!ax.on) { ledcSetup(ax.ch, 50, 16); ledcWrite(ax.ch, duty); ledcAttachPin(pin, ax.ch); ax.on = true; }
  else ledcWrite(ax.ch, duty);
  ax.idleAt = millis() + (uint32_t)cfg.servoHoldMs;
}
static void servoRelease(ServoAxis& ax);
static bool panCont() { return cfg.servoPin >= 0 && cfg.panCont; }
/** โหมด 360°: หมุน |steps| ก้าว ทีละก้าว = พัลส์ (stop ± contUs) นาน contMs แล้วปล่อยสัญญาณให้หยุด · ไม่เกิน contLimit จากหน้าตรง
 *  คืนจำนวนก้าวที่ทำจริง (ถูกตัดเมื่อชนเพดาน) */
static int contNudge(int steps) {
  int dir = steps > 0 ? 1 : -1, done = 0;
  bool inv = cfg.servoInvert;
  for (int i = 0; i < abs(steps); i++) {
    if (cfg.contLimit > 0 && abs(cfg.contPos + dir) > cfg.contLimit) break;
    int us = cfg.stopUs + (inv ? -dir : dir) * constrain(cfg.contUs, CONT_MIN_US, CONT_MAX_US);
    servoWriteUs(panAx, us);
    delay(constrain(cfg.contMs, 20, CONT_MAX_MS));
    servoRelease(panAx);              // ไม่มีพัลส์ = มอเตอร์หยุด (ไม่ต้องรู้จุดหยุดที่แม่นยำ)
    cfg.contPos += dir; done++;
    delay(60);
  }
  return done;
}
static void servoRelease(ServoAxis& ax) {
  if (!ax.on) return;
  int pin = axisPin(ax);
  // ดึงขาลงต่ำค้าง ไม่ปล่อยลอย (INPUT) — สายสัญญาณลอยรับสัญญาณรบกวน servo 360° อ่านเป็นพัลส์แล้วหมุนเองได้
  ledcWrite(ax.ch, 0); ledcDetachPin(pin); pinMode(pin, OUTPUT); digitalWrite(pin, LOW);
  ax.on = false;
}
static bool hasTilt() { return cfg.tiltPin >= 0; }
static int clampTilt(int a) { return constrain(a, cfg.tiltMin, cfg.tiltMax); }
static int clampPan(int a) { return constrain(a, cfg.panMin, cfg.panMax); }

/** หัน/ก้มเงยไปที่มุม (-1 = แกนนั้นไม่ขยับ) แล้วรอให้นิ่งก่อนถ่าย
 *  ขยับ "ทีละแกน" ไม่พร้อมกัน — SG90 ตอนออกตัวดึงได้ถึง ~0.6 A ต่อตัว สองตัวพร้อมกันบนไฟ 5V ของ ESP32-CAM
 *  (ที่กำลังส่ง WiFi อยู่) เสี่ยง brownout รีบูต · ขยับทีละตัวพีคเหลือครึ่งเดียว */
// หมุนนุ่ม: ไล่มุมทีละเฟรม servo (20 ms) ด้วยความเร็ว servo_speed องศา/วิ + ease in-out (smoothstep)
// แทนการกระโดดไปมุมใหม่ทันที (SG90 ไม่มีการคุมความเร็วเอง → เดิมสะบัดแรง กล้องสั่น ภาพเบลอ ดึงไฟพีค)
static void glide(ServoAxis& ax, int from, int to, bool invert) {
  int delta = abs(to - from);
  if (delta == 0) { servoWrite(ax, to, invert); return; }
  int speed = constrain(cfg.servoSpeed, 1, SERVO_MAX_SPEED);
  // smoothstep มีความเร็วสูงสุดกลางทาง = 1.5 × เฉลี่ย → ยืดเวลาให้ช่วงที่เร็วที่สุดยังไม่เกิน speed
  uint32_t dur = (uint32_t)delta * 1500 / speed; if (dur < 100) dur = 100;
  uint32_t t0 = millis();
  for (;;) {
    float t = (float)(millis() - t0) / dur; if (t > 1) t = 1;
    float e = t * t * (3 - 2 * t);                       // smoothstep: ค่อยๆ ออกตัว ค่อยๆ หยุด
    servoWrite(ax, from + (to - from) * e, invert);
    if (t >= 1) break;
    delay(20);
  }
  delay(delta <= 3 ? 30 : 250);   // settle ก่อนถ่าย (ขยับทีละองศาไม่ต้องรอนาน)
}
static uint32_t saveDueAt = 0;
static void moveTo(int pan, int tilt, bool save = true) {
  bool moved = false;
  if (pan >= 0 && cfg.servoPin >= 0 && !cfg.panCont) {   // โหมด 360° ห้ามส่งพัลส์มุม (= สั่งหมุนเต็มแรง)
    pan = clampPan(pan);
    glide(panAx, cfg.servoAngle, pan, cfg.servoInvert); cfg.servoAngle = pan; moved = true;
  }
  if (tilt >= 0 && hasTilt()) {
    tilt = clampTilt(tilt);
    glide(tiltAx, cfg.tiltAngle, tilt, cfg.tiltInvert); cfg.tiltAngle = tilt; moved = true;
  }
  if (!moved) return;
  if (save) saveDueAt = millis() + 3000;   // เลื่อนการเขียน NVS ไป 3 วิหลังขยับครั้งสุดท้าย (กดทีละองศารัวๆ ไม่เขียนแฟลชทุกครั้ง)
  Serial.printf("[servo] pan %d tilt %d\n", cfg.servoAngle, hasTilt() ? cfg.tiltAngle : -1);
}
static void panTo(int angle, bool save = true) { moveTo(angle, -1, save); }
// "90" = มุมตรงๆ · "+1" / "-3" = ขยับจากมุมปัจจุบัน (ปุ่ม ±1° บน dashboard) · คืน -999 ถ้าอ่านไม่ได้
static int parseAngle(const String& p, int cur) {
  if (!p.length()) return -999;
  if (p[0] == '+' || p[0] == '-') { String n = p.substring(1); if (!n.length() || !isDigit(n[0])) return -999; int d = n.toInt(); return cur + (p[0] == '+' ? d : -d); }
  return isDigit(p[0]) ? p.toInt() : -999;
}
static void tiltTo(int angle, bool save = true) { moveTo(-1, angle, save); }
static const PresetCfg* findPreset(const String& name) {
  for (int i = 0; i < cfg.presetCount; i++) if (cfg.preset[i].name == name) return &cfg.preset[i];
  return nullptr;
}
static String anglesJson() { String s = panCont() ? "\"steps\":" + String(cfg.contPos) : "\"angle\":" + String(cfg.servoAngle); if (hasTilt()) s += ",\"tilt\":" + String(cfg.tiltAngle); return s; }

static bool snapAndUpload(const char* reason);
static bool camOk = false;
static httpd_handle_t streamd = nullptr;
static uint32_t lastShot = 0;
// ดูสดแบบกล้องส่งเฟรมขึ้น Hut เอง (2026-10-24 ที่สวน: การเชื่อมต่อขาเข้า :81 ช้ามาก แต่ขาออกจากกล้องเร็ว)
static uint32_t liveUntil = 0, liveLast = 0; static uint32_t liveIntervalMs = 700;
static bool liveSmall = false;
static int lastCode = 0, lastBytes = 0; static uint32_t lastUploadMs = 0, lastUploadDur = 0; static int uploads = 0, fails = 0;
static bool flashOn = false;
static SemaphoreHandle_t camLock;
static framesize_t sizeFromCfg();
/** ระหว่างดูสดใช้ QVGA 320×240 (~10 kB แทน ~33 kB) — ลิงก์ที่สวนบางช่วงเหลือ ~2 kB/s ภาพเล็กคือทางเดียวที่ยังเห็นภาพเคลื่อน
 *  เลิกดูคืนขนาดตามตั้งค่า · ทิ้ง 2 เฟรมที่ค้างในบัฟเฟอร์ (GRAB_LATEST, fb_count 2) ไม่งั้นเฟรมแรกยังเป็นขนาด/คุณภาพเดิม
 *  (0.8.9 ลองบีบ quality แทน — เฟรมแรกออกมาค่าเดิม และลิงก์ช้าเหมือนกัน: ต้นเหตุคือ WiFi ไม่ใช่ขนาดภาพ — 2026-10-24) */
static void liveSize(bool small) {
  if (small == liveSmall) return;
  sensor_t* s = esp_camera_sensor_get(); if (!s) return;
  if (xSemaphoreTake(camLock, pdMS_TO_TICKS(2000)) != pdTRUE) return;
  s->set_framesize(s, small ? FRAMESIZE_QVGA : sizeFromCfg());
  for (int i = 0; i < 2; i++) { camera_fb_t* fb = esp_camera_fb_get(); if (fb) esp_camera_fb_return(fb); }
  xSemaphoreGive(camLock);
  liveSmall = small;
}

static framesize_t sizeFromCfg() {
  if (cfg.camSize == "uxga") return FRAMESIZE_UXGA;   // 1600x1200
  if (cfg.camSize == "xga") return FRAMESIZE_XGA;     // 1024x768
  if (cfg.camSize == "vga") return FRAMESIZE_VGA;     // 640x480
  return FRAMESIZE_SVGA;                              // 800x600 (default)
}

// ใช้ค่ากลับภาพกับเซ็นเซอร์ตรงๆ — เปลี่ยนได้ทันทีไม่ต้องรีบูต
static void applyFlip() {
  sensor_t* s = esp_camera_sensor_get();
  if (!s) return;
  s->set_vflip(s, cfg.camVflip ? 1 : 0);
  s->set_hmirror(s, cfg.camMirror ? 1 : 0);
}

static bool camInit(int xclkHz = 10000000) {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = CAM_PIN_D0; c.pin_d1 = CAM_PIN_D1; c.pin_d2 = CAM_PIN_D2; c.pin_d3 = CAM_PIN_D3;
  c.pin_d4 = CAM_PIN_D4; c.pin_d5 = CAM_PIN_D5; c.pin_d6 = CAM_PIN_D6; c.pin_d7 = CAM_PIN_D7;
  c.pin_xclk = CAM_PIN_XCLK; c.pin_pclk = CAM_PIN_PCLK; c.pin_vsync = CAM_PIN_VSYNC; c.pin_href = CAM_PIN_HREF;
  c.pin_sccb_sda = CAM_PIN_SIOD; c.pin_sccb_scl = CAM_PIN_SIOC; c.pin_pwdn = CAM_PIN_PWDN; c.pin_reset = CAM_PIN_RESET;
  // 10 MHz แทน 20 MHz: นาฬิกากล้องรบกวน WiFi ของ ESP32-CAM เอง (2026-10-24 ที่สวน อัปโหลด 43 kB ใช้ 7–25 วิ) · fps ไม่สำคัญกับงานนี้
  c.xclk_freq_hz = xclkHz; c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = psramFound() ? sizeFromCfg() : FRAMESIZE_VGA;
  c.jpeg_quality = psramFound() ? 15 : 17;   // เลขมาก = ไฟล์เล็ก · 12 → 15 ลดราว 30% ให้อัปโหลดทันบนลิงก์อ่อน
  c.fb_count = psramFound() ? 2 : 1;
  c.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;
  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) { Serial.printf("[cam] init failed 0x%x\n", err); return false; }
  sensor_t* s = esp_camera_sensor_get();
  applyFlip();
  Serial.printf("[cam] ok psram=%d size=%s\n", psramFound(), cfg.camSize.c_str());
  return true;
}

/** เริ่มกล้องแบบลองซ้ำ — ESP32-CAM บางครั้งรีสตาร์ทแบบซอฟต์แวร์ (OTA / selfheal) แล้วเซนเซอร์ไม่ตอบ
 *  (2026-10-24: หลังลง 0.8.5 ผ่านหน้าเว็บ cam.ok = false ถ่ายไม่ได้เลย) → ปิด-เปิด PWDN แล้วลองใหม่ · ครั้งสุดท้ายใช้ 20 MHz */
static bool camInitRetry() {
  for (int i = 0; i < 3; i++) {
    if (camInit(i < 2 ? 10000000 : 20000000)) return true;
    esp_camera_deinit();
    pinMode(CAM_PIN_PWDN, OUTPUT); digitalWrite(CAM_PIN_PWDN, HIGH); delay(200); digitalWrite(CAM_PIN_PWDN, LOW); delay(300);
  }
  return false;
}
static uint32_t camRetryAt = 0; static int camRetries = 0;

// ---- stream server (port 81) ----
static esp_err_t snapshotHandler(httpd_req_t* req) {
  if (xSemaphoreTake(camLock, pdMS_TO_TICKS(3000)) != pdTRUE) { httpd_resp_send_500(req); return ESP_FAIL; }
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { xSemaphoreGive(camLock); httpd_resp_send_500(req); return ESP_FAIL; }
  httpd_resp_set_type(req, "image/jpeg"); httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=snapshot.jpg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  xSemaphoreGive(camLock);   // ล็อกแค่ตอนหยิบเฟรม — ส่งช้าบนลิงก์แย่ก็ไม่บล็อกการถ่ายรอบอื่น (fb_count 2)
  esp_err_t r = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return r;
}
static esp_err_t streamHandler(httpd_req_t* req) {
  static const char* CT = "multipart/x-mixed-replace;boundary=gnomeframe";
  httpd_resp_set_type(req, CT); httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  char hdr[96];
  while (true) {
    if (xSemaphoreTake(camLock, pdMS_TO_TICKS(3000)) != pdTRUE) break;
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) { xSemaphoreGive(camLock); break; }
    xSemaphoreGive(camLock);   // เดิมถือล็อกระหว่างส่งเฟรม → ดูสดค้างไว้บนลิงก์ช้า = ถ่าย/อัปโหลดตามรอบ "busy" ตลอด (2026-10-24)
    int n = snprintf(hdr, sizeof hdr, "\r\n--gnomeframe\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", fb->len);
    esp_err_t r = httpd_resp_send_chunk(req, hdr, n);
    if (r == ESP_OK) r = httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len);
    esp_camera_fb_return(fb);
    if (r != ESP_OK) break;
    vTaskDelay(pdMS_TO_TICKS(80));   // ~10 fps สูงสุด
  }
  return ESP_OK;
}
// ---- โหมดคิด: ข้อความ + อารมณ์ที่ Hut ส่งกลับมาหลังดูภาพ ----
static String glanceText;          // ข้อความอังกฤษสั้นๆ ที่จะขึ้นจอ
static Mood   glanceMood = MOOD_HAPPY;
static uint32_t glanceUntil = 0;   // millis() ที่ข้อความหมดอายุ (0 = ไม่มี)
static bool glanceValid() { return glanceUntil && (int32_t)(glanceUntil - millis()) > 0; }

static void startStream() {
  httpd_config_t c = HTTPD_DEFAULT_CONFIG(); c.server_port = 81; c.ctrl_port = 32781; c.max_uri_handlers = 4;
  // client ที่ตายคาอยู่ต้องถูกเตะออก ไม่งั้นซ็อกเก็ตหมดทั้งบอร์ด · แต่ send 5 วิ สั้นไปเมื่อลิงก์ช้า (2026-10-23: ภาพ 39 kB ถูกตัดที่ 5.6 kB) → 20 วิ
  c.lru_purge_enable = true; c.send_wait_timeout = 20; c.recv_wait_timeout = 8;
  if (httpd_start(&streamd, &c) != ESP_OK) { Serial.println("[cam] stream server failed"); return; }
  httpd_uri_t u1 = { .uri = "/stream", .method = HTTP_GET, .handler = streamHandler, .user_ctx = nullptr };
  httpd_uri_t u2 = { .uri = "/snapshot", .method = HTTP_GET, .handler = snapshotHandler, .user_ctx = nullptr };
  httpd_register_uri_handler(streamd, &u1); httpd_register_uri_handler(streamd, &u2);
}

static String hutBase() { String b = cfg.hutUrl.length() ? cfg.hutUrl : ("http://" + cfg.mqttHost + ":8080"); while (b.endsWith("/")) b.remove(b.length() - 1); return b; }
// ใช้ตอนจะต่อจริง: แปลงชื่อ .local ใน URL เป็น IP (HTTPClient ไม่รู้จัก mDNS)
static String hutBaseResolved() { return netResolveUrl(hutBase()); }

static void setFlash(bool on) { flashOn = on; pinMode(CAM_FLASH_PIN, OUTPUT); digitalWrite(CAM_FLASH_PIN, on ? HIGH : LOW); }

// ถ่าย + ส่งขึ้น Hut
// ---- อัปโหลดเบื้องหลัง ----
// เดิม http.POST บล็อกลูปหลักไว้จนกว่าจะส่งเสร็จ (ลิงก์แย่ = นานเกิน 45 วิ) → MQTT keepalive ขาด → หลุด
// ตอนนี้ก๊อปเฟรมไว้ใน PSRAM แล้วปล่อยกล้องทันที ส่วนการส่งทำใน task แยก ลูปหลักเดินต่อ
struct UploadJob { uint8_t* buf; size_t len; char reason[16]; int angle; int tilt; };
static volatile bool upBusy = false;
static volatile int  upDoneCode = 0;     // 0 = ไม่มีผลค้าง
static size_t upDoneBytes = 0;
static char upDoneReason[16] = "";

static void uploadTask(void* arg) {
  UploadJob* j = (UploadJob*)arg;
  bool live = strcmp(j->reason, "live") == 0;   // เฟรมดูสด → endpoint แยก ไม่เก็บลงคลังภาพ
  String url = hutBaseResolved() + "/api/cam/" + cfg.node + (live ? "/live-frame" : "/snapshot");
  WiFiClient c; HTTPClient http; http.setTimeout(10000); http.setConnectTimeout(5000); http.begin(c, url);
  http.addHeader("Content-Type", "image/jpeg"); http.addHeader("X-Node", cfg.node); http.addHeader("X-Reason", j->reason);
  if (j->angle >= 0) http.addHeader("X-Angle", String(j->angle));
  if (j->tilt >= 0) http.addHeader("X-Tilt", String(j->tilt));
  uint32_t t0 = millis();
  int code = http.POST(j->buf, j->len);
  http.end();
  lastCode = code; lastBytes = j->len; lastUploadMs = millis(); lastUploadDur = lastUploadMs - t0;
  if (code >= 200 && code < 300) { uploads++; Serial.printf("[cam] uploaded %u bytes (%s) -> %d\n", (unsigned)j->len, j->reason, code); }
  else { fails++; Serial.printf("[cam] upload failed %d (%s)\n", code, j->reason); }
  upDoneBytes = j->len; strlcpy(upDoneReason, j->reason, sizeof upDoneReason); upDoneCode = code ? code : -99;
  free(j->buf); delete j;
  upBusy = false;
  vTaskDelete(nullptr);
}

/** ถ่าย 1 เฟรม แล้วส่งเบื้องหลัง — คืน true ถ้าเริ่มงานได้ (ผลส่งจริงดูจาก event ทีหลัง) */
static bool snapAndUpload(const char* reason) {
  if (!camOk || !netWifiConnected()) return false;
  if (upBusy) { Serial.println("[cam] upload still running, skip"); return false; }
  bool flash = cfg.camFlash && strcmp(reason, "live") != 0;
  if (flash) { setFlash(true); delay(120); }
  if (xSemaphoreTake(camLock, pdMS_TO_TICKS(3000)) != pdTRUE) { if (flash) setFlash(false); return false; }
  camera_fb_t* fb = esp_camera_fb_get();
  if (flash) setFlash(false);
  if (!fb) { xSemaphoreGive(camLock); fails++; Serial.println("[cam] capture failed"); mqttEvent("sensor_error", "\"msg\":\"capture failed\""); return false; }
  UploadJob* j = new UploadJob();
  j->buf = (uint8_t*)(psramFound() ? ps_malloc(fb->len) : malloc(fb->len));
  if (!j->buf) { esp_camera_fb_return(fb); xSemaphoreGive(camLock); delete j; fails++; return false; }
  memcpy(j->buf, fb->buf, fb->len); j->len = fb->len;
  esp_camera_fb_return(fb); xSemaphoreGive(camLock);          // ปล่อยกล้องทันที :81/stream ไม่ต้องรอส่งเสร็จ
  strlcpy(j->reason, reason, sizeof j->reason); j->angle = cfg.servoPin >= 0 ? cfg.servoAngle : -1; j->tilt = hasTilt() ? cfg.tiltAngle : -1;
  lastBytes = j->len;
  upBusy = true;
  if (xTaskCreatePinnedToCore(uploadTask, "camup", 8192, j, 1, nullptr, 0) != pdPASS) { free(j->buf); delete j; upBusy = false; fails++; return false; }
  return true;
}

/** เรียกจากลูปหลัก: ประกาศผลการส่งที่ task ทำเสร็จ (PubSubClient ไม่ thread-safe เลยส่งจากตรงนี้) */
// อาการ "TCP ค้าง": MQTT (socket เดิม) ยังอยู่ แต่เปิด socket ใหม่ไม่ได้ — อัปโหลดได้ -1 และ :81/:80 รับไม่ได้ (ดูสด/ถ่ายจาก Hut ไม่ได้)
// 2026-10-15 ค้าง 215 ครั้งข้ามคืน · 2026-10-23 เกณฑ์เดิม (3 → reconnect, 6 → restart ตามรอบถ่าย 6 นาที) ใช้เวลา 35 นาทีกว่าจะกู้
// ตอนนี้: พลาดแล้วลองใหม่ใน 30 วิ (ไม่รอรอบถ่าย) · 2 ครั้ง → WiFi reconnect · 4 ครั้ง → restart ⇒ กู้คืนภายใน ~2–3 นาที
static int connFailStreak = 0;   // -1/-3/-11 ติดกันกี่ครั้ง
#define RETRY_AFTER_FAIL_MS 30000
static void uploadReport() {
  if (!upDoneCode) return;
  int code = upDoneCode; upDoneCode = 0;
  if (strcmp(upDoneReason, "live") == 0) return;   // เฟรมดูสด: ไม่นับเป็นอัปโหลดล้มเหลว ไม่ส่ง event รัวๆ
  bool ok = code >= 200 && code < 300;
  if (ok) connFailStreak = 0;
  else if (code < 0 && netWifiConnected()) {
    connFailStreak++;
    uint32_t iv = (uint32_t)cfg.intervalS * 1000;
    if (iv > RETRY_AFTER_FAIL_MS) lastShot = millis() > iv - RETRY_AFTER_FAIL_MS ? millis() - (iv - RETRY_AFTER_FAIL_MS) : 0;   // รอบถัดไปใน 30 วิ
    if (connFailStreak == 2) { Serial.println("[cam] 2 connect failures — WiFi reconnect"); mqttEvent("selfheal", "\"action\":\"wifi_reconnect\",\"streak\":2"); WiFi.disconnect(); delay(200); WiFi.reconnect(); }
    else if (connFailStreak >= 4) { Serial.println("[cam] 4 connect failures — restart"); mqttEvent("selfheal", "\"action\":\"restart\",\"streak\":4"); netRequestReboot(1500); connFailStreak = 0; }
  }
  mqttEvent(ok ? "snapshot" : "snapshot_failed", String("\"bytes\":") + upDoneBytes + ",\"code\":" + code + ",\"reason\":\"" + upDoneReason + "\"");
}

static uint32_t servoRestoreAt = 0;   // 0 = ไม่ต้องคืนตำแหน่ง
static bool servoRestored = false;
void roleSetup() {
  camLock = xSemaphoreCreateMutex();
  pinMode(CAM_FLASH_PIN, OUTPUT); digitalWrite(CAM_FLASH_PIN, LOW);
  camOk = camInitRetry();
  if (!camOk) camRetryAt = millis() + 30000;
  // ไม่คืนตำแหน่ง servo ตรงนี้ — ตอนบูต WiFi กำลังต่อ + กล้อง init กินไฟสูงอยู่แล้ว ถ้า servo ออกตัวซ้ำเข้าไปจะ brownout
  // แล้วบูตวนไม่รู้จบ (2026-10-23) → รอ WiFi ติดก่อนค่อยคืน (ใน roleLoop) · ถ้ารอบนี้บูตเพราะ brownout ไม่คืนเลย
  if (cfg.servoPin >= 0 || hasTilt()) {
    if (netResetReason() == "brownout") { servoRestoreAt = 0; Serial.println("[servo] boot after brownout — skip restore"); }
    else servoRestoreAt = millis() + 3000;
  }
}
static void servoRestoreIfDue() {
  if (servoRestored || !servoRestoreAt || millis() < servoRestoreAt || !netWifiConnected()) return;
  servoRestored = true;
  if (cfg.servoPin >= 0 && !cfg.panCont) { Serial.printf("[servo] pan pin %d, restore %d\n", cfg.servoPin, cfg.servoAngle); servoWrite(panAx, cfg.servoAngle, cfg.servoInvert); delay(400); }
  if (hasTilt()) { Serial.printf("[servo] tilt pin %d, restore %d\n", cfg.tiltPin, cfg.tiltAngle); servoWrite(tiltAx, cfg.tiltAngle, cfg.tiltInvert); }
}

/** ถ่ายทุก preset: หัน → ถ่าย → ส่ง แล้วกลับมุมเดิม */
static int patrol(const char* reason) {
  if (cfg.presetCount == 0 || cfg.servoPin < 0) return 0;
  int backPan = cfg.servoAngle, backTilt = hasTilt() ? cfg.tiltAngle : -1, n = 0;
  for (int i = 0; i < cfg.presetCount; i++) {
    moveTo(cfg.preset[i].angle, cfg.preset[i].tilt, false);
    uint32_t t0 = millis(); while (upBusy && millis() - t0 < 20000) { mqttLoop(); delay(20); }
    if (snapAndUpload(reason)) n++;
    mqttLoop();
  }
  moveTo(backPan, backTilt);
  return n;
}

void roleLoop() {
  uploadReport();
  // กล้องเริ่มไม่ขึ้น: ลองใหม่ทุก 30 วิ · 4 รอบแล้วยังไม่ได้ → รีสตาร์ท (แจ้ง Hut ก่อน)
  if (!camOk && camRetryAt && millis() > camRetryAt) {
    camRetries++;
    if (camRetries == 1) mqttEvent("sensor_error", "\"msg\":\"camera init failed, retrying\"");
    camOk = camInitRetry();
    if (camOk) { mqttEvent("cam_recovered", "\"retries\":" + String(camRetries)); camRetryAt = 0; camRetries = 0; mqttPublishMeta(); }
    else if (camRetries >= 4) { mqttEvent("selfheal", "\"action\":\"restart\",\"why\":\"camera init\""); netRequestReboot(1500); camRetryAt = 0; }
    else camRetryAt = millis() + 30000;
  }
  servoRestoreIfDue();
  bool liveOn = liveUntil && (int32_t)(liveUntil - millis()) > 0;
  // เว้นช่วงหลังส่งเสร็จอย่างน้อยเท่าเวลาที่ส่งเฟรมก่อน (duty ≤ 50%) — ลิงก์ที่สวนอ่อน ถ้าส่งติดกันรวด WiFi อิ่มจน
  // ping 2 วิ MQTT หลุด คำสั่งหัน/ถ่ายไม่ถึง (2026-10-24) · ลิงก์ดีก็ยังได้ราว 1 เฟรม/วิ
  uint32_t liveGap = max(liveIntervalMs, min(lastUploadDur, (uint32_t)8000));
  if (liveOn && !upBusy && millis() - liveLast >= liveIntervalMs && millis() - lastUploadMs >= liveGap) { liveLast = millis(); snapAndUpload("live"); }
  if (!liveOn && liveSmall) { liveUntil = 0; liveSize(false); }   // หมดเวลาดูสด → คืนขนาดภาพเดิม
  if (saveDueAt && millis() > saveDueAt) { saveDueAt = 0; configSave(); }
  if (panAx.on && millis() > panAx.idleAt) servoRelease(panAx);
  if (tiltAx.on && millis() > tiltAx.idleAt) servoRelease(tiltAx);
  static bool streamStarted = false;
  if (!streamStarted && netWifiConnected()) { startStream(); streamStarted = true; }
  uint32_t iv = (uint32_t)cfg.intervalS * 1000;
  if (netWifiConnected() && !liveSmall && (lastShot == 0 || millis() - lastShot >= iv)) { lastShot = millis(); snapAndUpload("interval"); }   // ระหว่างดูสดเว้นภาพตามรอบ (ไม่เก็บภาพเล็ก)
}

void roleOnMqttConnect() {
  mqttPublish("sensor/snapshot_kb/meta", "{\"unit\":\"kB\",\"src\":\"ov2640\"}", true, 1);
  // ถ่ายทันทีเฉพาะครั้งแรกหลังบูตเท่านั้น
  // ถ้าถ่ายทุกครั้งที่ต่อใหม่ การอัปโหลดที่ช้าจะบล็อกลูปจน MQTT หลุด แล้ววนเป็นลูปไม่รู้จบ
  static bool firstConnect = true;
  if (firstConnect) { firstConnect = false; lastShot = 0; }
}

void roleMeta(JsonObject meta) {
  JsonObject cam = meta["cam"].to<JsonObject>();
  String ip = WiFi.localIP().toString();
  cam["stream"] = "http://" + ip + ":81/stream"; cam["snapshot"] = "http://" + ip + ":81/snapshot";
  cam["interval_s"] = cfg.intervalS; cam["size"] = cfg.camSize; cam["ok"] = camOk; cam["flash"] = cfg.camFlash; cam["vflip"] = cfg.camVflip; cam["mirror"] = cfg.camMirror;
  cam["servo"] = cfg.servoPin >= 0; cam["angle"] = cfg.servoAngle; cam["speed"] = cfg.servoSpeed; cam["hold_ms"] = cfg.servoHoldMs; cam["pan_min"] = cfg.panMin; cam["pan_max"] = cfg.panMax; cam["pan_invert"] = cfg.servoInvert; cam["tilt_invert"] = cfg.tiltInvert;
  cam["pan_mode"] = cfg.panCont ? "continuous" : "position"; cam["stop_us"] = cfg.stopUs; cam["cont_us"] = cfg.contUs; cam["cont_ms"] = cfg.contMs; cam["cont_limit"] = cfg.contLimit; cam["cont_pos"] = cfg.contPos;
  cam["tilt"] = hasTilt(); if (hasTilt()) { cam["tilt_angle"] = cfg.tiltAngle; cam["tilt_min"] = cfg.tiltMin; cam["tilt_max"] = cfg.tiltMax; }
  JsonArray pre = cam["presets"].to<JsonArray>();
  for (int i = 0; i < cfg.presetCount; i++) { JsonObject p = pre.add<JsonObject>(); p["name"] = cfg.preset[i].name; p["angle"] = cfg.preset[i].angle; if (cfg.preset[i].tilt >= 0) p["tilt"] = cfg.preset[i].tilt; }
}

void roleStatus(JsonObject st) {
  JsonObject cam = st["cam"].to<JsonObject>();
  String ip = netIp();
  cam["ok"] = camOk; cam["stream"] = "http://" + ip + ":81/stream"; cam["snapshot"] = "http://" + ip + ":81/snapshot";
  cam["uploads"] = uploads; cam["fails"] = fails; cam["last_code"] = lastCode; cam["last_kb"] = lastBytes / 1024;
  cam["last_upload_s_ago"] = lastUploadMs ? (int)((millis() - lastUploadMs) / 1000) : -1; cam["hut"] = hutBase(); cam["flash"] = flashOn; cam["vflip"] = cfg.camVflip; cam["mirror"] = cfg.camMirror;
  cam["servo"] = cfg.servoPin >= 0; cam["angle"] = cfg.servoAngle; cam["servo_pin"] = cfg.servoPin;
  cam["tilt"] = hasTilt(); cam["tilt_angle"] = cfg.tiltAngle; cam["tilt_pin"] = cfg.tiltPin; cam["tilt_min"] = cfg.tiltMin; cam["tilt_max"] = cfg.tiltMax;
  JsonObject gl = st["glance"].to<JsonObject>();     // โหมดคิด — ไว้ตรวจจากภายนอกว่าข้อความถึงจอจริงไหม
  gl["active"] = glanceValid();
  gl["text"] = glanceText;
  gl["left_s"] = glanceValid() ? (int)((glanceUntil - millis()) / 1000) : 0;
  JsonArray pre = cam["presets"].to<JsonArray>();
  for (int i = 0; i < cfg.presetCount; i++) { JsonObject p = pre.add<JsonObject>(); p["name"] = cfg.preset[i].name; p["angle"] = cfg.preset[i].angle; if (cfg.preset[i].tilt >= 0) p["tilt"] = cfg.preset[i].tilt; }
}

Mood roleMood() {
  if (!camOk) return MOOD_SICK;                                     // ของจริงที่พังมาก่อนเสมอ
  if (!mqttIsConnected() && cfg.mqttHost.length()) return MOOD_SICK;
  if (glanceValid()) return glanceMood;                             // โหมดคิด: อารมณ์ตามภาพที่เห็น
  if (fails > uploads && fails > 2) return MOOD_THIRSTY;
  return MOOD_HAPPY;
}

String roleCaption() { return glanceValid() ? glanceText : String(); }
int roleDisplayLines(String* lines, int, int) { lines[0] = String("shots ") + uploads + " fail " + fails; lines[1] = String("last ") + (lastBytes / 1024) + "kB " + lastCode + (cfg.servoPin >= 0 ? String("  ") + cfg.servoAngle + "\xB0" + (hasTilt() ? String("/") + cfg.tiltAngle + "\xB0" : "") : ""); return 2; }

int roleStats(StatItem* out, int max) {
  int n = 0;
  if (n < max) { StatItem s; s.label = "SHOTS"; s.value = String(uploads); s.unit = fails ? "fail " + String(fails) : ""; s.icon = 7; out[n++] = s; }
  if (n < max && cfg.servoPin >= 0) { StatItem s; s.label = hasTilt() ? "PAN/TILT" : "ANGLE"; s.value = hasTilt() ? String(cfg.servoAngle) + "/" + cfg.tiltAngle : String(cfg.servoAngle); s.unit = "deg"; s.icon = 7; out[n++] = s; }
  return n;
}

bool roleCommand(const String& sub, const String& payload) {
  if (sub == "cmd/snap") { lastShot = millis(); if (!snapAndUpload("cmd")) mqttEvent("snapshot_failed", "\"msg\":\"busy or capture failed\""); return true; }
  if (sub == "cmd/live") {   // {"seconds":60,"interval_ms":700} หรือ "0" = หยุด · Hut ส่งซ้ำเรื่อยๆ ตราบที่ยังมีคนดู
    JsonDocument d; int secs = 60;
    if (!deserializeJson(d, payload) && d.is<JsonObject>()) { secs = d["seconds"] | 60; liveIntervalMs = constrain((int)(d["interval_ms"] | 700), 200, 5000); }
    else secs = payload.toInt();
    secs = constrain(secs, 0, 300);
    liveUntil = secs ? millis() + (uint32_t)secs * 1000 : 0;
    liveSize(secs > 0);
    return true;
  }
  if (sub == "cmd/flash") { String p = payload; p.trim(); p.toUpperCase(); setFlash(p == "ON" || p == "1"); return true; }
  if (sub == "cmd/pan") {
    String p = payload; p.trim();
    if (cfg.servoPin < 0) { mqttEvent("pan_failed", "\"msg\":\"no servo\""); return true; }
    bool snap = false;
    if (p.endsWith("+snap")) { snap = true; p = p.substring(0, p.length() - 5); p.trim(); }
    if (panCont()) {
      // โหมด 360°: รับเฉพาะ "+N" / "-N" (ก้าว) และ preset front (= ย้อนก้าวกลับหน้าตรงโดยประมาณ)
      if (p.length() && (p[0] == '+' || p[0] == '-') && p.length() > 1 && isDigit(p[1])) {
        int n = constrain(p.substring(1).toInt(), 1, 10) * (p[0] == '+' ? 1 : -1);
        int done = contNudge(n); saveDueAt = millis() + 3000;
        if (done != abs(n)) mqttEvent("pan_limit", "\"steps\":" + String(cfg.contPos) + ",\"limit\":" + cfg.contLimit);
      } else if (p == "front") {
        if (cfg.contPos) contNudge(-cfg.contPos); saveDueAt = millis() + 3000;
        const PresetCfg* pr = findPreset(p); if (pr && pr->tilt >= 0) moveTo(-1, pr->tilt);
      } else { mqttEvent("pan_failed", "\"msg\":\"continuous pan: use +N/-N\""); return true; }
      mqttEvent("pan", anglesJson());
      if (snap) { lastShot = millis(); snapAndUpload("pan"); }
      return true;
    }
    int a = parseAngle(p, cfg.servoAngle);
    if (a != -999) panTo(a);
    else { const PresetCfg* pr = findPreset(p); if (!pr) { mqttEvent("pan_failed", "\"msg\":\"unknown preset " + p + "\""); return true; } moveTo(pr->angle, pr->tilt); }
    mqttEvent("pan", anglesJson());
    if (snap) { lastShot = millis(); snapAndUpload("pan"); }
    return true;
  }
  if (sub == "cmd/tilt") {   // มุมก้มเงย 0–180 (ถูกจำกัดด้วย tilt_min/max) · เติม +snap เพื่อถ่ายหลังขยับ
    String p = payload; p.trim();
    if (!hasTilt()) { mqttEvent("pan_failed", "\"msg\":\"no tilt servo\""); return true; }
    bool snap = false;
    if (p.endsWith("+snap")) { snap = true; p = p.substring(0, p.length() - 5); p.trim(); }
    int t = parseAngle(p, cfg.tiltAngle);
    if (t == -999) { mqttEvent("pan_failed", "\"msg\":\"bad tilt " + p + "\""); return true; }
    tiltTo(t);
    mqttEvent("pan", anglesJson());
    if (snap) { lastShot = millis(); snapAndUpload("tilt"); }
    return true;
  }
  if (sub == "cmd/patrol") { int n = patrol("patrol"); mqttEvent("patrol", "\"shots\":" + String(n)); return true; }
  if (sub == "cmd/servo") {
    // ตั้งค่า servo ทันทีไม่ต้องรีบูต: {"speed":30,"pan_min":20,"pan_max":160,"tilt_min":40,"tilt_max":140}
    // ถ้ามุมปัจจุบันหลุดช่วงใหม่ จะค่อยๆ หมุนกลับเข้าช่วงให้เอง
    JsonDocument d;
    if (deserializeJson(d, payload)) { mqttEvent("servo_cfg_error", "\"msg\":\"bad json\""); return true; }
    auto geti = [&](const char* k, int& dst, int lo, int hi) { if (d[k].is<int>()) dst = constrain(d[k].as<int>(), lo, hi); };
    geti("speed", cfg.servoSpeed, 1, SERVO_MAX_SPEED); geti("hold_ms", cfg.servoHoldMs, 500, 30000);
    if (d["pan_mode"].is<const char*>()) cfg.panCont = String(d["pan_mode"].as<const char*>()) == "continuous";
    geti("stop_us", cfg.stopUs, 1300, 1700); geti("cont_us", cfg.contUs, CONT_MIN_US, CONT_MAX_US); geti("cont_ms", cfg.contMs, 20, CONT_MAX_MS); geti("cont_limit", cfg.contLimit, 0, 500);
    geti("pan_min", cfg.panMin, 0, 180); geti("pan_max", cfg.panMax, 0, 180);
    geti("tilt_min", cfg.tiltMin, 0, 180); geti("tilt_max", cfg.tiltMax, 0, 180);
    if (cfg.panMax < cfg.panMin) cfg.panMax = cfg.panMin;
    if (cfg.tiltMax < cfg.tiltMin) cfg.tiltMax = cfg.tiltMin;
    // กลับทิศ: ตำแหน่งจริงต้องไม่ขยับ → มุมที่จำไว้ (และขอบเขต) สะท้อนเป็น 180 - x
    if (d["pan_invert"].is<bool>() && d["pan_invert"].as<bool>() != cfg.servoInvert) {
      cfg.servoInvert = !cfg.servoInvert; cfg.servoAngle = 180 - cfg.servoAngle; int lo = 180 - cfg.panMax, hi = 180 - cfg.panMin; cfg.panMin = lo; cfg.panMax = hi;
      for (int i = 0; i < cfg.presetCount; i++) cfg.preset[i].angle = 180 - cfg.preset[i].angle;
    }
    if (d["tilt_invert"].is<bool>() && d["tilt_invert"].as<bool>() != cfg.tiltInvert) {
      cfg.tiltInvert = !cfg.tiltInvert; cfg.tiltAngle = 180 - cfg.tiltAngle; int lo = 180 - cfg.tiltMax, hi = 180 - cfg.tiltMin; cfg.tiltMin = lo; cfg.tiltMax = hi;
      for (int i = 0; i < cfg.presetCount; i++) if (cfg.preset[i].tilt >= 0) cfg.preset[i].tilt = 180 - cfg.preset[i].tilt;
    }
    // home: จำมุมปัจจุบันเป็น preset "front" (หน้าตรง) — แทนที่ของเดิมถ้ามี
    if (d["home"] | false) {
      int i = 0; while (i < cfg.presetCount && cfg.preset[i].name != "front") i++;
      if (i == cfg.presetCount) { if (cfg.presetCount < GNOME_MAX_PRESET) cfg.presetCount++; else i = cfg.presetCount - 1; }
      cfg.preset[i].name = "front"; cfg.preset[i].angle = cfg.servoAngle; cfg.preset[i].tilt = hasTilt() ? cfg.tiltAngle : -1;
      if (cfg.panCont) cfg.contPos = 0;   // โหมด 360°: ตรงนี้คือก้าวที่ 0
    }
    int p = clampPan(cfg.servoAngle), t = hasTilt() ? clampTilt(cfg.tiltAngle) : -1;
    if (p != cfg.servoAngle || (t >= 0 && t != cfg.tiltAngle)) moveTo(p != cfg.servoAngle ? p : -1, (t >= 0 && t != cfg.tiltAngle) ? t : -1, false);
    configSave(); mqttPublishMeta();
    mqttEvent("servo_cfg", "\"speed\":" + String(cfg.servoSpeed) + ",\"pan_min\":" + cfg.panMin + ",\"pan_max\":" + cfg.panMax + ",\"tilt_min\":" + cfg.tiltMin + ",\"tilt_max\":" + cfg.tiltMax + "," + anglesJson());
    return true;
  }
  if (sub == "cmd/flip") {
    JsonDocument d;
    if (deserializeJson(d, payload)) { mqttEvent("flip_error"); return true; }
    if (d["vflip"].is<bool>()) cfg.camVflip = d["vflip"].as<bool>();
    if (d["mirror"].is<bool>()) cfg.camMirror = d["mirror"].as<bool>();
    applyFlip(); configSave(); mqttPublishMeta();
    mqttEvent("flip", String("\"vflip\":") + (cfg.camVflip ? "true" : "false") + ",\"mirror\":" + (cfg.camMirror ? "true" : "false"));
    return true;
  }
  if (sub == "cmd/glance") {
    // {"text":"gerbera in bloom","mood":"happy","ttl_s":900}  — ttl_s = 0 คือล้างทิ้ง
    JsonDocument d;
    if (deserializeJson(d, payload)) { mqttEvent("glance_error"); return true; }
    String txt = d["text"] | "";
    int ttl = d["ttl_s"] | 900;
    if (txt.length() > 64) txt = txt.substring(0, 64);
    if (!txt.length() || ttl <= 0) { glanceUntil = 0; glanceText = ""; return true; }
    glanceText = txt;
    glanceMood = moodFromName(d["mood"] | "happy");
    glanceUntil = millis() + (uint32_t)ttl * 1000;
    if (glanceUntil == 0) glanceUntil = 1;    // กันค่า 0 ที่แปลว่า "ไม่มี" ตอน millis วน
    return true;
  }
  return false;
}
bool roleWebSwitch(const String& key, bool on, int seconds) {
  if (key == "flash") { setFlash(on); return true; }
  if (key == "snap") { lastShot = millis(); return snapAndUpload("web"); }
  // หน้าเว็บของ node เองก็ต้องแจ้ง Hut ด้วย ไม่งั้น dashboard ไม่รู้ว่ากล้องหันไปแล้ว (2026-10-23: หันผ่าน :80 แล้ว Hut ยังคิดว่าอยู่ที่เดิม)
  if (key == "pan") { panTo(seconds); mqttEvent("pan", anglesJson()); return true; }   // seconds = มุม 0-180
  if (key == "tilt") { if (!hasTilt()) return false; tiltTo(seconds); mqttEvent("pan", anglesJson()); return true; }
  if (key == "patrol") { return patrol("web-patrol") > 0; }
  return false;
}
void roleRescan() { lastShot = 0; }
#endif
