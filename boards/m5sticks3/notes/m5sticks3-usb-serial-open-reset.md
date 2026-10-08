---
title: "M5StickS3: opening the USB serial port restarts the chip if DTR is lowered first"
tags: [m5sticks3, esp32-s3, usb-serial-jtag, pyserial, reset]
created: 2026-09-30
updated: 2026-10-07
---

# M5StickS3: opening the USB serial port restarts the chip if DTR is lowered first

**Symptom.** A host program that opens `/dev/cu.usbmodem*` restarts the firmware (`rst:0x15 (USB_UART_CHIP_RESET)`)
when it lowers DTR and RTS in the wrong order, as the usual ESP32 advice ("set DTR and RTS low so opening the port
does not reset the board") does. A script that opened the port with `serial.Serial(port, 115200)` and then reset the
board printed `boot:0x1 (DOWNLOAD(USB/UART0))` and `waiting for download`; the firmware never ran.

**Measured on the board** (2026-10-07, pyserial 3.5 on macOS, firmware running for 8 s first; bench scenario
`logger-reset`):

| How the host opens the port | Board |
| --- | --- |
| `s.dtr = False; s.rts = False` before `s.open()` (the usual advice) | restarts, 3 of 3 |
| `serial.Serial(port, 115200)`, then `s.dtr = False; s.rts = False` | restarts, 3 of 3 |
| `serial.Serial(port, 115200)` and nothing else: both lines stay high | keeps running, 6 of 6 |
| `s.dtr = True; s.rts = True; s.open()`, then `s.rts = False`, then `s.dtr = False` | keeps running, 3 of 3 |

An earlier version of this note said that merely opening the port with pyserial's defaults also reboots the chip;
that did not reproduce.

**Cause.** On the ESP32-S3's USB-Serial/JTAG port, RTS high with DTR low resets the chip and DTR high with RTS low
pulls the boot strap. The OS raises both lines when the port opens. pyserial sets DTR before RTS (when it opens the
port, and in the order a script sets them), so lowering both with DTR first passes through "RTS high, DTR low": a
reset.

**Fix.** Leave both lines high (pyserial's defaults), or, to end with both low, open with both high and lower RTS
before DTR:

```python
s = serial.Serial(); s.port, s.baudrate = port, 115200
s.dtr = True; s.rts = True; s.open()
s.rts = False; s.dtr = False          # RTS first: no reset on open
s.dtr = False; s.rts = True; time.sleep(0.2); s.rts = False   # a deliberate reset, when wanted
```

**Verified** on the board: with the RTS-first order, opening the port with no reset left the running firmware alone,
and deliberate resets booted normally (`boot:0x9 (SPI_FAST_FLASH_BOOT)`) in 90+ consecutive cycles (2026-10-01).

**Run it again.** The table above comes from this experiment (re-measured 2026-10-07 with pi-lab's
board_experiment: 3 runs per variant, shuffled, the board reset before each). On your board, have the agent run
`board_experiment` with `rerun` set to this note's path: pi-lab runs the same variants and says whether the
result still holds there. It needs firmware that prints `t=<ms since boot>`-style lines, such as the bench's
logger-reset scenario; with other firmware, judge by the boot banner alone.

```pi-lab-experiment
{
  "spec": {
    "question": "Which ways of opening the M5StickS3's USB serial port with pyserial restart it?",
    "variants": [
      {
        "name": "DTR and RTS low before open()",
        "command": "\"$PI_LAB_PYTHON\" - low <<'PY'\nimport os, sys, time\nimport serial\nhow = sys.argv[1]\ns = serial.Serial(); s.port, s.baudrate, s.timeout = os.environ[\"PI_LAB_PORT\"], 115200, 0.1\nif how == \"low\":\n    s.dtr = False; s.rts = False; s.open()\nelif how == \"default\":\n    s.open()\nelse:\n    s.dtr = True; s.rts = True; s.open(); s.rts = False; s.dtr = False\nend, data = time.time() + 2.5, b\"\"\nwhile time.time() < end:\n    data += s.read(4096)\ns.close()\nsys.stdout.write(data.decode(\"utf-8\", \"replace\"))\nPY"
      },
      {
        "name": "pyserial defaults",
        "command": "\"$PI_LAB_PYTHON\" - default <<'PY'\nimport os, sys, time\nimport serial\nhow = sys.argv[1]\ns = serial.Serial(); s.port, s.baudrate, s.timeout = os.environ[\"PI_LAB_PORT\"], 115200, 0.1\nif how == \"low\":\n    s.dtr = False; s.rts = False; s.open()\nelif how == \"default\":\n    s.open()\nelse:\n    s.dtr = True; s.rts = True; s.open(); s.rts = False; s.dtr = False\nend, data = time.time() + 2.5, b\"\"\nwhile time.time() < end:\n    data += s.read(4096)\ns.close()\nsys.stdout.write(data.decode(\"utf-8\", \"replace\"))\nPY"
      },
      {
        "name": "both high, then RTS low before DTR",
        "command": "\"$PI_LAB_PYTHON\" - rts-first <<'PY'\nimport os, sys, time\nimport serial\nhow = sys.argv[1]\ns = serial.Serial(); s.port, s.baudrate, s.timeout = os.environ[\"PI_LAB_PORT\"], 115200, 0.1\nif how == \"low\":\n    s.dtr = False; s.rts = False; s.open()\nelif how == \"default\":\n    s.open()\nelse:\n    s.dtr = True; s.rts = True; s.open(); s.rts = False; s.dtr = False\nend, data = time.time() + 2.5, b\"\"\nwhile time.time() < end:\n    data += s.read(4096)\ns.close()\nsys.stdout.write(data.decode(\"utf-8\", \"replace\"))\nPY"
      }
    ],
    "measure": {
      "source": "output",
      "match": "rst:0x|ESP-ROM:",
      "value": "^t=(\\d+)"
    },
    "repeat": 3,
    "reset": true,
    "settle": 3,
    "observe": 0,
    "timeout": 60
  },
  "expected": {
    "DTR and RTS low before open()": "yes",
    "pyserial defaults": "no",
    "both high, then RTS low before DTR": "no"
  }
}
```
