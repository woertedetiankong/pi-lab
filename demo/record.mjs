// Records the demo video without anyone at the keyboard: the board panel on the left, what pi does on the right,
// captions below. Everything in it is live: the real board, the real agent, the real datasheet.
//
// Usage: node demo/record.mjs [--lang zh|en] [--dir ~/pi-lab-demo] [--out demo/out/pi-lab-demo-zh.mp4]
// Needs: an M5StickS3 on USB, ESP-IDF v6.0.1, Google Chrome, ffmpeg, pi with a model configured, and pi-kb checked out
// next to this repository (../pi-knowledge) for the datasheet citations.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const lang = arg("--lang", "zh");
const dir = arg("--dir", join(homedir(), "pi-lab-demo"));
const out = arg("--out", join(here, "out", `pi-lab-demo-${lang}.mp4`));
const piKb = arg("--pi-kb", join(dirname(repo), "pi-knowledge", "src", "index.ts"));
const W = 1600, H = 900;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

const TEXT = {
  zh: {
    question: "为什么加速度读数一直是 0？板子是静止放着的。",
    c1: "M5StickS3 静止放在桌上，加速度计应该读到 1 g。实际读数：全是 0",
    c2: "在 pi-lab 面板上选中这几行日志，直接问 pi",
    c3: "pi 查 BMI270 原版手册（带页码）、读代码、改代码、烧录、看串口（5 倍速）",
    c4: "修好了：|a| ≈ 1.00 g，结果在真实板子上验证",
    end1: "pi-lab：给 pi 用的嵌入式调试插件",
    end2: "实时串口面板 · 指着日志问 AI · 板级工具 · 崩溃解码 · 芯片手册引用",
    terminal: "pi（终端）",
    working: "pi 正在工作…",
    done: "完成",
  },
  en: {
    question: "Why does the accelerometer always read 0? The board is lying still.",
    c1: "An M5StickS3 lying still should read 1 g from its accelerometer. It reads all zeros",
    c2: "Select the lines in the pi-lab panel and ask pi about them",
    c3: "pi reads Bosch's BMI270 datasheet (with page citations), the code, fixes it, flashes, reads the board (5× speed)",
    c4: "Fixed: |a| ≈ 1.00 g, verified on the real board",
    end1: "pi-lab: embedded debugging for the pi coding agent",
    end2: "Live serial panel · ask about the log · board tools · crash decoding · datasheet citations",
    terminal: "pi (terminal)",
    working: "pi is working…",
    done: "done",
  },
}[lang];

// ---- 1. the board, back to the bug ----
log("restoring the demo project and flashing the bug");
execFileSync(join(here, "setup.sh"), [dir], { stdio: "inherit" });

// ---- 2. pi with pi-lab and pi-kb, in its own config and knowledge base ----
const agentDir = mkdtempSync(join(tmpdir(), "pi-lab-demo-agent-"));
for (const f of ["auth.json", "models.json"]) if (existsSync(join(homedir(), ".pi/agent", f))) cpSync(join(homedir(), ".pi/agent", f), join(agentDir, f));
const settings = JSON.parse(readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8"));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel, packages: [] }));
// The knowledge base holds only Bosch's datasheet: the board pack's notes describe this very bug, and an agent that
// looks the answer up would show nothing.
const kbDir = mkdtempSync(join(tmpdir(), "pi-lab-demo-kb-"));
{
  const { KnowledgeBase } = await import(join(dirname(piKb), "kb.ts"));
  const kb = new KnowledgeBase(kbDir);
  const added = await kb.addFile(join(dir, "docs", "BMI270-datasheet.pdf"));
  kb.close();
  log(`knowledge base: ${added.doc?.title} (${added.doc?.pages} pages)`);
}
const pi = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "-e", join(repo, "index.ts"), ...(existsSync(piKb) ? ["-e", piKb] : [])],
  { cwd: dir, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_KB_DIR: kbDir, PI_LAB_BOARD: "none" } });

