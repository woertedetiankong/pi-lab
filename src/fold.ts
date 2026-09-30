// Folds old hardware logs (serial output, flash and build logs) in the context sent to the model.
// The session keeps every log in full; only what the model sees shrinks. The newest logs stay whole,
// older ones keep their first and last lines plus every line that looks like a failure.

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];

const LOG_COMMAND = new RegExp([
  String.raw`\bidf\.py\b`, String.raw`\besptool`, String.raw`\b(?:pio|platformio)\b`, String.raw`\bwest\b`,
  String.raw`\bopenocd\b`, String.raw`\bprobe-rs\b`, String.raw`\bcargo\s+(?:flash|embed|build)\b`,
  String.raw`\bst-flash\b`, String.raw`\bSTM32_Programmer_CLI\b`, String.raw`\bnrfjprog\b`, String.raw`\bJLink`,
  String.raw`\bUV4\b`, String.raw`\barduino-cli\b`, String.raw`\bminicom\b`, String.raw`\bpicocom\b`,
  String.raw`\bscreen\s+/dev/`, String.raw`\bminiterm\b`, String.raw`\bserial\b`, String.raw`/dev/(?:tty|cu)\.?[A-Za-z]`,
  String.raw`\bCOM\d+\b`, String.raw`\bmake\b`, String.raw`\bcmake\s+--build\b`, String.raw`\bninja\b`, String.raw`\bgdb\b`,
].join("|"));

const NOTABLE = /error|fail|fault|panic|assert|abort|exception|backtrace|guru meditation|watchdog|\bwdt\b|brownout|reset|reboot|timeout|timed out|overflow|undefined reference|warning:|\bnack\b|\bE \(\d+\)|\bW \(\d+\)/i;

export interface FoldOptions {
  /** Logs to keep whole, newest first. */
  keepRecent: number;
  /** Logs shorter than this stay whole. */
  minLines: number;
  head: number;
  tail: number;
  /** Most notable lines kept from the middle. */
  notable: number;
}

export const DEFAULT_FOLD: FoldOptions = { keepRecent: 2, minLines: 60, head: 8, tail: 15, notable: 40 };

export const isLogCommand = (command: string) => LOG_COMMAND.test(command);

export function foldText(text: string, o: FoldOptions): string | undefined {
  const lines = text.split("\n");
  if (lines.length < o.minLines) return undefined;
  const middle = lines.slice(o.head, lines.length - o.tail);
  const kept: string[] = [];
  let skipped = 0, notable = 0;
  const flush = () => { if (skipped) kept.push(`  … ${skipped} line${skipped > 1 ? "s" : ""} …`); skipped = 0; };
  for (const line of middle) {
    if (notable < o.notable && NOTABLE.test(line)) { flush(); kept.push(line); notable++; }
    else skipped++;
  }
  flush();
  return [
    `[pi-lab: older log folded from ${lines.length} to about ${o.head + kept.length + o.tail} lines; first and last lines and lines that look like failures are kept. Re-run the command if you need the rest.]`,
    ...lines.slice(0, o.head), ...kept, ...lines.slice(lines.length - o.tail),
  ].join("\n");
}

/** Returns new messages with old logs folded, or undefined when nothing changed. */
export function foldLogs(messages: AgentMessage[], o: FoldOptions = DEFAULT_FOLD): AgentMessage[] | undefined {
  const commands = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const part of m.content) {
      if (part.type === "toolCall" && part.name === "bash" && typeof part.arguments.command === "string") commands.set(part.id, part.arguments.command);
    }
  }
  const logs: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "toolResult" && m.toolName === "bash" && isLogCommand(commands.get(m.toolCallId) ?? "")) logs.push(i);
  });
  const old = new Set(logs.slice(0, Math.max(0, logs.length - o.keepRecent)));
  if (!old.size) return undefined;
  let changed = false;
  const result = messages.map((m, i) => {
    if (!old.has(i) || m.role !== "toolResult") return m;
    const content = m.content.map(part => {
      if (part.type !== "text") return part;
      const folded = foldText(part.text, o);
      if (folded === undefined) return part;
      changed = true;
      return { ...part, text: folded };
    });
    return { ...m, content };
  });
  return changed ? result : undefined;
}
