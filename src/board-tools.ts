// The board_flash, board_serial and board_recover tools.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { buildErrors, findPorts, flashFailure, projectKind, type Run, serialPython, shellQuote, toolchainPrefix } from "./board.ts";
import { foldText } from "./fold.ts";

const assets = fileURLToPath(new URL("../assets/", import.meta.url));
const SERIAL_FOLD = { keepRecent: 0, minLines: 150, head: 25, tail: 40, notable: 60 };

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export function registerBoardTools(pi: ExtensionAPI, hooks: {
  flashed: (ctx: ExtensionContext, command: string) => Promise<unknown>;
  /** What to tell the model when the chip keeps booting into its download mode. */
  downloadModeHint?: () => string | undefined;
}): void {
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

  const choosePort = (requested?: string) => {
    if (requested) return requested;
    const ports = findPorts();
    if (!ports.length) throw new Error("No board found: no USB serial port is connected. Ask the user to plug the board in.");
    return ports[0]!;
  };

  const capture = async (port: string, args: string[], seconds: number) => {
    const py = await serialTool();
    if (!py) throw new Error("No Python with pyserial found (looked in ESP-IDF's and PlatformIO's environments and python3).");
    const r = await run(py, [join(assets, "serial_capture.py"), "--port", port, "--seconds", String(seconds), ...args], { timeout: (seconds + 30) * 1000 });
    return r.stdout;
  };

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
      port: Type.Optional(Type.String({ description: "Serial port; found automatically when left out" })),
    }),
    async execute(_id, params) {
      const port = choosePort(params.port);
      const seconds = params.seconds ?? 8;
      const args = [...(params.reset === false ? ["--no-reset"] : []), ...(params.until ? ["--until", params.until] : [])];
      let log = await capture(port, args, seconds);
      let note = "";
      if (!log.trim() && params.reset !== false) {
        // A wedged USB port prints nothing at all, not even the ROM's boot banner.
        const recovered = await reenumerate();
        log = await capture(choosePort(params.port), args, seconds);
        note = `\n[pi-lab: the board printed nothing; USB ${recovered}${log.trim() ? ", then it answered" : ", still silent"}.]`;
      }
      if (!log.trim()) return text(`No output from ${port} in ${seconds} s${note || " (without a reset the firmware may simply be quiet)"}.`);
      const lines = log.split("\n").length;
      const file = join(tmpdir(), "pi-lab", `serial-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, log);
      if (/waiting for download/.test(log)) {
        note += `\n[pi-lab: ${hooks.downloadModeHint?.() ?? "The chip booted into its download mode (boot strap held low), so the firmware did not run. Ask the user to reset the board normally."}]`;
      }
      const shown = foldText(log, SERIAL_FOLD) ?? log;
      return text(`Serial log from ${port} (${params.reset === false ? "no reset" : "after reset"}, ${lines} lines, full log in ${file}):${note}\n${shown}`);
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

      if (kind === "platformio") {
        const r = await shell(`pio run -t upload --upload-port ${shellQuote(port)} 2>&1`, ctx.cwd, 15 * 60_000);
        if (r.code !== 0) return text(`Upload failed:\n${buildErrors(r.stdout) || r.stdout.slice(-3000)}`);
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
      let f = await flash();
      let note = "";
      if (f.code !== 0 && flashFailure(f.stdout) === "no-connect") {
        note = ` (the USB port had stopped responding; ${await reenumerate()} and retried)`;
        f = await flash();
      }
      if (f.code !== 0) {
        const why = flashFailure(f.stdout);
        const hint = why === "port-busy" ? "Another program has the port open (a serial monitor?). Close it and try again."
          : why === "no-connect" ? "The board does not answer. Ask the user to unplug it and plug it back in."
          : "";
        return text(`Flashing failed${note}. ${hint}\n${f.stdout.slice(-2000)}`);
      }
      await capture(port, ["--reset-only"], 5);
      await hooks.flashed(ctx, "board_flash");
      const written = f.stdout.match(/Wrote \d+ bytes[^\n]*/g)?.pop() ?? "";
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
}
