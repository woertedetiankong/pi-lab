---
title: "M5StickS3: opening the USB serial port resets the chip into download mode"
tags: [m5sticks3, esp32-s3, usb-serial-jtag, pyserial, reset]
created: 2026-09-30
updated: 2026-10-01
---

# M5StickS3: opening the USB serial port resets the chip into download mode

**Symptom.** A Python script that opens `/dev/cu.usbmodem*` with `serial.Serial(port, 115200)` and resets the board
prints `rst:0x15 (USB_UART_CHIP_RESET),boot:0x1 (DOWNLOAD(USB/UART0))` and `waiting for download`; the firmware never
runs. Merely opening the port, without any deliberate reset, also reboots the chip (`rst:0x15`).

**Cause.** On the ESP32-S3's USB-Serial/JTAG port, RTS high with DTR low resets the chip and DTR high with RTS low pulls
the boot strap. The OS raises both lines when the port opens; pyserial then lowers DTR first, which passes through
"RTS high, DTR low" for a few microseconds: a reset glitch, taken while the strap may still be pulled.

**Fix.** Open with both lines left high, then lower RTS before DTR:

```python
s = serial.Serial(); s.port, s.baudrate = port, 115200
s.dtr = True; s.rts = True; s.open()
s.rts = False; s.dtr = False          # RTS first: no reset on open
s.dtr = False; s.rts = True; time.sleep(0.2); s.rts = False   # a deliberate reset, when wanted
```

**Verified** on the board: with this order, opening the port with no reset left the running firmware alone, and
deliberate resets booted normally (`boot:0x9 (SPI_FAST_FLASH_BOOT)`) in 90+ consecutive cycles.
