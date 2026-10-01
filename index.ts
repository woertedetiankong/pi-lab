import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { compare, describeFirmware, FLASH_ENTRY, type FirmwareState, firmwareStatus, type FlashRecord, isFirmwareFile, isFlashCommand, sourceState } from "./src/firmware.ts";
import { usbIds } from "./src/board.ts";
import { registerBoardTools } from "./src/board-tools.ts";
import { BOARD_EVENT, type BoardEvent, type BoardPack, candidates, describePack, docsDir, ensureDocs, loadPacks, notePaths, projectBoard, setProjectBoard } from "./src/boards.ts";
import { foldLogs } from "./src/fold.ts";
import { checkCommand, checkWrite } from "./src/guard.ts";
import { applyAction, emptyLedger, isEmpty, LEDGER_ENTRY, type Ledger, type LedgerAction, renderLedger } from "./src/ledger.ts";

const NUDGE_TYPE = "pi-lab.stale-nudge";
const STEP_BACK_TYPE = "pi-lab.step-back";
/** Tool calls without settling anything before the agent is asked to step back. */
const STEP_BACK_AFTER = 30;

const GUIDELINES = [
  "You are debugging embedded firmware on real hardware. Keep a debug ledger with the lab_ledger tool; it is shown to you below on every turn and survives context compaction.",
  "- Record a fact only when the hardware showed it (serial output, a register read, a measurement), and say what showed it. A new fact is a single observation until you reproduce it from a clean build with one change and record that with verify_fact.",
  "- When an observation contradicts what the code says should happen, assume the experiment is wrong before the hardware: rebuild from the original code with only one change and repeat it.",
  "- Before testing an idea, add it as a hypothesis; when a test settles it, mark it ruled_out or confirmed with the evidence. Do not retest an idea the ledger already ruled out unless something relevant changed.",
  "- Flash with board_flash and read the board with board_serial (it resets the board and captures from the first boot line). Do not run `idf.py monitor` or other serial monitors: they never exit. If the board stops answering, use board_recover.",
  "- What you see on the board only reflects your edits after they are flashed. Check the Firmware line before drawing conclusions from board behaviour.",
  "- Keep changes inside the project. Do not edit the SDK or toolchain (copy a component into the project to change it) and do not install packages into shared Python environments.",
  "- Older build, flash and serial logs are shortened in your context; re-run a command if you need its full output.",
];

