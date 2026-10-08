import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Type } from "typebox";
import { compare, describeFirmware, FLASH_ENTRY, type FirmwareState, firmwareStatus, type FlashRecord, isFirmwareFile, isFlashCommand, sourceState, usesPort } from "./src/firmware.ts";
import { findPorts, usbIds } from "./src/board.ts";
import { BAUDS, readLabConfig } from "./src/project-config.ts";
import { registerBoardTools } from "./src/board-tools.ts";
import { BOARD_EVENT, type BoardEvent, type BoardPack, candidates, describePack, docsDir, ensureDocs, loadPacks, notePaths, projectBoard, setProjectBoard } from "./src/boards.ts";
import { foldLogs } from "./src/fold.ts";
import { checkCommand, checkWrite } from "./src/guard.ts";
import { sharedHub } from "./src/hub.ts";
import { LabApp } from "./src/web.ts";
import { applyAction, emptyLedger, isEmpty, LEDGER_ENTRY, type Ledger, type LedgerAction, renderLedger } from "./src/ledger.ts";
import { type ExperimentRecord, NOTES_EVENT, noteFiles, type NotesEvent, oneLine, settled } from "./src/experiment.ts";
import { CAREFUL_GUIDELINES, carefulMessage, CORE_GUIDELINES, escalation, type Mode, PROCESS_ENTRY, type ProcessRecord } from "./src/process.ts";
import { labSummary, checks as runChecks } from "./src/lab-actions.ts";

const NUDGE_TYPE = "pi-lab.stale-nudge";
const STEP_BACK_TYPE = "pi-lab.step-back";
/** Tool calls without settling anything before the agent is asked to step back. */
const STEP_BACK_AFTER = 30;
/** What pyserial and the OS say when two programs have the board's port open. */
const PORT_CONFLICT = /multiple access on port|Resource busy|could not open port|\[Errno 16\]/i;

