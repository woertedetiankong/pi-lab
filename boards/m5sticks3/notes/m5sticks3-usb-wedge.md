---
title: "M5StickS3: USB port stops responding after resets ('No serial data received')"
tags: [m5sticks3, esp32-s3, usb-serial-jtag, esptool, recovery]
created: 2026-09-30
updated: 2026-10-01
---

# M5StickS3: USB port stops responding after resets

**Symptom.** esptool fails with `Failed to connect to ESP32-S3: No serial data received`; reading the port prints
nothing, not even the ROM boot banner after a reset; OpenOCD cannot read the USB descriptor
(`libusb_get_string_descriptor_ascii() failed`). macOS still lists the device and `/dev/cu.usbmodem*` exists.

**When it happens.** Most often when the chip resets again while its USB is still re-enumerating: an RTS reset right
after flashing (esptool's default `--after hard-reset`), a second reset within a second of the first, and firmware
stuck in a crash-and-reboot loop. In stress tests, plain RTS resets four seconds apart never wedged (20/20), while
flash-then-reset wedged on the 2nd and 6th cycle.

**Recover.** Ask macOS to re-enumerate the device (a software unplug and replug): IOKit `USBDeviceReEnumerate` on
vendor 0x303a, then wait about 4 seconds. pi-lab's `board_recover` does this. Unplugging the cable also works.

**Avoid.** Flash with `--after no-reset` (ESP-IDF: `CONFIG_ESPTOOLPY_AFTER_NORESET=y`, or pi-lab's `board_flash`) and
reset once the port has existed for 2.5 s. With that and the RTS-first port opening, two full validation rounds plus
15 flash cycles ran without a wedge; the remaining rare wedges were recovered by re-enumeration.