export default function piLab(pi: ExtensionAPI): void {
  let ledger: Ledger = emptyLedger();
  let flash: FlashRecord | undefined;
  let firmware: FirmwareState = { kind: "unknown" };
  let editedFirmware = false, nudged = false;
  let sinceProgress = 0, steppedBack = false;

  const run = (cwd: string) => (command: string, args: string[]) => pi.exec(command, args, { cwd, timeout: 10_000 });

  // Both records are snapshots in the session, so the active branch decides which ones apply.
  const restore = (ctx: ExtensionContext) => {
    ledger = emptyLedger();
    flash = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === LEDGER_ENTRY && entry.data) ledger = entry.data as Ledger;
      if (entry.customType === FLASH_ENTRY && entry.data) flash = entry.data as FlashRecord;
    }
  };

  const refresh = async (ctx: ExtensionContext) => {
    firmware = compare(flash, await sourceState(run(ctx.cwd)).catch(() => undefined));
    if (ctx.hasUI) ctx.ui.setStatus("pi-lab", firmwareStatus(firmware));
  };

  const recordFlash = async (ctx: ExtensionContext, command: string) => {
    const now = await sourceState(run(ctx.cwd)).catch(() => undefined);
    if (!now) return false;
    flash = { at: Date.now(), command, ...now };
    pi.appendEntry(FLASH_ENTRY, flash);
    await refresh(ctx);
    return true;
  };

  const update = (act: LedgerAction) => {
    const result = applyAction(ledger, act);
    if (result.changed) {
      ledger = result.ledger;
      pi.appendEntry(LEDGER_ENTRY, ledger);
      // A reproduced fact or a settled hypothesis is progress; a new idea or a single observation is not.
      if (act.action === "verify_fact" || (act.action === "update" && (act.status === "ruled_out" || act.status === "confirmed"))) {
        sinceProgress = 0;
        steppedBack = false;
      }
    }
    return result;
  };

  // The board pack in use: chosen per project with /lab board (or PI_LAB_BOARD).
  const packs = loadPacks();
  let pack: BoardPack | undefined;
  let kbShelf: string | undefined;
  const projectRoot = (cwd: string) => {
    for (let dir = cwd; ; dir = dirname(dir)) {
      if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".pi", "lab.json"))) return dir;
      if (dirname(dir) === dir) return cwd;
    }
  };
  // pi-kb answers with the shelf it put the board's datasheets and notes on.
  pi.events.on("pi-kb:board-shelf", data => { kbShelf = (data as { shelf?: string }).shelf; });

  const usePack = async (ctx: ExtensionContext) => {
    const id = process.env.PI_LAB_BOARD ?? projectBoard(projectRoot(ctx.cwd));
    pack = packs.find(p => p.id === id);
    kbShelf = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("pi-lab-board", pack ? `🔧 ${pack.name}` : undefined);
    if (!pack) {
      if (!id && ctx.hasUI) {
        const found = candidates(packs, await usbIds(run(ctx.cwd)).catch(() => []));
        if (found.length) ctx.ui.notify(`pi-lab: a board like ${found.map(p => p.name).join(" or ")} is connected. If that is it, run /lab board ${found[0]!.id} so pi knows its pins and quirks.`, "info");
      }
      return;
    }
    // Datasheets are downloaded once; pi-kb, when installed, puts them and the pack's notes on a shelf.
    const fetchFile = async (url: string, file: string) => (await pi.exec("curl", ["-sSfL", "-o", file, url], { timeout: 120_000 })).code === 0;
    const docs = await ensureDocs(pack, fetchFile).catch(() => []);
    const event: BoardEvent = { name: pack.name, files: [...docs.map(d => ({ path: d.path, note: false })), ...notePaths(pack).map(path => ({ path, note: true }))] };
    pi.events.emit(BOARD_EVENT, event);
  };

  registerBoardTools(pi, {
    flashed: recordFlash,
    downloadModeHint: () => pack?.buttons ? `The board is in download mode. ${pack.buttons}` : undefined,
  });

  pi.on("session_start", async (_event, ctx) => { restore(ctx); await refresh(ctx); void usePack(ctx); });
  pi.on("session_tree", async (_event, ctx) => { restore(ctx); await refresh(ctx); });

  pi.on("agent_start", () => { editedFirmware = false; nudged = false; sinceProgress = 0; steppedBack = false; });

  // Changes outside the project, and commands that permanently change a chip, need a person's yes.
  pi.on("tool_call", async (event, ctx) => {
    if (process.env.PI_LAB_GUARD === "off") return;
    const input = event.input as Record<string, unknown>;
    const verdict = event.toolName === "bash" && typeof input.command === "string" ? checkCommand(input.command, ctx.cwd)
      : (event.toolName === "edit" || event.toolName === "write") && typeof input.path === "string" ? checkWrite(input.path, ctx.cwd)
      : undefined;
    if (!verdict) return;
    if (ctx.hasUI) {
      const what = typeof input.command === "string" ? input.command : String(input.path);
      const title = verdict.hardware ? "pi-lab: irreversible chip operation" : "pi-lab: change outside the project";
      if (await ctx.ui.confirm(title, `${verdict.reason}\n\n${what}\n\nAllow it?`)) return;
    }
    return { block: true, reason: `pi-lab blocked this: ${verdict.reason}${ctx.hasUI ? " The user declined." : " Nobody is available to approve it."}` };
  });

  // Many tool calls without a new fact or a settled hypothesis: likely deep in the wrong direction.
  pi.on("turn_end", event => {
    sinceProgress += event.toolResults.length;
    if (sinceProgress < STEP_BACK_AFTER || steppedBack) return;
    steppedBack = true;
    return {
      entries: [...event.entries, {
        type: "custom_message", customType: STEP_BACK_TYPE, display: false,
        content: `pi-lab: ${sinceProgress} tool calls without a reproduced fact or a settled hypothesis. Step back before going deeper: restate the original symptom, re-read the code path that produces it from start to end, and write down the simplest explanation that fits everything observed so far. Record what you conclude with lab_ledger.`,
      }],
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "bash" && !event.isError && typeof event.input.command === "string" && isFlashCommand(event.input.command)) {
      await recordFlash(ctx, event.input.command);
      return;
    }
    const path = event.input.path;
    if ((event.toolName === "edit" || event.toolName === "write") && typeof path === "string" && isFirmwareFile(path)) {
      editedFirmware = true;
      await refresh(ctx);
    }
  });

  pi.on("context", event => {
    const messages = foldLogs(event.messages);
    return messages ? { messages } : undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await refresh(ctx);
    const state = renderLedger(ledger, describeFirmware(firmware));
    const board = pack ? describePack(pack, kbShelf
      ? `with this board's verified notes, on the knowledge base shelf "${kbShelf}" (kb_search)`
      : `in ${docsDir(pack)}, and verified notes in ${join(pack.dir, "notes")}`) : undefined;
    event.systemPromptOptions.sections.pi_lab = [...GUIDELINES, ...(board ? ["", board] : []), "", "Debug ledger:", state || "(empty: set the target and add what you know)"].join("\n");
  });

  // The agent changed firmware and is about to stop without flashing: whatever it concluded is untested on the board.
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed" || !editedFirmware || nudged || !flash) return;
    await refresh(ctx);
    if (firmware.kind !== "stale") return;
    nudged = true;
    return {
      entries: [...event.entries, {
        type: "custom_message", customType: NUDGE_TYPE, display: false,
        content: "pi-lab: you edited firmware sources after the last flash, so the board still runs the old image. If your reply presents a fix as working, either flash and verify it on the board, or tell the user plainly that it is not yet tested on hardware. Do not repeat your reply otherwise.",
      }],
      continue: true,
    };
  });

  pi.registerTool({
    name: "lab_ledger",
    label: "Lab Ledger",
    description:
      "Update the debug ledger for the hardware under test: set the target board, record what the hardware has shown (add_fact, then verify_fact once reproduced), and track hypotheses (open, testing, ruled_out, confirmed) with evidence. The ledger is shown to you every turn.",
    promptSnippet: "Record hardware facts and debugging hypotheses in the debug ledger",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("set_target"), Type.Literal("add_fact"), Type.Literal("verify_fact"), Type.Literal("add_hypothesis"), Type.Literal("update"), Type.Literal("remove"),
      ]),
      text: Type.Optional(Type.String({ description: "Target description (e.g. 'STM32F407 on /dev/ttyUSB0'), fact or hypothesis" })),
      id: Type.Optional(Type.String({ description: "Entry id for update, verify_fact or remove, e.g. H2 or F1" })),
      status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("testing"), Type.Literal("ruled_out"), Type.Literal("confirmed")])),
      evidence: Type.Optional(Type.String({ description: "What the hardware showed: a log line, register value or measurement. For verify_fact: how it was reproduced" })),
      force: Type.Optional(Type.Boolean({ description: "Add a hypothesis even though it resembles one already settled" })),
    }),
    async execute(_id, params) {
      const need = (value: string | undefined, name: string) => {
        if (!value?.trim()) throw new Error(`${params.action} needs ${name}.`);
        return value;
      };
      const act: LedgerAction =
        params.action === "set_target" ? { action: "set_target", text: params.text ?? "" }
        : params.action === "add_fact" ? { action: "add_fact", text: need(params.text, "text"), evidence: params.evidence }
        : params.action === "verify_fact" ? { action: "verify_fact", id: need(params.id, "id"), evidence: params.evidence }
        : params.action === "add_hypothesis" ? { action: "add_hypothesis", text: need(params.text, "text"), force: params.force }
        : params.action === "update" ? { action: "update", id: need(params.id, "id"), status: params.status, evidence: params.evidence }
        : { action: "remove", id: need(params.id, "id") };
      const result = update(act);
      return { content: [{ type: "text", text: `${result.message}\n\n${renderLedger(ledger) || "(ledger empty)"}` }], details: { ledger } };
    },
  });

  pi.registerCommand("lab", {
    description: "Debug ledger, firmware sync and board: [show | flashed | target <text> | clear | board [id | none]]",
    getArgumentCompletions: prefix => {
      const [first, second] = prefix.split(/\s+/);
      if (first === "board" && second !== undefined) return [...packs.map(p => p.id), "none"].filter(id => id.startsWith(second)).map(id => ({ value: `board ${id}`, label: id }));
      return ["show", "flashed", "target", "clear", "board"].filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      const [command = "show", ...rest] = args.trim().split(/\s+/);
      if (command === "board") {
        const id = rest[0];
        const root = projectRoot(ctx.cwd);
        if (!id) {
          const connected = new Set(candidates(packs, await usbIds(run(ctx.cwd)).catch(() => [])).map(p => p.id));
          const list = packs.map(p => `${p.id === pack?.id ? "●" : "○"} ${p.id}  ${p.name}${connected.has(p.id) ? "  (a matching device is connected)" : ""}`);
          ctx.ui.notify([`Board for ${root}: ${pack?.name ?? "none"}`, ...list, "Choose with /lab board <id>, or /lab board none."].join("\n"), "info");
          return;
        }
        if (id !== "none" && !packs.some(p => p.id === id)) { ctx.ui.notify(`No board pack "${id}". Known: ${packs.map(p => p.id).join(", ")}`, "warning"); return; }
        setProjectBoard(root, id === "none" ? undefined : id);
        await usePack(ctx);
        ctx.ui.notify(pack ? `Board for this project: ${pack.name} (saved in .pi/lab.json).` : "No board for this project.", "info");
        return;
      }
      if (command === "flashed") {
        // For flashes done outside pi: an IDE, a GUI programmer, another terminal.
        const ok = await recordFlash(ctx, "(marked by user)");
        ctx.ui.notify(ok ? "Marked: the board runs the current sources." : "Not a git work tree: pi-lab cannot fingerprint the sources.", ok ? "info" : "warning");
        return;
      }
      if (command === "target") {
        update({ action: "set_target", text: rest.join(" ") });
      } else if (command === "clear") {
        if (ctx.hasUI && !(await ctx.ui.confirm("Clear the debug ledger?", "Facts and hypotheses on this branch will be cleared."))) return;
        ledger = emptyLedger();
        pi.appendEntry(LEDGER_ENTRY, ledger);
      }
      await refresh(ctx);
      const text = renderLedger(ledger, describeFirmware(firmware));
      ctx.ui.notify(isEmpty(ledger) && !text ? "Debug ledger is empty." : text, "info");
    },
  });
}
