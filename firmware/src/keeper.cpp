#if defined(GNOME_ROLE_KEEPER)
// GnomeOS Keeper — controller node (relay / solenoid / fan)
#include "gnome.h"

struct SwState { bool on = false; uint32_t offAt = 0; uint32_t onSince = 0; };
static SwState st[GNOME_MAX_SWITCH];
static bool failsafeTripped = false; static uint32_t failsafePending = 0;

static int findSw(const String& key) { for (int i = 0; i < cfg.swCount; i++) if (cfg.sw[i].key == key) return i; return -1; }
static void drive(int i, bool on) { digitalWrite(cfg.sw[i].pin, (on != cfg.sw[i].activeLow) ? HIGH : LOW); }
static void publishState(int i) { mqttPublish("switch/" + cfg.sw[i].key + "/state", st[i].on ? "ON" : "OFF", true, 1); }

static void setSwitch(int i, bool on, int seconds, const char* reason) {
  if (i < 0 || i >= cfg.swCount) return;
  if (on) {
    // interlock: ปิดตัวที่อยู่ในกลุ่ม exclusive ก่อน
    String ex = cfg.sw[i].exclusive;
    while (ex.length()) { int c = ex.indexOf(','); String k = c < 0 ? ex : ex.substring(0, c); k.trim(); int j = findSw(k);
      if (j >= 0 && j != i && st[j].on) { setSwitch(j, false, 0, "interlock"); mqttEvent("interlock_blocked", "\"key\":\"" + cfg.sw[j].key + "\",\"by\":\"" + cfg.sw[i].key + "\""); }
      if (c < 0) break; ex = ex.substring(c + 1); }
    int maxS = cfg.sw[i].maxOnS; int dur = (seconds > 0 && seconds < maxS) ? seconds : maxS;
    st[i].on = true; st[i].onSince = millis(); st[i].offAt = millis() + (uint32_t)dur * 1000UL;
    drive(i, true);
    Serial.printf("[keeper] %s ON for %ds (%s)\n", cfg.sw[i].key.c_str(), dur, reason);
  } else {
    bool was = st[i].on; st[i].on = false; st[i].offAt = 0; drive(i, false);
    if (was) Serial.printf("[keeper] %s OFF (%s) after %lus\n", cfg.sw[i].key.c_str(), reason, (millis() - st[i].onSince) / 1000);
  }
  publishState(i);
}

static void allOff(const char* reason) { for (int i = 0; i < cfg.swCount; i++) if (st[i].on) setSwitch(i, false, 0, reason); }

void roleSetup() {
  for (int i = 0; i < cfg.swCount; i++) { pinMode(cfg.sw[i].pin, OUTPUT); st[i] = SwState(); drive(i, false); }
  Serial.printf("[keeper] %d switches\n", cfg.swCount);
}

void roleLoop() {
  uint32_t now = millis();
  for (int i = 0; i < cfg.swCount; i++)
    if (st[i].on && st[i].offAt && (int32_t)(now - st[i].offAt) >= 0) {
      bool maxed = (now - st[i].onSince) >= (uint32_t)cfg.sw[i].maxOnS * 1000UL - 500;
      setSwitch(i, false, 0, maxed ? "max_on" : "timer");
      if (maxed) mqttEvent("max_on_reached", "\"key\":\"" + cfg.sw[i].key + "\"");
    }
  // failsafe: ขาด MQTT (หรือ server offline) นานเกิน failsafe_s → ปิดทุกตัว
  bool anyOn = false; for (int i = 0; i < cfg.swCount; i++) anyOn |= st[i].on;
  bool linkOk = mqttIsConnected() && mqttServerOnline();
  if (anyOn && !linkOk) {
    if (failsafePending == 0) failsafePending = now;
    if (now - failsafePending > (uint32_t)cfg.failsafeS * 1000UL) { allOff("failsafe"); failsafeTripped = true; failsafePending = 0; }
  } else failsafePending = 0;
}

void roleOnMqttConnect() {
  for (int i = 0; i < cfg.swCount; i++) {
    publishState(i);
    JsonDocument d; d["pin"] = cfg.sw[i].pin; d["active_low"] = cfg.sw[i].activeLow; d["max_on_s"] = cfg.sw[i].maxOnS;
    JsonArray ex = d["exclusive"].to<JsonArray>(); String e = cfg.sw[i].exclusive; while (e.length()) { int c = e.indexOf(','); String k = c < 0 ? e : e.substring(0, c); k.trim(); if (k.length()) ex.add(k); if (c < 0) break; e = e.substring(c + 1); }
    String s; serializeJson(d, s); mqttPublish("switch/" + cfg.sw[i].key + "/meta", s, true, 1);
  }
  if (failsafeTripped) { failsafeTripped = false; mqttEvent("failsafe_off"); }
}

