#!/usr/bin/env python3
"""Append the board's temperature readings to a CSV file.

Usage: python tools/logger.py [--seconds 5] [--out readings.csv] [--port /dev/cu.usbmodem101]

The board runs unattended for weeks. cron starts this logger every few minutes to collect what the board printed
since, so it must not disturb the board.
"""
import argparse
import csv
import glob
import os
import re
import sys
import time

import serial

READING = re.compile(r"^t=(\d+) temp=(-?[\d.]+)$")


def default_port():
    if os.environ.get("ESPPORT"):
        return os.environ["ESPPORT"]
    ports = sorted(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/ttyACM*"))
    if not ports:
        sys.exit("No board found (no /dev/cu.usbmodem* or /dev/ttyACM*). Is it plugged in?")
    return ports[0]


def open_board(port):
    s = serial.Serial()
    s.port, s.baudrate, s.timeout = port, 115200, 0.2
    # Keep DTR and RTS low so that opening the port does not reset the ESP32.
    s.dtr = False
    s.rts = False
    s.open()
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=5)
    ap.add_argument("--out", default="readings.csv")
    ap.add_argument("--port", default=None)
    args = ap.parse_args()

    board = open_board(args.port or default_port())
    new = not os.path.exists(args.out) or os.path.getsize(args.out) == 0
    rows, pending = 0, b""
    with open(args.out, "a", newline="") as f:
        out = csv.writer(f)
        if new:
            out.writerow(["t_ms", "temp_c"])
        deadline = time.time() + args.seconds
        while time.time() < deadline:
            pending += board.read(512)
            *lines, pending = pending.split(b"\n")
            for line in lines:
                m = READING.match(line.decode("utf-8", "replace").strip())
                if m:
                    out.writerow([int(m[1]), float(m[2])])
                    rows += 1
            f.flush()
    board.close()
    print(f"logged {rows} readings to {args.out}")


if __name__ == "__main__":
    main()
