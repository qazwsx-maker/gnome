#if !defined(GNOME_ROLE_KEEPER) && !defined(GNOME_ROLE_CAM)
// GnomeOS Scout — sensor node
#include "gnome.h"
#include <Wire.h>
#include <Adafruit_SHT31.h>
#include <Adafruit_BME280.h>
#include <BH1750.h>
#include <DHT.h>

static Adafruit_SHT31 sht; static bool hasSht = false; static uint8_t shtAddr = 0;
static Adafruit_BME280 bme; static bool hasBme = false;
static BH1750 bh; static bool hasBh = false;
static DHT* dht = nullptr;
static uint32_t lastPub = 0, lastErrEvent = 0, retryAt = 0;
static bool dhtRetryPending = false;

struct Reading { String key, unit, src; float value = NAN; bool valid = false; };
static Reading last[16]; static int lastCount = 0;

static void setLast(const char* key, const char* unit, const char* src, float v) {
  for (int i = 0; i < lastCount; i++) if (last[i].key == key) { last[i].value = v; last[i].valid = !isnan(v); return; }
  if (lastCount < 16) { last[lastCount].key = key; last[lastCount].unit = unit; last[lastCount].src = src; last[lastCount].value = v; last[lastCount].valid = !isnan(v); lastCount++; }
}

void roleRescan() {
  Wire.end(); Wire.begin(cfg.i2cSda, cfg.i2cScl); Wire.setTimeOut(50);
  hasSht = hasBme = hasBh = false; shtAddr = 0;
  Serial.printf("[scout] I2C scan (SDA %d SCL %d): ", cfg.i2cSda, cfg.i2cScl);
  for (uint8_t a = 1; a < 127; a++) { Wire.beginTransmission(a); if (Wire.endTransmission() == 0) Serial.printf("0x%02X ", a); }
  Serial.println();
  for (uint8_t a : {0x44, 0x45}) if (!hasSht && sht.begin(a)) { hasSht = true; shtAddr = a; }
  for (uint8_t a : {0x23, 0x5C}) if (!hasBh && bh.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, a, &Wire)) hasBh = true;
  for (uint8_t a : {0x76, 0x77}) if (!hasBme && bme.begin(a, &Wire)) hasBme = true;
  if (dht) { delete dht; dht = nullptr; }
  if (cfg.dhtPin >= 0) { dht = new DHT(cfg.dhtPin, DHT22); dht->begin(); }
  for (int i = 0; i < cfg.soilCount; i++) { pinMode(cfg.soil[i].pin, INPUT); analogSetPinAttenuation(cfg.soil[i].pin, ADC_11db); }
  if (cfg.soilPowerPin >= 0) { pinMode(cfg.soilPowerPin, OUTPUT); digitalWrite(cfg.soilPowerPin, LOW); }
  analogReadResolution(12);
  lastCount = 0;
  Serial.printf("[scout] sht3x=%d bh1750=%d bme280=%d dht=%d soil=%d\n", hasSht, hasBh, hasBme, dht != nullptr, cfg.soilCount);
  lastPub = 0; // publish soon
}

void roleSetup() { roleRescan(); }

static int readSoilRaw(int pin) { uint32_t acc = 0; for (int i = 0; i < 32; i++) { acc += analogRead(pin); delayMicroseconds(200); } return acc / 32; }

static void readAll(bool publish) {
  bool err = false;
  if (hasSht) { float t = sht.readTemperature(), h = sht.readHumidity(); if (isnan(t) || isnan(h)) err = true; setLast("temp_c", "°C", "sht3x", t); setLast("rh_pct", "%", "sht3x", h); }
  if (hasBme) { float t = bme.readTemperature(), h = bme.readHumidity(), p = bme.readPressure() / 100.0f;
    if (!hasSht) { setLast("temp_c", "°C", "bme280", t); setLast("rh_pct", "%", "bme280", h); } setLast("press_hpa", "hPa", "bme280", p); }
  if (hasBh) { float l = bh.readLightLevel(); if (l < 0) { err = true; l = NAN; } setLast("lux", "lx", "bh1750", l); }
  if (dht) {
    float t = dht->readTemperature(), h = dht->readHumidity();
    if (isnan(t) || isnan(h)) {
      err = true;
      // สายยาว / ไม่มี pull-up ภายนอก มักพลาดครั้งแรก → นัดอ่านซ้ำใน 2.5 s (ไม่บล็อก web/MQTT)
      if (publish && !dhtRetryPending) { dhtRetryPending = true; retryAt = millis() + 2500; }
    } else dhtRetryPending = false;
    setLast("dht_temp_c", "°C", "dht22", t); setLast("dht_rh_pct", "%", "dht22", h);
  }
  if (cfg.soilCount) {
    if (cfg.soilPowerPin >= 0) { digitalWrite(cfg.soilPowerPin, HIGH); delay(150); }   // เปิดไฟหัววัดแค่ตอนอ่าน
    for (int i = 0; i < cfg.soilCount; i++) {
      int raw = readSoilRaw(cfg.soil[i].pin); float pct = 100.0f * (cfg.soil[i].dry - raw) / (float)(cfg.soil[i].dry - cfg.soil[i].wet); pct = constrain(pct, 0.0f, 100.0f);
      String base = cfg.soil[i].key.length() ? cfg.soil[i].key : String("soil") + (i + 1);
      setLast((base + "_pct").c_str(), "%", "adc", pct); setLast((base + "_raw").c_str(), "raw", "adc", raw);
    }
    if (cfg.soilPowerPin >= 0) digitalWrite(cfg.soilPowerPin, LOW);
  }
  if (!publish) return;
  for (int i = 0; i < lastCount; i++) if (last[i].valid) mqttPublish("sensor/" + last[i].key + "/state", String(last[i].value, last[i].unit == "raw" ? 0 : 2));
  if (err && millis() - lastErrEvent > 600000) { lastErrEvent = millis(); mqttEvent("sensor_error"); }
}

