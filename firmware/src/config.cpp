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
#if defined(GNOME_ROLE_CAM)
  cfg.oled = "none"; cfg.intervalS = 60;
#endif
#if defined(GNOME_BOARD_RELAYX4)
  // LC Technology ESP32-Relay-X4: relay1-4 = GPIO32/33/25/26 active HIGH, LED GPIO23
  cfg.swCount = 4;
  // Concept v2: relay1 = ปั๊ม 12V น้ำหยด · relay2 = เต้ารับพัดลม 220V · relay3 = หมอก (สำรอง) · relay4 = ว่าง
  cfg.sw[0].key = "pump"; cfg.sw[0].pin = 32; cfg.sw[0].activeLow = false; cfg.sw[0].maxOnS = 600;  cfg.sw[0].exclusive = "mist";
  cfg.sw[1].key = "fan";  cfg.sw[1].pin = 33; cfg.sw[1].activeLow = false; cfg.sw[1].maxOnS = 3600; cfg.sw[1].exclusive = "";
  cfg.sw[2].key = "mist"; cfg.sw[2].pin = 25; cfg.sw[2].activeLow = false; cfg.sw[2].maxOnS = 600;  cfg.sw[2].exclusive = "pump";
  cfg.sw[3].key = "aux";  cfg.sw[3].pin = 26; cfg.sw[3].activeLow = false; cfg.sw[3].maxOnS = 600;  cfg.sw[3].exclusive = "";
#elif defined(GNOME_ROLE_KEEPER)
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
  o["interval_s"] = cfg.intervalS; o["i2c_sda"] = cfg.i2cSda; o["i2c_scl"] = cfg.i2cScl; o["dht_pin"] = cfg.dhtPin; o["soil_power_pin"] = cfg.soilPowerPin;
  o["failsafe_s"] = cfg.failsafeS; o["oled"] = cfg.oled; o["board"] = GNOME_BOARD; o["thirsty_pct"] = cfg.thirstyPct; o["hot_c"] = cfg.hotC;
  o["hut_url"] = cfg.hutUrl; o["cam_size"] = cfg.camSize; o["cam_flash"] = cfg.camFlash; o["cam_flip"] = cfg.camFlip;
  o["servo_pin"] = cfg.servoPin; o["servo_min_us"] = cfg.servoMinUs; o["servo_max_us"] = cfg.servoMaxUs; o["servo_angle"] = cfg.servoAngle; o["servo_invert"] = cfg.servoInvert;
  JsonArray pre = o["presets"].to<JsonArray>();
  for (int i = 0; i < cfg.presetCount; i++) { JsonObject p = pre.add<JsonObject>(); p["name"] = cfg.preset[i].name; p["angle"] = cfg.preset[i].angle; }
  JsonArray soil = o["soil"].to<JsonArray>();
  for (int i = 0; i < cfg.soilCount; i++) { JsonObject s = soil.add<JsonObject>(); s["pin"] = cfg.soil[i].pin; s["dry"] = cfg.soil[i].dry; s["wet"] = cfg.soil[i].wet; s["key"] = cfg.soil[i].key; }
  JsonArray sw = o["switches"].to<JsonArray>();
  for (int i = 0; i < cfg.swCount; i++) {
    JsonObject s = sw.add<JsonObject>(); s["key"] = cfg.sw[i].key; s["pin"] = cfg.sw[i].pin; s["active_low"] = cfg.sw[i].activeLow;
    s["max_on_s"] = cfg.sw[i].maxOnS;
    JsonArray ex = s["exclusive"].to<JsonArray>();
    String rest = cfg.sw[i].exclusive; while (rest.length()) { int c = rest.indexOf(','); String k = c < 0 ? rest : rest.substring(0, c); k.trim(); if (k.length()) ex.add(k); if (c < 0) break; rest = rest.substring(c + 1); }
  }
}

#if defined(CONFIG_IDF_TARGET_ESP32S3)
static bool isAdc1Pin(int p) { return p >= 1 && p <= 10; }   // S3: ADC1 = GPIO1-10
#elif defined(CONFIG_IDF_TARGET_ESP32C6)
static bool isAdc1Pin(int p) { return p >= 0 && p <= 6; }    // C6: ADC1 = GPIO0-6
#else
static bool isAdc1Pin(int p) { return p == 32 || p == 33 || p == 34 || p == 35 || p == 36 || p == 39; }
#endif

