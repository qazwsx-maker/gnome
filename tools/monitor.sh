#!/bin/bash
# ดู serial log ของบอร์ดที่เสียบ USB กับ Mac mini:  tools/monitor.sh [port]
PORT=${1:-$(ls /dev/cu.usb* /dev/cu.SLAB* /dev/cu.wchusb* 2>/dev/null | head -1)}
[ -n "$PORT" ] || { echo "ไม่พบพอร์ต USB serial (ls /dev/cu.*)"; exit 1; }
echo "== $PORT @115200 (Ctrl-C ออก)"; exec python3 -m serial.tools.miniterm "$PORT" 115200 --raw 2>/dev/null || exec pio device monitor -p "$PORT" -b 115200
