---
title: "M5StickS3: a host program opening the USB serial port can restart the chip"
tags: [m5sticks3, esp32-s3, usb-serial-jtag, pyserial, reset]
created: 2026-10-07
updated: 2026-10-07
---

# M5StickS3: a host program opening the USB serial port can restart the chip

**Symptom.** The firmware's log can start again from the boot banner (`rst:0x15 (USB_UART_CHIP_RESET)`) when a
host program such as a Python script with pyserial opens `/dev/cu.usbmodem*`; sometimes the chip ends up in the ROM
download mode instead (`waiting for download`).

**Cause.** The M5StickS3 has no USB-UART bridge: its console is the ESP32-S3's built-in USB-Serial/JTAG port, where
the DTR and RTS control lines drive the chip's reset and boot strap.

**Fix.** Keep the control lines from resetting the chip when a host program connects.
