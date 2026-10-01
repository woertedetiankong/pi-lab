---
title: "BMI270 on M5StickS3 reads all zeros: config upload needs advanced power save off"
tags: [m5sticks3, bmi270, imu, i2c, accelerometer]
created: 2026-10-01
updated: 2026-10-01
---

# BMI270 on M5StickS3 reads all zeros

The BMI270 sits on the internal I2C bus (SDA=GPIO47, SCL=GPIO48) at 0x68 and answers CHIP_ID 0x24 right after power-on,
but it produces no data until Bosch's 8 KB configuration file has been uploaded.

**Measured on the board** (accelerometer enabled with `PWR_CTRL=0x04`, `ACC_CONF=0xA8` in every case):

| Sequence | `INTERNAL_STATUS` (0x21) | Accel data |
| --- | --- | --- |
| No config upload | 0x00 | all zeros, although PWR_CTRL and ACC_CONF read back as written |
| Config uploaded while advanced power save is still on (`PWR_CONF` reset value 0x03) | 0x00 | all zeros; the burst writes fail silently |
| `PWR_CONF=0x00`, wait ≥ 450 µs, upload, `INIT_CTRL=1` | 0x01 | z ≈ 4073 at the default ±8 g range (≈ 1 g) |
| same, then `ACC_RANGE` (0x41) = 0x00 | 0x01 | z ≈ 16194 at ±2 g (≈ 1 g) |

**Sequence that works** (BMI270 datasheet, initialization section; register map: `ACC_RANGE` is 0x41, `GYR_CONF` 0x42):

1. Soft reset: write 0xB6 to `CMD` (0x7E), then wait 20 ms (in testing, writes 5 ms after the reset were not acknowledged).
2. `PWR_CONF` (0x7C) = 0x00, then wait at least 450 µs.
3. `INIT_CTRL` (0x59) = 0x00; write the config file to `INIT_DATA` (0x5E) in bursts, setting `INIT_ADDR_0/1`
   (0x5B/0x5C) to the word offset before each; `INIT_CTRL` = 0x01; wait about 20 ms.
4. Check `INTERNAL_STATUS` & 0x0F == 0x01 before going on: 0x00 means not initialized, 0x02 an init error.
5. Enable and configure: `PWR_CTRL` = 0x04, `ACC_CONF` = 0xA8, `ACC_RANGE` = 0x00 for ±2 g (16384 LSB/g).

**Also seen.** While advanced power save is on, writes closer together than about 450 µs are not acknowledged
(`ESP_ERR_INVALID_RESPONSE`), and some still take effect. With the 100 Hz FreeRTOS tick, `vTaskDelay(pdMS_TO_TICKS(2))`
is zero ticks and does not wait at all; use `esp_rom_delay_us`.
