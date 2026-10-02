// The board panel on the pi-web page (/lab/): the board's serial output live, a plot of the numbers it prints,
// reset and pause, and "ask pi" about the lines the user selects.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readFile as readBytes } from "node:fs/promises";
import { basename, join } from "node:path";
import type { BoardAccess } from "./board-tools.ts";
import { type BoardPack, docsDir } from "./boards.ts";
import { type WebApp, webError, type WebLanguage, type WebRequest } from "./hub.ts";
import { BAUDS } from "./project-config.ts";
import type { LogLine } from "./serial-hub.ts";

export interface PanelSession {
  /** The board pack's name, and whether the board runs the code on disk. */
  status(): { board?: string; firmware?: "unknown" | "never" | "synced" | "stale" };
  /** Send a prompt to the agent, queued after the current turn when it is busy. */
  ask(prompt: string): void;
  /** The board packs, which match a connected device, the one chosen for the project, and pi-kb's shelf for it. */
  boards(): Promise<{ packs: BoardPack[]; connected: string[]; current?: BoardPack; kbShelf?: string; kbInstalled: boolean }>;
  /** Choose the project's board pack (undefined: none). */
  chooseBoard(id: string | undefined): Promise<void>;
}

const PAGE = fileURLToPath(new URL("../web/lab.html", import.meta.url));
/** Lines sent at most per response; the page asks again for the rest. */
const BATCH = 2000;

export class LabApp implements WebApp {
  readonly id = "lab";
  readonly order = 40;
  readonly title: Record<WebLanguage, string> = { zh: "板子", en: "Board" };
  readonly languages: WebLanguage[] = ["zh", "en"];
  session?: PanelSession;
  private paused?: () => void;
  private readonly board: BoardAccess;

  constructor(board: BoardAccess) {
    this.board = board;
  }

  page(): Promise<string> {
    return readFile(PAGE, "utf8");
  }

