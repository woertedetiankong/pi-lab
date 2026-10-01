// Turns the code addresses in an ESP-IDF crash (a Guru Meditation backtrace, "abort() was called at PC ...") into
// functions and source lines, with addr2line and the project's ELF file.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Code addresses a crash line names, or undefined when it names none. */
export function crashAddresses(line: string): string[] | undefined {
  const backtrace = /^Backtrace:\s*(.*)$/.exec(line.trim());
  // Xtensa backtraces are PC:SP pairs; the PC is what addr2line needs.
  if (backtrace) return [...backtrace[1]!.matchAll(/(0x[0-9a-fA-F]{8}):0x[0-9a-fA-F]{8}/g)].map(m => m[1]!).filter(isCode);
  const pc = /(?:abort\(\) was called at PC|^\s*(?:PC|MEPC|RA)\s*:)\s*(0x[0-9a-fA-F]{8})/.exec(line);
  if (pc && isCode(pc[1]!)) return [pc[1]!];
  return undefined;
}

// Instruction memory on ESP32 chips: IRAM (0x4037.., 0x4008..) and flash-mapped code (0x400d.., 0x420..).
const isCode = (address: string) => /^0x4[0-2]/i.test(address) && address !== "0x00000000";

export interface ElfInfo {
  elf: string;
  /** e.g. xtensa-esp32s3-elf-addr2line */
  addr2line: string;
}

/** The app's ELF and the matching addr2line, from an ESP-IDF build directory. */
export function elfInfo(projectDir: string): ElfInfo | undefined {
  try {
    const description = JSON.parse(readFileSync(join(projectDir, "build", "project_description.json"), "utf8"));
    const elf = join(projectDir, "build", description.app_elf);
    if (!existsSync(elf)) return undefined;
    const target = String(description.target ?? "");
    const xtensa = ["esp32", "esp32s2", "esp32s3"].includes(target);
    return { elf, addr2line: xtensa ? `xtensa-${target}-elf-addr2line` : "riscv32-esp-elf-addr2line" };
  } catch {
    return undefined;
  }
}

/** "0x4200a1b2: app_main at /p/main/main.c:42" → "app_main at main/main.c:42", one frame per line. */
export function formatFrames(output: string, projectDir: string): string[] {
  return output.split("\n").map(l => l.trim()).filter(Boolean).map(line => {
    const m = /^(0x[0-9a-f]+): (.*?) at (.*?):(\d+|\?)(?: \(discriminator \d+\))?$/i.exec(line);
    const inlined = /^\(inlined by\) (.*?) at (.*?):(\d+|\?)/.exec(line);
    const where = (file: string, n: string) => {
      const rel = relative(projectDir, file);
      return `${rel.startsWith("..") ? file.replace(/^.*\/components\//, "IDF components/") : rel}:${n}`;
    };
    if (m) return m[3] === "??" ? `${m[1]}: ${m[2]} (no source line)` : `${m[1]}: ${m[2]} at ${where(m[3]!, m[4]!)}`;
    if (inlined) return `   (inlined by) ${inlined[1]} at ${where(inlined[2]!, inlined[3]!)}`;
    return line;
  });
}