export default function piLab(pi: ExtensionAPI): void {
  let ledger: Ledger = emptyLedger();
  let flash: FlashRecord | undefined;
  let firmware: FirmwareState = { kind: "unknown" };
  let editedFirmware = false, nudged = false;
  let sinceProgress = 0, steppedBack = false;
  // Light until the problem resists (see src/process.ts); the counters are for the current task.
  let mode: Mode = "light", modeReason: string | undefined;
  let callsThisTask = 0, flashesThisTask = 0, unsettledThisTask = false, ledgerUsedThisTask = false;
  const PROCESS_TYPE = "pi-lab.careful";

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
    const recorded = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === PROCESS_ENTRY).at(-1);
    const data = recorded?.type === "custom" ? recorded.data as ProcessRecord | undefined : undefined;
    mode = data?.mode ?? "light";
    modeReason = data?.reason;
  };
  const setMode = (next: Mode, reason?: string) => {
    mode = next;
    modeReason = reason;
    pi.appendEntry(PROCESS_ENTRY, { mode, reason } satisfies ProcessRecord);
  };
  const careful = () => mode === "careful" || readLabConfig(projectRoot(projectDir)).process === "careful";

  const refresh = async (ctx: ExtensionContext) => {
    firmware = compare(flash, await sourceState(run(ctx.cwd)).catch(() => undefined));
    if (ctx.hasUI) ctx.ui.setStatus("pi-lab", firmwareStatus(firmware));
  };

  const recordFlash = async (ctx: ExtensionContext, command: string) => {
    const now = await sourceState(run(ctx.cwd)).catch(() => undefined);
    if (!now) return false;
    flash = { at: Date.now(), command, ...now };
    pi.appendEntry(FLASH_ENTRY, flash);
    if (command !== "(marked by user)") flashesThisTask++;
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
  let kbSeen = false;
  pi.events?.on("pi-kb:board-shelf", data => { kbShelf = (data as { shelf?: string }).shelf; kbSeen = true; });
  // The project's experiment notes go to pi-kb too, so kb_search finds them; it mirrors them, following every
  // rewrite (a re-run that no longer matches marks one needs-review), and says where they went.
  let notesShelf: string | null | undefined;
  pi.events?.on("pi-kb:lab-notes", data => { notesShelf = (data as { shelf?: string | null }).shelf; kbSeen = true; });
  const announceNotes = (cwd: string) => {
    const root = projectRoot(cwd);
    const files = noteFiles(root);
    if (files.length) pi.events?.emit(NOTES_EVENT, { project: basename(root), root, files } satisfies NotesEvent);
  };

  let projectDir = process.cwd();
  const usePack = async (ctx: ExtensionContext) => {
    projectDir = ctx.cwd;
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
    pi.events?.emit(BOARD_EVENT, event);
  };

  // A settled experiment is a reproduced fact; one that did not settle means the problem is not simple.
  const experimented = (_ctx: ExtensionContext, record: ExperimentRecord): string | undefined => {
    if (!settled(record)) { unsettledThisTask = true; return undefined; }
    const added = update({ action: "add_fact", text: `${record.spec.question} → ${oneLine(record)}`, evidence: `board_experiment ${record.id}` });
    const fact = added.changed ? ledger.facts.at(-1) : undefined;
    if (!fact) return undefined;
    update({ action: "verify_fact", id: fact.id, evidence: `${record.id}: ${record.spec.repeat} runs per variant, shuffled, board reset before each, every variant consistent` });
    return `Recorded in the debug ledger as reproduced fact ${fact.id}.`;
  };

  const board_ = registerBoardTools(pi, {
    flashed: recordFlash,
    experimented,
    downloadModeHint: () => pack?.buttons ? `The board is in download mode. ${pack.buttons}` : undefined,
    cwd: () => projectDir,
    root: () => projectRoot(projectDir),
    boardName: () => pack?.name,
  });

  // The board panel on the shared pi-web page (/lab/), next to pi-kb's and pi-sessions' pages.
  const web = () => sharedHub(getAgentDir());
  const panel = new LabApp(board_);

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
    await refresh(ctx);
    void usePack(ctx);
    panel.session = {
      status: () => ({ board: pack?.name, firmware: firmware.kind }),
      ask: prompt => pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" }),
      boards: async () => ({
        packs,
        connected: candidates(packs, await usbIds(run(ctx.cwd)).catch(() => [])).map(p => p.id),
        current: pack,
        kbShelf,
        kbInstalled: kbSeen,
      }),
      root: () => projectRoot(ctx.cwd),
      chooseBoard: async id => {
        setProjectBoard(projectRoot(ctx.cwd), id);
        await usePack(ctx);
        // pi-kb answers the board event shortly; give it a moment so the page shows its shelf.
        for (let i = 0; i < 10 && pack && !kbShelf; i++) await new Promise(r => setTimeout(r, 200));
      },
    };
    // Mounted early (the server is not started) so the other pi-web pages link here.
    web().mount(panel);
    announceNotes(ctx.cwd);
  });

  pi.on("session_shutdown", async event => {
    panel.session = undefined;
    // Reload brings new code: leave the shared server (it stops once every page has left) and mount again later.
    if (event.reason === "quit" || event.reason === "reload") await web().unmount(panel.id);
  });
  pi.on("session_tree", async (_event, ctx) => { restore(ctx); await refresh(ctx); });

  pi.on("agent_start", () => {
    editedFirmware = false; nudged = false; sinceProgress = 0; steppedBack = false;
    callsThisTask = 0; flashesThisTask = 0; unsettledThisTask = false; ledgerUsedThisTask = false;
  });

  // A shell command that opens the board's port (a flasher, a monitor, a script) gets it: the hub lets go until the
  // command is done, so it never meets "port busy".
  const lentFor = new Map<string, (() => void)[]>();
  // Commands pi-lab did not recognize as opening the port, run while the hub had it open (the panel was watching, or
  // a capture was running): if one then fails to read the port, the agent is told it was the hub, not the board.
  const sharedFor = new Map<string, string[]>();
  /** Commands that met the hub on the port once: they get it from then on. */
  const conflicted = new Set<string>();
  const lendPort = async (toolCallId: string, toolName: string, input: Record<string, unknown>, cwd: string) => {
    if (toolName !== "bash" || typeof input.command !== "string") return;
    if (!usesPort(input.command, cwd) && !conflicted.has(input.command)) {
      const open = board_.hubs().filter(h => h.state === "open").map(h => h.port);
      if (open.length) sharedFor.set(toolCallId, open);
      return;
    }
    const giveBacks = await Promise.all(board_.hubs().map(h => h.lend()));
    if (giveBacks.length) lentFor.set(toolCallId, giveBacks);
  };

  // Changes outside the project, and commands that permanently change a chip, need a person's yes.
  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as Record<string, unknown>;
    if (process.env.PI_LAB_GUARD === "off") return lendPort(event.toolCallId, event.toolName, input, ctx.cwd);
    const verdict = event.toolName === "bash" && typeof input.command === "string" ? checkCommand(input.command, ctx.cwd)
      : (event.toolName === "edit" || event.toolName === "write") && typeof input.path === "string" ? checkWrite(input.path, ctx.cwd)
      : undefined;
    if (!verdict) return lendPort(event.toolCallId, event.toolName, input, ctx.cwd);
    if (ctx.hasUI) {
      const what = typeof input.command === "string" ? input.command : String(input.path);
      const title = verdict.hardware ? "pi-lab: irreversible chip operation" : "pi-lab: change outside the project";
      if (await ctx.ui.confirm(title, `${verdict.reason}\n\n${what}\n\nAllow it?`)) return lendPort(event.toolCallId, event.toolName, input, ctx.cwd);
    }
    return { block: true, reason: `pi-lab blocked this: ${verdict.reason}${ctx.hasUI ? " The user declined." : " Nobody is available to approve it."}` };
  });

  // Many tool calls without a new fact or a settled hypothesis: likely deep in the wrong direction.
  pi.on("turn_end", event => {
    sinceProgress += event.toolResults.length;
    callsThisTask += event.toolResults.length;
    // Light until the problem resists; then the ledger's rules, from this turn on.
    if (!careful()) {
      const reason = escalation({ toolCalls: callsThisTask, flashes: flashesThisTask, unsettled: unsettledThisTask, ledgerUsed: ledgerUsedThisTask });
      if (reason) {
        setMode("careful", reason);
        return { entries: [...event.entries, { type: "custom_message", customType: PROCESS_TYPE, display: false, content: carefulMessage(reason) }] };
      }
    }
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
    for (const giveBack of lentFor.get(event.toolCallId) ?? []) giveBack();
    lentFor.delete(event.toolCallId);
    const shared = sharedFor.get(event.toolCallId);
    sharedFor.delete(event.toolCallId);
    if (shared && event.toolName === "bash") {
      const output = event.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
      if (PORT_CONFLICT.test(output) && typeof event.input.command === "string") {
        conflicted.add(event.input.command);
        return { content: [...event.content, { type: "text" as const, text: `\n[pi-lab: pi-lab had ${shared.join(", ")} open (for the board panel or a capture) while this command ran, so the two shared the port. That, not the board, explains this error. Run it again: pi-lab now lets go of the port for this script.]` }] };
      }
    }
    if (event.toolName === "lab_note" || event.toolName === "board_experiment") announceNotes(ctx.cwd);
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
    const serial = board_.serial();
    const serialLine = serial.using ? `Serial: ${serial.using} at ${serial.baud} baud (the project's setting; the user can change it in the board panel).` : "Serial: no board connected.";
    const guidelines = careful() ? [...CORE_GUIDELINES, "", ...CAREFUL_GUIDELINES] : CORE_GUIDELINES;
    // Light mode shows the ledger only once it holds something (a settled experiment adds to it); careful mode always.
    const firmwareLine = describeFirmware(firmware);
    const ledgerPart = careful() || !isEmpty(ledger)
      ? ["", "Debug ledger:", state || "(empty: set the target and add what you know)"]
      : firmwareLine ? ["", `Firmware: ${firmwareLine}`] : [];
    const checkNames = (readLabConfig(projectRoot(ctx.cwd)).checks ?? []).map(c => c.name);
    const checksLine = checkNames.length ? [`Board checks (board_check): ${checkNames.join("; ")}.`] : [];
    // Experience recorded in this project: what was measured before, and which notes a later re-run put in doubt.
    const notes = labSummary(projectRoot(ctx.cwd)).notes;
    const doubtful = notes.filter(n => n.status === "needs-review").map(n => n.title);
    const notesLine = notes.length ? [`Experiment notes in .pi/lab/notes/ (${notes.length}${notesShelf ? `; in the knowledge base on the shelf "${notesShelf}"` : notesShelf === null ? "; in the project's knowledge base" : ""}): measured tables from earlier experiments, re-runnable with board_experiment rerun=<note>.${doubtful.length ? ` A re-run no longer matched, so do not rely on: ${doubtful.join("; ")}.` : ""}`] : [];
    event.systemPromptOptions.sections.pi_lab = [...guidelines, "", serialLine, ...checksLine, ...notesLine, ...(board ? ["", board] : []), ...ledgerPart].join("\n");
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
      ledgerUsedThisTask = true;
      const result = update(act);
      return { content: [{ type: "text", text: `${result.message}\n\n${renderLedger(ledger) || "(ledger empty)"}` }], details: { ledger } };
    },
  });

  pi.registerCommand("lab", {
    description: "Board panel, serial port, debug ledger, firmware sync, process, checks: [web [url | stop] | serial [port | auto | baud] | show | flashed | target <text> | clear | board [id | none] | careful | light | check [name]]",
    getArgumentCompletions: prefix => {
      const [first, second] = prefix.split(/\s+/);
      if (first === "board" && second !== undefined) return [...packs.map(p => p.id), "none"].filter(id => id.startsWith(second)).map(id => ({ value: `board ${id}`, label: id }));
      if (first === "web" && second !== undefined) return ["url", "stop"].filter(s => s.startsWith(second)).map(s => ({ value: `web ${s}`, label: s }));
      if (first === "serial" && second !== undefined) return [...findPorts(), "auto", ...BAUDS.map(String)].filter(s => s.startsWith(second)).map(s => ({ value: `serial ${s}`, label: s }));
      return ["web", "serial", "show", "flashed", "target", "clear", "board", "careful", "light", "check"].filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      const [command = "show", ...rest] = args.trim().split(/\s+/);
      if (command === "serial") {
        const arg = rest[0];
        if (arg) {
          if (/^\d+$/.test(arg)) await board_.select({ baud: Number(arg) });
          else if (arg === "auto") await board_.select({ port: null });
          else await board_.select({ port: arg });
        }
        const s = board_.serial();
        ctx.ui.notify([
          `Serial for this project: ${s.port ?? "the first board found"} at ${s.baud} baud${s.using ? ` (now ${s.using})` : ""}.`,
          `Ports: ${s.ports.join(", ") || "none"}`,
          "Change with /lab serial <port | auto | baud>, or in the board panel (/lab web).",
        ].join("\n"), "info");
        return;
      }
      if (command === "web") {
        if (rest[0] === "stop") { await web().close(); ctx.ui.notify("Stopped the pi-web page (shared with the other pi-web pages).", "info"); return; }
        web().mount(panel);
        await web().start();
        const url = web().url(panel.id) ?? "";
        if (rest[0] === "url") { ctx.ui.notify(url, "info"); return; }
        const [cmd, ...cmdArgs] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
        await pi.exec(cmd!, [...cmdArgs, url]).catch(() => undefined);
        ctx.ui.notify(`Board panel: ${url.replace(/#.*/, "")}`, "info");
        return;
      }
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
      if (command === "careful" || command === "light") {
        setMode(command, command === "careful" ? "chosen by the user" : undefined);
        const forced = readLabConfig(projectRoot(ctx.cwd)).process === "careful";
        ctx.ui.notify(command === "careful"
          ? "Careful mode: the agent keeps the debug ledger and reproduces facts before building on them."
          : `Light mode: no ledger bookkeeping until the problem resists${forced ? ' (but .pi/lab.json sets "process": "careful", which wins)' : ""}.`, "info");
        return;
      }
      if (command === "check") {
        const list = readLabConfig(projectRoot(ctx.cwd)).checks ?? [];
        if (!list.length) { ctx.ui.notify("No board checks in .pi/lab.json. Ask the agent to set them up with board_check (save=true), or add \"checks\" yourself.", "info"); return; }
        ctx.ui.notify(`Running ${rest[0] ? `"${rest.join(" ")}"` : `${list.length} board check(s)`}...`, "info");
        const r = await runChecks(board_, { names: rest.length ? [rest.join(" ")] : undefined }, { cwd: ctx.cwd, root: projectRoot(ctx.cwd), boardName: pack?.name }).catch(e => ({ text: (e as Error).message, results: [] }));
        ctx.ui.notify(r.text, r.results.every(x => x.pass) && r.results.length ? "info" : "warning");
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
        if (mode === "careful") setMode("light");
      }
      await refresh(ctx);
      const text = renderLedger(ledger, describeFirmware(firmware));
      ctx.ui.notify(isEmpty(ledger) && !text ? "Debug ledger is empty." : text, "info");
    },
  });
}
