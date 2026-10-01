#!/bin/bash
# Usage: prepare.sh <scenario> <workdir>
# Resets <workdir> to a fresh git repo holding the scenario's buggy firmware. The build/ directory is kept so
# rebuilds are incremental; everything else is replaced.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
scenario="$here/scenarios/$1"
work="$2"
[ -d "$scenario" ] || { echo "no scenario $1" >&2; exit 1; }
mkdir -p "$work"
find "$work" -mindepth 1 -maxdepth 1 ! -name build -exec rm -rf {} +
rsync -a --exclude TASK.md --exclude check.py --exclude solution.patch --exclude DOCS "$scenario/" "$work/"
# rsync keeps the scenario files' old timestamps, which are older than a cached build of a previous variant:
# touch them so the build always recompiles what is in the work tree.
find "$work" -path "$work/build" -prune -o -type f -exec touch {} +
mkdir -p "$work/tools"
cp "$here/common/serial_capture.py" "$work/tools/"
[ -x "$here/common/bin/usb_reenumerate" ] || { mkdir -p "$here/common/bin" && clang -O2 -o "$here/common/bin/usb_reenumerate" "$here/common/usb_reenumerate.c" -framework IOKit -framework CoreFoundation 2>/dev/null; }
cp "$here/common/bin/usb_reenumerate" "$work/tools/"
port="${ESPPORT:-$( (ls /dev/cu.usbmodem* /dev/ttyACM* 2>/dev/null || true) | head -1)}"
[ -n "$port" ] || { echo "no board found" >&2; exit 1; }
sed "s#{{PORT}}#$port#g" "$here/common/AGENTS.md" > "$work/AGENTS.md"
cp "$work/AGENTS.md" "$work/CLAUDE.md"
# Datasheets the scenario comes with: cached in docs-cache/ (not committed), copied into docs/.
if [ -f "$scenario/DOCS" ]; then
  mkdir -p "$here/docs-cache" "$work/docs"
  while read -r name url; do
    [ -n "$name" ] || continue
    [ -f "$here/docs-cache/$name" ] || curl -sSfL -o "$here/docs-cache/$name" "$url"
    cp "$here/docs-cache/$name" "$work/docs/"
  done < "$scenario/DOCS"
  printf -- '- Datasheets for parts on the board are in `docs/`: %s\n' "$(ls "$work/docs" | tr '\n' ' ')" >> "$work/AGENTS.md"
  cp "$work/AGENTS.md" "$work/CLAUDE.md"
fi
printf 'build/\nsdkconfig\nsdkconfig.old\nmanaged_components/\n' > "$work/.gitignore"
git -C "$work" init -q
git -C "$work" add -A
git -C "$work" -c user.name=bench -c user.email=bench@local commit -qm "scenario $1"
