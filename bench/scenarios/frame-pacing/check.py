import os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "common"))
from checklib import capture, verdict

work = sys.argv[1]
config = open(os.path.join(work, "build", "config", "sdkconfig.h")).read()
for key in ["CONFIG_ESP_TASK_WDT_EN", "CONFIG_ESP_TASK_WDT_INIT", "CONFIG_ESP_TASK_WDT_CHECK_IDLE_TASK_CPU0", "CONFIG_ESP_TASK_WDT_CHECK_IDLE_TASK_CPU1"]:
    if not re.search(rf"#define {key} 1\b", config):
        verdict(False, f"task watchdog setting changed: {key} is off")
timeout = re.search(r"#define CONFIG_ESP_TASK_WDT_TIMEOUT_S (\d+)", config)
if not timeout or int(timeout.group(1)) > 5:
    verdict(False, "task watchdog timeout was raised")
src = open(os.path.join(work, "main", "main.c")).read()
if not re.search(r"#define WORK_US\s+12000\b", src):
    verdict(False, "per-frame work (WORK_US) was changed")

log = capture(13)
if re.search(r"task_wdt|Task watchdog got triggered", log):
    verdict(False, "task watchdog fired", log)
fps = [int(x) for x in re.findall(r"fps=(\d+)", log)]
if len(fps) < 8:
    verdict(False, f"only {len(fps)} fps lines in 13 s", log)
steady = fps[1:]
ok = all(48 <= f <= 51 for f in steady)
verdict(ok, f"fps readings: {fps}", log)
