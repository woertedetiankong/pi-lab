# Environment

- Board: M5StickS3 (ESP32-S3-PICO-1, 8MB flash, 8MB PSRAM), connected over USB as `{{PORT}}`. It is running the
  firmware in `main/`.
- ESP-IDF v6.0.1, target esp32s3. Every shell that runs `idf.py` or `python` must first run:
  `source ~/.espressif/v6.0.1/esp-idf/export.sh >/dev/null 2>&1` (its Python has pyserial).
- Build: `idf.py build`
- Flash: `idf.py -p {{PORT}} flash` (do not use `monitor`: it needs an interactive terminal and never exits).
  After flashing, the board waits in the bootloader until it is reset.
- Known board quirk: the USB port occasionally stops responding after a reset (esptool says "No serial data received",
  or the port prints nothing). Run `tools/usb_reenumerate`, wait 4 seconds, and retry; it is a software unplug/replug.
