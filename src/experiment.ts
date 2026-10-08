// Controlled experiments on the board. Instead of a one-off probe script whose result the agent then generalizes,
// an experiment runs each variant several times in shuffled order from the same starting point (a reset), judges
// every run by the same rule, and reports a table: "lower DTR first: restarted 3/3; pyserial defaults: 0/3".
// The record is saved in the project, can become a note that carries its own experiment, and can be run again
// later, on another board or after an SDK update, to see whether what it says still holds.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Variant {
  name: string;
  /** Shell command run in the project directory, with PI_LAB_PORT and PI_LAB_BAUD set. None: only observe. */
  command?: string;
}

export interface Measure {
  /** Judge the command's output, or what the board printed after it. */
  source: "output" | "board";
  /** A run counts as "yes" when this regular expression matches. */
  match: string;
  /** Optional regular expression with one capture group: a number recorded for each run. */
  value?: string;
}

export interface ExperimentSpec {
  question: string;
  variants: Variant[];
  measure: Measure;
  /** Runs per variant (default 3). */
  repeat?: number;
  /** Reset the board before every run (default true), so each starts from the same state. */
  reset?: boolean;
  /** Seconds to let the board run after the reset, before the command (default 3). */
  settle?: number;
  /** Seconds to read the board after the command (default 0; needed when measure.source is "board"). */
  observe?: number;
  /** Seconds a command may take (default 60). */
  timeout?: number;
}

export interface RunResult {
  variant: string;
  /** Position in the shuffled order, from 1. */
  order: number;
  /** null: the run could not be judged (the board stayed silent, the command could not run). */
  matched: boolean | null;
  value?: number;
  exitCode?: number;
  /** The line that matched, or why the run could not be judged, or the end of the output. */
  evidence: string;
}

export interface ExperimentRecord {
  id: string;
  spec: Required<Omit<ExperimentSpec, "variants" | "measure" | "question">> & Pick<ExperimentSpec, "variants" | "measure" | "question">;
  seed: number;
  startedAt: string;
  finishedAt: string;
  /** Where it ran: board pack, port, host, firmware source. */
  env: Record<string, string>;
  runs: RunResult[];
}

export interface VariantSummary {
  name: string;
  runs: number;
  /** Runs that could be judged. */
  judged: number;
  matched: number;
  values: number[];
  /** Every judged run gave the same answer, and there were at least two. */
  consistent: boolean;
  /** "yes" or "no" by majority of judged runs, "mixed" at a tie, "unknown" with none judged. */
  verdict: "yes" | "no" | "mixed" | "unknown";
}

export const MAX_REPEAT = 10;
export const MAX_VARIANTS = 6;

/** The spec with defaults filled in, or an error that says what is wrong. */
export function normalizeSpec(spec: ExperimentSpec): ExperimentRecord["spec"] {
  if (!spec.question?.trim()) throw new Error("An experiment needs a question: what are you trying to find out?");
  if (!Array.isArray(spec.variants) || spec.variants.length < 1) throw new Error("An experiment needs at least one variant.");
  if (spec.variants.length > MAX_VARIANTS) throw new Error(`At most ${MAX_VARIANTS} variants per experiment.`);
  const names = new Set<string>();
  for (const v of spec.variants) {
    if (!v.name?.trim()) throw new Error("Every variant needs a name.");
    if (names.has(v.name)) throw new Error(`Two variants are called "${v.name}".`);
    names.add(v.name);
  }
  if (!spec.measure || (spec.measure.source !== "output" && spec.measure.source !== "board")) throw new Error('measure.source must be "output" or "board".');
  for (const [key, re] of [["match", spec.measure.match], ["value", spec.measure.value]] as const) {
    if (re === undefined && key === "value") continue;
    try { new RegExp(re ?? ""); } catch (e) { throw new Error(`measure.${key} is not a valid regular expression: ${(e as Error).message}`); }
    if (key === "match" && !re) throw new Error("measure.match is required: the rule that says whether a run counts.");
  }
  const repeat = Math.round(spec.repeat ?? 3);
  if (repeat < 1 || repeat > MAX_REPEAT) throw new Error(`repeat must be 1 to ${MAX_REPEAT}.`);
  const observe = spec.observe ?? 0;
  if (spec.measure.source === "board" && observe <= 0) throw new Error('measure.source "board" needs observe: how many seconds to read the board after the command.');
  if (spec.measure.source === "output" && spec.variants.some(v => !v.command)) throw new Error('measure.source "output" needs a command in every variant.');
  return {
    question: spec.question.trim(), variants: spec.variants.map(v => ({ name: v.name.trim(), ...(v.command ? { command: v.command } : {}) })),
    measure: spec.measure, repeat, reset: spec.reset !== false, settle: spec.settle ?? 3, observe, timeout: spec.timeout ?? 60,
  };
}

