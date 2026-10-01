#!/usr/bin/env python3
"""Reset the board and print its serial output for a few seconds, then exit.

Usage: python tools/serial_capture.py [--seconds 8] [--no-reset] [--port /dev/cu.usbmodem101]

The ESP32-S3 USB-Serial/JTAG port disappears for a moment while the chip resets,
so the port is reopened until output arrives or the time is up.
"""
import argparse
import glob
import os
import sys
import time

import serial


def default_port():
    if os.environ.get("ESPPORT"):
        return os.environ["ESPPORT"]
    ports = sorted(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/ttyACM*"))
    if not ports:
        sys.exit("No board found (no /dev/cu.usbmodem* or /dev/ttyACM*). Is it plugged in?")
    return ports[0]


def open_port(port, deadline):
    while time.time() < deadline:
        try:
            # On USB-Serial/JTAG, RTS high with DTR low resets the chip, and DTR high with RTS low pulls the boot strap.
            # The OS raises both lines on open; lowering DTR first (pyserial's order) passes through the reset state
            # and glitches the chip. Leave both as opened, then lower RTS before DTR so no reset happens.
            s = serial.Serial()
            s.port, s.baudrate, s.timeout = port, 115200, 0.1
            s.dtr = True
            s.rts = True
            s.open()
            s.rts = False
            s.dtr = False
            return s
        except (serial.SerialException, OSError):
            time.sleep(0.05)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=8)
    ap.add_argument("--port", default=None)
    ap.add_argument("--no-reset", action="store_true", help="do not reset the board first")
    args = ap.parse_args()
    port = args.port or default_port()
    if not args.no_reset:
        # Resetting again while the USB port is still re-enumerating after the previous reset (for example right
        # after `idf.py flash`) can wedge the ESP32-S3's USB until it is unplugged. The device node is recreated on
        # every enumeration, so wait until it has existed for a moment.
        for _ in range(100):
            try:
                st = os.stat(port)
                if time.time() - st.st_ctime >= 2.5:
                    break
            except OSError:
                pass
            time.sleep(0.1)
    deadline = time.time() + args.seconds

    s = open_port(port, deadline)
    if s is None:
        sys.exit(f"Could not open {port}")
    if not args.no_reset:
        # Same sequence esptool uses for a hard reset over USB-Serial/JTAG.
        s.dtr = False
        s.rts = True
        time.sleep(0.2)
        s.rts = False
        time.sleep(0.05)

    out = sys.stdout
    while time.time() < deadline:
        try:
            data = s.read(4096)
        except (serial.SerialException, OSError):
            s.close()
            s = open_port(port, deadline)
            if s is None:
                break
            continue
        if data:
            out.write(data.decode("utf-8", "replace"))
            out.flush()
    if s:
        s.close()


if __name__ == "__main__":
    main()
