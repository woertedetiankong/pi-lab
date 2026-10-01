#!/bin/bash
# Prepares (or restores) the demo: an ESP-IDF project for the M5StickS3 whose BMI270 accelerometer reads all zeros,
# with the bug flashed to the board. Run it again between takes to put everything back.
#
# Usage: demo/setup.sh [project dir]      (default ~/pi-lab-demo)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
dir="${1:-$HOME/pi-lab-demo}"
scenario="$repo/bench/scenarios/imu-zeros"

source ~/.espressif/v6.0.1/esp-idf/export.sh >/dev/null 2>&1
port="$( (ls /dev/cu.usbmodem* /dev/ttyACM* 2>/dev/null || true) | head -1)"
[ -n "$port" ] || { echo "No board found: plug in the M5StickS3." >&2; exit 1; }

if [ -d "$dir/.git" ] && git -C "$dir" rev-parse -q --verify demo-start >/dev/null; then
  echo "Restoring $dir to the start of the demo"
  git -C "$dir" reset -q --hard demo-start
  git -C "$dir" clean -qfdx -e build
else
  echo "Creating $dir"
  mkdir -p "$dir"
  rsync -a --exclude TASK.md --exclude check.py --exclude solution.patch --exclude DOCS "$scenario/" "$dir/"
  # A real project flashes with ESP-IDF's defaults.
  sed -i '' -e '/ESPTOOLPY_AFTER_NORESET/d' -e '/^# Leave the chip in the bootloader/d' -e '/^# M5StickS3 USB port/d' "$dir/sdkconfig.defaults"
  mkdir -p "$dir/docs"
  datasheet="$HOME/.pi/agent/pi-lab/boards/m5sticks3/docs/BMI270-datasheet.pdf"
  [ -f "$datasheet" ] || { mkdir -p "$(dirname "$datasheet")"; curl -sSfL -o "$datasheet" "https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmi270-ds000.pdf"; }
  cp "$datasheet" "$dir/docs/"
  # No board pack here: its notes describe this very bug, so the agent would look the answer up instead of finding it.
  cat > "$dir/AGENTS.md" <<'MD'
# Project

Firmware for an M5StickS3 (ESP32-S3) that reads its BMI270 accelerometer and logs it five times a second.
ESP-IDF v6.0.1 is installed in `~/.espressif/v6.0.1/esp-idf`. The BMI270 datasheet is in `docs/`.
MD
  printf 'build/\nsdkconfig\nsdkconfig.old\n' > "$dir/.gitignore"
  git -C "$dir" init -q
  git -C "$dir" add -A
  git -C "$dir" -c user.name=demo -c user.email=demo@local commit -qm "IMU logger for the M5StickS3"
  git -C "$dir" tag demo-start
fi

echo "Building and flashing the firmware with the bug to $port"
cd "$dir"
idf.py build >/dev/null
for attempt in 1 2 3; do
  if idf.py -p "$port" erase-flash >/dev/null 2>&1 && idf.py -p "$port" flash >/dev/null 2>&1; then break; fi
  [ "$attempt" = 3 ] && { echo "Flashing failed: unplug the board, plug it back in and run this again." >&2; exit 1; }
  echo "  the board did not answer; recovering its USB port"
  "$repo/bench/common/bin/usb_reenumerate" >/dev/null 2>&1 || true
  sleep 4
done
echo "Ready: the board reads all zeros. Next: cd $dir && pi, then /lab web"
