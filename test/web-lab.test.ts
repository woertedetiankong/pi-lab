import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BoardAccess } from "../src/board-core.ts";
import { type ExperimentRecord, noteMarkdown, saveRecord, writeNote } from "../src/experiment.ts";
import type { WebRequest } from "../src/hub.ts";
import { LabApp } from "../src/web.ts";

const request = (path: string, query = ""): WebRequest => ({
  method: "GET", path, query: new URLSearchParams(query), headers: {}, signal: new AbortController().signal, json: async () => ({}), raw: async () => Buffer.alloc(0),
});

function panel(root: string): LabApp {
  const board = { hub: async () => undefined, serial: () => ({ baud: 115200, ports: [] }), hubs: () => [] } as unknown as BoardAccess;
  const app = new LabApp(board);
  app.session = {
    status: () => ({ board: "M5StickS3", firmware: "synced" }), ask: () => {}, root: () => root,
    boards: async () => ({ packs: [], connected: [], kbInstalled: false }), chooseBoard: async () => {},
  };
  return app;
}

const spec = { question: "Does lowering DTR first restart it?", variants: [{ name: "low", command: "x low" }, { name: "default", command: "x default" }], measure: { source: "output" as const, match: "rst:0x" }, repeat: 2, reset: true, settle: 3, observe: 0, timeout: 60 };
const record = (id: string, lowMatches: boolean[]): ExperimentRecord => ({
  id, spec, seed: 1, startedAt: "2026-10-07T10:00:00Z", finishedAt: "2026-10-07T10:01:00Z", env: { board: "M5StickS3" },
  runs: [...lowMatches.map((m, i) => ({ variant: "low", order: i, matched: m, evidence: "" })), { variant: "default", order: 8, matched: false, evidence: "" }, { variant: "default", order: 9, matched: false, evidence: "" }],
});

test("the panel shows the last checks, the newest experiments first, and the notes with their status", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-panel-"));
  const app = panel(root);
  const empty = await app.handle(request("/lab")) as { checks: unknown; experiments: unknown[]; notes: unknown[] };
  assert.deepEqual(empty, { checks: null, experiments: [], notes: [] });

  saveRecord(root, record("E1", [true, true]));
  saveRecord(root, record("E2", [true, false]));
  writeNote(root, noteMarkdown(record("E1", [true, true]), { title: "Lowering DTR first restarts it" }));
  mkdirSync(join(root, ".pi", "lab"), { recursive: true });
  writeFileSync(join(root, ".pi", "lab", "last-check.json"), JSON.stringify({ at: "2026-10-07T10:05:00Z", port: "/dev/fake", results: [
    { name: "starts", pass: true, details: ["PASS expect /started/: started"] },
    { name: "no restart", pass: false, details: ["FAIL no restart: the board booted 1 more time(s) while watched"] },
  ] }));

  const lab = await app.handle(request("/lab")) as { checks: { results: unknown[] }; experiments: { id: string; settled: boolean; rows: { name: string; matched: number }[] }[]; notes: { file: string; status: string; experiment: string }[] };
  assert.deepEqual(lab.experiments.map(e => [e.id, e.settled]), [["E2", false], ["E1", true]]);
  assert.deepEqual(lab.experiments[1]!.rows.map(r => [r.name, r.matched]), [["low", 2], ["default", 0]]);
  assert.equal(lab.checks.results.length, 2);
  assert.deepEqual(lab.notes.map(n => [n.status, n.experiment]), [["measured", "E1"]]);

  const note = await app.handle(request("/lab/note", `file=${lab.notes[0]!.file}`)) as { text: string };
  assert.match(note.text, /pi-lab-experiment/);
  await assert.rejects(app.handle(request("/lab/note", "file=../../etc/passwd")), /No such note/);

  const state = await app.handle(request("/state")) as { checks: { passed: number; total: number } };
  assert.deepEqual([state.checks.passed, state.checks.total], [1, 2]);
});
