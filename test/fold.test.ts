import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FOLD, foldLogs, foldText } from "../src/fold.ts";

const log = (n: number, bad = 50) => Array.from({ length: n }, (_, i) => i === bad ? "E (1234) i2c: i2c_master_cmd_begin(1498): I2C bus busy" : `I (${i}) app: tick ${i}`).join("\n");

test("short output stays whole", () => {
  assert.equal(foldText(log(20), DEFAULT_FOLD), undefined);
});

test("long output keeps head, tail and failure lines", () => {
  const folded = foldText(log(500), DEFAULT_FOLD)!;
  assert.match(folded, /folded from 500/);
  assert.match(folded, /I2C bus busy/);
  assert.match(folded, /tick 0\n/);
  assert.match(folded, /tick 499$/);
  assert.ok(folded.split("\n").length < 40);
});

let n = 0;
const call = (command: string) => {
  const id = `c${n++}`;
  return [
    { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "toolUse", timestamp: 0 },
    { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: log(300) }], isError: false, timestamp: 0 },
  ];
};

test("only older hardware logs are folded", () => {
  const messages = [...call("idf.py monitor"), ...call("ls -la"), ...call("idf.py flash"), ...call("idf.py monitor")] as never[];
  const out = foldLogs(messages) as { role: string; content: { text?: string }[] }[];
  const texts = out.filter(m => m.role === "toolResult").map(m => m.content[0]!.text!);
  assert.match(texts[0]!, /folded/, "oldest monitor log folded");
  assert.doesNotMatch(texts[1]!, /folded/, "non-hardware command untouched");
  assert.doesNotMatch(texts[2]!, /folded/, "two newest logs kept");
  assert.doesNotMatch(texts[3]!, /folded/);
  assert.notEqual(out, messages);
  assert.equal(foldLogs([...call("idf.py monitor")] as never[]), undefined);
});
