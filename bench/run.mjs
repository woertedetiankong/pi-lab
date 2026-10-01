// Runs one agent on one scenario against the real board and records the outcome.
// Usage: node bench/run.mjs <scenario> <agent> [--model provider/id] [--timeout-min 30]
//   agent: pi-lab (pi + this extension), pi (pi without extensions), claude (Claude Code)
// Results go to bench/results/<scenario>/<agent>-<timestamp>/.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bench = dirname(fileURLToPath(import.meta.url));
const root = dirname(bench);
const [scenario, agent, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
const model = opt("--model");
const timeoutMin = Number(opt("--timeout-min", "30"));
const minimal = rest.includes("--minimal");
if (!scenario || !["pi-lab", "pi-lab-kb", "pi", "claude"].includes(agent)) {
  console.error("usage: node bench/run.mjs <scenario> <pi-lab|pi-lab-kb|pi|claude> [--model provider/id] [--timeout-min 30]");
  process.exit(2);
}

const work = `/tmp/pi-lab-bench/${scenario}`;
const port = process.env.ESPPORT ?? execFileSync("bash", ["-c", "ls /dev/cu.usbmodem* /dev/ttyACM* 2>/dev/null | head -1"], { encoding: "utf8" }).trim();
if (!port) { console.error("no board found"); process.exit(1); }
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(bench, "results", scenario, `${agent}${minimal ? "-minimal" : ""}${model ? "-" + model.replace(/\W+/g, "_") : ""}-${stamp}`);
mkdirSync(out, { recursive: true });
const idf = cmd => execFileSync("bash", ["-c", `source ~/.espressif/v6.0.1/esp-idf/export.sh >/dev/null 2>&1 && ${cmd}`], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
const log = msg => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

// The board's USB occasionally stops responding; a software re-enumeration brings it back.
const boardResponds = () => /\S/.test(idf(`python ${join(bench, "common", "serial_capture.py")} --seconds 4 --port ${port}`));
const ensureBoard = () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (boardResponds()) return;
    log(`board not responding, USB re-enumerate (attempt ${attempt})`);
    try { execFileSync(join(bench, "common", "bin", "usb_reenumerate"), { stdio: "ignore" }); } catch {}
    execFileSync("sleep", ["4"]);
  }
  if (!boardResponds()) { log("board still not responding: unplug and replug it, then rerun"); process.exit(3); }
};

// Flash the work tree's firmware on an erased chip, recovering the USB port between attempts.
const flashClean = () => {
  for (let attempt = 1; ; attempt++) {
    try {
      idf(`idf.py build >/dev/null && idf.py -p ${port} erase-flash >/dev/null && idf.py -p ${port} flash >/dev/null`);
      return;
    } catch (error) {
      if (attempt === 3 || !/No serial data received|Failed to connect/.test(String(error.stderr ?? error.stdout ?? error.message))) throw error;
      log(`flash failed to connect, USB re-enumerate (attempt ${attempt})`);
      try { execFileSync(join(bench, "common", "bin", "usb_reenumerate"), { stdio: "ignore" }); } catch {}
      execFileSync("sleep", ["4"]);
    }
  }
};
const judge = () => {
  flashClean();
  return JSON.parse(idf(`python ${join(bench, "scenarios", scenario, "check.py")} ${work}`).trim().split("\n").pop());
};

log(`prepare ${scenario}`);
execFileSync(join(bench, "prepare.sh"), [scenario, work], { stdio: "inherit", env: { ...process.env, BENCH_MINIMAL: minimal ? "1" : "" } });
// Start every run from the buggy firmware on the board, with a clean NVS.
ensureBoard();
flashClean();

