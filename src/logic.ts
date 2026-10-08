// A logic analyzer through sigrok-cli: what the serial log cannot show, such as whether the I2C bus carries any
// traffic, which address answers, or how fast a pin toggles. Works with any analyzer sigrok supports (the cheap
// fx2lafw ones, a Saleae Logic, a DSLogic); the project names it in .pi/lab.json under "logic".

import type { Run } from "./board.ts";
import { shellQuote } from "./board.ts";

export interface LogicConfig {
  /** sigrok driver, e.g. "fx2lafw", "saleae-logic16", "dreamsourcelab-dslogic"; "demo" for sigrok's simulated device. */
  driver?: string;
  /** Default sample rate, e.g. "1m", "4m" (default "1m"). */
  samplerate?: string;
  /** Channels to capture, e.g. "D0,D1". */
  channels?: string;
  /** What is wired to each channel, e.g. { "D0": "SCL", "D1": "SDA" }: shown in the summary. */
  names?: Record<string, string>;
}

export interface LogicParams {
  seconds?: number;
  /** A protocol decoder with its options, e.g. "i2c:scl=D0:sda=D1", "uart:rx=D2:baudrate=115200". */
  decoder?: string;
  channels?: string;
  samplerate?: string;
  /** Start capturing on a condition, e.g. "D0=f" (falling edge on D0). */
  trigger?: string;
  driver?: string;
}

const INSTALL = "sigrok-cli is not installed. Ask the user to install it (macOS: `brew install sigrok-cli`; Debian/Ubuntu: `sudo apt install sigrok-cli`), then name the analyzer in .pi/lab.json, e.g. {\"logic\": {\"driver\": \"fx2lafw\", \"names\": {\"D0\": \"SCL\", \"D1\": \"SDA\"}}}. `sigrok-cli --scan` lists what is connected.";

/** sigrok-cli's arguments for a capture. */
export function logicArgs(cfg: LogicConfig, p: LogicParams): string[] {
  const seconds = Math.min(Math.max(p.seconds ?? 0.5, 0.001), 10);
  const args = ["-d", p.driver ?? cfg.driver!, "--config", `samplerate=${p.samplerate ?? cfg.samplerate ?? "1m"}`, "--time", `${Math.round(seconds * 1000)}`];
  const channels = p.channels ?? cfg.channels;
  if (channels) args.push("-C", channels);
  if (p.trigger) args.push("-t", p.trigger, "-w");
  if (p.decoder) args.push("-P", p.decoder, "-A", p.decoder.split(":")[0]!);
  else args.push("-O", "csv");
  return args;
}

/** Per channel: share of time high, edges and the frequency they imply, from sigrok's CSV output. */
export function summarizeCsv(csv: string, seconds: number, names: Record<string, string> = {}): string {
  const rows = csv.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith(";"));
  const header = rows.findIndex(l => /[A-Za-z]/.test(l));
  if (header < 0 || header === rows.length - 1) return "The capture holds no samples.";
  const channels = rows[header]!.split(",").map(c => c.trim().replace(/ .*$/, ""));
  const samples = rows.slice(header + 1).map(r => r.split(",").map(v => v.trim()));
  const out = [`${samples.length} samples over ${seconds} s:`];
  channels.forEach((ch, i) => {
    let high = 0, edges = 0, prev: string | undefined;
    for (const s of samples) {
      const v = s[i];
      if (v === "1") high++;
      if (prev !== undefined && v !== prev) edges++;
      prev = v;
    }
    const label = names[ch] ? `${ch} (${names[ch]})` : ch;
    const freq = edges / 2 / seconds;
    const level = edges === 0 ? `stuck ${high ? "high" : "low"}` : `${Math.round((high / samples.length) * 100)}% high, ${edges} edges, ≈ ${freq >= 1000 ? `${(freq / 1000).toFixed(1)} kHz` : `${freq.toFixed(1)} Hz`}`;
    out.push(`- ${label}: ${level}`);
  });
  return out.join("\n");
}

/** Decoder annotations: the first lines as they came, and how often each kind occurred. */
export function summarizeDecoded(text: string, maxLines = 80): string {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length) return "The decoder found nothing: no traffic in the capture, or the decoder's channels or options do not match the wiring.";
  const kinds = new Map<string, number>();
  for (const l of lines) {
    const kind = l.replace(/^[\w-]+:\s*/, "").replace(/[:\s]+[0-9A-Fa-fx]+$/, "");
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const shown = lines.slice(0, maxLines);
  return [
    `${lines.length} annotations. By kind: ${[...kinds].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} ×${n}`).join(", ")}`,
    "",
    ...shown,
    ...(lines.length > maxLines ? [`... ${lines.length - maxLines} more`] : []),
  ].join("\n");
}

export async function captureLogic(run: Run, cwd: string, cfg: LogicConfig, p: LogicParams): Promise<string> {
  const have = await run("bash", ["-c", "command -v sigrok-cli"], { cwd, timeout: 5000 });
  if (have.code !== 0 || !have.stdout.trim()) return INSTALL;
  if (!(p.driver ?? cfg.driver)) {
    const scan = await run("sigrok-cli", ["--scan"], { cwd, timeout: 20_000 });
    return `No logic analyzer set for this project. sigrok-cli --scan found:\n${scan.stdout.trim() || "(nothing)"}\nName the driver in .pi/lab.json, e.g. {"logic": {"driver": "fx2lafw"}}, or pass driver.`;
  }
  const args = logicArgs(cfg, p);
  const seconds = Math.min(Math.max(p.seconds ?? 0.5, 0.001), 10);
  const r = await run("bash", ["-c", `sigrok-cli ${args.map(shellQuote).join(" ")} 2>&1`], { cwd, timeout: (seconds + 30) * 1000 });
  if (r.code !== 0) return `sigrok-cli failed (exit ${r.code}):\n${r.stdout.slice(-1500)}`;
  const what = `${p.driver ?? cfg.driver}, ${p.samplerate ?? cfg.samplerate ?? "1m"} samples/s, ${seconds} s${p.trigger ? `, trigger ${p.trigger}` : ""}`;
  return `Logic capture (${what}):\n${p.decoder ? summarizeDecoded(r.stdout) : summarizeCsv(r.stdout, seconds, cfg.names)}`;
}
