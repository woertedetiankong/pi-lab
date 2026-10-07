The M5StickS3 runs a temperature logger: five times a second the firmware prints `t=<ms since boot> temp=<°C>` on
its USB serial port. It is meant to run unattended for weeks. On this computer, cron starts `tools/logger.py`
every few minutes (`python tools/logger.py --seconds 5 --out readings.csv`) to append the readings to a CSV file.

In the CSV, every run of the logger starts again at `t` close to 0, as if the board restarted whenever the logger
connected. The board must keep running when the logger connects and disconnects.

Find the root cause and fix it, and check the fix on the board. The firmware is right and must stay as it is; the board is running it
now. Keep the logger's command line and CSV format.