  async handle(req: WebRequest): Promise<unknown> {
    const hub = await this.board.hub();
    const route = `${req.method} ${req.path}`;
    // The board pack panel: works without a board connected.
    if (route === "GET /board") {
      if (!this.session) throw webError(503, "pi is not ready / pi 还没准备好");
      const b = await this.session.boards();
      const brief = (p: BoardPack) => ({ id: p.id, name: p.name, vendor: p.vendor, chip: p.chip, connected: b.connected.includes(p.id) });
      const current = b.current && {
        ...brief(b.current), url: b.current.url, console: b.current.console, sources: b.current.sources, buses: b.current.buses ?? [],
        pins: b.current.pins ?? [], buttons: b.current.buttons, quirks: b.current.quirks ?? [],
        docs: (b.current.docs ?? []).map(d => ({ title: d.title, file: d.file, url: d.url })),
        notes: (b.current.notes ?? []).map(n => ({ file: basename(n), title: noteTitle(b.current!, n) })),
      };
      return { packs: b.packs.map(brief), current: current ?? null, kbShelf: b.kbShelf ?? null, kbInstalled: b.kbInstalled };
    }
    if (route === "POST /board") {
      if (!this.session) throw webError(503, "pi is not ready / pi 还没准备好");
      const body = await req.json();
      await this.session.chooseBoard(typeof body.id === "string" && body.id ? body.id : undefined);
      return { ok: true };
    }
    if (route === "GET /board/note" || route === "GET /board/doc") {
      const current = (await this.session?.boards())?.current;
      const name = req.query.get("file") ?? "";
      if (!current) throw webError(404, "No board chosen / 还没选板卡");
      if (route === "GET /board/note") {
        const note = (current.notes ?? []).find(n => basename(n) === name);
        if (!note) throw webError(404, "No such note / 没有这篇笔记");
        return { text: await readFile(join(current.dir, note), "utf8") };
      }
      const doc = (current.docs ?? []).find(d => d.file === name);
      if (!doc) throw webError(404, "No such datasheet / 没有这份手册");
      try {
        return { binary: await readBytes(join(docsDir(current), doc.file)), type: "application/pdf", filename: doc.file };
      } catch {
        throw webError(404, "The datasheet has not been downloaded yet / 手册还没下载");
      }
    }
    if (route === "GET /state") {
      const serial = this.board.serial();
      return { port: hub?.port, baud: hub?.baud ?? serial.baud, state: hub ? (this.paused ? "paused" : hub.state) : "no-board", detail: hub?.detail,
        serial: { chosen: serial.port ?? null, ports: serial.ports, bauds: BAUDS }, ...this.session?.status() };
    }
    if (route === "POST /select") {
      const body = await req.json();
      const baud = body.baud === undefined ? undefined : Number(body.baud);
      if (baud !== undefined && !(baud >= 300 && baud <= 10_000_000)) throw webError(400, "Invalid baud rate / 波特率无效");
      this.paused?.();
      this.paused = undefined;
      await this.board.select({ port: body.port === undefined ? undefined : body.port || null, baud });
      const next = await this.board.hub();
      next?.mark(`serial: ${next.port} at ${next.baud} baud`);
      next?.viewed();
      return { ok: true };
    }
    if (!hub) throw webError(404, "No board connected / 没有连接板子");

    if (route === "GET /lines") {
      // Long poll: answer as soon as there is something after `since`, or after about 20 s.
      if (!this.paused) hub.viewed();
      const since = Number(req.query.get("since") ?? 0);
      const lines = since > 0 && req.query.has("wait") ? await hub.wait(since, 20_000, req.signal) : hub.since(since);
      // First load: only the most recent lines.
      const sent = since === 0 ? lines.slice(-BATCH) : lines.slice(0, BATCH);
      return { lines: sent, last: hub.lastN, state: this.paused ? "paused" : hub.state };
    }
    if (route === "POST /reset") {
      if (this.paused) throw webError(409, "Resume the port first / 请先恢复串口");
      const from = hub.lastN;
      await hub.hold(async () => {
        await hub.reset();
        await hub.recoverStalledBoot(from);
      });
      return { ok: true };
    }
    if (route === "POST /recover") {
      hub.mark("USB re-enumeration asked for from the panel");
      return { result: await this.board.reenumerate() };
    }
    if (route === "POST /pause") {
      // Let the user's own tools open the port until they resume.
      this.paused ??= await hub.lend();
      hub.mark("port released for other programs");
      return { ok: true };
    }
    if (route === "POST /resume") {
      this.paused?.();
      this.paused = undefined;
      hub.viewed();
      hub.mark("port taken back");
      return { ok: true };
    }
    if (route === "POST /ask") {
      const body = await req.json();
      const numbers = new Set<number>((Array.isArray(body.lines) ? body.lines : []).map(Number));
      const picked = hub.since(0).filter(l => numbers.has(l.n));
      if (!picked.length) throw webError(400, "Select some lines first / 请先选中几行日志");
      if (!this.session) throw webError(503, "pi is not ready / pi 还没准备好");
      this.session.ask(askPrompt(picked, String(body.question ?? "").trim(), hub.port));
      return { ok: true };
    }
    throw webError(404, `Unknown ${route}`);
  }
}

/** The prompt for "ask pi": the selected lines with their times and what is around them. */
export function askPrompt(lines: LogLine[], question: string, port: string): string {
  const time = (ts: number) => new Date(ts).toISOString().slice(11, 23);
  const body = lines.map(l => `${time(l.ts)}  ${l.kind === "mark" ? `[pi-lab: ${l.text}]` : l.text}`).join("\n");
  return [
    `From the board panel: I selected ${lines.length} line${lines.length > 1 ? "s" : ""} of the serial log on ${port} (time, then text):`,
    "```",
    body,
    "```",
    question || "What does this mean? If it shows a problem, find the cause.",
  ].join("\n");
}

/** A note's title from its front matter, else its file name. */
function noteTitle(pack: BoardPack, note: string): string {
  try {
    const text = readFileSync(join(pack.dir, note), "utf8");
    return /^title:\s*"?(.*?)"?\s*$/m.exec(text)?.[1] ?? basename(note);
  } catch {
    return basename(note);
  }
}
