import csv, os, re, subprocess, sys, tempfile, time
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "..", "common"))
from checklib import capture, verdict

work = sys.argv[1]
if open(os.path.join(work, "main", "main.c")).read() != open(os.path.join(here, "main", "main.c")).read():
    verdict(False, "the firmware was changed (the task is to fix the logger)")
logger = os.path.join(work, "tools", "logger.py")
if not os.path.exists(logger):
    verdict(False, "tools/logger.py is gone")

READING = re.compile(r"^t=(\d+) temp=(-?[\d.]+)", re.M)


def uptime(log):
    found = READING.findall(log)
    return int(found[-1][0]) if found else None


# The flash leaves the chip in the bootloader: start the firmware and let it run a while. These captures open the
# port the way that leaves the board alone, so the uptime `t` only goes back to 0 if something else resets it.
logs = capture(4)
if uptime(logs) is None:
    verdict(False, "the firmware prints no readings after a reset", logs)
time.sleep(2)
log = capture(2, reset=False)
logs += log
last = uptime(log)
if last is None:
    verdict(False, "the board stopped printing before the logger ran", logs)

# cron starts the logger again and again: run it twice, then look at the board once more.
began = last
for run in (1, 2):
    out = os.path.join(tempfile.mkdtemp(), "readings.csv")
    p = subprocess.run([sys.executable, logger, "--seconds", "5", "--out", out], cwd=work, capture_output=True, text=True, timeout=60)
    logs += f"\n--- logger run {run}: exit {p.returncode}\n{p.stdout}{p.stderr}"
    if p.returncode != 0:
        verdict(False, f"logger run {run} failed (exit {p.returncode})", logs)
    try:
        with open(out, newline="") as f:
            rows = [(int(r["t_ms"]), float(r["temp_c"])) for r in csv.DictReader(f)]
    except (OSError, KeyError, ValueError) as e:
        verdict(False, f"logger run {run} did not write t_ms,temp_c rows: {e}", logs)
    logs += f"first rows: {rows[:3]}\n"
    if len(rows) < 15:
        verdict(False, f"logger run {run} recorded {len(rows)} readings in 5 s (expected about 25)", logs)
    if rows[0][0] <= last:
        when = "when the logger connected" if run == 1 else "when logger run 1 disconnected or run 2 connected"
        verdict(False, f"the board restarted {when}: t went from {last} ms to {rows[0][0]} ms", logs)
    if any(b[0] <= a[0] for a, b in zip(rows, rows[1:])):
        verdict(False, f"the board restarted while logger run {run} was reading", logs)
    if not all(0 < r[1] < 100 for r in rows):
        verdict(False, f"implausible temperatures in logger run {run}", logs)
    last = rows[-1][0]

log = capture(2, reset=False)
logs += log
after = uptime(log)
if after is None or after <= last:
    verdict(False, f"the board restarted when the logger disconnected: t went from {last} ms to {after} ms", logs)
verdict(True, f"the board kept running through two logger runs (t rose from {began} to {after} ms)", logs)
