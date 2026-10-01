import os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "..", "common"))
from checklib import capture, verdict

work = sys.argv[1]
for name in ("link.c", "link.h"):
    if open(os.path.join(work, "main", name)).read() != open(os.path.join(here, "main", name)).read():
        verdict(False, f"main/{name} was changed (it stands in for the radio driver)")
if not re.search(r"#define\s+FRAME_SIZE\s+4096\b", open(os.path.join(work, "main", "payload.h")).read()):
    verdict(False, "FRAME_SIZE was changed")
if not re.search(r"#define\s+SEND_PERIOD_MS\s+20\b", open(os.path.join(work, "main", "main.c")).read()):
    verdict(False, "SEND_PERIOD_MS was changed")

log = capture(20)
boots = len(re.findall(r"^rst:", log, re.M))
if boots != 1 or re.search(r"abort\(\)|Guru Meditation|Backtrace:|out of memory", log):
    verdict(False, f"firmware crashed or rebooted ({boots} boots in 20 s)", log)
stats = [(int(s), int(h)) for s, h in re.findall(r"^stats seq=\d+ sent=(\d+) .*heap_free=(\d+)", log, re.M)]
if len(stats) < 15:
    verdict(False, f"only {len(stats)} stats lines in 20 s", log)
sent_rate = (stats[-1][0] - stats[2][0]) / (len(stats) - 3)
if sent_rate < 45:
    verdict(False, f"only {sent_rate:.0f} frames sent per second (expected about 50)", log)
early, last = stats[2][1], stats[-1][1]
if last < early - 2048:
    verdict(False, f"free heap still falling: {early} -> {last} bytes", log)
verdict(True, f"ran 20 s without crashing, {sent_rate:.0f} frames/s, free heap {early} -> {last}", log)
