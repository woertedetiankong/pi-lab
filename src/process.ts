// How much process the agent is asked for. A bug the agent can find by trying things on the board needs none: in
// the bench, plain pi fixed such bugs in about three minutes, and the debug ledger's bookkeeping only added time.
// A bug that resists is where the ledger earned its keep (it stopped an agent that took two misread observations
// for facts). So pi-lab starts light and turns careful when the problem resists.

export type Mode = "light" | "careful";

/** The mode is a snapshot in the session, so each branch of the session tree has its own. */
export const PROCESS_ENTRY = "pi-lab.process";

export interface ProcessRecord {
  mode: Mode;
  reason?: string;
}

/** What happened in the current task so far. */
export interface Signals {
  toolCalls: number;
  /** Flashes in this task: a second one means the first change did not settle it. */
  flashes: number;
  /** An experiment whose variants did not answer the same way in every run. */
  unsettled: boolean;
  /** The agent itself started the debug ledger. */
  ledgerUsed: boolean;
}

export const TOOL_CALLS_BEFORE_CAREFUL = 20;

/** Why to turn careful now, or undefined to stay light. */
export function escalation(s: Signals): string | undefined {
  if (s.ledgerUsed) return "you started keeping the debug ledger";
  if (s.unsettled) return "an experiment answered differently across runs of the same variant";
  if (s.flashes >= 2) return "this is the second flash in this task: the first change did not settle it";
  if (s.toolCalls >= TOOL_CALLS_BEFORE_CAREFUL) return `${s.toolCalls} tool calls on this task without a settled answer`;
  return undefined;
}

export const CORE_GUIDELINES = [
  "You are working on embedded firmware with a real board attached (pi-lab).",
  "- Flash with board_flash and read the board with board_serial (it resets the board and captures from the first boot line). Do not run `idf.py monitor` or other serial monitors: they never exit. If the board stops answering, use board_recover.",
  "- What you see on the board only reflects your edits after they are flashed. Check the Firmware line before drawing conclusions from board behaviour.",
  "- When a result surprises you, when two explanations fit what you saw, or before you state a cause, test it with board_experiment: the variants that would tell the explanations apart, several runs each. One probe run is an anecdote; a table that repeats is a fact.",
  "- When the project has board checks, a fix is done when board_check passes.",
  "- Keep changes inside the project. Do not edit the SDK or toolchain (copy a component into the project to change it) and do not install packages into shared Python environments.",
  "- Older build, flash and serial logs are shortened in your context; re-run a command if you need its full output.",
];

export const CAREFUL_GUIDELINES = [
  "Careful mode: this problem has resisted a direct fix. Keep a debug ledger with lab_ledger; it is shown to you below on every turn and survives context compaction.",
  "- Record a fact only when the hardware showed it (serial output, a register read, a measurement), and say what showed it. A new fact is a single observation until it is reproduced: a settled board_experiment counts, and is recorded for you. Otherwise repeat it from the same starting point and record that with verify_fact: for firmware, a clean build with one change; for host-side scripts and tools, the same run again.",
  "- Reproduce a fact before you build on it, not as a closing ritual: once the original symptom is fixed and checked on the board, the remaining facts need no verifying.",
  "- When an observation contradicts what the code says should happen, assume the experiment is wrong before the hardware: rebuild from the original code with only one change and repeat it.",
  "- Before testing an idea, add it as a hypothesis; when a test settles it, mark it ruled_out or confirmed with the evidence. Do not retest an idea the ledger already ruled out unless something relevant changed.",
];

/** The message that switches the agent to careful mode in the middle of a task. */
export const carefulMessage = (reason: string) => `pi-lab: switching to careful mode because ${reason}.\n${CAREFUL_GUIDELINES.join("\n")}`;
