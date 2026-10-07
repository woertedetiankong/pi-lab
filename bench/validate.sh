#!/bin/bash
# Checks every scenario on the board: the buggy firmware must fail its checker and the reference fix must pass.
# A scenario's wrong-*.patch files are fixes that look right but are not (the usual advice that this board defeats):
# each must fail too. Its alt-*.patch files are other correct fixes: each must pass.
# Usage: bench/validate.sh [scenario...]
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source ~/.espressif/v6.0.1/esp-idf/export.sh >/dev/null 2>&1
port="${ESPPORT:-$( (ls /dev/cu.usbmodem* /dev/ttyACM* 2>/dev/null || true) | head -1)}"
export ESPPORT="$port"
scenarios=("$@"); [ ${#scenarios[@]} -gt 0 ] || scenarios=($(ls "$here/scenarios"))
# The board's USB occasionally stops responding; re-enumerate it (a software unplug/replug) when it does.
ensure_board() {
  for attempt in 1 2 3; do
    [ -n "$(python "$here/common/serial_capture.py" --seconds 4 --port "$port" | tr -d '[:space:]')" ] && return 0
    echo "board not responding, USB re-enumerate (attempt $attempt)" >&2
    "$here/common/bin/usb_reenumerate" >/dev/null 2>&1; sleep 4
  done
  echo "board still not responding: unplug and replug it" >&2; exit 3
}
status=0
for s in "${scenarios[@]}"; do
  work="/tmp/pi-lab-bench/$s"
  "$here/prepare.sh" "$s" "$work"
  variants=(buggy fixed)
  for p in "$here/scenarios/$s"/{alt,wrong}-*.patch; do [ -f "$p" ] && variants+=("$(basename "$p" .patch)"); done
  for variant in "${variants[@]}"; do
    ensure_board
    git -C "$work" checkout -q .
    case $variant in
      buggy) ;;
      fixed) git -C "$work" apply "$here/scenarios/$s/solution.patch" ;;
      *) git -C "$work" apply "$here/scenarios/$s/$variant.patch" ;;
    esac
    if ! (cd "$work" && idf.py build >/dev/null 2>&1 && idf.py -p "$port" erase-flash >/dev/null 2>&1 && idf.py -p "$port" flash >/dev/null 2>&1); then
      echo "$s $variant: BUILD/FLASH FAILED"; status=1; continue
    fi
    result=$(python "$here/scenarios/$s/check.py" "$work" | tail -1)
    pass=$(python -c 'import json,sys; print(json.loads(sys.argv[1])["pass"])' "$result")
    detail=$(python -c 'import json,sys; print(json.loads(sys.argv[1])["detail"])' "$result")
    case $variant in fixed|alt-*) want=True ;; *) want=False ;; esac
    if [ "$pass" = "$want" ]; then mark=ok; else mark=WRONG; status=1; fi
    echo "$s $variant: pass=$pass ($mark) - $detail"
  done
  git -C "$work" checkout -q .
done
exit $status
