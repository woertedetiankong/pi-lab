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
| `imu-zeros` | BMI270 reads all zeros, then 0.25 g | config upload before advanced power save is off fails silently; ACC_RANGE written to the wrong register |

Every scenario has `TASK.md` (what the agent is told), `check.py` (the judge) and `solution.patch` (a reference
fix). `validate.sh` confirms on the board that the buggy firmware fails its checker and the reference fix passes.

## Running

```bash
bench/validate.sh [scenario...]                  # buggy must FAIL, reference fix must PASS
node bench/run.mjs <scenario> pi-lab             # pi + this extension
node bench/run.mjs <scenario> pi                 # pi without extensions
node bench/run.mjs <scenario> claude             # Claude Code
node bench/run.mjs <scenario> pi-lab-kb        # pi-lab + pi-kb with the scenario's datasheet (node bench/make-kb.mjs first)
node bench/run.mjs <scenario> pi --minimal       # project docs name only the board and the SDK location
node bench/run.mjs <scenario> pi --model provider/id --timeout-min 30
node bench/summary.mjs                           # pass rate, median time, flashes and cost per scenario and agent
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

## Results (deepseek-flash)

Run `node bench/summary.mjs` for the current table. Highlights:

**Ledger-only pi-lab (v0.1) vs pi, full project docs, 3 runs each.** pi-lab was slower in all six scenarios
(median 1.6–16.9 min vs 1.3–4.3) and timed out once on boot-counter, where two misobserved "facts" in its ledger
kept it on a flash-timing theory for 30 minutes. Plain pi passed every run.

**pi-lab v0.2 (board tools, guard, single-observation facts, step-back) vs pi, minimal docs, 2 runs each.** Both
passed all 24 runs. pi-lab was faster on boot-counter (6.3 vs 7.5 min) and frame-pacing (5.4 vs 7.5) and slower on
the other four. Without serial tooling, plain pi spent one 12-minute frame-pacing run trying DTR/RTS sequences,
esptool internals and libusb before it could read the board; in 3 of its 12 runs it tried to change the machine
(probing `sudo` twice, `pip3 install` into the shared Python once). pi-lab: none.

One wedged-USB judgement was re-judged from the agent's diff on a recovered board; it is marked `firstJudge` in
its `result.json`.

All bugs here are visible in the source, and the model finds most of them by reading. Scenarios whose cause only
the board and its datasheet reveal (like `imu-zeros`) and longer sessions are where a difference would have to show.