void roleMeta(JsonObject meta) {
  JsonArray a = meta["switches"].as<JsonArray>();
  for (int i = 0; i < cfg.swCount; i++) { JsonObject o = a.add<JsonObject>(); o["key"] = cfg.sw[i].key; o["pin"] = cfg.sw[i].pin; o["active_low"] = cfg.sw[i].activeLow; o["max_on_s"] = cfg.sw[i].maxOnS;
    JsonArray ex = o["exclusive"].to<JsonArray>(); String e = cfg.sw[i].exclusive; while (e.length()) { int c = e.indexOf(','); String k = c < 0 ? e : e.substring(0, c); k.trim(); if (k.length()) ex.add(k); if (c < 0) break; e = e.substring(c + 1); } }
  meta["failsafe_s"] = cfg.failsafeS;
}

void roleStatus(JsonObject s) {
  JsonArray a = s["switches"].to<JsonArray>();
  for (int i = 0; i < cfg.swCount; i++) { JsonObject o = a.add<JsonObject>(); o["key"] = cfg.sw[i].key; o["state"] = st[i].on ? "ON" : "OFF"; o["pin"] = cfg.sw[i].pin;
    o["remaining_s"] = st[i].on && st[i].offAt ? (int)((st[i].offAt - millis()) / 1000) : 0; }
}

bool roleCommand(const String& sub, const String& payload) {
  // switch/<key>/command
  if (!sub.startsWith("switch/")) return false;
  int e = sub.indexOf("/command"); if (e < 0) return false;
  String key = sub.substring(7, e); int i = findSw(key); if (i < 0) { mqttEvent("unknown_switch", "\"key\":\"" + key + "\""); return true; }
  String p = payload; p.trim(); p.toUpperCase();
  if (p.startsWith("ON")) { int sec = 0; if (p.length() > 2) sec = p.substring(2).toInt(); setSwitch(i, true, sec, "mqtt"); }
  else setSwitch(i, false, 0, "mqtt");
  return true;
}

Mood roleMood() {
  if (!mqttIsConnected() && cfg.mqttHost.length()) return MOOD_SICK;
  for (int i = 0; i < cfg.swCount; i++) if (st[i].on && (cfg.sw[i].key.indexOf("drip") >= 0 || cfg.sw[i].key.indexOf("pump") >= 0 || cfg.sw[i].key.indexOf("mist") >= 0 || cfg.sw[i].key.indexOf("water") >= 0)) return MOOD_WATERING;
  for (int i = 0; i < cfg.swCount; i++) if (st[i].on && cfg.sw[i].key.indexOf("fan") >= 0) return MOOD_FAN;
  return MOOD_HAPPY;
}

int roleDisplayLines(String* lines, int max, int) {
  int n = 0;
  for (int i = 0; i < cfg.swCount && n < max; i += 2) {
    String l;
    for (int j = i; j < i + 2 && j < cfg.swCount; j++) {
      String cell = cfg.sw[j].key.substring(0, 4) + (st[j].on ? ":ON " : ":off");
      if (st[j].on && st[j].offAt) { int rem = (int)((st[j].offAt - millis()) / 1000); cell += String(rem) + "s"; }
      while (cell.length() < 11) cell += ' ';
      l += cell;
    }
    lines[n++] = l;
  }
  return n;
}

int roleStats(StatItem* out, int max) {
  int n = 0;
  for (int i = 0; i < cfg.swCount && n < max; i++) {
    StatItem s; s.label = cfg.sw[i].key; s.label.toUpperCase(); s.icon = 6;
    s.value = st[i].on ? "ON" : "OFF";
    s.unit = st[i].on && st[i].offAt ? String((int)((st[i].offAt - millis()) / 1000)) + "s left" : "";
    out[n++] = s;
  }
  return n;
}

bool roleWebSwitch(const String& key, bool on, int seconds) { int i = findSw(key); if (i < 0) return false; setSwitch(i, on, seconds, "web"); return true; }
void roleRescan() {}
#endif
