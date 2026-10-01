// The board panel on the pi-web page (/lab/): the board's serial output live, a plot of the numbers it prints,
// reset and pause, and "ask pi" about the lines the user selects.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { BoardAccess } from "./board-tools.ts";
import { type WebApp, webError, type WebLanguage, type WebRequest } from "./hub.ts";
import type { LogLine } from "./serial-hub.ts";

export interface PanelSession {
  /** The board pack's name, and whether the board runs the code on disk. */
  status(): { board?: string; firmware?: "unknown" | "never" | "synced" | "stale" };
  /** Send a prompt to the agent, queued after the current turn when it is busy. */
  ask(prompt: string): void;
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
    if (route === "GET /state") {
      return { port: hub?.port, state: hub ? (this.paused ? "paused" : hub.state) : "no-board", detail: hub?.detail, ...this.session?.status() };
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
