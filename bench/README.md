# pi-lab bench

Hardware-in-the-loop debugging tasks for comparing agents on a real board. Each scenario is an ESP-IDF project
with a planted bug; an agent gets the task text, works on the board (build, flash, read serial), and a checker
judges the code it leaves behind by flashing it and watching the board.

Board: M5StickS3 (ESP32-S3-PICO-1) over its built-in USB-Serial/JTAG port, ESP-IDF v6.0.1.

## Scenarios

| Scenario | Symptom | Cause |
| --- | --- | --- |
| `boot-counter` | `boot_count` stays at 1 across resets | NVS init condition missing `err ==`, so NVS is erased on every boot |
| `sensor-queue` | duplicated `seq`, wrong temperatures | queue carries a pointer to a stack buffer the producer keeps overwriting |
| `frame-pacing` | wrong frame rate, task watchdog fires | `pdMS_TO_TICKS(8)` is 0 at 100 Hz, so the task never yields |
| `leaky-uplink` | after ~7 s every send fails | retry path leaks the packet the link driver hands back on failure |
| `racy-ring` | CRC errors, then silent gaps, then drops | ring publishes before filling (cross-core race), unreachable full check, ring too small for the 80 ms write |

Every scenario has `TASK.md` (what the agent is told), `check.py` (the judge) and `solution.patch` (a reference
fix). `validate.sh` confirms on the board that the buggy firmware fails its checker and the reference fix passes.

## Running

```bash
bench/validate.sh [scenario...]                  # buggy must FAIL, reference fix must PASS
node bench/run.mjs <scenario> pi-lab             # pi + this extension
node bench/run.mjs <scenario> pi                 # pi without extensions
node bench/run.mjs <scenario> claude             # Claude Code
node bench/run.mjs <scenario> pi --model provider/id --timeout-min 30
```

`run.mjs` resets the work tree to the buggy firmware, flashes it with an erased chip, runs the agent with the task,
then rebuilds and flashes whatever the agent left and runs the checker. Results land in
`bench/results/<scenario>/<agent>-<time>/`: `result.json` (verdict, minutes, tool calls, flashes, serial captures,
ledger calls, cost), `diff.patch`, `judge-serial.log`, and the full `transcript.jsonl` (kept locally, not committed).

## Board quirks the tooling handles

- **Opening the port glitches a reset.** The OS raises DTR and RTS on open; pyserial lowers DTR first, which passes
  through "RTS high, DTR low" (reset) for a few microseconds. `serial_capture.py` lowers RTS first instead.
- **An RTS reset right after flashing can wedge the USB port.** Scenarios set `CONFIG_ESPTOOLPY_AFTER_NORESET`
  so `idf.py flash` leaves the chip in the bootloader, and `serial_capture.py` resets it once the port has settled.
- **It can still wedge occasionally.** `common/usb_reenumerate.c` asks macOS to re-enumerate the device, a software
  unplug and replug; `run.mjs` and `validate.sh` use it automatically, and agents are told about it. A pi agent wrote
  this tool during a benchmark run when the board wedged under it.
- **Long-pressing the side button enters download mode.** Single-click resets, double-click powers off.

## Results so far (deepseek-flash, one run each)

| Scenario | pi + pi-lab | pi |
| --- | --- | --- |
| boot-counter | pass, 6.6 min | pass, 20.9 min (board wedged once mid-run) |
| sensor-queue | pass, 1.1 min | pass, 1.3 min |
| frame-pacing | pass, 1.8 min | pass, 3.2 min |
| leaky-uplink | pass, 2.2 min | pass, 3.4 min |
| racy-ring | pass, 3.8 min | pass, 3.7 min |

One run per cell is not enough to conclude anything. All five bugs are visible in the source, and the model finds
most of them by reading; the next scenarios need causes that only the board and its datasheets reveal.
