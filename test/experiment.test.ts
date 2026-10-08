import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Board } from "../src/board-core.ts";
import {
  compare, type ExperimentRecord, judge, loadRecord, nextId, noteMarkdown, normalizeSpec, parseNote, plan, recordRerun, renderTable,
  runExperiment, saveRecord, settled, summarize, writeNote,
} from "../src/experiment.ts";
import { checks, experiment, noteFromExperiment, rerun } from "../src/lab-actions.ts";

const spec = normalizeSpec({
  question: "Does lowering DTR first restart the board?",
  variants: [{ name: "dtr first", command: "./open.py low" }, { name: "defaults", command: "./open.py default" }],
  measure: { source: "output", match: "rst:0x", value: "t=(\\d+)" },
});

test("a spec gets its defaults, and a broken one says what is wrong", () => {
  assert.equal(spec.repeat, 3);
  assert.equal(spec.reset, true);
  assert.equal(spec.settle, 3);
  const bad = (s: object, why: RegExp) => assert.throws(() => normalizeSpec(s as never), why);
  bad({ ...spec, question: " " }, /question/);
  bad({ ...spec, variants: [] }, /at least one variant/);
  bad({ ...spec, variants: [{ name: "a", command: "x" }, { name: "a", command: "y" }] }, /Two variants/);
  bad({ ...spec, measure: { source: "output", match: "(" } }, /not a valid regular expression/);
  bad({ ...spec, measure: { source: "board", match: "x" } }, /needs observe/);
  bad({ ...spec, variants: [{ name: "a" }] }, /needs a command/);
  bad({ ...spec, repeat: 11 }, /repeat/);
});

test("the plan runs every variant `repeat` times, shuffled the same way for the same seed", () => {
  const a = plan(spec, 42).map(v => v.name);
  assert.deepEqual(a, plan(spec, 42).map(v => v.name));
  assert.equal(a.filter(n => n === "dtr first").length, 3);
  assert.equal(a.filter(n => n === "defaults").length, 3);
  const orders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(seed => plan(spec, seed).map(v => v.name).join()));
  assert.ok(orders.size > 1, "different seeds give different orders");
});

test("a run is judged by its first matching line, with the value it reports", () => {
  assert.deepEqual(judge("t=16 temp=40\nrst:0x15 (USB_UART_CHIP_RESET)", spec.measure), { matched: true, value: 16, line: "rst:0x15 (USB_UART_CHIP_RESET)" });
  assert.deepEqual(judge("t=8007 temp=40", spec.measure), { matched: false, value: 8007 });
});

/** A board where "dtr first" restarts the chip and "defaults" does not. */
function fakeDeps(over: Partial<Parameters<typeof runExperiment>[1]> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      reset: async () => { calls.push("reset"); return "boot"; },
      wait: async () => {},
      command: async (cmd: string, env: Record<string, string>) => {
        calls.push(`${env.PI_LAB_VARIANT}@${env.PI_LAB_PORT}`);
        return { output: cmd.endsWith("low") ? "rst:0x15\nt=16" : "t=9000", code: 0 };
      },
      observe: async () => "",
      recover: async () => { calls.push("recover"); },
      env: { PI_LAB_PORT: "/dev/fake" },
      ...over,
    },
  };
}

test("an experiment resets before every run and judges each one", async () => {
  const { calls, deps } = fakeDeps();
  const { runs, seed } = await runExperiment(spec, deps, 7);
  assert.equal(seed, 7);
  assert.equal(runs.length, 6);
  assert.equal(calls.filter(c => c === "reset").length, 6);
  assert.ok(calls.includes("dtr first@/dev/fake"));
  const record = { spec, runs };
  const [dtr, defaults] = summarize(record);
  assert.deepEqual([dtr!.matched, dtr!.judged, dtr!.verdict, dtr!.consistent], [3, 3, "yes", true]);
  assert.deepEqual([defaults!.matched, defaults!.verdict, defaults!.values], [0, "no", [9000, 9000, 9000]]);
  assert.ok(settled(record));
  assert.match(renderTable(record), /\| dtr first \| 3\/3 \| 16 \/ 16 \/ 16 \| yes \|/);
});

