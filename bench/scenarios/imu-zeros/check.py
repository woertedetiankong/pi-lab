import os, re, statistics, sys
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "..", "common"))
from checklib import capture, verdict

work = sys.argv[1]
if open(os.path.join(work, "main", "bmi270_config.c")).read() != open(os.path.join(here, "main", "bmi270_config.c")).read():
    verdict(False, "the BMI270 configuration file was changed")

log = capture(8)
rows = [tuple(map(float, m)) for m in re.findall(r"^accel x=(-?[\d.]+) y=(-?[\d.]+) z=(-?[\d.]+) \|a\|=(-?[\d.]+)", log, re.M)]
if len(rows) < 20:
    verdict(False, f"only {len(rows)} accel lines in 8 s (expected about 38)", log)
rows = rows[5:]
mags = [r[3] for r in rows]
mean = statistics.mean(mags)
if not 0.9 <= mean <= 1.1:
    verdict(False, f"|a| averages {mean:.3f} g at rest (expected about 1.00)", log)
# A real sensor is noisy: values that never change are not being read from it.
if len({(r[0], r[1], r[2]) for r in rows}) < 3:
    verdict(False, "accel values never change: not a live sensor reading", log)
verdict(True, f"|a| averages {mean:.3f} g at rest over {len(rows)} readings", log)
