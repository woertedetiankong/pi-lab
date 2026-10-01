// Guards against changes an agent should not make while debugging firmware: editing the toolchain, installing
// into the system Python, and irreversible chip operations. Benchmark agents did the first two on their own.

import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export interface Verdict {
  /** Why the call is held back, phrased for the model. */
  reason: string;
  /** Irreversible for the hardware: never allowed without a person confirming. */
  hardware?: boolean;
}

/** Directories holding toolchains and SDKs, shared by every project on the machine. */
export function protectedRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  return [
    env.IDF_PATH, env.IDF_TOOLS_PATH,
    `${home}/.espressif`, `${home}/esp`, `${home}/.platformio`, `${home}/.arduino15`, `${home}/Library/Arduino15`,
    `${home}/.cargo/registry`, `${home}/.rustup`, `${home}/zephyrproject`, `${home}/ncs`,
    "/opt/homebrew", "/usr/local", "/usr/lib", "/Library", "/System",
  ].filter((p): p is string => !!p).map(p => resolve(p));
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const TOOLCHAIN_ADVICE =
  "It is shared by every project on this machine. To change a component, copy it into the project " +
  "(for ESP-IDF: components/<name>/, which overrides the SDK's copy); to debug it, add logging in the project instead.";

/** Checks a file write (edit or write tool). */
export function checkWrite(path: string, cwd: string, roots = protectedRoots()): Verdict | undefined {
  const target = resolve(cwd, path);
  if (inside(target, resolve(cwd))) return undefined;
  const root = roots.find(r => inside(target, r));
  if (!root) return undefined;
  return { reason: `${target} is inside ${root}, a toolchain or system directory. ${TOOLCHAIN_ADVICE}` };
}

// Commands that permanently change a chip.
const HARDWARE: [RegExp, string][] = [
  [/\bespefuse(?:\.py)?\b[^\n;|&]*\bburn[-_]/i, "burns eFuses, which is permanent and can brick the chip"],
  [/\bidf\.py\b[^\n;|&]*\befuse[-_]burn/i, "burns eFuses, which is permanent and can brick the chip"],
  [/\bespsecure(?:\.py)?\b/i, "changes secure boot or flash encryption keys"],
  [/\bSTM32_Programmer_CLI\b[^\n;|&]*\b-ob\b[^\n;|&]*\bRDP\s*=\s*(?:0x)?(?:CC|2)\b/i, "sets read protection level 2, which permanently locks the chip"],
  [/\bnrfjprog\b[^\n;|&]*--(?:rbp|readback)\b/i, "enables readback protection"],
  [/\bopenocd\b[^\n;|&]*\b(?:stm32\w*x\s+lock|flash\s+protect)\b/i, "locks or write-protects flash"],
];

// Commands that change the machine rather than the project.
const SYSTEM: [RegExp, string][] = [
  [/\bpip3?\b[^\n;|&]*\binstall\b[^\n;|&]*--break-system-packages\b/, "installs into the system Python"],
  // pip without a project virtual environment installs into whichever Python comes first: often ESP-IDF's.
  [/^(?![^\n]*(?:\.venv|\bvenv\/|--target|\s-t\s))[^\n]*\b(?:pip3?|python3?\s+-m\s+pip)\s+install\b/m, "installs into a shared Python environment (the system's or the toolchain's)"],
  [/\bsudo\s/, "runs as root"],
  [/\bbrew\s+(?:install|upgrade|uninstall|remove)\b/, "changes Homebrew packages"],
];

/** Splits a command line into simple commands and their words. Quotes are honoured, expansions are not. */
export function simpleCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], word = "", quote = "", started = false;
  const endWord = () => { if (started) words.push(word); word = ""; started = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === "\\" && i + 1 < command.length) { word += command[++i]; started = true; continue; }
    if (c === "\n" || c === ";" || c === "|" || (c === "&" && command[i + 1] === "&")) {
      if (c === "&" || (c === "|" && command[i + 1] === "|")) i++;
      endCommand();
      continue;
    }
    if (c === ">" || c === "<") {
      // Keep redirections as their own words: ">", ">>", "2>", "2>&1".
      if (/^\d$/.test(word)) { word += c; } else { endWord(); word = c; }
      started = true;
      if (command[i + 1] === ">" ) word += command[++i];
      if (command[i + 1] === "&") { word += command[++i]; while (/\d/.test(command[i + 1] ?? "")) word += command[++i]; endWord(); }
      else endWord();
      continue;
    }
    if (c === " " || c === "\t") { endWord(); continue; }
    word += c;
    started = true;
  }
  endCommand();
  return commands;
}

/** Paths a simple command writes to. */
export function writeTargets(words: string[]): string[] {
  const targets: string[] = [];
  const args: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (/^\d?>>?$/.test(w)) { if (words[i + 1]) targets.push(words[++i]!); continue; }
    if (/^\d?>>?&\d*$|^<$/.test(w)) { if (w === "<") i++; continue; }
    args.push(w);
  }
  while (args.length && /^\w+=/.test(args[0]!)) args.shift();
  const verb = (args[0] ?? "").replace(/^.*\//, "");
  const operands = args.slice(1).filter(a => !a.startsWith("-"));
  const options = args.slice(1).filter(a => a.startsWith("-"));
  if ((verb === "sed" || verb === "perl") && options.some(o => /^-[a-zA-Z]*i|^--in-place/.test(o))) {
    // The first operand is the script unless it came with -e.
    targets.push(...(options.some(o => o === "-e") ? operands : operands.slice(1)));
  } else if (verb === "cp" || verb === "mv" || verb === "install" || verb === "ln") {
    if (operands.length > 1) targets.push(operands[operands.length - 1]!);
  } else if (["rm", "rmdir", "tee", "truncate", "patch", "touch", "chmod", "unlink"].includes(verb)) {
    targets.push(...operands);
  }
  return targets.filter(t => !t.startsWith("/dev/"));
}

/** Checks a shell command. */
export function checkCommand(command: string, cwd: string, roots = protectedRoots(), home = homedir(), env: NodeJS.ProcessEnv = process.env): Verdict | undefined {
  for (const [pattern, what] of HARDWARE) {
    if (pattern.test(command)) return { reason: `This command ${what}.`, hardware: true };
  }
  for (const [pattern, what] of SYSTEM) {
    if (pattern.test(command)) {
      return { reason: `This command ${what}. Keep changes inside the project: for Python packages use a virtual environment in the project (python3 -m venv .venv).` };
    }
  }
  for (const words of simpleCommands(command)) {
    for (const raw of writeTargets(words)) {
      const expanded = raw
        .replace(/^~(?=\/|$)/, home)
        .replace(/^\$\{?HOME\}?(?=\/|$)/, home)
        .replace(/^\$\{?IDF_PATH\}?(?=\/|$)/, env.IDF_PATH ?? `${home}/.espressif`);
      const target = resolve(cwd, expanded);
      if (inside(target, resolve(cwd))) continue;
      const root = roots.find(r => inside(target, r));
      if (root) return { reason: `This command writes to ${target}, inside ${root}, a toolchain or system directory. ${TOOLCHAIN_ADVICE}` };
    }
  }
  return undefined;
}
