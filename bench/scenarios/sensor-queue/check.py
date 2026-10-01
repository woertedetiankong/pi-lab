import os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "common"))
from checklib import capture, verdict

def temp(seq):
    t = 2150 + (seq * 37) % 300 - 150
    return f"{t // 100}.{t % 100:02d}"

log = capture(9)
reports = [(int(s), t) for s, t in re.findall(r"^report seq=(\d+) temp=(-?\d+\.\d+)\s*$", log, re.M)]
if len(reports) < 50:
    verdict(False, f"only {len(reports)} report lines in 9 s (expected about 85)", log)
seqs = [s for s, _ in reports]
if seqs[0] != 0:
    verdict(False, f"first report is seq={seqs[0]}, expected seq=0 right after reset", log)
bad_order = next((i for i in range(1, len(seqs)) if seqs[i] != seqs[i - 1] + 1), None)
if bad_order is not None:
    verdict(False, f"seq not consecutive: ...{seqs[max(0, bad_order - 3):bad_order + 3]}...", log)
wrong = [(s, t) for s, t in reports if t != temp(s)]
if wrong:
    verdict(False, f"{len(wrong)} readings carry the wrong temperature, e.g. seq={wrong[0][0]} temp={wrong[0][1]} (expected {temp(wrong[0][0])})", log)
if "dropped" in log:
    verdict(False, "readings were dropped", log)
verdict(True, f"{len(reports)} readings reported in order with correct temperatures", log)
