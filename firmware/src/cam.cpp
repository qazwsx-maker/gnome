#if defined(GNOME_ROLE_CAM)
// GnomeOS Watcher — ESP32-CAM (AI-Thinker, OV2640)
//   - ถ่าย JPEG ทุก interval_s แล้ว POST ไป Hut  {hut_url}/api/cam/<node>/snapshot
//   - เว็บสตรีมสดที่พอร์ต 81: /stream (MJPEG) และ /snapshot (JPEG) — รันใน task แยก ไม่บล็อก MQTT
//   - cmd/snap = ถ่ายทันที · cmd/flash ON|OFF = ไฟแฟลช GPIO4
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

// ---------- servo (pan) ----------
// LEDC: กล้องใช้ channel 0 / timer 0 อยู่แล้ว → servo ใช้ channel 2 (timer 1) เพื่อไม่ชนกัน
#define SERVO_LEDC_CH 2
static bool servoOn = false;
static uint32_t servoIdleAt = 0;   // ถึงเวลานี้แล้วปล่อยสัญญาณ (ลดเสียงสั่น/ความร้อน)

static void servoWrite(int angle) {
  if (cfg.servoPin < 0) return;
  angle = constrain(angle, 0, 180);
  int a = cfg.servoInvert ? 180 - angle : angle;
  int us = cfg.servoMinUs + (long)(cfg.servoMaxUs - cfg.servoMinUs) * a / 180;
  uint32_t duty = (uint32_t)((float)us * 65536.0f / 20000.0f);   // 50 Hz, 16-bit
  if (!servoOn) { ledcSetup(SERVO_LEDC_CH, 50, 16); ledcAttachPin(cfg.servoPin, SERVO_LEDC_CH); servoOn = true; }
  ledcWrite(SERVO_LEDC_CH, duty);
  servoIdleAt = millis() + 1200;   // ค้างสัญญาณ 1.2 s ให้หมุนถึงตำแหน่ง แล้วปล่อย
}
static void servoRelease() {
  if (!servoOn) return;
  ledcWrite(SERVO_LEDC_CH, 0); ledcDetachPin(cfg.servoPin); pinMode(cfg.servoPin, INPUT);
  servoOn = false;
}
/** หันไปที่มุม แล้วรอให้นิ่งก่อนถ่าย */
static void panTo(int angle, bool save = true) {
  if (cfg.servoPin < 0) return;
  angle = constrain(angle, 0, 180);
  int delta = abs(angle - cfg.servoAngle);
  servoWrite(angle);
  cfg.servoAngle = angle;
  if (save) configSave();
  delay(300 + delta * 6);   // ~6 ms/องศา + settle
  Serial.printf("[servo] pan -> %d\n", angle);
}
static int presetAngle(const String& name) {
  for (int i = 0; i < cfg.presetCount; i++) if (cfg.preset[i].name == name) return cfg.preset[i].angle;
  return -1;
}

static bool snapAndUpload(const char* reason);
static bool camOk = false;
static httpd_handle_t streamd = nullptr;
static uint32_t lastShot = 0;
static int lastCode = 0, lastBytes = 0; static uint32_t lastUploadMs = 0; static int uploads = 0, fails = 0;
static bool flashOn = false;
static SemaphoreHandle_t camLock;

static framesize_t sizeFromCfg() {
  if (cfg.camSize == "uxga") return FRAMESIZE_UXGA;   // 1600x1200
  if (cfg.camSize == "xga") return FRAMESIZE_XGA;     // 1024x768
  if (cfg.camSize == "vga") return FRAMESIZE_VGA;     // 640x480
  return FRAMESIZE_SVGA;                              // 800x600 (default)
}

static bool camInit() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = CAM_PIN_D0; c.pin_d1 = CAM_PIN_D1; c.pin_d2 = CAM_PIN_D2; c.pin_d3 = CAM_PIN_D3;
  c.pin_d4 = CAM_PIN_D4; c.pin_d5 = CAM_PIN_D5; c.pin_d6 = CAM_PIN_D6; c.pin_d7 = CAM_PIN_D7;
  c.pin_xclk = CAM_PIN_XCLK; c.pin_pclk = CAM_PIN_PCLK; c.pin_vsync = CAM_PIN_VSYNC; c.pin_href = CAM_PIN_HREF;
  c.pin_sccb_sda = CAM_PIN_SIOD; c.pin_sccb_scl = CAM_PIN_SIOC; c.pin_pwdn = CAM_PIN_PWDN; c.pin_reset = CAM_PIN_RESET;
  c.xclk_freq_hz = 20000000; c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = psramFound() ? sizeFromCfg() : FRAMESIZE_VGA;
  c.jpeg_quality = psramFound() ? 12 : 15;
  c.fb_count = psramFound() ? 2 : 1;
  c.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;
  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) { Serial.printf("[cam] init failed 0x%x\n", err); return false; }
  sensor_t* s = esp_camera_sensor_get();
  if (s) { s->set_vflip(s, cfg.camFlip ? 1 : 0); s->set_hmirror(s, cfg.camFlip ? 1 : 0); }
  Serial.printf("[cam] ok psram=%d size=%s\n", psramFound(), cfg.camSize.c_str());
  return true;
}

