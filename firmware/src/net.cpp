#include "gnome.h"
#include "improv.h"
#include "web_ui.h"
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <Update.h>

static WebServer server(80);
static DNSServer dns;
static bool portal = false;
static uint32_t rebootAt = 0;
static uint32_t lastStaTry = 0;
static String apName;
static bool staServicesUp = false;

// เรียกเมื่อ WiFi STA ต่อได้: mDNS + ArduinoOTA (ครั้งเดียว)
static void onStaUp() {
  if (!staServicesUp) {
    MDNS.begin(cfg.node.c_str()); MDNS.addService("http", "tcp", 80);
    ArduinoOTA.setHostname(cfg.node.c_str()); ArduinoOTA.setPassword(GNOME_AP_PASS); ArduinoOTA.begin();
    staServicesUp = true;
  }
  ledSetMode(mqttIsConnected() ? LED_OK : LED_WIFI_ONLY);
  Serial.printf("[net] web: http://%s/  (%s.local)\n", WiFi.localIP().toString().c_str(), cfg.node.c_str());
}

// ---------- LED ----------
static LedMode ledMode = LED_PORTAL; static uint32_t identifyUntil = 0;
void ledSetMode(LedMode m) { if (m == LED_IDENTIFY) identifyUntil = millis() + 10000; else ledMode = m; }
void ledLoop() {
  uint32_t t = millis(); bool on;
  if (t < identifyUntil) on = (t / 100) % 2;
  else if (ledMode == LED_PORTAL) on = (t / 250) % 2;
  else if (ledMode == LED_WIFI_ONLY) on = (t / 1000) % 2;
  else on = (t % 5000) < 60;
  digitalWrite(GNOME_LED_PIN, on ? HIGH : LOW);
}

// ---------- helpers ----------
bool netPortalActive() { return portal; }
bool netWifiConnected() { return WiFi.status() == WL_CONNECTED; }
String netIp() { return netWifiConnected() ? WiFi.localIP().toString() : (portal ? WiFi.softAPIP().toString() : String("0.0.0.0")); }
int netRssi() { return netWifiConnected() ? WiFi.RSSI() : 0; }
void netRequestReboot(uint32_t delayMs) { rebootAt = millis() + delayMs; }

static void startPortal() {
  if (portal) return;
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str(), GNOME_AP_PASS);
  dns.start(53, "*", WiFi.softAPIP());
  portal = true; ledSetMode(LED_PORTAL);
  Serial.printf("[net] portal: WiFi \"%s\" pass %s → http://%s/\n", apName.c_str(), GNOME_AP_PASS, WiFi.softAPIP().toString().c_str());
}
static void stopPortal() {
  if (!portal) return;
  dns.stop(); WiFi.softAPdisconnect(true); WiFi.mode(WIFI_STA); portal = false;
}

static bool connectSta(const String& ssid, const String& pass, uint32_t timeoutMs) {
  if (ssid.length() == 0) return false;
  Serial.printf("[net] connecting to %s ...\n", ssid.c_str());
  WiFi.begin(ssid.c_str(), pass.c_str());
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) { delay(100); ledLoop(); improv::loop(); }
  bool ok = WiFi.status() == WL_CONNECTED;
  Serial.printf("[net] %s (%s)\n", ok ? "connected" : "failed", ok ? WiFi.localIP().toString().c_str() : "-");
  return ok;
}

static bool improvConnect(const String& ssid, const String& pass) {
  if (!portal) WiFi.mode(WIFI_STA);
  bool ok = connectSta(ssid, pass, 15000);
  if (ok) { cfg.wifiSsid = ssid; cfg.wifiPass = pass; configSave(); stopPortal(); onStaUp(); }
  return ok;
}
static String improvUrl() { return "http://" + WiFi.localIP().toString() + "/"; }

// ---------- web ----------
static void sendJson(JsonDocument& d, int code = 200) { String s; serializeJson(d, s); server.send(code, "application/json", s); }
static bool captiveRedirect() {
  if (!portal) return false;
  String host = server.hostHeader();
  if (host == WiFi.softAPIP().toString()) return false;
  server.sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/", true);
  server.send(302, "text/plain", ""); return true;
}

