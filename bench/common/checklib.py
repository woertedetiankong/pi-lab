"""Helpers for scenario checkers: capture the board's serial log and report a verdict as JSON."""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def capture(seconds, reset=True):
    args = [sys.executable, os.path.join(HERE, "serial_capture.py"), "--seconds", str(seconds)]
    if not reset:
        args.append("--no-reset")
    return subprocess.run(args, capture_output=True, text=True, timeout=seconds + 30).stdout


def verdict(passed, detail, log=""):
    print(json.dumps({"pass": passed, "detail": detail, "log_tail": log[-3000:]}))
    sys.exit(0)