const task = readFileSync(join(bench, "scenarios", scenario, "TASK.md"), "utf8");
const prompt = `${task}\nWork autonomously: nobody will answer questions. When you are done, reply with the root cause and what you changed.`;
const sessions = join(out, "sessions");
// pi-lab-kb also gets pi-kb, with a fresh copy of the benchmark knowledge base (bench/make-kb.mjs).
const piKb = process.env.PI_KB_SRC ?? join(root, "..", "pi-knowledge");
const kbDir = join(out, "kb");
if (agent === "pi-lab-kb") execFileSync("cp", ["-R", "/tmp/pi-lab-bench/kb", kbDir]);
const cmd = agent === "claude"
  ? ["claude", ["-p", prompt, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", ...(model ? ["--model", model] : [])]]
  : ["pi", ["-p", "--mode", "json", "--no-extensions", ...(agent.startsWith("pi-lab") ? ["-e", join(root, "index.ts")] : []), ...(agent === "pi-lab-kb" ? ["-e", join(piKb, "src", "index.ts")] : []), "--session-dir", sessions, ...(model ? ["--model", model] : []), prompt]];

log(`run ${agent}${model ? ` (${model})` : ""}, timeout ${timeoutMin} min`);
const started = Date.now();
const transcript = [];
const exit = await new Promise(resolve => {
  const child = spawn(cmd[0], cmd[1], { cwd: work, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ESPPORT: port, ...(agent === "pi-lab-kb" ? { PI_KB_DIR: kbDir } : {}) } });
  let buf = "";
  child.stdout.on("data", chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { transcript.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  const timer = setTimeout(() => { log("timeout, stopping agent"); child.kill("SIGTERM"); }, timeoutMin * 60_000);
  child.on("close", code => { clearTimeout(timer); resolve(code); });
});
const minutes = (Date.now() - started) / 60_000;
writeFileSync(join(out, "transcript.jsonl"), transcript.join("\n") + "\n");

// Tool calls, from either agent's stream.
const calls = [];
let usage = { input: 0, output: 0, cost: 0 }, finalText = "";
for (const line of transcript) {
  let rec; try { rec = JSON.parse(line); } catch { continue; }
  if (agent === "claude") {
    if (rec.type === "assistant") for (const part of rec.message?.content ?? []) if (part.type === "tool_use") calls.push({ name: part.name, command: part.input?.command });
    if (rec.type === "result") { finalText = rec.result ?? ""; usage = { input: rec.usage?.input_tokens ?? 0, output: rec.usage?.output_tokens ?? 0, cost: rec.total_cost_usd ?? 0 }; }
  } else if (rec.type === "message_end" && rec.message?.role === "assistant") {
    const m = rec.message;
    for (const part of m.content ?? []) if (part.type === "toolCall") calls.push({ name: part.name, command: part.arguments?.command, action: part.arguments?.action });
    usage.input += m.usage?.input ?? 0; usage.output += m.usage?.output ?? 0; usage.cost += m.usage?.cost?.total ?? 0;
    const text = (m.content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n");
    if (text) finalText = text;
  }
}
const isBash = c => c.name === "bash" || c.name === "Bash";
const flashes = calls.filter(c => c.name === "board_flash" || (isBash(c) && /idf\.py[^\n]*\bflash\b|write[-_]flash/.test(c.command ?? ""))).length;
const captures = calls.filter(c => c.name === "board_serial" || (isBash(c) && /serial_capture|\/dev\/(?:cu|tty)|serial\.Serial|miniterm|monitor/.test(c.command ?? ""))).length;
const ledger = calls.filter(c => c.name === "lab_ledger").length;
const kbCalls = calls.filter(c => c.name.startsWith("kb_")).length;
const boardCalls = calls.filter(c => c.name.startsWith("board_")).length;

// Judge the code the agent left behind on a freshly flashed board.
log("judge: build, flash, check");
ensureBoard();
let check, firstCheck;
try {
  check = judge();
  if (!check.pass) {
    // The bugs are deterministic, so a second failure is the agent's; a pass means the board misbehaved the first time.
    log(`judge failed (${check.detail}); recover the board and judge again`);
    firstCheck = check;
    ensureBoard();
    check = judge();
  }
} catch (error) {
  check = { pass: false, detail: `build or flash failed: ${String(error.stderr ?? error.message).slice(-500)}` };
}
const diff = execFileSync("bash", ["-c", "git add -A >/dev/null && git diff --cached HEAD"], { cwd: work, encoding: "utf8", maxBuffer: 64 << 20 });
writeFileSync(join(out, "diff.patch"), diff);

const result = {
  scenario, agent, docs: minimal ? "minimal" : "full", model: model ?? "(default)", pass: check.pass, detail: check.detail,
  ...(firstCheck ? { firstJudge: firstCheck.detail } : {}),
  minutes: Number(minutes.toFixed(1)), exitCode: exit, toolCalls: calls.length, flashes, serialCaptures: captures, ledgerCalls: ledger, kbCalls, boardCalls,
  tokens: { input: usage.input, output: usage.output }, costUsd: Number(usage.cost.toFixed(4)), finalText,
};
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
if (check.log_tail) writeFileSync(join(out, "judge-serial.log"), check.log_tail);
log(`${check.pass ? "PASS" : "FAIL"}: ${check.detail}`);
log(`${result.minutes} min, ${calls.length} tool calls, ${flashes} flashes, ${captures} serial captures, ${ledger} ledger calls, ${kbCalls} kb calls, $${result.costUsd}`);
log(`results: ${out}`);
if (!existsSync(join(out, "result.json"))) process.exit(1);