test("a silent board is recovered once; if it stays silent the run is not judged", async () => {
  let resets = 0;
  const { calls, deps } = fakeDeps({ reset: async () => (++resets === 1 ? "" : "boot") });
  const first = await runExperiment(spec, deps, 1);
  assert.equal(calls.filter(c => c === "recover").length, 1);
  assert.equal(first.runs.filter(r => r.matched === null).length, 0);

  const dead = fakeDeps({ reset: async () => "" });
  const { runs } = await runExperiment(spec, dead.deps, 1);
  assert.ok(runs.every(r => r.matched === null && /printed nothing/.test(r.evidence)));
  assert.equal(summarize({ spec, runs })[0]!.verdict, "unknown");
  assert.ok(!settled({ spec, runs }));
});

test("variants that answer differently across runs are not settled", async () => {
  let n = 0;
  const { deps } = fakeDeps({ command: async () => ({ output: n++ % 2 ? "rst:0x15" : "ok", code: 0 }) });
  const { runs } = await runExperiment({ ...spec, repeat: 4 }, deps, 3);
  assert.ok(!settled({ spec: { ...spec, repeat: 4 }, runs }));
});

const record = (runs: ExperimentRecord["runs"], id = "E1"): ExperimentRecord => ({
  id, spec, seed: 1, startedAt: "2026-10-07T00:00:00Z", finishedAt: "2026-10-07T00:01:00Z", env: { board: "M5StickS3", port: "/dev/fake" }, runs,
});
const yes = (variant: string, order: number) => ({ variant, order, matched: true, evidence: "rst:0x15" });
const no = (variant: string, order: number) => ({ variant, order, matched: false, evidence: "t=9000" });

test("a note carries its experiment and its verdicts, and a re-run is compared with them", () => {
  const r = record([yes("dtr first", 1), no("defaults", 2), yes("dtr first", 3), no("defaults", 4), yes("dtr first", 5), no("defaults", 6)]);
  const note = noteMarkdown(r, { title: "Lowering DTR first restarts the M5StickS3", explanation: "RTS high with DTR low is the reset state.", tags: ["esp32-s3"] });
  assert.equal(note.file, "lowering-dtr-first-restarts-the-m5sticks3.md");
  assert.match(note.text, /^status: measured$/m);
  assert.match(note.text, /not measured/);
  assert.match(note.text, /^- \*\*dtr first\*\*: `\.\/open\.py low`$/m);
  const script = noteMarkdown({ ...r, spec: { ...spec, variants: [{ name: "inline", command: "\"$PI_LAB_PYTHON\" - <<'PY'\nimport serial\nPY" }] } }, { title: "t" });
  assert.match(script.text, /^- \*\*inline\*\*: `"\$PI_LAB_PYTHON" - <<'PY'` \(the full command is in the experiment block below\)$/m);
  const carried = parseNote(note.text)!;
  assert.deepEqual(carried.expected, { "dtr first": "yes", defaults: "no" });
  assert.equal(carried.spec.question, spec.question);

  const same = compare(carried.expected, r);
  assert.ok(same.holds);
  const changed = record([no("dtr first", 1), no("defaults", 2), no("dtr first", 3), no("defaults", 4)], "E2");
  const diff = compare(carried.expected, changed);
  assert.ok(!diff.holds);
  assert.match(diff.lines.join("\n"), /dtr first: recorded yes, now no \(0\/2\)  ← differs/);

  const reviewed = recordRerun(note.text, changed, diff);
  assert.match(reviewed, /^status: needs-review$/m);
  assert.match(reviewed, /## Re-runs\n\n### \d{4}-\d\d-\d\d: no longer matches/);
  assert.ok(parseNote(reviewed), "the experiment block survives");
  const again = recordRerun(reviewed, r, same);
  assert.match(again, /^status: measured$/m);
  assert.equal(again.match(/## Re-runs/g)!.length, 1);
});

test("records are numbered and kept in the project", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-exp-"));
  assert.equal(nextId(root), "E1");
  saveRecord(root, record([yes("dtr first", 1)], "E1"));
  saveRecord(root, record([yes("dtr first", 1)], "E7"));
  assert.equal(nextId(root), "E8");
  assert.equal(loadRecord(root, "E7")!.id, "E7");
  assert.equal(loadRecord(root, "E2"), undefined);
});

/** Enough of a board for lab-actions: a hub that "boots" on reset, and a shell that answers per variant. */
function fakeBoard(restarts: (variant: string) => boolean): Board & { lent: number } {
  let lent = 0;
  const hub = {
    port: "/dev/fake", baud: 115200,
    capture: async (o: { reset?: boolean }) => (o.reset === false ? [] : [{ n: 1, ts: 0, text: "ESP-ROM:esp32s3", kind: "out" }]),
    lend: async () => { lent++; return () => {}; },
  };
  return {
    get lent() { return lent; },
    needHub: async () => hub, hubs: () => [hub], reenumerate: async () => "re-enumerated", python: async () => "/fake/python",
    shell: async (cmd: string, _cwd: string, _t: number, env?: Record<string, string>) => {
      if (cmd.startsWith("git")) return { stdout: "abc1234\n", stderr: "", code: 0 };
      assert.equal(env!.PI_LAB_PYTHON, "/fake/python");
      return { stdout: restarts(env!.PI_LAB_VARIANT!) ? "rst:0x15 (USB_UART_CHIP_RESET)\nt=16" : "t=9000", stderr: "", code: 0 };
    },
  } as unknown as Board & { lent: number };
}

test("on the board: the experiment lends the port to each command, saves the record, and a note re-runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-lab-"));
  const ctx = { cwd: root, root, boardName: "M5StickS3" };
  const board = fakeBoard(v => v === "dtr first");
  const r = await experiment(board, spec, ctx);
  assert.equal(r.record!.id, "E1");
  assert.equal(board.lent, 6);
  assert.equal(r.record!.env.source, "abc1234");
  assert.match(r.text, /Every variant answered the same way/);
  assert.match(r.text, /Saved as \.pi\/lab\/experiments\/E1\.json/);

  const note = noteFromExperiment(ctx, { experiment: "E1", title: "DTR first restarts it", explanation: "the reset state" });
  assert.ok(note.file);
  const holds = await rerun(board, note.file!, ctx);
  assert.equal(holds.holds, true);
  assert.match(readFileSync(note.file!, "utf8"), /### \d{4}-\d\d-\d\d: still holds/);

  // On another board the result differs: the note is marked for review.
  const other = fakeBoard(() => false);
  const differs = await rerun(other, note.file!, ctx);
  assert.equal(differs.holds, false);
  assert.match(differs.text, /does NOT hold/);
  assert.match(readFileSync(note.file!, "utf8"), /^status: needs-review$/m);
});

