---
title: "M5StickS3: stuck in download mode after a long press of the side button"
tags: [m5sticks3, esp32-s3, download-mode, button]
created: 2026-09-30
updated: 2026-09-30
---

# M5StickS3: stuck in download mode after a long press of the side button

**Symptom.** Every reset prints `boot:0x1 (DOWNLOAD(USB/UART0))` and `waiting for download`, even after esptool's
hard reset, so freshly flashed firmware never starts.

**Cause.** The side power button goes through the M5PM1 power management chip: single click powers on or resets,
double click powers off, long press enters download mode. After a long press the board keeps booting into the ROM
loader.

**Fix.** Single-click the side button. The next boot showed `boot:0x9 (SPI_FAST_FLASH_BOOT)` and the firmware ran.
Do not long-press it to "power off": that is what put the board in download mode.
