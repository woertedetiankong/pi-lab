import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { looksGarbled } from "../src/board-tools.ts";
import { readLabConfig, updateLabConfig } from "../src/project-config.ts";

const out = (text: string, n = 1) => ({ n, ts: 0, text, kind: "out" as const });

test("text at the wrong baud rate looks garbled", () => {
  // What 115200 baud output looks like when read at 9600.
  const wrong = "�\u0000x��\u0003��\u0018f��\u0000�~��\u0006����\u0000��`��\u0000�x��\u0000����";
  assert.ok(looksGarbled([out(wrong)]));
  assert.ok(!looksGarbled([out("I (1757) boot: saved boot_count=1"), out("accel x=-0.032 y=-0.023 z=0.996 |a|=0.997")]));
  assert.ok(!looksGarbled([out("�")]), "too little to tell");
});

test("project settings merge and remove", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-cfg-"));
  updateLabConfig(root, { board: "m5sticks3" });
  updateLabConfig(root, { serial: { port: "/dev/cu.usbserial-1410", baud: 9600 } });
  assert.deepEqual(readLabConfig(root), { board: "m5sticks3", serial: { port: "/dev/cu.usbserial-1410", baud: 9600 } });
  updateLabConfig(root, { board: undefined });
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".pi", "lab.json"), "utf8")), { serial: { port: "/dev/cu.usbserial-1410", baud: 9600 } });
});