test("a note is refused for an experiment that did not settle", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-unsettled-"));
  saveRecord(root, record([yes("dtr first", 1), no("dtr first", 2), no("defaults", 3), no("defaults", 4)], "E1"));
  const r = noteFromExperiment({ cwd: root, root }, { experiment: "E1", title: "x" });
  assert.equal(r.file, undefined);
  assert.match(r.text, /not settled/);
  writeFileSync(join(root, "plain.md"), "# no experiment here\n");
  return assert.rejects(rerun(fakeBoard(() => true), join(root, "plain.md"), { cwd: root, root }), /carries no experiment/);
});

test("a check whose board stays silent after a reset recovers the USB port once before judging", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-checks-"));
  let captures = 0, recovered = 0;
  const hub = {
    port: "/dev/fake", baud: 115200,
    capture: async () => (++captures === 1 ? [] : [{ n: 1, ts: 0, text: "temperature logger started", kind: "out" }]),
  };
  const board = { needHub: async () => hub, reenumerate: async () => { recovered++; return "re-enumerated"; } } as unknown as Board;
  const r = await checks(board, { checks: [{ name: "starts", expect: ["logger started"] }] }, { cwd: root, root });
  assert.equal(recovered, 1);
  assert.equal(r.results[0]!.pass, true);
});

test("the project's .pi/lab ignores the last check result but keeps experiments and notes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-ignore-"));
  saveRecord(root, record([yes("dtr first", 1)], "E1"));
  const ignore = readFileSync(join(root, ".pi", "lab", ".gitignore"), "utf8");
  assert.match(ignore, /^last-check\.json$/m);
  assert.deepEqual(ignore.split("\n").filter(l => l && !l.startsWith("#")), ["last-check.json"]);
  // An edited .gitignore is the user's: it is not rewritten.
  writeFileSync(join(root, ".pi", "lab", ".gitignore"), "mine\n");
  writeNote(root, { file: "n.md", text: "x" });
  assert.equal(readFileSync(join(root, ".pi", "lab", ".gitignore"), "utf8"), "mine\n");
});
