#include "sensors.h"
#include "config.h"

// ขาที่เลือกไว้เป็นมาตรฐานของแต่ละบอร์ด
// analog ต้องเป็น ADC1 เท่านั้น เพราะ ADC2 อ่านไม่ได้ขณะเปิด WiFi
#if defined(GNOME_BOARD_S3UNO)
  static const int POWER_PIN = 12;
  static const SensorSlot SLOTS[] = {
    { "dht",   "AM2301A / DHT22 — อุณหภูมิ + ความชื้นอากาศ", "dht",    14, "",      0,    0,    "DATA→IO14 · VCC→3V3 · GND→GND · ใส่ R 4.7–10kΩ ระหว่าง DATA กับ 3V3" },
    { "soil1", "หัววัดความชื้นดิน #1",                        "analog",  2, "soil1",      3100, 1300, "AO→A0 (IO2) · VCC→IO12 · GND→GND · DO ไม่ต้องต่อ · ห้าม 5V" },
    { "soil2", "หัววัดความชื้นดิน #2",                        "analog",  1, "soil2",      3100, 1300, "AO→A1 (IO1) · VCC→IO12 · GND→GND" },
    { "soil3", "หัววัดความชื้นดิน #3",                        "analog",  7, "soil3",      3100, 1300, "AO→A2 (IO7) · VCC→IO12 · GND→GND" },
    { "rain",  "แผ่นวัดน้ำฝน (MH-RD)",                        "analog",  6, "rain",  3800, 1200, "AO→A3 (IO6) · VCC→IO12 · GND→GND · ติดเอียงอย่างน้อย 30° ให้น้ำไหลออก" },
  };
#else
  static const int POWER_PIN = 13;
  static const SensorSlot SLOTS[] = {
    { "dht",   "AM2301A / DHT22 — อุณหภูมิ + ความชื้นอากาศ", "dht",     4, "",      0,    0,    "สายเหลือง (DATA)→D4 · แดง→3V3 · ดำ→GND · ใส่ R 4.7–10kΩ ระหว่าง DATA กับ 3V3" },
    { "soil1", "หัววัดความชื้นดิน #1",                        "analog", 34, "soil1",      3100, 1300, "AO→D34 · VCC→D13 · GND→GND · DO ไม่ต้องต่อ · ห้าม 5V" },
    { "soil2", "หัววัดความชื้นดิน #2",                        "analog", 35, "soil2",      3100, 1300, "AO→D35 · VCC→D13 · GND→GND" },
    { "soil3", "หัววัดความชื้นดิน #3",                        "analog", 32, "soil3",      3100, 1300, "AO→D32 · VCC→D13 · GND→GND" },
    { "rain",  "แผ่นวัดน้ำฝน (MH-RD)",                        "analog", 33, "rain",  3800, 1200, "AO→D33 · VCC→D13 · GND→GND · ติดเอียงอย่างน้อย 30° ให้น้ำไหลออก" },
  };
#endif

static const int N_SLOTS = sizeof(SLOTS) / sizeof(SLOTS[0]);

int sensorSlotCount() { return N_SLOTS; }
const SensorSlot* sensorSlots() { return SLOTS; }
int sensorPowerPin() { return POWER_PIN; }

const SensorSlot* sensorSlotById(const char* id) {
  for (int i = 0; i < N_SLOTS; i++) if (strcmp(SLOTS[i].id, id) == 0) return &SLOTS[i];
  return nullptr;
}

/** ช่องนี้เปิดอยู่ไหม — ดูจากขาที่ตั้งไว้จริงในคอนฟิก */
static bool slotEnabled(const SensorSlot& s) {
  if (strcmp(s.kind, "dht") == 0) return cfg.dhtPin == s.pin;
  for (int i = 0; i < cfg.soilCount; i++) if (cfg.soil[i].pin == s.pin) return true;
  return false;
}

void sensorsToJson(JsonObject o) {
  JsonArray slots = o["slots"].to<JsonArray>();
  JsonArray on = o["sensors"].to<JsonArray>();
  for (int i = 0; i < N_SLOTS; i++) {
    const SensorSlot& s = SLOTS[i];
    JsonObject j = slots.add<JsonObject>();
    j["id"] = s.id; j["label"] = s.label; j["kind"] = s.kind; j["pin"] = s.pin; j["wiring"] = s.wiring;
    bool en = slotEnabled(s);
    j["on"] = en;
    if (en) on.add(s.id);
  }
  o["sensor_power_pin"] = POWER_PIN;
}

/** ตั้ง dhtPin + soil[] ใหม่ทั้งชุดจากรายการ id ที่ติ๊กไว้
    ค่าปรับเทียบ dry/wet ของช่องที่เคยเปิดอยู่แล้วจะถูกเก็บไว้ ไม่โดนรีเซ็ต */
bool sensorsApplyIds(JsonArrayConst ids) {
  int keepDry[GNOME_MAX_SOIL], keepWet[GNOME_MAX_SOIL], keepPin[GNOME_MAX_SOIL], nKeep = cfg.soilCount;
  for (int i = 0; i < nKeep && i < GNOME_MAX_SOIL; i++) { keepPin[i] = cfg.soil[i].pin; keepDry[i] = cfg.soil[i].dry; keepWet[i] = cfg.soil[i].wet; }

  cfg.dhtPin = -1;
  cfg.soilCount = 0;
  bool anyAnalog = false;
  for (JsonVariantConst v : ids) {
    const char* id = v.as<const char*>();
    if (!id) continue;
    const SensorSlot* s = sensorSlotById(id);
    if (!s) continue;
    if (strcmp(s->kind, "dht") == 0) { cfg.dhtPin = s->pin; continue; }
    if (cfg.soilCount >= GNOME_MAX_SOIL) continue;
    int dry = s->dry, wet = s->wet;
    for (int i = 0; i < nKeep && i < GNOME_MAX_SOIL; i++) if (keepPin[i] == s->pin) { dry = keepDry[i]; wet = keepWet[i]; }
    cfg.soil[cfg.soilCount].pin = s->pin;
    cfg.soil[cfg.soilCount].key = s->key;
    cfg.soil[cfg.soilCount].dry = dry;
    cfg.soil[cfg.soilCount].wet = wet;
    cfg.soilCount++;
    anyAnalog = true;
  }
  // มีหัว analog = ต้องมีขาจ่ายไฟ ไม่มีก็ปิด
  cfg.soilPowerPin = anyAnalog ? POWER_PIN : -1;
  return true;
}