static void setupRoutes() {
  server.on("/", HTTP_GET, []() { if (captiveRedirect()) return; server.send_P(200, "text/html; charset=utf-8", WEB_UI); });
  server.on("/api/status", HTTP_GET, []() {
    JsonDocument d; JsonObject o = d.to<JsonObject>();
    o["node"] = cfg.node; o["role"] = GNOME_ROLE; o["fw"] = String(GNOME_FW_NAME) + " " + GNOME_VERSION;
    o["ip"] = netIp(); o["rssi"] = netRssi(); o["wifi"] = netWifiConnected(); o["portal"] = portal;
    o["mqtt"] = mqttIsConnected(); o["mqtt_host"] = cfg.mqttHost; o["oled"] = displayPresent(); o["board"] = GNOME_BOARD; o["uptime_s"] = millis() / 1000; o["heap"] = ESP.getFreeHeap();
    roleStatus(o); sendJson(d);
  });
  server.on("/api/config", HTTP_GET, []() { JsonDocument d; configToJson(d.to<JsonObject>(), false); sendJson(d); });
  server.on("/api/config", HTTP_POST, []() {
    JsonDocument d; if (deserializeJson(d, server.arg("plain"))) { JsonDocument e; e["ok"] = false; e["msg"] = "JSON ไม่ถูกต้อง"; sendJson(e, 400); return; }
    configApplyJson(d.as<JsonObjectConst>()); configSave();
    JsonDocument r; r["ok"] = true; r["msg"] = "บันทึกแล้ว กำลังรีบูต"; r["reboot"] = true; sendJson(r);
    netRequestReboot(800);
  });
  server.on("/api/scan", HTTP_GET, []() {
    int n = WiFi.scanNetworks(); JsonDocument d; JsonArray a = d.to<JsonArray>();
    for (int i = 0; i < n && i < 25; i++) { JsonObject o = a.add<JsonObject>(); o["ssid"] = WiFi.SSID(i); o["rssi"] = WiFi.RSSI(i); o["auth"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN; }
    WiFi.scanDelete(); sendJson(d);
  });
  server.on("/api/switch", HTTP_POST, []() {
    JsonDocument d; deserializeJson(d, server.arg("plain"));
    bool ok = roleWebSwitch(d["key"] | "", String(d["state"] | "OFF") == "ON", d["seconds"] | 0);
    JsonDocument r; r["ok"] = ok; r["msg"] = ok ? "สั่งแล้ว" : "ไม่พบสวิตช์"; sendJson(r, ok ? 200 : 404);
  });
  server.on("/api/reboot", HTTP_POST, []() { JsonDocument r; r["ok"] = true; r["msg"] = "กำลังรีบูต"; sendJson(r); netRequestReboot(500); });
  server.on("/api/identify", HTTP_POST, []() { ledSetMode(LED_IDENTIFY); JsonDocument r; r["ok"] = true; r["msg"] = "กระพริบ 10 วินาที"; sendJson(r); });
  server.on("/api/rescan", HTTP_POST, []() { roleRescan(); displaySetup(); JsonDocument r; r["ok"] = true; r["msg"] = "สแกนแล้ว"; sendJson(r); });
  server.on("/update", HTTP_POST,
    []() { bool ok = !Update.hasError(); server.send(200, "text/html; charset=utf-8", ok ? "<meta http-equiv=refresh content='8;url=/'>อัปเดตสำเร็จ กำลังรีบูต…" : "อัปเดตล้มเหลว"); if (ok) netRequestReboot(800); },
    []() { HTTPUpload& up = server.upload();
      if (up.status == UPLOAD_FILE_START) { Serial.printf("[ota] %s\n", up.filename.c_str()); Update.begin(UPDATE_SIZE_UNKNOWN); }
      else if (up.status == UPLOAD_FILE_WRITE) { Update.write(up.buf, up.currentSize); }
      else if (up.status == UPLOAD_FILE_END) { Update.end(true); } });
  // captive-portal probes
  for (const char* p : {"/generate_204", "/gen_204", "/hotspot-detect.html", "/library/test/success.html", "/connecttest.txt", "/ncsi.txt", "/success.txt", "/redirect"})
    server.on(p, HTTP_GET, []() { if (!captiveRedirect()) server.send(200, "text/plain", "ok"); });
  server.onNotFound([]() { if (!captiveRedirect()) server.send(404, "text/plain", "not found"); });
}

void netSetup() {
  pinMode(GNOME_LED_PIN, OUTPUT);
  apName = String("GNOME-") + (String(GNOME_ROLE) == "keeper" ? "Keeper" : "Scout") + "-" + macTail();
  WiFi.persistent(false); WiFi.setAutoReconnect(true); WiFi.setHostname(cfg.node.c_str());
  improv::begin(improvConnect, improvUrl, GNOME_FW_NAME, GNOME_VERSION, "ESP32", cfg.node.c_str());
  WiFi.mode(WIFI_STA);
  bool ok = connectSta(cfg.wifiSsid, cfg.wifiPass, 20000);
  setupRoutes(); server.begin();
  if (!ok) startPortal(); else onStaUp();
}

void netLoop() {
  improv::loop(); server.handleClient(); if (staServicesUp) ArduinoOTA.handle(); ledLoop();
  if (portal) dns.processNextRequest();
  if (rebootAt && millis() > rebootAt) { Serial.println("[net] reboot"); delay(100); ESP.restart(); }
  // STA หลุด: ลองต่อใหม่ทุก 30 s และเปิด portal ค้างไว้เพื่อให้แก้ค่าได้
  if (!netWifiConnected()) {
    if (!portal && millis() - lastStaTry > 30000 && cfg.wifiSsid.length()) { lastStaTry = millis(); WiFi.reconnect(); }
    if (!portal && cfg.wifiSsid.length() == 0) startPortal();
    if (portal && cfg.wifiSsid.length() && millis() - lastStaTry > 30000) { lastStaTry = millis(); WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPass.c_str()); }
  } else {
    if (!staServicesUp) onStaUp();
    // ต่อ WiFi ได้แล้วขณะเปิด portal อยู่ → ปิด portal หลังผ่านไปสักครู่
    if (portal && millis() - lastStaTry > 60000) stopPortal();
  }
}
