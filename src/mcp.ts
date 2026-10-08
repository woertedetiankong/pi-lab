#!/usr/bin/env node
// pi-lab's board tools for other coding agents (Claude Code, Codex, Cursor, ...), as an MCP server over stdio:
//   claude mcp add pi-lab -- node /path/to/pi-lab/src/mcp.ts
// The project is the working directory the agent starts the server in (or PI_LAB_PROJECT). What needs pi's
// extension API (the toolchain guard, the debug ledger, the panel's "Ask pi") stays in pi; the board, experiments,
// notes, checks and the logic analyzer are the same code.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Run } from "./board.ts";
import { createBoard, type SerialParams } from "./board-core.ts";
import { loadPacks, projectBoard } from "./boards.ts";
import type { BoardCheck } from "./checks.ts";
import type { ExperimentSpec } from "./experiment.ts";
import { checks, experiment, type LabContext, logic, noteFromExperiment, rerun } from "./lab-actions.ts";
import type { LogicParams } from "./logic.ts";
import { readLabConfig } from "./project-config.ts";
import { TOOLS } from "./schemas.ts";

const VERSION = (() => { try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string; } catch { return "0"; } })();

const INSTRUCTIONS = [
  "pi-lab drives the embedded board attached to this computer.",
  "Read the board with board_serial (it resets the board and captures from the first boot line) instead of `idf.py monitor`, which never exits; flash with board_flash; if the board stops answering, use board_recover.",
  "When a result surprises you, when two explanations fit, or before you state a cause, test it with board_experiment: the variants that would tell them apart, several runs each. One probe run is an anecdote; a table that repeats is a fact.",
  "When the project has board checks, a fix is done when board_check passes.",
].join("\n");

const run: Run = (command, args, options) => new Promise(resolve => {
  execFile(command, args, { cwd: options?.cwd, timeout: options?.timeout, maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
    const code = !error ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
    resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error && !stdout ? error.message : ""), code });
  });
});

/** The project root: the nearest directory with .git or .pi/lab.json. */
function projectRoot(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".pi", "lab.json"))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

const cwd = process.env.PI_LAB_PROJECT ?? process.cwd();
const root = projectRoot(cwd);
const pack = (() => { const id = process.env.PI_LAB_BOARD ?? projectBoard(root); return loadPacks().find(p => p.id === id); })();
const board = createBoard({ run, cwd: () => cwd, root: () => root, downloadModeHint: () => (pack?.buttons ? `The board is in download mode. ${pack.buttons}` : undefined) });
const lab = (): LabContext => ({ cwd, root, boardName: pack?.name });

type Args = Record<string, unknown>;
const handlers: Record<string, (args: Args) => Promise<string>> = {
  board_serial: args => board.readSerial(args as SerialParams),
  board_flash: async args => {
    const r = await board.flash(args as { build?: boolean; port?: string }, cwd);
    const config = readLabConfig(root);
    if (!r.flashed || !config.checkAfterFlash || !config.checks?.length) return r.text;
    const c = await checks(board, {}, lab()).catch(e => ({ text: `Board checks could not run: ${(e as Error).message}` }));
    return `${r.text}\n\n${c.text}`;
  },
  board_recover: () => board.recover(),
  board_experiment: async args => {
    const r = typeof args.rerun === "string" && args.rerun ? await rerun(board, args.rerun, lab()) : await experiment(board, args as unknown as ExperimentSpec, lab());
    return r.text;
  },
  lab_note: async args => noteFromExperiment(lab(), args as { experiment: string; title: string; explanation?: string; tags?: string[] }).text,
  board_check: async args => (await checks(board, args as { names?: string[]; checks?: BoardCheck[]; save?: boolean; afterFlash?: boolean }, lab())).text,
  board_logic: args => logic(board, args as LogicParams, lab()),
};

interface Request { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: Args }

const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");

async function handle(req: Request): Promise<unknown> {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pi-lab", version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(t => ({ name: t.name, title: t.label, description: t.description, inputSchema: t.parameters })) };
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const handler = handlers[name];
      if (!handler) throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
      try {
        return { content: [{ type: "text", text: await handler((req.params?.arguments as Args) ?? {}) }], isError: false };
      } catch (e) {
        // A tool that fails (no board, a bad regular expression) is a result the agent reads, not a protocol error.
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 });
  }
}

const lines = createInterface({ input: process.stdin });
const pending = new Set<Promise<unknown>>();
lines.on("line", line => {
  if (!line.trim()) return;
  let req: Request;
  try { req = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
  // Notifications (no id) get no answer.
  if (req.id === undefined || req.id === null) return;
  const done = handle(req).then(
    result => send({ jsonrpc: "2.0", id: req.id, result }),
    (e: Error & { code?: number }) => send({ jsonrpc: "2.0", id: req.id, error: { code: e.code ?? -32603, message: e.message } }),
  ).finally(() => pending.delete(done));
  pending.add(done);
});
// The client closed its end: answer what is in flight (a capture or flash must not stop half-way), then leave.
lines.on("close", async () => {
  await Promise.allSettled([...pending]);
  board.stop();
  process.exit(0);
});
