#!/bin/bash
# GnomeOS release: build ทุก env → วาง binaries ให้หน้า flash (docs/firmware) และ gnome-core (/firmware/<env>/…) → OTA ได้ทันที
#   tools/release.sh 0.2.1        ตั้งเวอร์ชันใหม่แล้ว build
#   tools/release.sh              build ด้วยเวอร์ชันปัจจุบันใน platformio.ini
set -euo pipefail
cd "$(dirname "$0")/../firmware"
ENVS=(scout keeper keeper-relayx4 scout-s3)
C6_ENVS=(scout-c6)   # ESP32-C6 build ด้วย core dir แยก (pioarduino) — ข้ามถ้ายังไม่เคยติดตั้ง
if [ -n "${1:-}" ]; then printf '#pragma once\n// เขียนโดย tools/release.sh — อย่าแก้มือ\n#define GNOME_VERSION "%s"\n' "$1" > src/version.h; fi
VER=$(grep -o '"[0-9.]*"' src/version.h | tr -d '"')
echo "== GnomeOS $VER: building ${ENVS[*]}"
pio run -e "$(IFS=, ; echo "${ENVS[*]}")" 2>&1 | grep -E "SUCCESS|FAILED|error:" || true
if [ -d "$HOME/.platformio-c6/platforms" ]; then
  PLATFORMIO_CORE_DIR=$HOME/.platformio-c6 pio run -e "$(IFS=, ; echo "${C6_ENVS[*]}")" 2>&1 | grep -E "SUCCESS|FAILED|error:" || true
  ENVS+=("${C6_ENVS[@]}")
fi
BOOT0=$HOME/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin
for e in "${ENVS[@]}"; do
  d=../docs/firmware/$e; mkdir -p "$d"
  [ -f ".pio/build/$e/firmware.bin" ] || { echo "!! $e build missing"; exit 1; }
  cp ".pio/build/$e/bootloader.bin" ".pio/build/$e/partitions.bin" ".pio/build/$e/firmware.bin" "$d/"
  case $e in *-c6) cp "$HOME/.platformio-c6/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin" "$d/";; *) cp "$BOOT0" "$d/";; esac
  python3 - "$d/manifest.json" "$VER" "$e" <<'PY'
import json,sys
p,ver,env=sys.argv[1:]
name={'scout':'GnomeOS Mini Scout (ESP32 DevKit)','keeper':'GnomeOS Keeper','keeper-relayx4':'GnomeOS Keeper (ESP32-Relay-X4)','scout-s3':'GnomeOS Scout (ESP32-S3 UNO)','scout-c6':'GnomeOS Scout (ESP32-C6-LCD)','cam':'GnomeOS Watcher'}.get(env,'GnomeOS '+env)
chip='ESP32-S3' if env.endswith('-s3') else 'ESP32-C6' if env.endswith('-c6') else 'ESP32'
boot_off=4096 if chip=='ESP32' else 0
try: m=json.load(open(p))
except Exception: m={}
m.update({'name':name,'version':ver,'new_install_prompt_erase':True,'new_install_improv_wait_time':15,
  'builds':[{'chipFamily':chip,'parts':[{'path':'bootloader.bin','offset':boot_off},{'path':'partitions.bin','offset':32768},{'path':'boot_app0.bin','offset':57344},{'path':'firmware.bin','offset':65536}]}]})
json.dump(m,open(p,'w'),ensure_ascii=False,indent=2)
PY
  strings "$d/firmware.bin" | grep -qx "$VER" || { echo "!! $e: binary does not contain version $VER"; exit 1; }
  printf "   %-16s %s  (%s bytes) ✓ version inside binary\n" "$e" "$VER" "$(stat -f %z "$d/firmware.bin")"
done
python3 -c "import json,sys; json.dump({e:'$VER' for e in sys.argv[1:]}, open('../docs/firmware/versions.json','w'), indent=2)" "${ENVS[@]}"
echo "== done. commit + push เพื่อให้หน้า flash ได้ไฟล์ใหม่ · gnome-core เสิร์ฟจาก docs/firmware ทันที (OTA ปุ่มบน dashboard)"
