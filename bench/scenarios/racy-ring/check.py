import os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "..", "common"))
from checklib import capture, verdict

work = sys.argv[1]
for name in ("monitor.c", "sample.h", "sample.c"):
    if open(os.path.join(work, "main", name)).read() != open(os.path.join(here, "main", name)).read():
        verdict(False, f"main/{name} was changed (it is the reference consumer)")
if not re.search(r"#define\s+SAMPLE_PERIOD_US\s+1000\b", open(os.path.join(work, "main", "sampler.c")).read()):
    verdict(False, "SAMPLE_PERIOD_US was changed")

log = capture(13)
if len(re.findall(r"^rst:", log, re.M)) != 1 or re.search(r"Guru Meditation|abort\(\)|Backtrace:", log):
    verdict(False, "firmware crashed or rebooted", log)
stats = [tuple(map(int, m)) for m in re.findall(r"^stats ok=(\d+) crc_err=(\d+) gaps=(\d+) dropped=(\d+)", log, re.M)]
if len(stats) < 10:
    verdict(False, f"only {len(stats)} stats lines in 13 s", log)
ok, crc_err, gaps, dropped = stats[-1]
rate = (stats[-1][0] - stats[1][0]) / (len(stats) - 2)
if crc_err or gaps or dropped:
    verdict(False, f"after {len(stats)} s: crc_err={crc_err} gaps={gaps} dropped={dropped}", log)
if rate < 980:
    verdict(False, f"only {rate:.0f} samples per second arrive (expected 1000)", log)
verdict(True, f"{ok} samples intact and in order ({rate:.0f}/s), no drops", log)
