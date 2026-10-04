#pragma once
#include <ArduinoJson.h>

// รายการเซ็นเซอร์ที่ node รุ่นนี้รองรับ พร้อมขาที่ต้องเสียบ (ตายตัวต่อรุ่นบอร์ด)
// ผู้ใช้แค่ติ๊กเลือกว่าต่ออะไรไว้บ้าง ไม่ต้องกรอกเลขขาเอง
struct SensorSlot {
  const char* id;      // ใช้ในคอนฟิก เช่น "dht", "soil1", "rain"
  const char* label;   // ชื่อที่โชว์ให้คน
  const char* kind;    // "dht" = ดิจิทัล 1 สาย · "analog" = ADC1
  int pin;             // ขาที่ตายตัว
  const char* key;     // analog: ชื่อค่าที่จะส่ง ("" = soilN ตามลำดับ)
  int dry, wet;        // analog: ค่า raw เริ่มต้น (ปรับเทียบทีหลังได้)
  const char* wiring;  // ไกด์ต่อสาย
};

int sensorSlotCount();
const SensorSlot* sensorSlots();
const SensorSlot* sensorSlotById(const char* id);
int sensorPowerPin();                    // ขาจ่ายไฟหัววัด analog ของบอร์ดนี้
void sensorsToJson(JsonObject o);        // เติม slots[] + sensors[] (ที่เปิดอยู่) + sensor_power_pin
bool sensorsApplyIds(JsonArrayConst ids);// ตั้ง dhtPin/soil[] จากรายการ id ที่ติ๊ก
