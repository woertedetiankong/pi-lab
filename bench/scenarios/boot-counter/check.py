import os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "common"))
from checklib import capture, verdict

counts, logs = [], ""
for _ in range(3):
    log = capture(5)
    logs += log
    m = re.findall(r"^boot_count=(\d+)", log, re.M)
    if not m:
        verdict(False, "no boot_count line after reset", logs)
    if not re.search(r"saved boot_count=" + m[-1], log):
        verdict(False, f"boot_count={m[-1]} was not saved", logs)
    counts.append(int(m[-1]))
ok = counts[1] == counts[0] + 1 and counts[2] == counts[1] + 1
verdict(ok, f"boot counts across three resets: {counts}", logs)