// What the right-hand pane shows, built from pi's event stream.
const items = [];   // { kind: "say" | "tool" | "result" | "status", text }
let settled = false, url;
const add = (kind, text) => items.push({ kind, text });
const summarize = (name, a = {}) => {
  if (name === "bash") return `$ ${String(a.command ?? "").split("\n")[0].replace(/source \S+export\.sh >\/dev\/null 2>&1\s*(&&|;)\s*/, "").slice(0, 90)}`;
  if (name === "read" || name === "edit" || name === "write") return `${name} ${String(a.path ?? "").replace(dir + "/", "")}`;
  if (name === "kb_search") return `kb_search "${a.query}"`;
  if (name === "kb_read") return `kb_read ${a.id ?? ""} ${a.pages ? `p.${a.pages}` : ""}`;
  if (name === "lab_ledger") return `lab_ledger ${a.action} ${String(a.text ?? a.id ?? "").slice(0, 70)}`;
  return `${name} ${Object.keys(a).length ? JSON.stringify(a).slice(0, 70) : ""}`;
};
let buf = "";
pi.stdout.on("data", chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type === "extension_ui_request" && r.method === "notify") { const m = /(http:\/\/\S+)/.exec(r.message ?? ""); if (m) url = m[1]; }
    // Nobody is at the keyboard: decline what pi-lab's guard asks about, cancel other dialogs.
    if (r.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(r.method)) {
      pi.stdin.write(JSON.stringify(r.method === "confirm" ? { type: "extension_ui_response", id: r.id, confirmed: false } : { type: "extension_ui_response", id: r.id, cancelled: true }) + "\n");
      add("status", `(${r.title ?? r.method}: declined)`);
    }
    if (r.type === "message_update" && r.assistantMessageEvent?.type === "text_delta") {
      const last = items[items.length - 1];
      if (last?.kind === "say") last.text += r.assistantMessageEvent.delta; else add("say", r.assistantMessageEvent.delta);
    }
    if (r.type === "tool_execution_start") add("tool", summarize(r.toolName, r.args));
    if (r.type === "tool_execution_end") {
      const text = (r.result?.content ?? []).map(c => c.text ?? "").join(" ").replace(/\s+/g, " ").trim();
      add("result", (r.isError ? "✗ " : "") + text.slice(0, 160));
    }
    if (r.type === "agent_settled") settled = true;
  }
});

// ---- 3. a small server the page overlay reads the pane from ----
const stage = createServer((req, res) => {
  const since = Number(new URL(req.url, "http://x").searchParams.get("since") ?? 0);
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify({ items: items.slice(since), total: items.length, settled }));
});
await new Promise(r => stage.listen(47400, "127.0.0.1", r));

await sleep(3000);
pi.stdin.write(JSON.stringify({ type: "prompt", message: "/lab web url" }) + "\n");
for (let i = 0; i < 60 && !url; i++) await sleep(250);
if (!url) throw new Error("the board panel did not start");
const token = /token=([a-f0-9]+)/.exec(url)[1];
const origin = new URL(url).origin;
const panelApi = async (path, body) => (await fetch(`${origin}/api/lab${path}`, body ? { method: "POST", headers: { "x-token": token, "content-type": "application/json" }, body: JSON.stringify(body) } : { headers: { "x-token": token } })).json();
await sleep(4000);

