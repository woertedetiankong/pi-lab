// Working with the board: find its port, flash it, read its serial output, recover a wedged USB port.
// Everything goes through a Run function so it can be tested without hardware.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}
export type Run = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<RunResult>;

const PORT_PATTERNS = process.platform === "darwin"
  ? [/^cu\.usbmodem/, /^cu\.usbserial/, /^cu\.wchusbserial/, /^cu\.SLAB_USBtoUART/]
  : [/^ttyACM\d/, /^ttyUSB\d/];

/** Serial ports that look like a development board, most recently connected first. */
export function findPorts(dev = "/dev"): string[] {
  let names: string[];
  try { names = readdirSync(dev); } catch { return []; }
  return names
    .filter(n => PORT_PATTERNS.some(p => p.test(n)))
    .map(n => join(dev, n))
    .sort((a, b) => mtime(b) - mtime(a));
}

const mtime = (path: string) => { try { return statSync(path).ctimeMs; } catch { return 0; } };

/** ESP-IDF's export script: $IDF_PATH, else the newest install under ~/.espressif or ~/esp. */
export function findIdfExport(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  if (env.IDF_PATH && existsSync(join(env.IDF_PATH, "export.sh"))) return join(env.IDF_PATH, "export.sh");
  const candidates: string[] = [];
  const espressif = join(home, ".espressif");
  try {
    for (const v of readdirSync(espressif)) {
      const script = join(espressif, v, "esp-idf", "export.sh");
      if (existsSync(script)) candidates.push(script);
    }
  } catch {}
  for (const dir of [join(home, "esp", "esp-idf"), join(home, "esp-idf")]) {
    if (existsSync(join(dir, "export.sh"))) candidates.push(join(dir, "export.sh"));
  }
  return candidates.sort(versionOrder).pop();
}

const versionOrder = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export type ProjectKind = "esp-idf" | "platformio";

export function projectKind(cwd: string): ProjectKind | undefined {
  if (existsSync(join(cwd, "platformio.ini"))) return "platformio";
  try {
    if (/project\.cmake/.test(readFileSync(join(cwd, "CMakeLists.txt"), "utf8"))) return "esp-idf";
  } catch {}
  return undefined;
}

/** A shell prefix that puts the project's toolchain on PATH. */
export function toolchainPrefix(kind: ProjectKind | undefined, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (kind === "esp-idf") {
    const script = findIdfExport(env, home);
    return script ? `source ${shellQuote(script)} >/dev/null 2>&1 && ` : "";
  }
  return "";
}

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A Python that can import pyserial: ESP-IDF's or PlatformIO's environment, else python3. */
export async function serialPython(run: Run, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string | undefined> {
  const candidates: string[] = [];
  if (env.IDF_PYTHON_ENV_PATH) candidates.push(join(env.IDF_PYTHON_ENV_PATH, "bin", "python"));
  try {
    const envs = join(home, ".espressif", "python_env");
    for (const e of readdirSync(envs).sort(versionOrder).reverse()) candidates.push(join(envs, e, "bin", "python"));
  } catch {}
  candidates.push(join(home, ".platformio", "penv", "bin", "python"), "python3");
  for (const python of candidates) {
    if (python !== "python3" && !existsSync(python)) continue;
    const r = await run(python, ["-c", "import serial"], { timeout: 10_000 }).catch(() => undefined);
    if (r?.code === 0) return python;
  }
  return undefined;
}

/** Why a flash failed, in a form that tells the agent what to do next. */
export function flashFailure(output: string): "no-connect" | "port-busy" | "build" | "other" {
  if (/Failed to connect|No serial data received|Could not open port.*(No such file|not found)/i.test(output)) return "no-connect";
  if (/Resource busy|could not exclusively lock|port is busy|Errno 16/i.test(output)) return "port-busy";
  if (/error:|ninja: build stopped|FAILED:/i.test(output)) return "build";
  return "other";
}

/** The compiler errors from a build log, without the noise. */
export function buildErrors(output: string, max = 20): string {
  const lines = output.split("\n").filter(l => /\berror\b|undefined reference|FAILED:/i.test(l) && !/^\s*ninja: build stopped/.test(l));
  return [...new Set(lines)].slice(0, max).join("\n");
}

/** USB vendor:product ids of connected devices, as "303a:1001". */
export async function usbIds(run: Run): Promise<string[]> {
  if (process.platform === "darwin") {
    const r = await run("ioreg", ["-p", "IOUSB", "-l", "-w0"], { timeout: 10_000 }).catch(() => undefined);
    return parseIoreg(r?.stdout ?? "");
  }
  const r = await run("sh", ["-c", "for d in /sys/bus/usb/devices/*; do [ -f $d/idVendor ] && echo $(cat $d/idVendor):$(cat $d/idProduct); done"], { timeout: 10_000 }).catch(() => undefined);
  return [...new Set((r?.stdout ?? "").match(/\b[0-9a-f]{4}:[0-9a-f]{4}\b/g) ?? [])];
}

export function parseIoreg(text: string): string[] {
  const ids: string[] = [];
  let vendor: number | undefined, product: number | undefined;
  for (const line of text.split("\n")) {
    // Each device starts a "+-o" block; its properties come in any order.
    if (line.includes("+-o ")) { vendor = product = undefined; continue; }
    const v = line.match(/"idVendor" = (\d+)/), p = line.match(/"idProduct" = (\d+)/);
    if (v) vendor = Number(v[1]);
    if (p) product = Number(p[1]);
    if (vendor !== undefined && product !== undefined) {
      ids.push(`${vendor.toString(16).padStart(4, "0")}:${product.toString(16).padStart(4, "0")}`);
      vendor = product = undefined;
    }
  }
  return [...new Set(ids)];
}
