#if !defined(GNOME_ROLE_KEEPER)
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
static uint32_t lastPub = 0, lastErrEvent = 0;

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
  if (dht) { float t = dht->readTemperature(), h = dht->readHumidity(); if (isnan(t)) err = true; setLast("dht_temp_c", "°C", "dht22", t); setLast("dht_rh_pct", "%", "dht22", h); }
  for (int i = 0; i < cfg.soilCount; i++) {
    int raw = readSoilRaw(cfg.soil[i].pin); float pct = 100.0f * (cfg.soil[i].dry - raw) / (float)(cfg.soil[i].dry - cfg.soil[i].wet); pct = constrain(pct, 0.0f, 100.0f);
    char k1[16], k2[16]; snprintf(k1, 16, "soil%d_pct", i + 1); snprintf(k2, 16, "soil%d_raw", i + 1);
    setLast(k1, "%", "adc", pct); setLast(k2, "raw", "adc", raw);
  }
  if (!publish) return;
  for (int i = 0; i < lastCount; i++) if (last[i].valid) mqttPublish("sensor/" + last[i].key + "/state", String(last[i].value, last[i].unit == "raw" ? 0 : 2));
  if (err && millis() - lastErrEvent > 600000) { lastErrEvent = millis(); mqttEvent("sensor_error"); }
}

void roleLoop() {
  uint32_t iv = (uint32_t)cfg.intervalS * 1000;
  if (millis() - lastPub >= iv || lastPub == 0) { lastPub = millis(); readAll(mqttIsConnected()); }
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

bool roleCommand(const String& sub, const String&) { if (sub == "cmd/rescan") { roleRescan(); return true; } return false; }
bool roleWebSwitch(const String&, bool, int) { return false; }
#endif