bool configApplyJson(JsonObjectConst o) {
  bool changed = false;
  auto setS = [&](const char* k, String& dst) { if (o[k].is<const char*>()) { String v = o[k].as<String>(); if (v != dst) { dst = v; changed = true; } } };
  auto setI = [&](const char* k, int& dst) { if (o[k].is<int>()) { int v = o[k].as<int>(); if (v != dst) { dst = v; changed = true; } } };
  if (o["node"].is<const char*>()) { String n = sanitizeNode(o["node"].as<String>()); if (n.length() == 0) n = defaultNodeName(); if (n != cfg.node) { cfg.node = n; changed = true; } }
  setS("wifi_ssid", cfg.wifiSsid); setS("wifi_pass", cfg.wifiPass);
  setS("mqtt_host", cfg.mqttHost); setI("mqtt_port", cfg.mqttPort); setS("mqtt_user", cfg.mqttUser); setS("mqtt_pass", cfg.mqttPass);
  setI("interval_s", cfg.intervalS); setI("i2c_sda", cfg.i2cSda); setI("i2c_scl", cfg.i2cScl); setI("dht_pin", cfg.dhtPin); setI("soil_power_pin", cfg.soilPowerPin); setI("failsafe_s", cfg.failsafeS); setI("thirsty_pct", cfg.thirstyPct); setI("hot_c", cfg.hotC);
  setS("hut_url", cfg.hutUrl); if (o["cam_size"].is<const char*>()) { String v = o["cam_size"].as<String>(); if (v == "vga" || v == "svga" || v == "xga" || v == "uxga") { if (v != cfg.camSize) { cfg.camSize = v; changed = true; } } }
  if (o["cam_flash"].is<bool>()) { cfg.camFlash = o["cam_flash"].as<bool>(); changed = true; } if (o["cam_flip"].is<bool>()) { cfg.camFlip = o["cam_flip"].as<bool>(); changed = true; }
  setI("servo_pin", cfg.servoPin); setI("servo_min_us", cfg.servoMinUs); setI("servo_max_us", cfg.servoMaxUs); setI("servo_angle", cfg.servoAngle);
  if (o["servo_invert"].is<bool>()) { cfg.servoInvert = o["servo_invert"].as<bool>(); changed = true; }
  cfg.servoAngle = constrain(cfg.servoAngle, 0, 180);
  if (cfg.servoMinUs < 400) cfg.servoMinUs = 400; if (cfg.servoMaxUs > 2600) cfg.servoMaxUs = 2600;
  if (o["presets"].is<JsonArrayConst>()) {
    int n = 0;
    for (JsonObjectConst p : o["presets"].as<JsonArrayConst>()) {
      if (n >= GNOME_MAX_PRESET) break;
      String nm = sanitizeNode(p["name"] | ""); if (nm.length() == 0) continue;
      cfg.preset[n].name = nm; cfg.preset[n].angle = constrain((int)(p["angle"] | 90), 0, 180); n++;
    }
    cfg.presetCount = n; changed = true;
  }
  if (cfg.intervalS < 5) cfg.intervalS = 5; if (cfg.failsafeS < 30) cfg.failsafeS = 30;
  if (o["oled"].is<const char*>()) { String v = o["oled"].as<String>(); if (v != "sh1106" && v != "ssd1306" && v != "none") v = "sh1106"; if (v != cfg.oled) { cfg.oled = v; changed = true; } }
  if (o["soil"].is<JsonArrayConst>()) {
    int n = 0; for (JsonObjectConst s : o["soil"].as<JsonArrayConst>()) { if (n >= GNOME_MAX_SOIL) break; int pin = s["pin"] | -1; if (!isAdc1Pin(pin)) continue;
      cfg.soil[n].pin = pin; cfg.soil[n].dry = s["dry"] | 3100; cfg.soil[n].wet = s["wet"] | 1300; cfg.soil[n].key = sanitizeNode(s["key"] | ""); n++; }
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
