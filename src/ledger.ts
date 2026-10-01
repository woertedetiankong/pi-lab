// The debug ledger: what the agent has established about the hardware and which ideas it has tried.
// It lives in the session as snapshot entries, so every branch of the session tree has its own ledger
// and a compaction cannot lose it.

export const LEDGER_ENTRY = "pi-lab.ledger";

export type HypothesisStatus = "open" | "testing" | "ruled_out" | "confirmed";

export interface Fact {
  id: string;
  text: string;
  evidence?: string;
  /** Reproduced at least once more, from a clean build. Until then it is a single observation. */
  verified?: boolean;
  reproduction?: string;
}

export interface Hypothesis {
  id: string;
  text: string;
  status: HypothesisStatus;
  evidence?: string;
}

export interface Ledger {
  target?: string;
  facts: Fact[];
  hypotheses: Hypothesis[];
}

export const emptyLedger = (): Ledger => ({ facts: [], hypotheses: [] });

export type LedgerAction =
  | { action: "set_target"; text: string }
  | { action: "add_fact"; text: string; evidence?: string }
  | { action: "verify_fact"; id: string; evidence?: string }
  | { action: "add_hypothesis"; text: string; force?: boolean }
  | { action: "update"; id: string; status?: HypothesisStatus; evidence?: string }
  | { action: "remove"; id: string };

export interface ApplyResult {
  ledger: Ledger;
  changed: boolean;
  message: string;
}

const nextId = (prefix: string, items: { id: string }[]) =>
  `${prefix}${items.reduce((max, item) => Math.max(max, Number(item.id.slice(1)) || 0), 0) + 1}`;

export function applyAction(ledger: Ledger, act: LedgerAction): ApplyResult {
  const next: Ledger = { target: ledger.target, facts: [...ledger.facts], hypotheses: [...ledger.hypotheses] };
  switch (act.action) {
    case "set_target":
      next.target = act.text.trim() || undefined;
      return { ledger: next, changed: true, message: next.target ? `Target: ${next.target}` : "Target cleared." };
    case "add_fact": {
      if (!act.evidence?.trim()) {
        return { ledger, changed: false, message: "Give the evidence: what the hardware showed (a log line, register value, measurement)." };
      }
      const fact: Fact = { id: nextId("F", next.facts), text: act.text.trim(), evidence: act.evidence.trim() };
      next.facts.push(fact);
      return {
        ledger: next, changed: true,
        message: `Added ${fact.id} as a single observation. If it contradicts what the code implies, suspect the experiment first ` +
          "(a stale build, leftover instrumentation, a different code path than you think). Reproduce it from a clean build with one change, " +
          `then record that with verify_fact before building on it.`,
      };
    }
    case "verify_fact": {
      const index = next.facts.findIndex(f => f.id === act.id);
      if (index < 0) return { ledger, changed: false, message: `No fact ${act.id}.` };
      if (!act.evidence?.trim()) return { ledger, changed: false, message: `Say how ${act.id} was reproduced: the clean build, the one change, and what the hardware showed again.` };
      next.facts[index] = { ...next.facts[index]!, verified: true, reproduction: act.evidence.trim() };
      return { ledger: next, changed: true, message: `${act.id} is now an established fact.` };
    }
    case "add_hypothesis": {
      const tried = next.hypotheses.find(h => (h.status === "ruled_out" || h.status === "confirmed") && similar(h.text, act.text));
      if (tried && !act.force) {
        return {
          ledger,
          changed: false,
          message: `Not added: this looks like ${tried.id} "${tried.text}", already ${tried.status === "ruled_out" ? "ruled out" : "confirmed"}${tried.evidence ? ` (${tried.evidence})` : ""}. ` +
            "If it really is a different idea, say what is different and add it again with force: true.",
        };
      }
      const hypothesis: Hypothesis = { id: nextId("H", next.hypotheses), text: act.text.trim(), status: "open" };
      next.hypotheses.push(hypothesis);
      return { ledger: next, changed: true, message: `Added ${hypothesis.id}.` };
    }
    case "update": {
      const index = next.hypotheses.findIndex(h => h.id === act.id);
      if (index < 0) return { ledger, changed: false, message: `No hypothesis ${act.id}. Facts cannot be updated; remove and add them again.` };
      const old = next.hypotheses[index]!;
      if ((act.status === "ruled_out" || act.status === "confirmed") && !act.evidence?.trim() && !old.evidence) {
        return { ledger, changed: false, message: `Give the evidence that ${act.status === "ruled_out" ? "rules out" : "confirms"} ${act.id} (a log line, register value, measurement).` };
      }
      next.hypotheses[index] = { ...old, status: act.status ?? old.status, evidence: act.evidence?.trim() || old.evidence };
      return { ledger: next, changed: true, message: `Updated ${act.id}.` };
    }
    case "remove": {
      const facts = next.facts.filter(f => f.id !== act.id), hypotheses = next.hypotheses.filter(h => h.id !== act.id);
      if (facts.length === next.facts.length && hypotheses.length === next.hypotheses.length) return { ledger, changed: false, message: `No entry ${act.id}.` };
      return { ledger: { ...next, facts, hypotheses }, changed: true, message: `Removed ${act.id}.` };
    }
  }
}

// Word-set overlap, good enough to catch the agent rephrasing an idea it already ruled out.
// CJK text has no spaces, so it is compared by character pairs.
function tokens(text: string): Set<string> {
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z0-9_]+(?:[-.][a-z0-9_]+)*/g) ?? [];
  const cjk = [...lower.matchAll(/[㐀-鿿]+/g)].flatMap(([run]) => {
    const chars = [...run];
    return chars.length === 1 ? chars : chars.slice(1).map((c, i) => chars[i] + c);
  });
  return new Set([...words, ...cjk].filter(t => !STOP.has(t)));
}

const STOP = new Set(["the", "a", "an", "is", "are", "of", "to", "in", "on", "and", "or", "not", "be", "too", "it", "its", "wrong", "bad", "issue", "problem"]);

export function similar(a: string, b: string, threshold = 0.6): boolean {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / Math.min(x.size, y.size) >= threshold;
}

const MARK: Record<HypothesisStatus, string> = { open: "[ ]", testing: "[~]", ruled_out: "[x]", confirmed: "[✓]" };

export function renderLedger(ledger: Ledger, firmware?: string): string {
  const lines: string[] = [];
  if (ledger.target) lines.push(`Target: ${ledger.target}`);
  if (firmware) lines.push(`Firmware: ${firmware}`);
  const established = ledger.facts.filter(f => f.verified), observed = ledger.facts.filter(f => !f.verified);
  if (established.length) {
    lines.push("Established facts (reproduced):");
    for (const f of established) lines.push(`- ${f.id} ${f.text} (evidence: ${f.evidence}; reproduced: ${f.reproduction})`);
  }
  if (observed.length) {
    lines.push("Single observations (not reproduced yet; do not build on them, and doubt any that contradict the code):");
    for (const f of observed) lines.push(`- ${f.id} ${f.text}${f.evidence ? ` (evidence: ${f.evidence})` : ""}`);
  }
  if (ledger.hypotheses.length) {
    lines.push("Hypotheses ([ ] open, [~] testing, [x] ruled out, [✓] confirmed):");
    for (const h of ledger.hypotheses) lines.push(`- ${MARK[h.status]} ${h.id} ${h.text}${h.evidence ? ` (evidence: ${h.evidence})` : ""}`);
  }
  return lines.join("\n");
}

export const isEmpty = (ledger: Ledger) => !ledger.target && !ledger.facts.length && !ledger.hypotheses.length;
