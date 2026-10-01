#!/usr/bin/env python3
"""Owns a board's serial port for pi-lab, so the web panel, the agent and flashing can share it.

Usage: serial_broker.py --port PORT [--baud 115200]

stdout: one JSON object per line
  {"t": "data", "text": "..."}                 bytes the board printed (decoded as UTF-8)
  {"t": "state", "state": "open|waiting|released", "detail": "..."}
  {"t": "ok", "id": N} / {"t": "error", "id": N, "message": "..."}   replies to commands
stdin: one JSON command per line
  {"id": N, "cmd": "reset"}     reset the board (RTS pulse), once the port has settled
  {"id": N, "cmd": "release"}   close the port so another program (a flasher) can use it
  {"id": N, "cmd": "acquire"}   open it again
  {"id": N, "cmd": "quit"}
"""
import argparse
import json
import os
import sys
import threading
import time

import serial

out_lock = threading.Lock()


def emit(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


class Broker:
    def __init__(self, path, baud):
        self.path = path
        self.baud = baud
        self.port = None
        self.held = True
        self.lock = threading.Lock()
        self.state = None

    def set_state(self, state, detail=""):
        if state != self.state:
            self.state = state
            emit({"t": "state", "state": state, "detail": detail})

    def open(self):
        # On USB-Serial/JTAG, RTS high with DTR low resets the chip. The OS raises both lines on open; lowering DTR
        # first (pyserial's order) passes through that state, so leave both as opened and lower RTS before DTR.
        s = serial.Serial()
        s.port, s.baudrate, s.timeout = self.path, self.baud, 0.1
        s.dtr = True
        s.rts = True
        s.open()
        s.rts = False
        s.dtr = False
        return s

    def close(self):
        if self.port:
            try:
                self.port.close()
            except Exception:
                pass
            self.port = None

    def settle(self):
        # Resetting again while the USB port is still re-enumerating can wedge an ESP32-S3's USB until it is unplugged.
        # The device node is recreated on every enumeration, so wait until it has existed for a moment.
        for _ in range(100):
            try:
                if time.time() - os.stat(self.path).st_ctime >= 2.5:
                    return
            except OSError:
                pass
            time.sleep(0.1)

    def reset(self):
        self.settle()
        with self.lock:
            if not self.port:
                try:
                    self.port = self.open()
                except (serial.SerialException, OSError) as e:
                    raise RuntimeError(f"cannot open {self.path}: {e}")
            self.port.dtr = False
            self.port.rts = True
            time.sleep(0.2)
            self.port.rts = False

    def read_loop(self):
        while True:
            if not self.held:
                time.sleep(0.1)
                continue
            if not self.port:
                with self.lock:
                    if self.held and not self.port:
                        try:
                            self.port = self.open()
                            self.set_state("open")
                        except (serial.SerialException, OSError) as e:
                            self.set_state("waiting", str(e))
                if not self.port:
                    time.sleep(0.3)
                    continue
            try:
                data = self.port.read(4096)
            except (serial.SerialException, OSError, TypeError, AttributeError):
                # The port went away (the chip reset and USB re-enumerated) or was closed under us.
                with self.lock:
                    self.close()
                if self.held:
                    self.set_state("waiting", "reconnecting")
                continue
            if data:
                emit({"t": "data", "text": data.decode("utf-8", "replace")})

    def command(self, msg):
        cmd = msg.get("cmd")
        if cmd == "reset":
            self.held = True
            self.reset()
        elif cmd == "release":
            self.held = False
            with self.lock:
                self.close()
            self.set_state("released")
        elif cmd == "acquire":
            self.held = True
        elif cmd == "quit":
            with self.lock:
                self.close()
            sys.exit(0)
        else:
            raise RuntimeError(f"unknown command {cmd}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", required=True)
    ap.add_argument("--baud", type=int, default=115200)
    args = ap.parse_args()
    broker = Broker(args.port, args.baud)
    threading.Thread(target=broker.read_loop, daemon=True).start()
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        try:
            broker.command(msg)
            emit({"t": "ok", "id": msg.get("id")})
        except SystemExit:
            raise
        except Exception as e:
            emit({"t": "error", "id": msg.get("id"), "message": str(e)})
    with broker.lock:
        broker.close()


if __name__ == "__main__":
    main()
