// What pi's tools and the MCP server do with the board beyond reading and flashing: experiments, notes made from
// them, and re-running a note's experiment. Each returns the text the agent reads.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Board } from "./board-core.ts";
import { type BoardCheck, checkProblems, type CheckResult, evaluateCheck, renderChecks } from "./checks.ts";
import {
  compare, ensureLabDir, type ExperimentRecord, type ExperimentSpec, experimentsDir, loadRecord, nextId, noteMarkdown, normalizeSpec, notesDir, parseNote, recordRerun,
  renderTable, runExperiment, saveRecord, settled, summarize, type VariantSummary, writeNote,
} from "./experiment.ts";
import { captureLogic, type LogicParams } from "./logic.ts";
import { readLabConfig, updateLabConfig } from "./project-config.ts";
import type { LogLine } from "./serial-hub.ts";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const out = (lines: LogLine[]) => lines.filter(l => l.kind !== "mark").map(l => l.text).join("\n");

export interface LabContext {
  cwd: string;
  root: string;
  /** The board pack in use, for the record. */
  boardName?: string;
  signal?: AbortSignal;
  progress?: (text: string) => void;
}

export interface ExperimentResult {
  text: string;
  record?: ExperimentRecord;
  /** For a re-run: whether the result still matches what was recorded. */
  holds?: boolean;
}

async function environment(board: Board, ctx: LabContext, port: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  if (ctx.boardName) env.board = ctx.boardName;
  env.port = port;
  env.host = `${platform()} ${release()}`;
  const head = await board.shell("git rev-parse --short HEAD 2>/dev/null && git status --porcelain 2>/dev/null | head -1", ctx.cwd, 5000).catch(() => undefined);
  const [sha, dirty] = (head?.stdout ?? "").split("\n");
  if (sha?.trim()) env.source = `${sha.trim()}${dirty?.trim() ? " + changes" : ""}`;
  return env;
}

