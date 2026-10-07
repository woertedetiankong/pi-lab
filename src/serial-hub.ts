// One owner for the board's serial port inside pi: the web panel, board_serial and flashing share it through here.
// A Python helper (assets/serial_broker.py) holds the port; this keeps the numbered, timestamped lines it printed.
// The port is held only while someone needs it: a panel viewing it, or a capture in progress. Otherwise it is
// released, so the user's own tools can open it.

import { type ChildProcess, spawn } from "node:child_process";

export interface LogLine {
  n: number;
  /** ms since epoch */
  ts: number;
  text: string;
  /** "out": printed by the board; "mark": pi-lab's own marker (flash, reset); "decoded": a decoded crash. */
  kind: "out" | "mark" | "decoded";
}

export type PortState = "stopped" | "waiting" | "open" | "released";

export interface HubOptions {
  python: string;
  script: string;
  baud?: number;
  /** Extra arguments for the script (tests). */
  scriptArgs?: string[];
  port: string;
  /** Lines kept in memory. */
  keep?: number;
  /** Keep the port this long after the last look from a viewer (the web panel). */
  idleMs?: number;
  /** Software unplug and replug of the board's USB device, for a port that wedged. */
  recover?: () => Promise<unknown>;
  /** Lines to add after a line the board printed, e.g. a decoded crash backtrace. */
  annotate?: (line: LogLine) => Promise<string[]> | undefined;
}

type Waiter = { resolve: () => void };

/** Line numbers run on across hubs, so a page following one port keeps going after a switch to another port or baud. */
let nextLine = 1;

export class SerialHub {
  private lines: LogLine[] = [];

  private partial = "";
  private partialTimer?: NodeJS.Timeout;
  private child?: ChildProcess;
  private replies = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private cmdId = 1;
  private waiters: Waiter[] = [];
  private listeners: ((line: LogLine) => void)[] = [];
  private holds = 0;
  private annotating = new Set<Promise<unknown>>();
  /** Another program is using the port (a flasher, a monitor run through bash): do not take it back. */
  private suspended = 0;
  private lastViewer = 0;
  private idleTimer?: NodeJS.Timeout;
  state: PortState = "stopped";
  detail = "";

  private readonly opts: HubOptions;

  constructor(opts: HubOptions) {
    this.opts = opts;
  }

  get port() { return this.opts.port; }

  get baud() { return this.opts.baud ?? 115200; }

  /** Lines after `n` (0 for everything kept). */
  since(n: number): LogLine[] {
    const first = this.lines.findIndex(l => l.n > n);
    return first < 0 ? [] : this.lines.slice(first);
  }

  /** The last line number this hub has, or the last given out anywhere when it has none yet. */
  get lastN() { return this.lines.at(-1)?.n ?? nextLine - 1; }

  onLine(fn: (line: LogLine) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  }

  /** Wait until there are lines after `n`, or the time is up or the request goes away. */
  async wait(n: number, ms: number, signal?: AbortSignal): Promise<LogLine[]> {
    if ((this.lines.at(-1)?.n ?? 0) > n) return this.since(n);
    await new Promise<void>(resolve => {
      const waiter: Waiter = { resolve };
      const done = () => { clearTimeout(timer); this.waiters = this.waiters.filter(w => w !== waiter); resolve(); };
      waiter.resolve = done;
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      this.waiters.push(waiter);
    });
    return this.since(n);
  }

  /** A marker in the log, e.g. "flashed a3f2c1d". */
  mark(text: string, kind: LogLine["kind"] = "mark"): LogLine {
    this.flushPartial();
    return this.push(text, kind);
  }

  /** A viewer (the web panel) is watching: hold the port for a while. */
  viewed(): void {
    this.lastViewer = Date.now();
    this.ensure();
    void this.acquire();
  }

  /** Hold the port for the duration of `fn`. */
  async hold<T>(fn: () => Promise<T>): Promise<T> {
    this.holds++;
    try {
      this.ensure();
      await this.acquire();
      return await fn();
    } finally {
      this.holds--;
      // With no panel watching, nobody needs the port once the last capture or flash is done: let it go now. The
      // agent's next command is often a script of its own that opens the port, and pi-lab cannot always tell from
      // the command line; holding on would make the two share the port ("multiple access on port").
      if (!this.needed()) void this.release().catch(() => {});
      else this.scheduleIdle();
    }
  }

  /** A capture or flash holds the port, or a viewer looked at it recently. */
  private needed(): boolean {
    return this.holds > 0 || Date.now() - this.lastViewer < (this.opts.idleMs ?? 30_000);
  }

  async reset(): Promise<void> {
    if (this.suspended > 0) throw new Error(`${this.opts.port} is in use by another program (a flash or monitor is running)`);
    this.ensure();
    this.mark("reset");
    await this.command("reset");
  }

  /** Let another program (a flasher) use the port; nobody holds it until acquire(). */
  async release(): Promise<void> {
    if (!this.child) return;
    await this.command("release");
  }

  /** Release the port to another program until the returned function is called. */
  async lend(): Promise<() => void> {
    this.suspended++;
    await this.release().catch(() => {});
    let returned = false;
    return () => {
      if (returned) return;
      returned = true;
      this.suspended--;
      if (this.needed()) void this.acquire().catch(() => {});
    };
  }

  get lent() { return this.suspended > 0; }

  async acquire(): Promise<void> {
    if (this.suspended > 0) return;
    if (!this.child || (this.state !== "released" && this.state !== "stopped")) return;
    this.state = "waiting";
    await this.command("acquire");
  }