// ---- stream server (port 81) ----
static esp_err_t snapshotHandler(httpd_req_t* req) {
  if (xSemaphoreTake(camLock, pdMS_TO_TICKS(3000)) != pdTRUE) { httpd_resp_send_500(req); return ESP_FAIL; }
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { xSemaphoreGive(camLock); httpd_resp_send_500(req); return ESP_FAIL; }
  httpd_resp_set_type(req, "image/jpeg"); httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=snapshot.jpg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t r = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb); xSemaphoreGive(camLock);
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
    int n = snprintf(hdr, sizeof hdr, "\r\n--gnomeframe\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", fb->len);
    esp_err_t r = httpd_resp_send_chunk(req, hdr, n);
    if (r == ESP_OK) r = httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len);
    esp_camera_fb_return(fb); xSemaphoreGive(camLock);
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
  if (httpd_start(&streamd, &c) != ESP_OK) { Serial.println("[cam] stream server failed"); return; }
  httpd_uri_t u1 = { .uri = "/stream", .method = HTTP_GET, .handler = streamHandler, .user_ctx = nullptr };
  httpd_uri_t u2 = { .uri = "/snapshot", .method = HTTP_GET, .handler = snapshotHandler, .user_ctx = nullptr };
  httpd_register_uri_handler(streamd, &u1); httpd_register_uri_handler(streamd, &u2);
}

static String hutBase() { String b = cfg.hutUrl.length() ? cfg.hutUrl : ("http://" + cfg.mqttHost + ":8080"); while (b.endsWith("/")) b.remove(b.length() - 1); return b; }

static void setFlash(bool on) { flashOn = on; pinMode(CAM_FLASH_PIN, OUTPUT); digitalWrite(CAM_FLASH_PIN, on ? HIGH : LOW); }

// ถ่าย + ส่งขึ้น Hut
static bool snapAndUpload(const char* reason) {
  if (!camOk || !netWifiConnected()) return false;
  if (cfg.camFlash) { setFlash(true); delay(120); }
  if (xSemaphoreTake(camLock, pdMS_TO_TICKS(3000)) != pdTRUE) { if (cfg.camFlash) setFlash(false); return false; }
  camera_fb_t* fb = esp_camera_fb_get();
  if (cfg.camFlash) setFlash(false);
  if (!fb) { xSemaphoreGive(camLock); fails++; Serial.println("[cam] capture failed"); mqttEvent("sensor_error", "\"msg\":\"capture failed\""); return false; }
  String url = hutBase() + "/api/cam/" + cfg.node + "/snapshot";
  WiFiClient c; HTTPClient http; http.setTimeout(15000); http.begin(c, url);
  http.addHeader("Content-Type", "image/jpeg"); http.addHeader("X-Node", cfg.node); http.addHeader("X-Reason", reason);
  if (cfg.servoPin >= 0) http.addHeader("X-Angle", String(cfg.servoAngle));
  int code = http.POST(fb->buf, fb->len);
  http.end();
  lastCode = code; lastBytes = fb->len; lastUploadMs = millis();
  esp_camera_fb_return(fb); xSemaphoreGive(camLock);
  if (code >= 200 && code < 300) { uploads++; Serial.printf("[cam] uploaded %d bytes (%s) -> %d\n", lastBytes, reason, code); return true; }
  fails++; Serial.printf("[cam] upload failed %d -> %s\n", code, url.c_str());
  return false;
}

void roleSetup() {
  camLock = xSemaphoreCreateMutex();
  pinMode(CAM_FLASH_PIN, OUTPUT); digitalWrite(CAM_FLASH_PIN, LOW);
  camOk = camInit();
  if (cfg.servoPin >= 0) { Serial.printf("[servo] pin %d, restore angle %d\n", cfg.servoPin, cfg.servoAngle); servoWrite(cfg.servoAngle); }
}

/** ถ่ายทุก preset: หัน → ถ่าย → ส่ง แล้วกลับมุมเดิม */
static int patrol(const char* reason) {
  if (cfg.presetCount == 0 || cfg.servoPin < 0) return 0;
  int back = cfg.servoAngle, n = 0;
  for (int i = 0; i < cfg.presetCount; i++) {
    panTo(cfg.preset[i].angle, false);
    if (snapAndUpload(reason)) n++;
    mqttLoop();
  }
  panTo(back);
  return n;
}

