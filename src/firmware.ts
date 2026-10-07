// Tracks whether the chip runs the code on disk: a flash records a fingerprint of the firmware sources,
// and any later difference means the board is running stale firmware.

import { createHash } from "node:crypto";
import { openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const FLASH_ENTRY = "pi-lab.flash";

export interface FlashRecord {
  at: number;
  command: string;
  fingerprint: string;
  /** Short description of the source state, e.g. "a3f2c1d + 2 changed files". */
  source: string;
}

// Commands that write firmware to a board. Build-only commands are left out on purpose.
const FLASH_PATTERNS: RegExp[] = [
  /\bidf\.py\b[^\n|;&]*\b(?:flash|app-flash|dfu-flash)\b/,
  /\besptool(?:\.py)?\b[^\n|;&]*\bwrite[-_]flash\b/,
  /\b(?:pio|platformio)\b[^\n|;&]*(?:-t|--target)\s+upload\b/,
  /\bwest\s+flash\b/,
  /\bopenocd\b[^\n|;&]*\bprogram\b/,
  /\bprobe-rs\s+(?:download|run|flash)\b/,
  /\bcargo\s+(?:flash|embed)\b/,
  /\bst-flash\b[^\n|;&]*\bwrite\b/,
  /\bSTM32_Programmer_CLI\b[^\n|;&]*\s(?:-w|--write|-d|--download)\b/,
  /\bnrfjprog\b[^\n|;&]*--program\b/,
  /\bJLink(?:Exe)?\b[^\n|;&]*(?:-CommandFile|-CommanderScript)\b/,
  /\bUV4(?:\.exe)?\b[^\n|;&]*\s-f\b/,
  /\bpicotool\s+load\b/,
  /\barduino-cli\s+upload\b/,
  /\bmake\b[^\n|;&]*\b(?:flash|upload|program)\b/,
];

export const isFlashCommand = (command: string) => FLASH_PATTERNS.some(p => p.test(command));

/**
 * Commands that open the board's serial port: flashers, monitors, scripts that talk to it. With `cwd`, a Python
 * script the command runs counts too when its source opens a serial port (`python tools/logger.py` says nothing
 * about the port on the command line).
 */
export const usesPort = (command: string, cwd?: string) =>
  isFlashCommand(command) ||
  /\bidf\.py\b[^\n|;&]*\bmonitor\b|\b(?:pio|platformio)\b[^\n|;&]*device\s+monitor|\besptool|\bminiterm|\bminicom\b|\bpicocom\b|\bscreen\s+\/dev\/|\bserial\.Serial\b|\bimport\s+serial\b|\bfrom\s+serial\b|\bserial_capture\b|\/dev\/(?:cu\.|tty\.|ttyACM|ttyUSB)/.test(command) ||
  (cwd !== undefined && pythonScripts(command).some(script => scriptOpensPort(script, cwd, cdTargets(command))));

const OPENS_PORT = /\bimport\s+serial\b|\bfrom\s+serial\b|\bserial\.Serial\b|\/dev\/(?:cu\.|tty\.|ttyACM|ttyUSB)/;

/** Scripts the command runs with Python: `python3 tools/x.py`, `python -u x.py`, `./x.py`. */
function pythonScripts(command: string): string[] {
  const found: string[] = [];
  for (const m of command.matchAll(/\bpython[\d.]*\s+(?:-[^\s-]\S*\s+)*["']?([^\s"';&|]+\.py)\b/g)) found.push(m[1]!);
  for (const m of command.matchAll(/(?:^|[\s;&|(])(\.{1,2}\/[^\s"';&|]+\.py)\b/g)) found.push(m[1]!);
  return found;
}

/** Directories the command changes into, since a script path is relative to where it runs. */
function cdTargets(command: string): string[] {
  return [...command.matchAll(/\bcd\s+["']?([^\s"';&|]+)/g)].map(m => m[1]!.replace(/^~(?=\/|$)/, homedir()));
}

function scriptOpensPort(script: string, cwd: string, dirs: string[]): boolean {
  for (const dir of [cwd, ...dirs.map(d => resolve(cwd, d))]) {
    const head = readHead(resolve(dir, script.replace(/^~(?=\/)/, homedir())));
    if (head !== undefined) return OPENS_PORT.test(head);
  }
  return false;
}

/** The first 256 KB of a file, or undefined when it cannot be read. */
function readHead(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(256 * 1024);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Files whose change means the image on the chip no longer matches.
const FIRMWARE_FILE = /(?:\.(?:c|h|cc|cpp|cxx|hpp|hh|s|S|asm|ld|lds|icf|sct|rs|ino|dts|dtsi|overlay|ioc|uvprojx|ewp|cmake)$|(?:^|\/)(?:CMakeLists\.txt|Kconfig[^/]*|sdkconfig[^/]*|prj\.conf|platformio\.ini|Makefile|Cargo\.toml|memory\.x|partitions[^/]*\.csv)$)/;

export const isFirmwareFile = (path: string) => FIRMWARE_FILE.test(path);

export type Run = (command: string, args: string[]) => Promise<{ stdout: string; code: number }>;

export interface SourceState {
  fingerprint: string;
  source: string;
}

/** Fingerprint of the firmware sources in a git work tree, or undefined outside git. */
export async function sourceState(run: Run): Promise<SourceState | undefined> {
  const top = await run("git", ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return undefined;
  // Paths from `git status` are relative to the top level, whatever directory pi runs in.
  const git = (...args: string[]) => run("git", ["-C", top.stdout.trim(), ...args]);
  const head = await git("rev-parse", "--short", "HEAD");
  const status = await git("status", "--porcelain", "--untracked-files=all");
  if (head.code !== 0 || status.code !== 0) return undefined;
  const entries = status.stdout.split("\n").filter(Boolean)
    .map(line => ({ untracked: line.startsWith("??"), path: line.slice(3).replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1") }))
    .filter(e => isFirmwareFile(e.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const changed = entries.map(e => e.path), untracked = entries.filter(e => e.untracked).map(e => e.path);
  const hash = createHash("sha256").update(head.stdout.trim());
  if (changed.length) hash.update((await git("diff", "HEAD", "--", ...changed)).stdout);
  // `git diff HEAD` leaves out untracked files, so hash their contents too.
  if (untracked.length) hash.update((await git("hash-object", "--", ...untracked)).stdout);
  const short = head.stdout.trim();
  return {
    fingerprint: hash.digest("hex").slice(0, 16),
    source: changed.length ? `${short} + ${changed.length} changed file${changed.length > 1 ? "s" : ""}` : short,
  };
}

export type FirmwareState =
  | { kind: "unknown" }
  | { kind: "never" }
  | { kind: "synced"; flash: FlashRecord }
  | { kind: "stale"; flash: FlashRecord; now: SourceState };

export function compare(flash: FlashRecord | undefined, now: SourceState | undefined): FirmwareState {
  if (!now) return { kind: "unknown" };
  if (!flash) return { kind: "never" };
  return flash.fingerprint === now.fingerprint ? { kind: "synced", flash } : { kind: "stale", flash, now };
}

const ago = (at: number, now = Date.now()) => {
  const minutes = Math.round((now - at) / 60000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

/** One line for the model. */
export function describeFirmware(state: FirmwareState): string | undefined {
  switch (state.kind) {
    case "unknown": return undefined;
    case "never": return "not flashed in this session; the board may run anything";
    case "synced": return `board runs the current sources (${state.flash.source}, flashed ${ago(state.flash.at)})`;
    case "stale": return `STALE: board runs ${state.flash.source} (flashed ${ago(state.flash.at)}), sources are now ${state.now.source}. Behaviour you observe on the board does not reflect the latest edits until you flash.`;
  }
}

/** Short text for the status bar. */
export function firmwareStatus(state: FirmwareState): string | undefined {
  switch (state.kind) {
    case "unknown": return undefined;
    case "never": return "🔌 not flashed";
    case "synced": return "🔌 firmware in sync";
    case "stale": return "⚠ board runs stale firmware";
  }
}
