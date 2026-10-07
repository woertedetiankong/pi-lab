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