/** Run an experiment on the board and save it in the project. */
export async function experiment(board: Board, spec: ExperimentSpec, ctx: LabContext): Promise<ExperimentResult> {
  const normalized = normalizeSpec(spec);
  const hub = await board.needHub();
  const id = nextId(ctx.root);
  const startedAt = new Date().toISOString();
  const env = await environment(board, ctx, hub.port);
  const { runs, seed } = await runExperiment(normalized, {
    reset: async seconds => out(await hub.capture({ seconds, reset: true, signal: ctx.signal })),
    wait: seconds => sleep(seconds * 1000),
    command: async (command, vars, timeout) => {
      // The command may open the port itself (a host script, a monitor): the hub lets go of it meanwhile.
      const giveBacks = await Promise.all(board.hubs().map(h => h.lend()));
      try {
        const r = await board.shell(command, ctx.cwd, timeout * 1000, vars);
        return { output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`, code: r.code };
      } finally { for (const g of giveBacks) g(); }
    },
    observe: async seconds => out(await hub.capture({ seconds, reset: false, signal: ctx.signal })),
    recover: () => board.reenumerate(),
    env: { PI_LAB_PORT: hub.port, PI_LAB_BAUD: String(hub.baud), PI_LAB_PYTHON: (await board.python()) ?? "python3" },
    signal: ctx.signal,
    progress: (done, total, run) => ctx.progress?.(`run ${done}/${total}: ${run.variant} → ${run.matched === null ? "not judged" : run.matched ? "yes" : "no"}`),
  });
  const record: ExperimentRecord = { id, spec: normalized, seed, startedAt, finishedAt: new Date().toISOString(), env, runs };
  const file = saveRecord(ctx.root, record);
  return { text: report(record, relative(ctx.cwd, file) || file), record };
}

function report(record: ExperimentRecord, file: string): string {
  const rows = summarize(record);
  const unjudged = record.runs.filter(r => r.matched === null);
  const lines = [
    `Experiment ${record.id}: ${record.spec.question}`,
    `${record.spec.variants.length} variant(s) × ${record.spec.repeat} runs in shuffled order (seed ${record.seed})${record.spec.reset ? ", board reset before each run" : ""}. A run counts when ${record.spec.measure.source === "output" ? "the command's output" : "the board's output after the command"} matches /${record.spec.measure.match}/.`,
    "",
    renderTable(record),
    "",
    "Runs in the order they ran:",
    ...record.runs.map(r => `${r.order}. ${r.variant}: ${r.matched === null ? "not judged" : r.matched ? "yes" : "no"}${r.value !== undefined ? ` (${r.value})` : ""}${r.exitCode ? ` [exit ${r.exitCode}]` : ""} - ${r.evidence}`),
    "",
  ];
  if (unjudged.length) lines.push(`${unjudged.length} run(s) could not be judged: fix the setup before reading the table.`);
  if (settled(record)) {
    lines.push("Every variant answered the same way in every run: you can build on this table.");
  } else {
    const shaky = rows.filter(r => !r.consistent).map(r => r.name);
    lines.push(`Not settled: ${shaky.join(", ")} did not answer the same way every run${record.spec.repeat < 2 ? " (one run per variant cannot show that)" : ""}. Either the variants do not control what matters, or the measure does not separate them; change one of those before drawing a conclusion.`);
  }
  lines.push(`Saved as ${file}. To keep what it showed as a note that others can re-run, use lab_note with experiment ${record.id}.`);
  return lines.join("\n");
}

/** Run a saved experiment (E<n>) or a note's experiment again, and say whether it still holds. */
export async function rerun(board: Board, target: string, ctx: LabContext): Promise<ExperimentResult> {
  let spec: ExperimentRecord["spec"], expected: Record<string, string>, notePath: string | undefined, noteText: string | undefined;
  if (/^E\d+$/i.test(target.trim())) {
    const saved = loadRecord(ctx.root, target.trim().toUpperCase());
    if (!saved) throw new Error(`No experiment ${target} in ${ctx.root}/.pi/lab/experiments.`);
    spec = saved.spec;
    expected = Object.fromEntries(summarize(saved).map(r => [r.name, r.verdict]));
  } else {
    notePath = isAbsolute(target) ? target : resolve(ctx.cwd, target);
    noteText = readFileSync(notePath, "utf8");
    const parsed = parseNote(noteText);
    if (!parsed) throw new Error(`${target} carries no experiment (no \`\`\`pi-lab-experiment block).`);
    spec = parsed.spec;
    expected = parsed.expected;
  }
  const result = await experiment(board, spec, ctx);
  const comparison = compare(expected as never, result.record!);
  let tail = "";
  if (notePath && noteText) {
    // Notes in this project record the re-run; a board pack's notes ship with pi-lab and are only reported on.
    if (!relative(ctx.root, notePath).startsWith("..")) {
      writeFileSync(notePath, recordRerun(noteText, result.record!, comparison));
      tail = comparison.holds ? `\nRecorded in ${relative(ctx.cwd, notePath)}.` : `\n${relative(ctx.cwd, notePath)} is now marked needs-review, with this table under "Re-runs".`;
    } else {
      tail = comparison.holds ? "" : "\nThis note ships with pi-lab, so it was not changed: tell the user it does not hold on this board.";
    }
  }
  const verdict = comparison.holds ? "The recorded result still holds:" : "The recorded result does NOT hold here:";
  return { text: `${result.text}\n\n${verdict}\n${comparison.lines.join("\n")}${tail}`, record: result.record, holds: comparison.holds };
}

/** A note made from an experiment: its table as the facts, the explanation marked as the agent's reading. */
export function noteFromExperiment(ctx: LabContext, params: { experiment: string; title: string; explanation?: string; tags?: string[] }): { text: string; file?: string } {
  const record = loadRecord(ctx.root, params.experiment.trim().toUpperCase());
  if (!record) throw new Error(`No experiment ${params.experiment} in ${ctx.root}/.pi/lab/experiments.`);
  if (!settled(record)) {
    return { text: `${record.id} is not settled (${summarize(record).filter(r => !r.consistent).map(r => r.name).join(", ")} answered differently across runs, or ran once). A note should rest on a table that repeats: run the experiment again with more runs or a sharper measure first.` };
  }
  const note = noteMarkdown(record, params);
  const file = writeNote(ctx.root, note);
  return { text: `Wrote ${relative(ctx.cwd, file)}: the table from ${record.id} as measured facts, your explanation marked as not measured, and the experiment itself, so anyone can re-run it with board_experiment rerun=${relative(ctx.cwd, file)}.`, file };
}

/** Run board checks: the given ones, or the project's (all, or those named). */
export async function checks(board: Board, params: { names?: string[]; checks?: BoardCheck[]; save?: boolean; afterFlash?: boolean }, ctx: LabContext): Promise<{ text: string; results: CheckResult[] }> {
  const config = readLabConfig(ctx.root);
  let list = params.checks?.length ? params.checks : config.checks ?? [];
  if (!list.length) {
    return { text: 'This project has no board checks. Agree on what "fixed" means with the user (lines that must appear, errors that must not, no restart, a value in range), then pass them as checks with save=true.', results: [] };
  }
  if (params.names?.length) {
    const wanted = new Set(params.names);
    list = list.filter(c => wanted.has(c.name));
    if (!list.length) return { text: `No check named ${params.names.join(", ")}. The project's: ${(config.checks ?? []).map(c => c.name).join(", ") || "none"}.`, results: [] };
  }
  const problems = list.flatMap(checkProblems);
  if (problems.length) throw new Error(`Fix these checks first:\n${problems.join("\n")}`);
  let saved = "";
  if (params.save && params.checks?.length) {
    updateLabConfig(ctx.root, { checks: params.checks, checkAfterFlash: params.afterFlash ?? config.checkAfterFlash });
    saved = `\nSaved ${params.checks.length} check(s) as this project's acceptance checks in .pi/lab.json${params.afterFlash ? "; they run after every board_flash" : ""}.`;
  }
  const hub = await board.needHub();
  const results: CheckResult[] = [];
  for (const c of list) {
    if (ctx.signal?.aborted) break;
    ctx.progress?.(`checking: ${c.name}`);
    const watch = () => hub.capture({ seconds: c.seconds ?? 10, reset: c.reset !== false, signal: ctx.signal });
    let lines = await watch();
    if (c.reset !== false && !lines.some(l => l.kind === "out" && l.text.trim())) {
      // A wedged USB port prints nothing after a reset, not even the ROM's banner: that is the port, not the firmware.
      ctx.progress?.(`${c.name}: the board printed nothing; recovering the USB port`);
      await board.reenumerate();
      lines = await watch();
    }
    results.push(evaluateCheck(c, lines));
  }
  saveLastCheck(ctx.root, { at: new Date().toISOString(), port: hub.port, results });
  return { text: `Board checks on ${hub.port}:\n${renderChecks(results)}${saved}`, results };
}

/** A logic analyzer capture, with the project's analyzer settings. */
export function logic(board: Board, params: LogicParams, ctx: LabContext): Promise<string> {
  return captureLogic(board.run, ctx.cwd, readLabConfig(ctx.root).logic ?? {}, params);
}

// ---- what the board panel shows: the last checks, recent experiments, notes ----

export interface LastCheck { at: string; port: string; results: CheckResult[] }

const lastCheckFile = (root: string) => join(root, ".pi", "lab", "last-check.json");

function saveLastCheck(root: string, last: LastCheck): void {
  try {
    ensureLabDir(root);
    writeFileSync(lastCheckFile(root), JSON.stringify(last, null, 2) + "\n");
  } catch {}
}

export function lastCheck(root: string): LastCheck | undefined {
  try { return JSON.parse(readFileSync(lastCheckFile(root), "utf8")); } catch { return undefined; }
}

export interface LabSummary {
  checks: LastCheck | null;
  experiments: { id: string; question: string; at: string; settled: boolean; rows: VariantSummary[]; measure: string; env: Record<string, string> }[];
  notes: { file: string; title: string; status: string; experiment?: string }[];
}

/** The newest experiments first (at most `limit`), and the project's notes with their status. */
export function labSummary(root: string, limit = 12): LabSummary {
  let files: string[] = [];
  try { files = readdirSync(experimentsDir(root)).filter(f => /^E\d+\.json$/.test(f)); } catch {}
  const experiments = files
    .map(f => Number(f.slice(1, -5)))
    .sort((a, b) => b - a)
    .slice(0, limit)
    .flatMap(n => {
      const r = loadRecord(root, `E${n}`);
      return r ? [{ id: r.id, question: r.spec.question, at: r.finishedAt, settled: settled(r), rows: summarize(r), measure: r.spec.measure.match, env: r.env }] : [];
    });
  let noteFiles: string[] = [];
  try { noteFiles = readdirSync(notesDir(root)).filter(f => f.endsWith(".md")); } catch {}
  const notes = noteFiles.map(file => {
    const text = readFileSync(join(notesDir(root), file), "utf8");
    const field = (k: string) => new RegExp(`^${k}: "?(.*?)"?$`, "m").exec(text)?.[1];
    return { file, title: field("title") ?? file, status: field("status") ?? "measured", ...(field("experiment") ? { experiment: field("experiment") } : {}) };
  });
  return { checks: lastCheck(root) ?? null, experiments, notes };
}
