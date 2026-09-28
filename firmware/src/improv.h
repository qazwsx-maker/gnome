#pragma once
#include <Arduino.h>
// Improv Wi-Fi (serial) — ให้ ESP Web Tools บนหน้า flash ตั้ง WiFi ให้ node ได้ทันทีหลัง flash
// spec: https://www.improv-wifi.com/serial/
namespace improv {
  enum State : uint8_t { STATE_AUTHORIZED = 0x02, STATE_PROVISIONING = 0x03, STATE_PROVISIONED = 0x04 };
  enum Error : uint8_t { ERR_NONE = 0x00, ERR_INVALID_RPC = 0x01, ERR_UNKNOWN_CMD = 0x02, ERR_UNABLE_TO_CONNECT = 0x03, ERR_UNKNOWN = 0xFF };
  // callback: รับ ssid/pass → คืน true ถ้าเชื่อมต่อสำเร็จ (ภายในเวลาที่กำหนด)
  typedef bool (*ConnectFn)(const String& ssid, const String& pass);
  typedef String (*UrlFn)();
  void begin(ConnectFn connect, UrlFn url, const char* fwName, const char* fwVersion, const char* chip, const char* deviceName);
  void loop();                // อ่าน Serial
  void setState(State s);     // ส่งสถานะปัจจุบัน (เช่นเมื่อต่อ WiFi ได้แล้ว)
}
