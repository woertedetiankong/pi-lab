import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SerialHub } from "../src/serial-hub.ts";

const fake = join(import.meta.dirname, "fixtures", "fake-broker.mjs");
const hub = (idleMs = 30_000) => new SerialHub({ python: process.execPath, script: fake, port: "/dev/fake", idleMs });

test("a capture after reset joins split lines and stops at the pattern", async () => {
  const h = hub();
  const lines = await h.capture({ seconds: 3, until: /app: ready/ });
  h.stop();
  const text = lines.map(l => l.text);
  assert.ok(text.includes("reset"), "reset marker");
  assert.ok(text.includes("boot_count=3 (reset reason 11)"), `joined line in ${JSON.stringify(text)}`);
  assert.ok(text.some(t => t.endsWith("app: ready")));
  assert.ok(!text.some(t => t.includes("\r")));
});

test("lines are numbered, kept, and waited for", async () => {
  const h = hub();
  h.viewed();
  const first = await h.wait(0, 2000);
  assert.ok(first.length > 0);
  const after = first[first.length - 1]!.n;
  const more = await h.wait(after, 2000);
  assert.ok(more.every(l => l.n > after) && more.length > 0);
  assert.deepEqual(h.since(after).map(l => l.n), more.map(l => l.n).concat(h.since(after).slice(more.length).map(l => l.n)));
  h.stop();
});

test("release and acquire", async () => {
  const h = hub();
  h.viewed();
  await h.wait(0, 1000);
  await h.release();
  assert.equal(h.state, "released");
  await h.acquire();
  assert.equal(h.state, "open");
  h.stop();
});

test("the port is released when nobody needs it", async () => {
  const h = hub(200);
  await h.capture({ seconds: 0.3, reset: false });
  await new Promise(r => setTimeout(r, 5600));
  assert.equal(h.state, "released");
  h.stop();
});

test("markers and listeners", async () => {
  const h = hub();
  const seen: string[] = [];
  h.onLine(l => seen.push(`${l.kind}:${l.text}`));
  h.mark("flashed a3f2");
  assert.deepEqual(seen, ["mark:flashed a3f2"]);
  h.stop();
});

test("a boot that stops at the bootloader's hand-off is recovered once", async () => {
  let recovered = 0;
  const h = new SerialHub({ python: process.execPath, script: fake, scriptArgs: ["--stall-first"], port: "/dev/fake", recover: async () => { recovered++; } });
  const lines = await h.capture({ seconds: 8, until: /app: ready/ });
  h.stop();
  const text = lines.map(l => l.text);
  assert.equal(recovered, 1);
  assert.ok(text.some(t => t.includes("re-enumerating")), "marker");
  assert.ok(text.includes("boot_count=3 (reset reason 11)"), "full boot after the second reset");
});

test("a normal boot is left alone", async () => {
  let recovered = 0;
  const h = new SerialHub({ python: process.execPath, script: fake, port: "/dev/fake", recover: async () => { recovered++; } });
  await h.capture({ seconds: 3, until: /app: ready/ });
  h.stop();
  assert.equal(recovered, 0);
});
