#include "gnome.h"
#include <WiFi.h>
#include <PubSubClient.h>
#include <HTTPUpdate.h>

static WiFiClient wifiClient;
static WiFiClient otaClient;
static PubSubClient client(wifiClient);
static uint32_t lastTry = 0, lastOk = 0, lastDebug = 0;
static bool serverOnline = false;
static String pendingFail;   // ข้อความ ota_failed ที่จะส่งหลังต่อ MQTT กลับ
static String base;   // "gnome/<node>/"

bool mqttIsConnected() { return client.connected(); }
uint32_t mqttLastOkMs() { return lastOk; }
bool mqttServerOnline() { return serverOnline; }

void mqttPublish(const String& sub, const String& payload, bool retained, int qos) {
  if (!client.connected()) return;
  client.publish((base + sub).c_str(), (const uint8_t*)payload.c_str(), payload.length(), retained);
}
void mqttEvent(const char* type, const String& extra) {
  String p = String("{\"type\":\"") + type + "\",\"node\":\"" + cfg.node + "\",\"uptime_s\":" + String(millis() / 1000);
  if (extra.length()) p += "," + extra;
  p += "}";
  mqttPublish("event", p, false, 1);
}
void mqttPublishMeta() {
  JsonDocument d; JsonObject o = d.to<JsonObject>();
  o["node"] = cfg.node; o["role"] = GNOME_ROLE; o["fw"] = String(GNOME_FW_NAME) + " " + GNOME_VERSION; o["board"] = GNOME_BOARD;
  o["mac"] = WiFi.macAddress(); o["ip"] = WiFi.localIP().toString();
  o["sensors"].to<JsonArray>(); o["switches"].to<JsonArray>();
  roleMeta(o);
  String s; serializeJson(d, s); mqttPublish("meta", s, true, 1);
}

static void onMessage(char* topic, byte* payload, unsigned int len) {
  String t(topic), p; p.reserve(len); for (unsigned int i = 0; i < len; i++) p += (char)payload[i];
  if (t == "gnome/server/status") { serverOnline = (p == "online"); return; }
  if (!t.startsWith(base)) return;
  String sub = t.substring(base.length());
  if (sub == "cmd/reboot") { mqttEvent("reboot_cmd"); netRequestReboot(500); return; }
  if (sub == "cmd/identify") { ledSetMode(LED_IDENTIFY); return; }
  if (sub == "cmd/config") {
    JsonDocument d; if (deserializeJson(d, p)) { mqttEvent("config_error"); return; }
    configApplyJson(d.as<JsonObjectConst>()); configSave(); mqttEvent("config_changed"); netRequestReboot(800); return;
  }
  if (sub == "cmd/ota") {
    mqttEvent("ota_start", "\"url\":\"" + p + "\""); client.loop(); delay(300);
    client.disconnect();                       // ตัดแบบ clean → broker ไม่ยิง LWT offline ระหว่างดาวน์โหลด
    Serial.printf("[ota] %s\n", p.c_str());
    httpUpdate.rebootOnUpdate(true); httpUpdate.setLedPin(GNOME_LED_PIN >= 0 ? GNOME_LED_PIN : -1, HIGH);
    t_httpUpdate_return r = httpUpdate.update(otaClient, p);
    // มาถึงตรงนี้ = ไม่สำเร็จ (สำเร็จจะรีบูตไปแล้ว)
    pendingFail = String(httpUpdate.getLastError()) + " " + httpUpdate.getLastErrorString(); if (r == HTTP_UPDATE_NO_UPDATES) pendingFail = "no update";
    Serial.printf("[ota] failed: %s\n", pendingFail.c_str()); lastTry = 0;
    return;
  }
  roleCommand(sub, p);
}

void mqttSetup() {
  base = "gnome/" + cfg.node + "/";
  client.setBufferSize(1024); client.setKeepAlive(30); client.setCallback(onMessage);
}

static void tryConnect() {
  if (cfg.mqttHost.length() == 0) return;
  client.setServer(cfg.mqttHost.c_str(), cfg.mqttPort);
  String will = base + "status";
  Serial.printf("[mqtt] connecting %s:%d as %s\n", cfg.mqttHost.c_str(), cfg.mqttPort, cfg.node.c_str());
  bool ok = client.connect(cfg.node.c_str(), cfg.mqttUser.length() ? cfg.mqttUser.c_str() : nullptr, cfg.mqttPass.length() ? cfg.mqttPass.c_str() : nullptr,
                           will.c_str(), 1, true, "offline");
  if (!ok) { Serial.printf("[mqtt] failed rc=%d\n", client.state()); return; }
  Serial.println("[mqtt] connected");
  client.publish(will.c_str(), "online", true);
  client.subscribe((base + "switch/+/command").c_str(), 1);
  client.subscribe((base + "cmd/#").c_str(), 1);
  client.subscribe("gnome/server/status", 1);
  mqttPublishMeta();
  static bool booted = false; if (!booted) { booted = true; mqttEvent("boot", "\"fw\":\"" + String(GNOME_FW_NAME) + " " + GNOME_VERSION + "\",\"ip\":\"" + WiFi.localIP().toString() + "\""); }
  roleOnMqttConnect();
  if (pendingFail.length()) { pendingFail.replace('"', '\''); mqttEvent("ota_failed", "\"msg\":\"" + pendingFail + "\""); pendingFail = ""; }
  ledSetMode(LED_OK);
}

void mqttLoop() {
  if (!netWifiConnected()) return;
  if (!client.connected()) {
    if (lastOk && millis() - lastOk > 5000) ledSetMode(LED_WIFI_ONLY);
    if (millis() - lastTry > 5000) { lastTry = millis(); tryConnect(); }
    return;
  }
  client.loop(); lastOk = millis();
  if (millis() - lastDebug > 60000) {
    lastDebug = millis();
    mqttPublish("debug", String("{\"rssi\":") + WiFi.RSSI() + ",\"uptime_s\":" + (millis() / 1000) + ",\"heap\":" + ESP.getFreeHeap() + ",\"ip\":\"" + WiFi.localIP().toString() + "\"}");
  }
}
