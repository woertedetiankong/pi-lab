// Board checks: the project's acceptance criteria, judged on what the board prints. "Temperature keeps updating,
// no restart in three minutes" becomes a check in .pi/lab.json that runs on demand and after every flash, so a
// fix is called done only when the board says so, by rules the engineer agreed to beforehand.

import type { LogLine } from "./serial-hub.ts";

export interface BoardCheck {
  name: string;
  /** How long to watch the board (default 10 s). */
  seconds?: number;
  /** Reset the board first (default true). */
  reset?: boolean;
  /** Regular expressions that must each appear. */
  expect?: string[];
  /** Regular expressions that must not appear. */
  forbid?: string[];
  /** The board must not restart while it is watched (a second boot banner, or the first one without a reset). */
  noRestart?: boolean;
  /** A number in the log (the first capture group of `pattern`) that must stay in range, and change if `changes`. */
  metric?: { pattern: string; min?: number; max?: number; changes?: boolean; atLeast?: number };
}

export interface CheckResult {
  name: string;
  /** null: the check could not run (no output at all). */
  pass: boolean | null;
  /** One line per criterion, each starting with PASS or FAIL. */
  details: string[];
}

/** Problems with a check as written, before running it. */
export function checkProblems(c: BoardCheck): string[] {
  const problems: string[] = [];
  if (!c.name?.trim()) problems.push("a check needs a name");
  const res = [...(c.expect ?? []), ...(c.forbid ?? []), ...(c.metric ? [c.metric.pattern] : [])];
  for (const re of res) { try { new RegExp(re); } catch (e) { problems.push(`${c.name}: /${re}/ is not a valid regular expression (${(e as Error).message})`); } }
  if (c.metric && !/\((?!\?)/.test(c.metric.pattern)) problems.push(`${c.name}: metric.pattern needs a capture group around the number`);
  if (!c.expect?.length && !c.forbid?.length && !c.noRestart && !c.metric) problems.push(`${c.name}: says nothing to check (expect, forbid, noRestart or metric)`);
  return problems;
}

export function evaluateCheck(check: BoardCheck, lines: LogLine[]): CheckResult {
  const out = lines.filter(l => l.kind === "out").map(l => l.text);
  const details: string[] = [];
  if (!out.some(l => l.trim())) return { name: check.name, pass: null, details: ["the board printed nothing while watched"] };
  for (const re of check.expect ?? []) {
    const line = out.find(l => new RegExp(re).test(l));
    details.push(line !== undefined ? `PASS expect /${re}/: ${line.trim().slice(0, 100)}` : `FAIL expect /${re}/: never printed`);
  }
  for (const re of check.forbid ?? []) {
    const line = out.find(l => new RegExp(re).test(l));
    details.push(line === undefined ? `PASS forbid /${re}/` : `FAIL forbid /${re}/: ${line.trim().slice(0, 100)}`);
  }
  if (check.noRestart) {
    // Boots seen: the ESP32 ROM's banner, or its reset reason line on chips that print no banner. After a reset
    // the first boot is expected; anything beyond it is a restart.
    const count = out.filter(l => l.startsWith("ESP-ROM:")).length || out.filter(l => /^rst:0x[0-9a-f]+ /.test(l)).length;
    const allowed = check.reset === false ? 0 : 1;
    details.push(count <= allowed ? "PASS no restart" : `FAIL no restart: the board booted ${count - allowed} more time(s) while watched`);
  }
  if (check.metric) {
    const re = new RegExp(check.metric.pattern);
    const values = out.flatMap(l => { const m = re.exec(l); return m?.[1] !== undefined && Number.isFinite(Number(m[1])) ? [Number(m[1])] : []; });
    const { min, max, changes, atLeast = 1 } = check.metric;
    if (values.length < atLeast) {
      details.push(`FAIL metric /${check.metric.pattern}/: ${values.length} value(s), expected at least ${atLeast}`);
    } else {
      const lo = Math.min(...values), hi = Math.max(...values);
      const range = (min === undefined || lo >= min) && (max === undefined || hi <= max);
      details.push(`${range ? "PASS" : "FAIL"} metric in [${min ?? "-∞"}, ${max ?? "∞"}]: ${values.length} values from ${lo} to ${hi}`);
      if (changes) details.push(new Set(values).size > 1 ? "PASS metric changes" : `FAIL metric changes: every value was ${lo}, not a live reading`);
    }
  }
  return { name: check.name, pass: details.every(d => d.startsWith("PASS")), details };
}

export function renderChecks(results: CheckResult[]): string {
  const mark = (p: boolean | null) => (p === null ? "[----]" : p ? "[PASS]" : "[FAIL]");
  const lines = results.flatMap(r => [`${mark(r.pass)} ${r.name}`, ...r.details.map(d => `       ${d}`)]);
  const passed = results.filter(r => r.pass).length;
  const verdict = results.every(r => r.pass) ? "All checks pass." : `${passed}/${results.length} checks pass.`;
  return [...lines, "", verdict].join("\n");
}
