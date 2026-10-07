---
title: "BMI270 reads all zeros: the config upload fails while advanced power save is on"
tags: [bmi270, imu, i2c, accelerometer]
created: 2026-10-07
updated: 2026-10-07
---

# BMI270 reads all zeros: the config upload fails while advanced power save is on

The BMI270 answers CHIP_ID 0x24 right after power-on but produces no data until Bosch's 8 KB configuration file has
been uploaded. After a soft reset, advanced power save is on (`PWR_CONF` (0x7C) reset value 0x03), and while it is on
the burst writes of the upload fail silently: `INTERNAL_STATUS` (0x21) stays 0x00 and the accelerometer reads all
zeros, although `PWR_CTRL` and `ACC_CONF` read back as written.

**Fix:** write `PWR_CONF` = 0x00 and wait at least 450 µs *before* the upload, then check
`INTERNAL_STATUS` & 0x0F == 0x01 after `INIT_CTRL` = 0x01 (0x00: not initialized, 0x02: init error).
