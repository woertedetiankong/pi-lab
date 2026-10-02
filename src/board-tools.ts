// The board_flash, board_serial and board_recover tools.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { buildErrors, findPorts, flashFailure, projectKind, type Run, serialPython, shellQuote, toolchainPrefix } from "./board.ts";
import { crashAddresses, elfInfo, formatFrames } from "./crash.ts";
import { foldText } from "./fold.ts";
import { DEFAULT_BAUD, readLabConfig, updateLabConfig } from "./project-config.ts";
import { type LogLine, SerialHub } from "./serial-hub.ts";

const assets = fileURLToPath(new URL("../assets/", import.meta.url));
const SERIAL_FOLD = { keepRecent: 0, minLines: 150, head: 25, tail: 40, notable: 60 };

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export interface SerialChoice {
  /** The port to use; undefined means the first board found. */
  port?: string;
  baud: number;
}

export interface BoardAccess {
  /** The serial hub for a port (the chosen one, else the first board found); undefined without a board or pyserial. */
  hub(port?: string): Promise<SerialHub | undefined>;
  /** The project's port and baud, and the ports connected now. */
  serial(): SerialChoice & { ports: string[]; using?: string };
  /** Change the port (null: back to the first board found) and baud, for this project. */
  select(choice: { port?: string | null; baud?: number }): Promise<void>;
  /** Hubs started so far. */
  hubs(): SerialHub[];
  reenumerate(): Promise<string>;
}

/** Text received at the wrong baud rate: mostly replacement characters and control bytes. */
export function looksGarbled(lines: LogLine[]): boolean {
  const text = lines.filter(l => l.kind === "out").map(l => l.text).join("");
  if (text.length < 24) return false;
  const bad = [...text].filter(c => c === "\uFFFD" || (c < " " && c !== "\t")).length;
  return bad / text.length > 0.2;
}

/** Lines as the model reads them: pi-lab's markers in brackets. */
export const logText = (lines: LogLine[]) => lines.map(l => (l.kind === "mark" ? `[pi-lab: ${l.text}]` : l.text)).join("\n");

