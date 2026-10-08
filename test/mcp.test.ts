import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const server = join(import.meta.dirname, "..", "src", "mcp.ts");

/** Start the server in an empty project, send requests, collect the answers by id. */
async function session(requests: object[]): Promise<Map<number, { result?: Record<string, unknown>; error?: { code: number } }>> {
  const project = mkdtempSync(join(tmpdir(), "pi-lab-mcp-"));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", server], { cwd: project, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PI_LAB_BOARD: "" } });
  const answers = new Map();
  let buf = "";
  const want = requests.filter(r => "id" in r).length;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`only ${answers.size}/${want} answers`)), 15_000);
    child.stdout.on("data", chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const message = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        answers.set(message.id, message);
        if (answers.size === want) { clearTimeout(timer); resolve(); }
      }
    });
  });
  for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...r }) + "\n");
  await done;
  child.stdin.end();
  return answers;
}

test("the MCP server introduces itself and lists the board tools with their schemas", async () => {
  const a = await session([
    { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "ping" },
  ]);
  const init = a.get(1)!.result!;
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.deepEqual((init.serverInfo as { name: string }).name, "pi-lab");
  assert.match(String(init.instructions), /board_experiment/);
  const tools = (a.get(2)!.result!.tools as { name: string; inputSchema: { type: string } }[]);
  assert.deepEqual(tools.map(t => t.name), ["board_serial", "board_flash", "board_recover", "board_experiment", "lab_note", "board_check", "board_logic"]);
  assert.ok(tools.every(t => t.inputSchema.type === "object"));
  assert.deepEqual(a.get(3)!.result, {});
});

test("tool failures are results the agent reads; unknown methods are protocol errors", async () => {
  const a = await session([
    { id: 1, method: "tools/call", params: { name: "lab_note", arguments: { experiment: "E9", title: "x" } } },
    { id: 2, method: "tools/call", params: { name: "board_check", arguments: {} } },
    { id: 3, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
    { id: 4, method: "resources/list" },
    { id: 5, method: "tools/call", params: { name: "board_experiment", arguments: { question: "q", variants: [], measure: { source: "output", match: "x" } } } },
  ]);
  const text = (id: number) => (a.get(id)!.result!.content as { text: string }[])[0]!.text;
  assert.equal(a.get(1)!.result!.isError, true);
  assert.match(text(1), /No experiment E9/);
  assert.equal(a.get(2)!.result!.isError, false);
  assert.match(text(2), /no board checks/);
  assert.equal(a.get(3)!.error!.code, -32602);
  assert.equal(a.get(4)!.error!.code, -32601);
  assert.match(text(5), /at least one variant/);
});
