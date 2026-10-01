// Summarizes bench/results: per scenario and agent, pass rate and median time, flashes and cost.
// Usage: node bench/summary.mjs [--model <name>]
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const results = join(dirname(fileURLToPath(import.meta.url)), "results");
const rows = [];
for (const scenario of readdirSync(results)) {
  for (const run of readdirSync(join(results, scenario))) {
    try { rows.push(JSON.parse(readFileSync(join(results, scenario, run, "result.json"), "utf8"))); } catch {}
  }
}
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : undefined;
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const groups = new Map();
for (const r of rows.filter(r => !model || r.model === model)) {
  const key = `${r.scenario}\t${r.agent}`;
  groups.set(key, [...(groups.get(key) ?? []), r]);
}
const fmt = (n, d = 1) => n.toFixed(d);
console.log("| Scenario | Agent | Runs | Pass | Median min | Min–max min | Median flashes | Median $ |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const key of [...groups.keys()].sort()) {
  const rs = groups.get(key);
  const [scenario, agent] = key.split("\t");
  const mins = rs.map(r => r.minutes);
  console.log(`| ${scenario} | ${agent} | ${rs.length} | ${rs.filter(r => r.pass).length}/${rs.length} | ${fmt(median(mins))} | ${fmt(Math.min(...mins))}–${fmt(Math.max(...mins))} | ${median(rs.map(r => r.flashes))} | ${fmt(median(rs.map(r => r.costUsd)), 3)} |`);
}
