#include "config.h"
#include <Preferences.h>
#include <WiFi.h>
#include <esp_system.h>

Config cfg;
static Preferences prefs;

String macTail() {
  uint8_t m[6]; esp_read_mac(m, ESP_MAC_WIFI_STA);
  char b[5]; snprintf(b, sizeof b, "%02x%02x", m[4], m[5]);
  return String(b);
}
String defaultNodeName() { return String(GNOME_ROLE) + "-" + macTail(); }

static String sanitizeNode(String s) {
  s.toLowerCase(); String out;
  for (size_t i = 0; i < s.length() && out.length() < 24; i++) {
    char c = s[i];
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') out += c;
    else if (c == ' ' || c == '_') out += '-';
  }
  while (out.startsWith("-")) out.remove(0, 1);
  return out;
}

void configSetDefaults() {
  cfg = Config();
  cfg.node = defaultNodeName();
#if defined(GNOME_ROLE_KEEPER)
  cfg.swCount = 2;
  cfg.sw[0].key = "drip"; cfg.sw[0].pin = 26; cfg.sw[0].activeLow = true; cfg.sw[0].maxOnS = 600; cfg.sw[0].exclusive = "mist";
  cfg.sw[1].key = "mist"; cfg.sw[1].pin = 27; cfg.sw[1].activeLow = true; cfg.sw[1].maxOnS = 600; cfg.sw[1].exclusive = "drip";
#endif
}

void configToJson(JsonObject o, bool includeSecrets) {
  o["node"] = cfg.node; o["role"] = GNOME_ROLE;
  o["wifi_ssid"] = cfg.wifiSsid; if (includeSecrets) o["wifi_pass"] = cfg.wifiPass; else o["wifi_pass_set"] = cfg.wifiPass.length() > 0;
  o["mqtt_host"] = cfg.mqttHost; o["mqtt_port"] = cfg.mqttPort; o["mqtt_user"] = cfg.mqttUser;
  if (includeSecrets) o["mqtt_pass"] = cfg.mqttPass; else o["mqtt_pass_set"] = cfg.mqttPass.length() > 0;
  o["interval_s"] = cfg.intervalS; o["i2c_sda"] = cfg.i2cSda; o["i2c_scl"] = cfg.i2cScl; o["dht_pin"] = cfg.dhtPin;
  o["failsafe_s"] = cfg.failsafeS;
  JsonArray soil = o["soil"].to<JsonArray>();
  for (int i = 0; i < cfg.soilCount; i++) { JsonObject s = soil.add<JsonObject>(); s["pin"] = cfg.soil[i].pin; s["dry"] = cfg.soil[i].dry; s["wet"] = cfg.soil[i].wet; }
  JsonArray sw = o["switches"].to<JsonArray>();
  for (int i = 0; i < cfg.swCount; i++) {
    JsonObject s = sw.add<JsonObject>(); s["key"] = cfg.sw[i].key; s["pin"] = cfg.sw[i].pin; s["active_low"] = cfg.sw[i].activeLow;
    s["max_on_s"] = cfg.sw[i].maxOnS;
    JsonArray ex = s["exclusive"].to<JsonArray>();
    String rest = cfg.sw[i].exclusive; while (rest.length()) { int c = rest.indexOf(','); String k = c < 0 ? rest : rest.substring(0, c); k.trim(); if (k.length()) ex.add(k); if (c < 0) break; rest = rest.substring(c + 1); }
  }
}

static bool isAdc1Pin(int p) { return p == 32 || p == 33 || p == 34 || p == 35 || p == 36 || p == 39; }

bool configApplyJson(JsonObjectConst o) {
  bool changed = false;
  auto setS = [&](const char* k, String& dst) { if (o[k].is<const char*>()) { String v = o[k].as<String>(); if (v != dst) { dst = v; changed = true; } } };
  auto setI = [&](const char* k, int& dst) { if (o[k].is<int>()) { int v = o[k].as<int>(); if (v != dst) { dst = v; changed = true; } } };
  if (o["node"].is<const char*>()) { String n = sanitizeNode(o["node"].as<String>()); if (n.length() == 0) n = defaultNodeName(); if (n != cfg.node) { cfg.node = n; changed = true; } }
  setS("wifi_ssid", cfg.wifiSsid); setS("wifi_pass", cfg.wifiPass);
  setS("mqtt_host", cfg.mqttHost); setI("mqtt_port", cfg.mqttPort); setS("mqtt_user", cfg.mqttUser); setS("mqtt_pass", cfg.mqttPass);
  setI("interval_s", cfg.intervalS); setI("i2c_sda", cfg.i2cSda); setI("i2c_scl", cfg.i2cScl); setI("dht_pin", cfg.dhtPin); setI("failsafe_s", cfg.failsafeS);
  if (cfg.intervalS < 5) cfg.intervalS = 5; if (cfg.failsafeS < 30) cfg.failsafeS = 30;
  if (o["soil"].is<JsonArrayConst>()) {
    int n = 0; for (JsonObjectConst s : o["soil"].as<JsonArrayConst>()) { if (n >= GNOME_MAX_SOIL) break; int pin = s["pin"] | -1; if (!isAdc1Pin(pin)) continue;
      cfg.soil[n].pin = pin; cfg.soil[n].dry = s["dry"] | 3100; cfg.soil[n].wet = s["wet"] | 1300; n++; }
    cfg.soilCount = n; changed = true;
  }
  if (o["switches"].is<JsonArrayConst>()) {
    int n = 0; for (JsonObjectConst s : o["switches"].as<JsonArrayConst>()) { if (n >= GNOME_MAX_SWITCH) break; String key = sanitizeNode(s["key"] | ""); int pin = s["pin"] | -1; if (pin < 0 || key.length() == 0) continue;
      cfg.sw[n].key = key; cfg.sw[n].pin = pin; cfg.sw[n].activeLow = s["active_low"] | true; cfg.sw[n].maxOnS = s["max_on_s"] | 600; if (cfg.sw[n].maxOnS < 5) cfg.sw[n].maxOnS = 5;
      String ex; if (s["exclusive"].is<JsonArrayConst>()) { for (JsonVariantConst e : s["exclusive"].as<JsonArrayConst>()) { if (ex.length()) ex += ","; ex += e.as<String>(); } } else if (s["exclusive"].is<const char*>()) ex = s["exclusive"].as<String>();
      cfg.sw[n].exclusive = ex; n++; }
    cfg.swCount = n; changed = true;
  }
  return changed;
}

void configLoad() {
  configSetDefaults();
  prefs.begin("gnome", true);
  String blob = prefs.getString("cfg", "");
  prefs.end();
  if (blob.length()) {
    JsonDocument d; if (!deserializeJson(d, blob)) configApplyJson(d.as<JsonObjectConst>());
  }
  if (cfg.node.length() == 0) cfg.node = defaultNodeName();
}

void configSave() {
  JsonDocument d; configToJson(d.to<JsonObject>(), true);
  String blob; serializeJson(d, blob);
  prefs.begin("gnome", false); prefs.putString("cfg", blob); prefs.end();
}
