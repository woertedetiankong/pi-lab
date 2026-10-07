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
| `logger-reset` | the board restarts whenever the host logger (`tools/logger.py`) connects | the logger sets DTR and RTS low before opening, the usual advice for ESP32 boards; pyserial applies DTR first, which on the USB-Serial/JTAG port passes through the reset state |

Every scenario has `TASK.md` (what the agent is told), `check.py` (the judge) and `solution.patch` (a reference
fix). `validate.sh` confirms on the board that the buggy firmware fails its checker and the reference fix passes.
A scenario may also have `wrong-*.patch` files, fixes that look right but are not, which must fail as well;
`alt-*.patch` files, other correct fixes, which must pass; and its
own `AGENTS.md`, which replaces `common/AGENTS.md` and leaves `serial_capture.py` out of the project (for scenarios
about reading the serial port, where that script would hold the answer).

`logger-reset` is the one bug here that is about this board rather than about code: the fix is a measured fact of the
M5StickS3's USB port (`boards/m5sticks3/notes/m5sticks3-usb-serial-open-reset.md`), and the advice an agent is likely
to know from elsewhere is already in the buggy logger. Measured on the board: the buggy logger and opening with
pyserial's defaults then lowering both lines (`wrong-lower-after-open.patch`) restart it every time; lowering RTS
before DTR (`solution.patch`) and simply opening with pyserial's defaults, both lines left high
(`alt-default-open.patch`), never did (2/2 and 5/5 runs).

## Running

```bash
bench/validate.sh [scenario...]                  # buggy and wrong-*.patch must FAIL, solution and alt-*.patch must PASS
node bench/run.mjs <scenario> pi-lab             # pi + this extension
node bench/run.mjs <scenario> pi                 # pi without extensions
node bench/run.mjs <scenario> claude             # Claude Code
node bench/make-kb.mjs <scenario>                 # knowledge bases for the pi-lab-kb* agents, from the scenario's KB.json
node bench/run.mjs <scenario> pi-lab-kb          # pi-lab + pi-kb with the scenario's datasheets
node bench/run.mjs <scenario> pi-lab-kb-note     # same, plus a note that has the answer
node bench/run.mjs <scenario> pi-lab-kb-partial  # same, plus a note that is only partly right
node bench/run.mjs <scenario> pi --minimal       # project docs name only the board and the SDK location
node bench/run.mjs <scenario> pi --model provider/id --timeout-min 30
node bench/summary.mjs                           # pass rate, median time, flashes and cost per scenario and agent
```

`run.mjs` resets the work tree to the buggy firmware, flashes it with an erased chip, runs the agent with the task,
then rebuilds and flashes whatever the agent left and runs the checker. Results land in
`bench/results/<scenario>/<agent>-<time>/`: `result.json` (verdict, minutes, tool calls, flashes, serial captures,
ledger calls, cost), `diff.patch`, `judge-serial.log`, and the full `transcript.jsonl` (kept locally, not committed).

## Does recorded experience help?

`pi-lab-kb`, `pi-lab-kb-note` and `pi-lab-kb-partial` differ only in their knowledge base, built by `make-kb.mjs`
from the scenario's `KB.json`: the scenario's datasheets alone (`docs`, possibly none), plus a note that has the
answer (`note`), or plus one that is only partly right (`partial`). The first asks whether the agent looks up and uses
a note with the answer; the second whether a partly right note still helps, or narrows the search too early.

| Scenario | `note` | `partial` |
| --- | --- | --- |
| `imu-zeros` | the board pack's BMI270 note: both bugs | `notes/bmi270-config-upload-power-save.md`: only the power-save bug, not the ACC_RANGE register |
| `logger-reset` | the board pack's note on opening the USB serial port: the line order that works | `notes/usb-serial-open-reset-partial.md`: that DTR and RTS reset the chip, but not how to avoid it |

Models have seen a lot about the BMI270 and plain pi fixes imu-zeros in a few minutes, so a note has little to add
there. logger-reset depends on a fact measured on this board, which is where recorded experience should matter.

`result.json` records how often the agent's kb tools returned the note (`noteHits`) and when it first did
(`noteFirstMin`); `summary.mjs` shows it as "Note found". Board packs are kept out of every run (`PI_LAB_BOARD=""`),
so they cannot bring the note in through pi-lab.

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

**logger-reset, with and without a note (pi-lab 0.3.4), 3 runs each.** All 18 runs passed. Median minutes: pi 2.9,
pi-lab-kb 6.9, pi-lab-kb-note 2.8, pi-lab-kb-partial 4.5. Every agent with a note found it within the first 0.1 min.
The note did not beat plain pi, which finds this bug by trying a few ways to open the port; it took away pi-lab-kb's
extra time and made the explanations right: the three note runs named the cause (RTS high with DTR low, and
pyserial lowering DTR first) every time, the other groups once in three; the rest said "DTR low resets", and one
pi-lab-kb run saved that in a kb note. Most of pi-lab-kb's extra time was the hub holding the port while the agent's
own scripts opened it ("multiple access on port", in all three runs). After the fix (`[port-fix]` runs): no port
conflicts in six runs; pi-lab 4.4 min, pi-lab-kb 5.9 (one run of 9.2 that kept re-verifying ledger facts, and
reflashed unchanged firmware, after its fix was done). Eight runs that the model API cut short (no credit) are kept
with `agentError` and left out of the summary.

One wedged-USB judgement was re-judged from the agent's diff on a recovered board; it is marked `firstJudge` in
its `result.json`.

All bugs here are visible in the source, and the model finds most of them by reading. Scenarios whose cause only
the board and its datasheet reveal (like `imu-zeros`) and longer sessions are where a difference would have to show.