  /**
   * Capture what the board prints for `seconds`, optionally resetting it first and stopping early once a line
   * matches `until`. Returns the lines printed after the reset (or from now).
   */
  async capture(options: { seconds: number; reset?: boolean; until?: RegExp; signal?: AbortSignal }): Promise<LogLine[]> {
    return this.hold(async () => {
      const start = this.mark(options.reset === false ? "capture" : "capture after reset").n;
      if (options.reset !== false) {
        await this.reset();
        if (await this.recoverStalledBoot(start, options.signal)) this.mark("reset again after recovering the port");
      }
      const deadline = Date.now() + options.seconds * 1000;
      let seen = start;
      while (Date.now() < deadline && !options.signal?.aborted) {
        const fresh = await this.wait(seen, deadline - Date.now(), options.signal);
        if (fresh.length) seen = fresh[fresh.length - 1]!.n;
        if (options.until && fresh.some(l => l.kind === "out" && options.until!.test(l.text))) {
          await new Promise(r => setTimeout(r, 200));
          break;
        }
      }
      this.flushPartial();
      // Give decoding (a crash backtrace) a moment to land in what is returned.
      if (this.annotating.size) await Promise.race([Promise.all(this.annotating), new Promise(r => setTimeout(r, 4000))]);
      return this.since(start).filter(l => l.kind !== "mark" || !l.text.startsWith("capture"));
    });
  }

  stop(): void {
    clearTimeout(this.idleTimer);
    this.child?.kill();
    this.child = undefined;
    this.state = "stopped";
  }

  private ensure(): void {
    if (this.child) return;
    const child = spawn(this.opts.python, [this.opts.script, ...(this.opts.scriptArgs ?? []), "--port", this.opts.port, "--baud", String(this.baud)], { stdio: ["pipe", "pipe", "ignore"] });
    this.child = child;
    this.state = "waiting";
    let buf = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { this.event(JSON.parse(line)); } catch {}
      }
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.state = "stopped";
      for (const r of this.replies.values()) r.reject(new Error("serial helper stopped"));
      this.replies.clear();
    });
    this.scheduleIdle();
  }

  private command(cmd: string): Promise<void> {
    const child = this.child;
    if (!child?.stdin) return Promise.reject(new Error("serial helper not running"));
    const id = this.cmdId++;
    return new Promise((resolve, reject) => {
      this.replies.set(id, { resolve, reject });
      child.stdin!.write(JSON.stringify({ id, cmd }) + "\n");
    });
  }

  private event(e: { t: string; text?: string; state?: PortState; detail?: string; id?: number; message?: string }): void {
    if (e.t === "data" && e.text) this.data(e.text);
    else if (e.t === "state" && e.state) { this.state = e.state; this.detail = e.detail ?? ""; }
    else if ((e.t === "ok" || e.t === "error") && e.id !== undefined) {
      const reply = this.replies.get(e.id);
      this.replies.delete(e.id);
      if (e.t === "ok") reply?.resolve(); else reply?.reject(new Error(e.message ?? "serial helper error"));
    }
  }

  private data(text: string): void {
    const parts = (this.partial + text).replace(/\r\n?/g, "\n").split("\n");
    this.partial = parts.pop()!;
    for (const line of parts) this.push(line, "out");
    // A line without its newline yet (a prompt, a crash mid-print) still shows up after a moment.
    clearTimeout(this.partialTimer);
    if (this.partial) this.partialTimer = setTimeout(() => this.flushPartial(), 300);
  }

  private flushPartial(): void {
    clearTimeout(this.partialTimer);
    if (!this.partial) return;
    const text = this.partial;
    this.partial = "";
    this.push(text, "out");
  }

  private push(text: string, kind: LogLine["kind"]): LogLine {
    // ESP-IDF colours its log lines; the colours are noise for the model and the page colours by level itself.
    const line: LogLine = { n: nextLine++, ts: Date.now(), text: text.replace(/\x1b\[[0-9;]*m/g, ""), kind };
    this.lines.push(line);
    const keep = this.opts.keep ?? 20_000;
    if (this.lines.length > keep) this.lines.splice(0, this.lines.length - keep);
    for (const fn of this.listeners) { try { fn(line); } catch {} }
    if (kind === "out" && this.opts.annotate) {
      const pending = this.opts.annotate(line);
      if (pending) {
        const done = pending.then(texts => { for (const t of texts) this.push(t, "decoded"); }, () => {}).finally(() => this.annotating.delete(done));
        this.annotating.add(done);
      }
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve();
    return line;
  }

  /**
   * After a reset: if the log stops at the hand-off from ESP-IDF's bootloader to the app, the USB port wedged as the app
   * took it over (seen on the ESP32-S3's native USB). Re-enumerate it and reset once more. True when it recovered.
   */
  async recoverStalledBoot(from: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.opts.recover) return false;
    const handoff = /boot: Loaded app|Disabling RNG early entropy source/;
    const deadline = Date.now() + 5000;
    let at: number | undefined;
    while (!signal?.aborted && Date.now() < deadline && at === undefined) {
      const fresh = await this.wait(this.since(from).at(-1)?.n ?? from, deadline - Date.now(), signal);
      at = fresh.find(l => l.kind === "out" && handoff.test(l.text))?.n;
    }
    if (at === undefined) return false;
    if (this.lastN > at || (await this.wait(at, 2500, signal)).length > 0 || signal?.aborted) return false;
    this.mark("the USB port stopped at the bootloader's hand-off to the app; re-enumerating it");
    await this.opts.recover();
    await this.reset();
    return true;
  }

  /** Release the port once the panel has stopped looking at it. */
  private scheduleIdle(): void {
    clearTimeout(this.idleTimer);
    const idle = this.opts.idleMs ?? 30_000;
    this.idleTimer = setTimeout(() => {
      if (!this.needed()) { void this.release().catch(() => {}); return; }
      this.scheduleIdle();
    }, Math.min(idle, 5000));
    this.idleTimer.unref();
  }
}
