// GnomeOS — firmware ของ node ในโปรเจค GNOME (ภูตดูแลสวน)
// Scout = sensor node · Keeper = controller node
#include "gnome.h"

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n[gnome] %s %s\n", GNOME_FW_NAME, GNOME_VERSION);
  configLoad();
  Serial.printf("[gnome] node=%s wifi=%s mqtt=%s:%d\n", cfg.node.c_str(), cfg.wifiSsid.length() ? cfg.wifiSsid.c_str() : "(none)", cfg.mqttHost.length() ? cfg.mqttHost.c_str() : "(none)", cfg.mqttPort);
  roleSetup();      // keeper: ทุก relay OFF ก่อนต่อเน็ตเสมอ
  netSetup();
  mqttSetup();
}

void loop() {
  netLoop();
  mqttLoop();
  roleLoop();
  delay(5);
}