void roleLoop() {
  uint32_t iv = (uint32_t)cfg.intervalS * 1000;
  if (retryAt && (int32_t)(millis() - retryAt) >= 0) { retryAt = 0; readAll(mqttIsConnected()); return; }
  if (millis() - lastPub >= iv || lastPub == 0) { lastPub = millis(); dhtRetryPending = false; readAll(mqttIsConnected()); }
}

void roleOnMqttConnect() {
  readAll(false);
  for (int i = 0; i < lastCount; i++) mqttPublish("sensor/" + last[i].key + "/meta", "{\"unit\":\"" + last[i].unit + "\",\"src\":\"" + last[i].src + "\"}", true, 1);
  lastPub = 0;
}

void roleMeta(JsonObject meta) {
  readAll(false);
  JsonArray a = meta["sensors"].as<JsonArray>();
  for (int i = 0; i < lastCount; i++) { JsonObject o = a.add<JsonObject>(); o["key"] = last[i].key; o["unit"] = last[i].unit; o["src"] = last[i].src; }
  meta["i2c"] = String("sda=") + cfg.i2cSda + " scl=" + cfg.i2cScl;
}

void roleStatus(JsonObject st) {
  JsonObject s = st["sensors"].to<JsonObject>();
  for (int i = 0; i < lastCount; i++) { JsonObject o = s[last[i].key].to<JsonObject>(); if (last[i].valid) o["value"] = last[i].value; else o["value"] = nullptr; o["unit"] = last[i].unit; o["src"] = last[i].src; }
  st["detected"] = String(hasSht ? "sht3x " : "") + (hasBh ? "bh1750 " : "") + (hasBme ? "bme280 " : "") + (dht ? "dht22 " : "");
}

static float lastVal(const char* key, bool* ok = nullptr) { for (int i = 0; i < lastCount; i++) if (last[i].key == key) { if (ok) *ok = last[i].valid; return last[i].value; } if (ok) *ok = false; return NAN; }

Mood roleMood() {
  if (!mqttIsConnected() && cfg.mqttHost.length()) return MOOD_SICK;
  int nValid = 0; for (int i = 0; i < lastCount; i++) if (last[i].valid) nValid++;
  if (lastCount > 0 && nValid == 0) return MOOD_SICK;   // มีเซ็นเซอร์แต่อ่านไม่ได้เลยในรอบล่าสุด (ไม่ใช่แค่พลาดครั้งเดียวเมื่อ 10 นาทีก่อน)
  bool ok; float v;
  v = lastVal("rain_pct", &ok); if (ok && v > 50) return MOOD_RAIN;
  for (int i = 0; i < lastCount; i++) if (last[i].valid && last[i].key.endsWith("_pct") && !last[i].key.startsWith("rh") && !last[i].key.startsWith("dht") && !last[i].key.startsWith("rain") && last[i].value < cfg.thirstyPct) return MOOD_THIRSTY;
  v = lastVal("temp_c", &ok); if (!ok) v = lastVal("dht_temp_c", &ok); if (ok && v > cfg.hotC) return MOOD_HOT;
  v = lastVal("lux", &ok); if (ok && v < 5) return MOOD_SLEEPY;
  return MOOD_HAPPY;
}

static String shortKey(String k) { k.replace("dht_", ""); k.replace("_pct", ""); k.replace("_hpa", ""); k.replace("_raw", "~"); if (k.endsWith("_c")) k.remove(k.length() - 2); return k; }

int roleDisplayLines(String* lines, int max, int page) {
  int n = 0, start = page * (max * 2);
  for (int i = start, col = 0; i < lastCount && n < max; i++) {
    String v = last[i].valid ? String(last[i].value, last[i].unit == "raw" ? 0 : 1) : String("--");
    String cell = shortKey(last[i].key) + " " + v; if (cell.length() > 10) cell = cell.substring(0, 10);
    while (cell.length() < 11) cell += ' ';
    if (col == 0) { lines[n] = cell; col = 1; } else { lines[n] += cell; col = 0; n++; }
    if (i == lastCount - 1 && col == 1) n++;
  }
  if (lastCount == 0 && page == 0) { lines[0] = "no sensors"; n = 1; }
  return n;
}

int roleStats(StatItem* out, int max) {
  int n = 0;
  for (int i = 0; i < lastCount && n < max; i++) {
    if (!last[i].valid || last[i].key.endsWith("_raw")) continue;
    const String& k = last[i].key;
    StatItem s; s.unit = last[i].unit;
    if (k.indexOf("temp") >= 0)       { s.label = "TEMP";  s.icon = 1; s.unit = "C"; }
    else if (k.indexOf("rh") >= 0)    { s.label = "HUMID"; s.icon = 2; }
    else if (k == "lux")              { s.label = "LIGHT"; s.icon = 3; }
    else if (k.startsWith("rain"))    { s.label = "RAIN";  s.icon = 5; }
    else if (k.startsWith("soil"))    { s.label = "SOIL " + k.substring(4, 5); s.icon = 4; }
    else if (k == "press_hpa")        { s.label = "PRESS"; s.icon = 0; }
    else                              { s.label = k; s.label.toUpperCase(); s.icon = 0; }
    s.value = String(last[i].value, 1);
    out[n++] = s;
  }
  return n;
}

bool roleCommand(const String& sub, const String&) { if (sub == "cmd/rescan") { roleRescan(); return true; } return false; }
bool roleWebSwitch(const String&, bool, int) { return false; }
String roleCaption() { return String(); }
#endif
