#include "improv.h"
#include <WiFi.h>
#include <vector>

namespace improv {
static const uint8_t TYPE_CURRENT_STATE = 0x01, TYPE_ERROR = 0x02, TYPE_RPC = 0x03, TYPE_RPC_RESULT = 0x04;
static const uint8_t CMD_WIFI = 0x01, CMD_GET_STATE = 0x02, CMD_GET_INFO = 0x03, CMD_GET_NETWORKS = 0x04;

static ConnectFn s_connect = nullptr; static UrlFn s_url = nullptr;
static String s_fwName, s_fwVersion, s_chip, s_devName;
static State s_state = STATE_AUTHORIZED;
static std::vector<uint8_t> rx; static uint32_t lastRxMs = 0;

static void sendPacket(uint8_t type, const std::vector<uint8_t>& data) {
  std::vector<uint8_t> p = {'I','M','P','R','O','V', 1, type, (uint8_t)data.size()};
  p.insert(p.end(), data.begin(), data.end());
  uint8_t sum = 0; for (uint8_t b : p) sum += b; p.push_back(sum);
  Serial.write(p.data(), p.size()); Serial.write('\n');
}
static void sendState(State s) { sendPacket(TYPE_CURRENT_STATE, {(uint8_t)s}); }
static void sendError(Error e) { sendPacket(TYPE_ERROR, {(uint8_t)e}); }
static void sendRpcResult(uint8_t cmd, const std::vector<String>& strs) {
  std::vector<uint8_t> d; for (auto& s : strs) { d.push_back((uint8_t)s.length()); for (char c : s) d.push_back((uint8_t)c); }
  std::vector<uint8_t> out = {cmd, (uint8_t)d.size()}; out.insert(out.end(), d.begin(), d.end());
  sendPacket(TYPE_RPC_RESULT, out);
}

void setState(State s) { s_state = s; sendState(s); }

void begin(ConnectFn connect, UrlFn url, const char* fwName, const char* fwVersion, const char* chip, const char* deviceName) {
  s_connect = connect; s_url = url; s_fwName = fwName; s_fwVersion = fwVersion; s_chip = chip; s_devName = deviceName;
  s_state = WiFi.status() == WL_CONNECTED ? STATE_PROVISIONED : STATE_AUTHORIZED;
}

static void handleRpc(const uint8_t* d, size_t n) {
  if (n < 2) { sendError(ERR_INVALID_RPC); return; }
  uint8_t cmd = d[0]; uint8_t len = d[1]; if (len + 2 > n) { sendError(ERR_INVALID_RPC); return; }
  const uint8_t* body = d + 2;
  switch (cmd) {
    case CMD_GET_STATE:
      sendState(s_state);
      if (s_state == STATE_PROVISIONED && s_url) sendRpcResult(cmd, {s_url()});
      break;
    case CMD_GET_INFO:
      sendRpcResult(cmd, {s_fwName, s_fwVersion, s_chip, s_devName});
      break;
    case CMD_GET_NETWORKS: {
      int cnt = WiFi.scanNetworks();
      for (int i = 0; i < cnt && i < 20; i++)
        sendRpcResult(cmd, {WiFi.SSID(i), String(WiFi.RSSI(i)), WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "NO" : "YES"});
      sendRpcResult(cmd, {}); WiFi.scanDelete();
      break; }
    case CMD_WIFI: {
      if (len < 2) { sendError(ERR_INVALID_RPC); return; }
      uint8_t sl = body[0]; if (1 + sl + 1 > len) { sendError(ERR_INVALID_RPC); return; }
      String ssid; for (int i = 0; i < sl; i++) ssid += (char)body[1 + i];
      uint8_t pl = body[1 + sl]; String pass; for (int i = 0; i < pl && 2 + sl + i < len; i++) pass += (char)body[2 + sl + i];
      setState(STATE_PROVISIONING);
      bool ok = s_connect ? s_connect(ssid, pass) : false;
      if (ok) { setState(STATE_PROVISIONED); sendRpcResult(cmd, {s_url ? s_url() : String("")}); }
      else { sendError(ERR_UNABLE_TO_CONNECT); setState(STATE_AUTHORIZED); }
      break; }
    default: sendError(ERR_UNKNOWN_CMD);
  }
}

void loop() {
  while (Serial.available()) {
    uint8_t b = (uint8_t)Serial.read(); uint32_t now = millis();
    if (now - lastRxMs > 500) rx.clear(); lastRxMs = now;
    rx.push_back(b);
    // header sync
    static const char* H = "IMPROV";
    if (rx.size() <= 6) { if (rx.back() != (uint8_t)H[rx.size() - 1]) rx.clear(); continue; }
    if (rx.size() < 9) continue;
    uint8_t len = rx[8]; size_t total = 9 + len + 1;
    if (rx.size() < total) continue;
    uint8_t sum = 0; for (size_t i = 0; i < total - 1; i++) sum += rx[i];
    uint8_t type = rx[7];
    if (sum == rx[total - 1] && rx[6] == 1) { if (type == TYPE_RPC) handleRpc(rx.data() + 9, len); }
    else sendError(ERR_INVALID_RPC);
    rx.clear();
  }
}
}