export function registerBoardTools(pi: ExtensionAPI, hooks: {
  flashed: (ctx: ExtensionContext, command: string) => Promise<unknown>;
  /** What to tell the model when the chip keeps booting into its download mode. */
  downloadModeHint?: () => string | undefined;
  /** The project directory, for its build output (crash decoding). */
  cwd: () => string;
  /** The project root, where .pi/lab.json keeps the serial port and baud. */
  root: () => string;
}): BoardAccess {
  const run: Run = async (command, args, options) => {
    const r = await pi.exec(command, args, { cwd: options?.cwd, timeout: options?.timeout });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
  };
  const shell = (script: string, cwd: string, timeout: number) => run("bash", ["-c", script], { cwd, timeout });

  let python: string | undefined;
  const serialTool = async () => {
    python ??= await serialPython(run);
    return python;
  };

  const choice = (): SerialChoice => {
    const saved = readLabConfig(hooks.root()).serial ?? {};
    return { port: saved.port, baud: saved.baud && saved.baud > 0 ? saved.baud : DEFAULT_BAUD };
  };
  const choosePort = (requested?: string) => {
    if (requested) return requested;
    const ports = findPorts();
    // A chosen port that is not connected now (its name changes with the USB socket) falls back to the first found.
    const chosen = choice().port;
    if (chosen && ports.includes(chosen)) return chosen;
    if (!ports.length) throw new Error("No board found: no USB serial port is connected. Ask the user to plug the board in.");
    return ports[0]!;
  };

  // A crash line's code addresses, as functions and source lines. A crash loop repeats the same addresses: decode once.
  const decoded = new Map<string, Promise<string[]>>();
  const decodeCrash = (line: LogLine): Promise<string[]> | undefined => {
    const addresses = crashAddresses(line.text);
    if (!addresses?.length) return undefined;
    const dir = hooks.cwd();
    const info = elfInfo(dir);
    if (!info) return undefined;
    const key = `${info.elf}|${addresses.join(" ")}`;
    let result = decoded.get(key);
    if (!result) {
      result = shell(`${toolchainPrefix("esp-idf")}${info.addr2line} -pfiaC -e ${shellQuote(info.elf)} ${addresses.join(" ")}`, dir, 30_000)
        .then(r => r.code === 0 ? formatFrames(r.stdout, dir).map(f => `↳ ${f}`) : []);
      decoded.set(key, result);
    }
    return result;
  };

  const hubs = new Map<string, SerialHub>();
  const hubFor = async (requested?: string): Promise<SerialHub | undefined> => {
    let port: string;
    try { port = choosePort(requested); } catch { return undefined; }
    const baud = choice().baud;
    const existing = hubs.get(port);
    if (existing && existing.baud === baud) return existing;
    if (existing) { existing.stop(); hubs.delete(port); }
    const py = await serialTool();
    if (!py) return undefined;
    const hub = new SerialHub({ python: py, script: join(assets, "serial_broker.py"), port, baud, recover: reenumerate, annotate: decodeCrash });
    hubs.set(port, hub);
    return hub;
  };
  const needHub = async (requested?: string) => {
    const hub = await hubFor(requested);
    if (hub) return hub;
    choosePort(requested);
    throw new Error("No Python with pyserial found (looked in ESP-IDF's and PlatformIO's environments and python3).");
  };
  pi.on("session_shutdown", () => { for (const h of hubs.values()) h.stop(); hubs.clear(); });

  /** Software unplug and replug of the board's USB device (macOS). */
  const reenumerate = async (): Promise<string> => {
    if (process.platform !== "darwin") return "Automatic USB recovery is only available on macOS. Ask the user to unplug the board and plug it back in.";
    const bin = join(homedir(), ".pi", "agent", "pi-lab", "bin", "usb_reenumerate");
    if (!existsSync(bin)) {
      mkdirSync(join(bin, ".."), { recursive: true });
      const built = await run("xcrun", ["clang", "-O2", "-o", bin, join(assets, "usb_reenumerate.c"), "-framework", "IOKit", "-framework", "CoreFoundation"], { timeout: 60_000 });
      if (built.code !== 0) return `Could not build the USB recovery helper: ${built.stderr.slice(-300)}`;
    }
    const r = await run(bin, [], { timeout: 15_000 });
    await new Promise(resolve => setTimeout(resolve, 4000));
    return r.stdout.includes("re-enumerate -> 0") ? "re-enumerated" : `re-enumeration did not succeed: ${r.stdout.trim()}`;
  };

  pi.registerTool({
    name: "board_serial",
    label: "Board Serial",
    description:
      "Read the board's serial output. By default resets the board first and captures from the first boot line, for the given number of seconds or until a line matches `until`. Use this instead of `idf.py monitor` or `pio device monitor`, which never exit.",
    promptSnippet: "Reset the board and read its serial log",
    parameters: Type.Object({
      seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 120, description: "How long to capture (default 8)" })),
      reset: Type.Optional(Type.Boolean({ description: "Reset the board first (default true). false reads what it prints now" })),
      until: Type.Optional(Type.String({ description: "Stop early once a line matches this regular expression, e.g. 'Guru Meditation|boot_count='" })),
      port: Type.Optional(Type.String({ description: "Serial port; the project's chosen port, or found automatically, when left out" })),
      baud: Type.Optional(Type.Integer({ minimum: 300, description: "Baud rate, when the firmware's differs from the project's setting (saved for the project). Native USB ports (ESP32-S3, ESP32-C3 USB-Serial/JTAG) ignore it" })),
    }),
    async execute(_id, params, signal) {
      if (params.baud && params.baud !== choice().baud) await select({ baud: params.baud });
      const hub = await needHub(params.port);
      const seconds = params.seconds ?? 8;
      const options = { seconds, reset: params.reset !== false, until: params.until ? new RegExp(params.until) : undefined, signal };
      let lines = await hub.capture(options);
      let note = "";
      const printed = () => lines.some(l => l.kind === "out" && l.text.trim());
      if (!printed() && options.reset) {
        // A wedged USB port prints nothing at all, not even the ROM's boot banner.
        const recovered = await reenumerate();
        lines = await hub.capture(options);
        note = `\n[pi-lab: the board printed nothing; USB ${recovered}${printed() ? ", then it answered" : ", still silent"}.]`;
      }
      if (!printed()) return text(`No output from ${hub.port} in ${seconds} s${note || " (without a reset the firmware may simply be quiet)"}.`);
      const log = logText(lines);
      if (/waiting for download/.test(log)) {
        note += `\n[pi-lab: ${hooks.downloadModeHint?.() ?? "The chip booted into its download mode (boot strap held low), so the firmware did not run. Ask the user to reset the board normally."}]`;
      }
      const file = join(tmpdir(), "pi-lab", `serial-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, log);
      const shown = foldText(log, SERIAL_FOLD) ?? log;
      if (looksGarbled(lines)) note += `\n[pi-lab: most of this is unreadable: the baud rate (${hub.baud}) probably does not match the firmware's. Try the firmware's rate with the baud parameter.]`;
      return text(`Serial log from ${hub.port} at ${hub.baud} baud (${options.reset ? "after reset" : "no reset"}, ${lines.length} lines, full log in ${file}):${note}\n${shown}`);
    },
  });

  pi.registerTool({
    name: "board_flash",
    label: "Board Flash",
    description:
      "Build the firmware and flash it to the board, then reset the board so it runs. Works for ESP-IDF and PlatformIO projects in the working directory, sets up the toolchain environment itself, and recovers a USB port that stopped responding. Returns compiler errors when the build fails.",
    promptSnippet: "Build and flash the firmware to the board",
    parameters: Type.Object({
      build: Type.Optional(Type.Boolean({ description: "Build before flashing (default true)" })),
      port: Type.Optional(Type.String({ description: "Serial port; found automatically when left out" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const kind = projectKind(ctx.cwd);
      if (!kind) throw new Error("The working directory is not an ESP-IDF or PlatformIO project; flash with the project's own command through bash.");
      const port = choosePort(params.port);
      const prefix = toolchainPrefix(kind);

      const hub = await hubFor(port);
      if (kind === "platformio") {
        const giveBack = await hub?.lend();
        try {
          const r = await shell(`pio run -t upload --upload-port ${shellQuote(port)} 2>&1`, ctx.cwd, 15 * 60_000);
          if (r.code !== 0) return text(`Upload failed:\n${buildErrors(r.stdout) || r.stdout.slice(-3000)}`);
        } finally { giveBack?.(); }
        hub?.mark("flashed (PlatformIO upload)");
        await hooks.flashed(ctx, "board_flash");
        return text(`Built and uploaded to ${port}. Use board_serial to read its output.`);
      }

      if (params.build !== false) {
        const b = await shell(`${prefix}idf.py build 2>&1`, ctx.cwd, 15 * 60_000);
        if (b.code !== 0) return text(`Build failed:\n${buildErrors(b.stdout) || b.stdout.slice(-3000)}`);
      }
      // Stay in the bootloader after writing: an RTS reset straight after flashing can wedge native USB ports.
      // The reset below waits for the port to settle first.
      const flash = () => shell(
        `${prefix}cd build && python -m esptool --chip auto -p ${shellQuote(port)} -b 460800 --before default-reset --after no-reset write-flash @flash_args 2>&1`,
        ctx.cwd, 5 * 60_000);
      const giveBack = await hub?.lend();
      let f, note = "";
      try {
        f = await flash();
        if (f.code !== 0 && flashFailure(f.stdout) === "no-connect") {
          note = ` (the USB port had stopped responding; ${await reenumerate()} and retried)`;
          f = await flash();
        }
      } finally { giveBack?.(); }
      if (f.code !== 0) {
        const why = flashFailure(f.stdout);
        const hint = why === "port-busy" ? "Another program has the port open (a serial monitor?). Close it and try again."
          : why === "no-connect" ? "The board does not answer. Ask the user to unplug it and plug it back in."
          : "";
        return text(`Flashing failed${note}. ${hint}\n${f.stdout.slice(-2000)}`);
      }
      const written = f.stdout.match(/Wrote \d+ bytes[^\n]*/g)?.pop() ?? "";
      hub?.mark(`flashed${written ? `: ${written}` : ""}`);
      if (hub) {
        const from = hub.lastN;
        await hub.hold(async () => {
          await hub.reset();
          if (await hub.recoverStalledBoot(from)) note += " (the USB port wedged as the new firmware started; pi-lab re-enumerated it and reset again)";
        });
      }
      await hooks.flashed(ctx, "board_flash");
      return text(`Flashed ${port}${note}. ${written}\nThe board was reset and runs the new firmware; read it with board_serial.`);
    },
  });

  pi.registerTool({
    name: "board_recover",
    label: "Board Recover",
    description: "Recover a board whose USB port stopped responding (esptool says 'No serial data received', or the serial log is empty): a software unplug and replug of the USB device.",
    promptSnippet: "Recover a board whose USB port stopped responding",
    parameters: Type.Object({}),
    async execute() {
      const result = await reenumerate();
      const ports = findPorts();
      return text(`USB ${result}. Ports now: ${ports.join(", ") || "none"}.`);
    },
  });

  const serial = () => {
    const ports = findPorts();
    let using: string | undefined;
    try { using = choosePort(); } catch {}
    return { ...choice(), ports, using };
  };
  const select = async (next: { port?: string | null; baud?: number }) => {
    const current = choice();
    const port = next.port === null ? undefined : next.port ?? current.port;
    const baud = next.baud && next.baud > 0 ? Math.round(next.baud) : current.baud;
    const saved = { ...(port ? { port } : {}), ...(baud !== DEFAULT_BAUD ? { baud } : {}) };
    updateLabConfig(hooks.root(), { serial: Object.keys(saved).length ? saved : undefined });
    // Hubs on other ports or at the old baud are not wanted any more; the next use opens the right one.
    for (const [p, hub] of hubs) if (p !== (port ?? serial().using) || hub.baud !== baud) { hub.stop(); hubs.delete(p); }
  };

  return { hub: hubFor, hubs: () => [...hubs.values()], reenumerate, serial, select };
}