/** A small seeded generator (mulberry32), so a recorded order can be reproduced. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every variant `repeat` times, shuffled: a drifting board or a warming chip then affects all variants alike. */
export function plan(spec: { variants: Variant[]; repeat: number }, seed: number): Variant[] {
  const list = spec.variants.flatMap(v => Array.from({ length: spec.repeat }, () => v));
  const next = random(seed);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list;
}

/** Judge one run's text by the measure. */
export function judge(text: string, measure: Measure): { matched: boolean; value?: number; line?: string } {
  const lines = text.split("\n");
  const re = new RegExp(measure.match);
  const line = lines.find(l => re.test(l));
  let value: number | undefined;
  if (measure.value) {
    const v = new RegExp(measure.value);
    for (const l of lines) {
      const m = v.exec(l);
      if (m?.[1] !== undefined && Number.isFinite(Number(m[1]))) { value = Number(m[1]); break; }
    }
  }
  return { matched: line !== undefined, ...(value !== undefined ? { value } : {}), ...(line !== undefined ? { line: line.trim() } : {}) };
}

export interface ExperimentDeps {
  /** Reset the board and return what it printed for `seconds`. */
  reset(seconds: number): Promise<string>;
  /** Let the board run for `seconds` without reading it. */
  wait(seconds: number): Promise<void>;
  /** Run a variant's command with the port lent to it. */
  command(command: string, env: Record<string, string>, timeoutSeconds: number): Promise<{ output: string; code: number }>;
  /** What the board prints in the next `seconds`, without a reset. */
  observe(seconds: number): Promise<string>;
  /** Recover a board that stopped answering (USB re-enumeration). */
  recover(): Promise<unknown>;
  env: Record<string, string>;
  signal?: AbortSignal;
  progress?: (done: number, total: number, run: RunResult) => void;
}

export async function runExperiment(spec: ExperimentRecord["spec"], deps: ExperimentDeps, seed = Math.floor(Math.random() * 2 ** 31)): Promise<{ runs: RunResult[]; seed: number }> {
  const order = plan(spec, seed);
  const runs: RunResult[] = [];
  for (const [i, variant] of order.entries()) {
    if (deps.signal?.aborted) break;
    const result: RunResult = { variant: variant.name, order: i + 1, matched: null, evidence: "" };
    try {
      if (spec.reset) {
        let boot = await deps.reset(spec.settle);
        if (!boot.trim()) {
          // A wedged USB port prints nothing, not even the ROM's banner: recover once, then judge or give up.
          await deps.recover();
          boot = await deps.reset(spec.settle);
        }
        if (!boot.trim()) { result.evidence = "the board printed nothing after a reset, even after USB recovery"; runs.push(result); deps.progress?.(i + 1, order.length, result); continue; }
      } else if (spec.settle > 0) {
        await deps.wait(spec.settle);
      }
      let text = "";
      if (variant.command) {
        const r = await deps.command(variant.command, { ...deps.env, PI_LAB_VARIANT: variant.name, PI_LAB_RUN: String(i + 1) }, spec.timeout);
        result.exitCode = r.code;
        if (spec.measure.source === "output") text = r.output;
      }
      if (spec.observe > 0) {
        const seen = await deps.observe(spec.observe);
        if (spec.measure.source === "board") text = seen;
      }
      const j = judge(text, spec.measure);
      result.matched = j.matched;
      if (j.value !== undefined) result.value = j.value;
      result.evidence = j.line ?? (text.trim().split("\n").slice(-2).join(" | ").slice(-200) || "(no output)");
    } catch (e) {
      result.evidence = `could not run: ${(e as Error).message}`.slice(0, 300);
    }
    runs.push(result);
    deps.progress?.(i + 1, order.length, result);
  }
  return { runs, seed };
}