// ---- 4. Chrome, driven over the DevTools protocol ----
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ["--headless=new", "--disable-gpu", "--remote-debugging-port=9334", `--user-data-dir=${mkdtempSync(join(tmpdir(), "pi-lab-demo-chrome-"))}`, "about:blank"], { stdio: "ignore" });
await sleep(2500);
const target = await (await fetch("http://127.0.0.1:9334/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let cdpId = 0;
const pending = new Map();
ws.addEventListener("message", e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m.result); pending.delete(m.id); });
const cdp = (method, params = {}) => new Promise(r => { const id = ++cdpId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const js = async expression => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await cdp("Page.navigate", { url: `${origin}/lab/?lang=${lang}#token=${token}` });
await sleep(4000);

// The overlay: the pane with what pi does, a title, captions, and the end card.
await js(`(() => {
  const css = document.createElement("style");
  css.textContent = \`
    body { width: 62%; }
    #askBar { right: calc(38% + 16px) !important; bottom: 86px !important; }
    #demoPane { position: fixed; top: 0; right: 0; width: 38%; height: 100%; background: #111110; color: #e8e7e2; font: 13px/1.5 ui-monospace, Menlo, monospace; display: flex; flex-direction: column; border-left: 1px solid #333; }
    #demoPane h2 { margin: 0; padding: 12px 16px; font: 600 13px -apple-system, sans-serif; color: #a09f97; border-bottom: 1px solid #2c2c29; display: flex; justify-content: space-between; }
    #demoItems { flex: 1; overflow: hidden; padding: 10px 16px 120px; display: flex; flex-direction: column; justify-content: flex-end; }
    #demoItems div { margin: 3px 0; white-space: pre-wrap; word-break: break-word; }
    #demoItems .say { color: #ecebe6; font-family: -apple-system, "PingFang SC", sans-serif; font-size: 14px; }
    #demoItems .tool { color: #7b8cff; }
    #demoItems .result { color: #8f8e86; font-size: 12px; padding-left: 14px; }
    #demoCaption { position: fixed; left: 0; bottom: 0; width: 100%; padding: 16px 28px; background: rgba(15,15,14,.88); color: #fff; font: 600 24px/1.4 -apple-system, "PingFang SC", sans-serif; text-align: center; z-index: 20; transition: opacity .3s; }
    #demoCaption:empty { opacity: 0; }
    #demoEnd { position: fixed; inset: 0; background: #111110; color: #fff; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 18px; z-index: 30; font-family: -apple-system, "PingFang SC", sans-serif; }
    #demoEnd b { font-size: 46px; } #demoEnd span { font-size: 22px; color: #c9c8c0; } #demoEnd code { font: 20px ui-monospace, Menlo, monospace; color: #9aa8ff; background: #1e1e1c; padding: 10px 18px; border-radius: 10px; }
  \`;
  document.head.appendChild(css);
  const pane = document.createElement("div");
  pane.id = "demoPane";
  pane.innerHTML = '<h2><span>${TEXT.terminal}</span><span id="demoState"></span></h2><div id="demoItems"></div>';
  document.body.appendChild(pane);
  const cap = document.createElement("div"); cap.id = "demoCaption"; document.body.appendChild(cap);
  const end = document.createElement("div"); end.id = "demoEnd";
  end.innerHTML = '<b>${TEXT.end1}</b><span>${TEXT.end2}</span><code>pi install git:github.com/woertedetiankong/pi-lab</code>';
  document.body.appendChild(end);
  let seen = 0;
  const box = document.getElementById("demoItems");
  setInterval(async () => {
    try {
      const r = await (await fetch("http://127.0.0.1:47400/?since=0")).json();
      box.textContent = "";
      for (const it of r.items.slice(-40)) { const d = document.createElement("div"); d.className = it.kind; d.textContent = (it.kind === "tool" ? "⚙ " : "") + it.text; box.appendChild(d); }
      document.getElementById("demoState").textContent = r.items.length ? (r.settled ? "${TEXT.done}" : "${TEXT.working}") : "";
    } catch {}
  }, 300);
  window.__caption = t => { cap.textContent = t; };
  window.__end = () => { end.style.display = "flex"; };
  return true;
})()`);

// ---- 5. frames: a steady capture; `speed` says how fast that stretch plays back ----
const framesDir = mkdtempSync(join(tmpdir(), "pi-lab-demo-frames-"));
const frames = [];
let speed = 1, capturing = true;
const capture = (async () => {
  while (capturing) {
    const started = Date.now();
    const shot = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 88 });
    const file = join(framesDir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    const interval = speed > 1 ? 1000 : 200;
    frames.push({ file, seconds: interval / 1000 / speed });
    await sleep(Math.max(0, interval - (Date.now() - started)));
  }
})();

// ---- 6. the script ----
const caption = t => js(`window.__caption(${JSON.stringify(t)})`);
log("scene 1: all zeros");
await caption(TEXT.c1);
await sleep(7000);

log("scene 2: select the zero lines and ask");
await caption(TEXT.c2);
await js(`(() => {
  const rows = [...document.querySelectorAll(".row")].filter(r => /accel x=/.test(r.textContent)).slice(-5);
  rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
  rows[rows.length - 1].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  return rows.length;
})()`);
await sleep(1200);
for (const ch of TEXT.question) {
  await js(`(() => { const q = document.getElementById("question"); q.value += ${JSON.stringify(ch)}; q.dispatchEvent(new Event("input")); })()`);
  await sleep(70);
}
await sleep(800);
await js(`document.getElementById("ask").click()`);
await sleep(2500);

log("scene 3: pi works (sped up)");
await caption(TEXT.c3);
speed = 5;
const deadline = Date.now() + 25 * 60_000;
while (!settled && Date.now() < deadline) await sleep(1000);
speed = 1;
log(settled ? "pi is done" : "pi did not finish in 25 minutes");

log("scene 4: fixed");
await caption(TEXT.c4);
// Wait for the board to print readings around 1 g, then show them for a while.
for (let i = 0; i < 60; i++) {
  const lines = (await panelApi("/lines?since=0")).lines;
  const m = [...lines].reverse().map(l => /\|a\|=(-?[\d.]+)/.exec(l.text)).find(Boolean);
  if (m && Number(m[1]) > 0.9) break;
  await sleep(1000);
}
await sleep(9000);
await caption("");
await js("window.__end()");
await sleep(6000);
capturing = false;
await capture;

// ---- 7. the video ----
mkdirSync(dirname(out), { recursive: true });
const list = join(framesDir, "frames.txt");
writeFileSync(list, frames.map(f => `file '${f.file}'\nduration ${f.seconds.toFixed(4)}`).join("\n") + `\nfile '${frames[frames.length - 1].file}'\n`);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=30,scale=${W}:${H},format=yuv420p`, "-c:v", "libx264", "-crf", "21", "-movflags", "+faststart", out], { stdio: "inherit" });
const duration = frames.reduce((s, f) => s + f.seconds, 0);
log(`video: ${out} (${duration.toFixed(0)} s, ${frames.length} frames)`);

ws.close(); chrome.kill(); pi.kill(); stage.close();
process.exit(0);