void roleLoop() {
  if (servoOn && millis() > servoIdleAt) servoRelease();
  static bool streamStarted = false;
  if (!streamStarted && netWifiConnected()) { startStream(); streamStarted = true; }
  uint32_t iv = (uint32_t)cfg.intervalS * 1000;
  if (netWifiConnected() && (lastShot == 0 || millis() - lastShot >= iv)) { lastShot = millis(); snapAndUpload("interval"); }
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
  cam["interval_s"] = cfg.intervalS; cam["size"] = cfg.camSize; cam["ok"] = camOk; cam["flash"] = cfg.camFlash;
  cam["servo"] = cfg.servoPin >= 0; cam["angle"] = cfg.servoAngle;
  JsonArray pre = cam["presets"].to<JsonArray>();
  for (int i = 0; i < cfg.presetCount; i++) { JsonObject p = pre.add<JsonObject>(); p["name"] = cfg.preset[i].name; p["angle"] = cfg.preset[i].angle; }
}

void roleStatus(JsonObject st) {
  JsonObject cam = st["cam"].to<JsonObject>();
  String ip = netIp();
  cam["ok"] = camOk; cam["stream"] = "http://" + ip + ":81/stream"; cam["snapshot"] = "http://" + ip + ":81/snapshot";
  cam["uploads"] = uploads; cam["fails"] = fails; cam["last_code"] = lastCode; cam["last_kb"] = lastBytes / 1024;
  cam["last_upload_s_ago"] = lastUploadMs ? (int)((millis() - lastUploadMs) / 1000) : -1; cam["hut"] = hutBase(); cam["flash"] = flashOn;
  cam["servo"] = cfg.servoPin >= 0; cam["angle"] = cfg.servoAngle; cam["servo_pin"] = cfg.servoPin;
  JsonObject gl = st["glance"].to<JsonObject>();     // โหมดคิด — ไว้ตรวจจากภายนอกว่าข้อความถึงจอจริงไหม
  gl["active"] = glanceValid();
  gl["text"] = glanceText;
  gl["left_s"] = glanceValid() ? (int)((glanceUntil - millis()) / 1000) : 0;
  JsonArray pre = cam["presets"].to<JsonArray>();
  for (int i = 0; i < cfg.presetCount; i++) { JsonObject p = pre.add<JsonObject>(); p["name"] = cfg.preset[i].name; p["angle"] = cfg.preset[i].angle; }
}

Mood roleMood() {
  if (!camOk) return MOOD_SICK;                                     // ของจริงที่พังมาก่อนเสมอ
  if (!mqttIsConnected() && cfg.mqttHost.length()) return MOOD_SICK;
  if (glanceValid()) return glanceMood;                             // โหมดคิด: อารมณ์ตามภาพที่เห็น
  if (fails > uploads && fails > 2) return MOOD_THIRSTY;
  return MOOD_HAPPY;
}

String roleCaption() { return glanceValid() ? glanceText : String(); }
int roleDisplayLines(String* lines, int, int) { lines[0] = String("shots ") + uploads + " fail " + fails; lines[1] = String("last ") + (lastBytes / 1024) + "kB " + lastCode + (cfg.servoPin >= 0 ? String("  ") + cfg.servoAngle + "\xB0" : ""); return 2; }

int roleStats(StatItem* out, int max) {
  int n = 0;
  if (n < max) { StatItem s; s.label = "SHOTS"; s.value = String(uploads); s.unit = fails ? "fail " + String(fails) : ""; s.icon = 7; out[n++] = s; }
  if (n < max && cfg.servoPin >= 0) { StatItem s; s.label = "ANGLE"; s.value = String(cfg.servoAngle); s.unit = "deg"; s.icon = 7; out[n++] = s; }
  return n;
}

bool roleCommand(const String& sub, const String& payload) {
  if (sub == "cmd/snap") { lastShot = millis(); bool ok = snapAndUpload("cmd"); mqttEvent(ok ? "snapshot" : "snapshot_failed", "\"bytes\":" + String(lastBytes)); return true; }
  if (sub == "cmd/flash") { String p = payload; p.trim(); p.toUpperCase(); setFlash(p == "ON" || p == "1"); return true; }
  if (sub == "cmd/pan") {
    String p = payload; p.trim();
    if (cfg.servoPin < 0) { mqttEvent("pan_failed", "\"msg\":\"no servo\""); return true; }
    bool snap = false;
    if (p.endsWith("+snap")) { snap = true; p = p.substring(0, p.length() - 5); p.trim(); }
    int a = p.length() && (isDigit(p[0]) || p[0] == '-') ? p.toInt() : presetAngle(p);
    if (a < 0) { mqttEvent("pan_failed", "\"msg\":\"unknown preset " + p + "\""); return true; }
    panTo(a);
    mqttEvent("pan", "\"angle\":" + String(cfg.servoAngle));
    if (snap) { lastShot = millis(); snapAndUpload("pan"); }
    return true;
  }
  if (sub == "cmd/patrol") { int n = patrol("patrol"); mqttEvent("patrol", "\"shots\":" + String(n)); return true; }
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
  if (key == "pan") { panTo(seconds); return true; }                      // seconds = มุม 0-180
  if (key == "patrol") { return patrol("web-patrol") > 0; }
  return false;
}
void roleRescan() { lastShot = 0; }
#endif