export function summarize(record: Pick<ExperimentRecord, "spec" | "runs">): VariantSummary[] {
  return record.spec.variants.map(v => {
    const runs = record.runs.filter(r => r.variant === v.name);
    const judged = runs.filter(r => r.matched !== null);
    const matched = judged.filter(r => r.matched).length;
    const verdict = !judged.length ? "unknown" : matched * 2 > judged.length ? "yes" : matched * 2 < judged.length ? "no" : "mixed";
    return {
      name: v.name, runs: runs.length, judged: judged.length, matched,
      values: runs.flatMap(r => (r.value !== undefined ? [r.value] : [])),
      consistent: judged.length >= 2 && (matched === 0 || matched === judged.length),
      verdict,
    };
  });
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/** The table the model and the user read. */
export function renderTable(record: Pick<ExperimentRecord, "spec" | "runs">): string {
  const rows = summarize(record);
  const hasValues = rows.some(r => r.values.length);
  const head = `| Variant | ${record.spec.measure.match.length > 40 ? "matched" : `\`${record.spec.measure.match.replace(/\|/g, "\\|")}\``} |${hasValues ? " value (min / median / max) |" : ""} Consistent |`;
  const lines = [head, `| --- | --- |${hasValues ? " --- |" : ""} --- |`];
  for (const r of rows) {
    const unjudged = r.runs - r.judged;
    const count = `${r.matched}/${r.judged}${unjudged ? ` (+${unjudged} not judged)` : ""}`;
    const values = r.values.length ? `${Math.min(...r.values)} / ${median(r.values)} / ${Math.max(...r.values)}` : "–";
    lines.push(`| ${r.name} | ${count} |${hasValues ? ` ${values} |` : ""} ${r.consistent ? "yes" : "no"} |`);
  }
  return lines.join("\n");
}

/** Short summary for the ledger: "lower DTR first: 3/3; defaults: 0/3". */
export function oneLine(record: Pick<ExperimentRecord, "spec" | "runs">): string {
  return summarize(record).map(r => `${r.name}: ${r.matched}/${r.judged}`).join("; ");
}

/** All variants answered the same way every time, with at least two runs each: a result to build on. */
export const settled = (record: Pick<ExperimentRecord, "spec" | "runs">) => summarize(record).every(r => r.consistent);

// ---- records in the project: .pi/lab/experiments/E<n>.json ----

/**
 * The project's .pi/lab, made on first use with a .gitignore: experiments and notes are meant to be shared through
 * git, but the last board-check result changes on every run and would only clutter the team's diffs.
 */
export function ensureLabDir(root: string): string {
  const dir = join(root, ".pi", "lab");
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "# pi-lab: experiments/ and notes/ are shared; the last board-check result is per machine\nlast-check.json\n");
  return dir;
}

export const experimentsDir = (root: string) => join(root, ".pi", "lab", "experiments");

export function nextId(root: string): string {
  let max = 0;
  try { for (const f of readdirSync(experimentsDir(root))) { const m = /^E(\d+)\.json$/.exec(f); if (m) max = Math.max(max, Number(m[1])); } } catch {}
  return `E${max + 1}`;
}

export function saveRecord(root: string, record: ExperimentRecord): string {
  ensureLabDir(root);
  mkdirSync(experimentsDir(root), { recursive: true });
  const file = join(experimentsDir(root), `${record.id}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  return file;
}

export function loadRecord(root: string, id: string): ExperimentRecord | undefined {
  try { return JSON.parse(readFileSync(join(experimentsDir(root), `${id}.json`), "utf8")); } catch { return undefined; }
}

// ---- notes that carry their experiment ----

/** A command as one line of Markdown; a script's full text is in the experiment block. */
function commandLine(command: string): string {
  const [first = ""] = command.split("\n");
  const short = first.length > 140 ? `${first.slice(0, 137)}...` : first;
  return `\`${short.replace(/`/g, "'")}\`${command.includes("\n") || first.length > 140 ? " (the full command is in the experiment block below)" : ""}`;
}

/** What a note records about its experiment: the spec and each variant's verdict. */
export interface NoteExperiment {
  spec: ExperimentRecord["spec"];
  expected: Record<string, VariantSummary["verdict"]>;
}

const FENCE = "pi-lab-experiment";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "note";
const today = () => new Date().toISOString().slice(0, 10);
const yaml = (s: string) => JSON.stringify(s);

/**
 * A note in pi-kb's format whose facts are the experiment's table, measured, and whose explanation is marked as the
 * agent's reading of it. The experiment travels with the note, so anyone can run it again on their board.
 */
