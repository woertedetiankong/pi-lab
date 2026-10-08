// pi's board tools: board_serial, board_flash, board_recover, board_experiment, lab_note, board_check, board_logic.
// The work is done by the board core (board-core.ts) and lab actions (lab-actions.ts), which the MCP server shares.

import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Run } from "./board.ts";
import { type Board, createBoard, type SerialParams } from "./board-core.ts";
import type { BoardCheck } from "./checks.ts";
import type { ExperimentRecord, ExperimentSpec } from "./experiment.ts";
import { checks, experiment, type LabContext, logic, noteFromExperiment, rerun } from "./lab-actions.ts";
import type { LogicParams } from "./logic.ts";
import { readLabConfig } from "./project-config.ts";
import { CHECK, EXPERIMENT, FLASH, LOGIC, NOTE, RECOVER, SERIAL, type ToolSpec } from "./schemas.ts";

export { type BoardAccess, logText, looksGarbled, type SerialChoice } from "./board-core.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export function registerBoardTools(pi: ExtensionAPI, hooks: {
  flashed: (ctx: ExtensionContext, command: string) => Promise<unknown>;
  /** A finished experiment, for the ledger; returns a line to add to the result. */
  experimented?: (ctx: ExtensionContext, record: ExperimentRecord) => string | undefined;
  /** What to tell the model when the chip keeps booting into its download mode. */
  downloadModeHint?: () => string | undefined;
  /** The project directory, for its build output (crash decoding). */
  cwd: () => string;
  /** The project root, where .pi/lab.json keeps the serial port and baud. */
  root: () => string;
  /** The board pack in use, recorded with experiments. */
  boardName?: () => string | undefined;
}): Board {
  const run: Run = async (command, args, options) => {
    const r = await pi.exec(command, args, { cwd: options?.cwd, timeout: options?.timeout });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
  };
  const board = createBoard({ run, cwd: hooks.cwd, root: hooks.root, downloadModeHint: hooks.downloadModeHint });
  pi.on("session_shutdown", () => board.stop());

  const register = <P>(spec: ToolSpec, execute: (params: P, signal: AbortSignal | undefined, update: AgentToolUpdateCallback<unknown> | undefined, ctx: ExtensionContext) => Promise<ReturnType<typeof text>>) =>
    pi.registerTool({
      name: spec.name, label: spec.label, description: spec.description, promptSnippet: spec.promptSnippet,
      parameters: Type.Unsafe<P>(spec.parameters),
      execute: (_id, params, signal, update, ctx) => execute(params as P, signal, update, ctx),
    });

  const lab = (ctx: ExtensionContext, signal?: AbortSignal, update?: AgentToolUpdateCallback<unknown>): LabContext => ({
    cwd: ctx.cwd, root: hooks.root(), boardName: hooks.boardName?.(), signal,
    progress: t => update?.({ content: [{ type: "text", text: t }], details: undefined }),
  });

  register<SerialParams>(SERIAL, async (params, signal) => text(await board.readSerial(params, signal)));

  register<{ build?: boolean; port?: string }>(FLASH, async (params, signal, update, ctx) => {
    const r = await board.flash(params, ctx.cwd);
    if (!r.flashed) return text(r.text);
    await hooks.flashed(ctx, "board_flash");
    const config = readLabConfig(hooks.root());
    if (!config.checkAfterFlash || !config.checks?.length) return text(r.text);
    // The engineer asked for the checks after every flash: the fix is judged by them, not by the agent.
    const c = await checks(board, {}, lab(ctx, signal, update)).catch(e => ({ text: `Board checks could not run: ${(e as Error).message}` }));
    return text(`${r.text}\n\n${c.text}`);
  });

  register<Record<string, never>>(RECOVER, async () => text(await board.recover()));

  register<ExperimentSpec & { rerun?: string }>(EXPERIMENT, async (params, signal, update, ctx) => {
    const r = params.rerun ? await rerun(board, params.rerun, lab(ctx, signal, update)) : await experiment(board, params, lab(ctx, signal, update));
    const added = r.record ? hooks.experimented?.(ctx, r.record) : undefined;
    return text(added ? `${r.text}\n${added}` : r.text);
  });

  register<{ experiment: string; title: string; explanation?: string; tags?: string[] }>(NOTE, async (params, _signal, _update, ctx) =>
    text(noteFromExperiment(lab(ctx), params).text));

  register<{ names?: string[]; checks?: BoardCheck[]; save?: boolean; afterFlash?: boolean }>(CHECK, async (params, signal, update, ctx) =>
    text((await checks(board, params, lab(ctx, signal, update))).text));

  register<LogicParams>(LOGIC, async (params, _signal, _update, ctx) => text(await logic(board, params, lab(ctx))));

  return board;
}