export function noteMarkdown(record: ExperimentRecord, opts: { title: string; explanation?: string; tags?: string[] }): { file: string; text: string } {
  const embedded: NoteExperiment = { spec: record.spec, expected: Object.fromEntries(summarize(record).map(r => [r.name, r.verdict])) };
  const env = Object.entries(record.env).map(([k, v]) => `${k}: ${v}`).join(", ");
  const text = [
    "---",
    `title: ${yaml(opts.title)}`,
    `tags: [${["pi-lab", "experiment", ...(opts.tags ?? [])].join(", ")}]`,
    `created: ${today()}`,
    `updated: ${today()}`,
    `experiment: ${record.id}`,
    "status: measured",
    "---",
    "",
    `# ${opts.title}`,
    "",
    `**Question.** ${record.spec.question}`,
    "",
    `**Measured** (${record.finishedAt.slice(0, 10)}; ${record.spec.repeat} runs per variant in shuffled order${record.spec.reset ? ", the board reset before each" : ""}; ${env}). A run counts when ${record.spec.measure.source === "output" ? "the command's output" : `what the board printed in the ${record.spec.observe} s after the command`} matches \`${record.spec.measure.match}\`:`,
    "",
    renderTable(record),
    "",
    ...record.spec.variants.flatMap(v => (v.command ? [`- **${v.name}**: ${commandLine(v.command)}`] : [])),
    "",
    "**Explanation** (the agent's reading of the table; not measured):",
    "",
    opts.explanation?.trim() || "(none given)",
    "",
    "**Run it again** on your board with `board_experiment` and `rerun` set to this note's path; pi-lab compares the result with the table above.",
    "",
    "```" + FENCE,
    JSON.stringify(embedded, null, 2),
    "```",
    "",
  ].join("\n");
  return { file: `${slug(opts.title)}.md`, text };
}

/** The experiment a note carries, if it has one. */
export function parseNote(text: string): NoteExperiment | undefined {
  const m = new RegExp("```" + FENCE + "\\n([\\s\\S]*?)\\n```").exec(text);
  if (!m) return undefined;
  try {
    const parsed = JSON.parse(m[1]!) as NoteExperiment;
    return parsed.spec && parsed.expected ? parsed : undefined;
  } catch { return undefined; }
}

export interface Comparison {
  holds: boolean;
  /** One line per variant: recorded verdict → now. */
  lines: string[];
}

/** Does a new run say what the note says? Variants judged differently, or not at all, mean it no longer holds. */
export function compare(expected: NoteExperiment["expected"], record: Pick<ExperimentRecord, "spec" | "runs">): Comparison {
  const now = summarize(record);
  const lines: string[] = [];
  let holds = true;
  for (const [name, was] of Object.entries(expected)) {
    const r = now.find(s => s.name === name);
    const is = r?.verdict ?? "unknown";
    const same = is === was && is !== "unknown" && is !== "mixed";
    if (!same) holds = false;
    lines.push(`- ${name}: recorded ${was}, now ${is}${r ? ` (${r.matched}/${r.judged})` : ""}${same ? "" : "  ← differs"}`);
  }
  return { holds, lines };
}

/** The note with this re-run recorded: its status, its date, and the new table under "Re-runs". */
export function recordRerun(text: string, record: ExperimentRecord, result: Comparison): string {
  const status = result.holds ? "measured" : "needs-review";
  let out = text
    .replace(/^status: .*$/m, `status: ${status}`)
    .replace(/^updated: .*$/m, `updated: ${today()}`);
  if (!/^status: /m.test(out)) out = out.replace(/^---\n/, `---\nstatus: ${status}\n`);
  const env = Object.entries(record.env).map(([k, v]) => `${k}: ${v}`).join(", ");
  const section = [
    `### ${today()}: ${result.holds ? "still holds" : "no longer matches the table above, review this note"}`,
    "",
    `${record.id}; ${env}.`,
    "",
    renderTable(record),
    "",
    ...result.lines,
    "",
  ].join("\n");
  const fence = out.lastIndexOf("```" + FENCE);
  const head = fence >= 0 ? out.slice(0, fence) : out;
  const tail = fence >= 0 ? out.slice(fence) : "";
  return head.includes("## Re-runs") ? `${head.trimEnd()}\n\n${section}\n${tail}` : `${head.trimEnd()}\n\n## Re-runs\n\n${section}\n${tail}`;
}

/** Notes pi-lab wrote in this project. */
export const notesDir = (root: string) => join(root, ".pi", "lab", "notes");

export function writeNote(root: string, note: { file: string; text: string }): string {
  ensureLabDir(root);
  mkdirSync(notesDir(root), { recursive: true });
  let file = join(notesDir(root), note.file);
  for (let n = 2; existsSync(file); n++) file = join(notesDir(root), note.file.replace(/\.md$/, `-${n}.md`));
  writeFileSync(file, note.text);
  return file;
}
