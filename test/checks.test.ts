import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProblems, evaluateCheck, renderChecks } from "../src/checks.ts";
import type { LogLine } from "../src/serial-hub.ts";

const log = (...texts: string[]): LogLine[] => texts.map((text, i) => ({ n: i + 1, ts: i, text, kind: "out" }));
const boot = ["ESP-ROM:esp32s3-20210327", "rst:0x15 (USB_UART_CHIP_RESET),boot:0x2b (SPI_FAST_FLASH_BOOT)", "temperature logger started"];

test("expect and forbid look for lines", () => {
  const r = evaluateCheck({ name: "starts", expect: ["logger started"], forbid: ["Guru Meditation"] }, log(...boot));
  assert.equal(r.pass, true);
  assert.deepEqual(r.details, ["PASS expect /logger started/: temperature logger started", "PASS forbid /Guru Meditation/"]);
  const bad = evaluateCheck({ name: "x", expect: ["ready"], forbid: ["rst:0x15"] }, log(...boot));
  assert.equal(bad.pass, false);
  assert.match(bad.details[0]!, /^FAIL expect \/ready\/: never printed/);
  assert.match(bad.details[1]!, /^FAIL forbid/);
});

test("noRestart allows the boot after the reset, and no other", () => {
  assert.equal(evaluateCheck({ name: "stable", noRestart: true }, log(...boot, "t=200 temp=40")).pass, true);
  const restarted = evaluateCheck({ name: "stable", noRestart: true }, log(...boot, "t=200", ...boot, "t=16"));
  assert.equal(restarted.pass, false);
  assert.match(restarted.details[0]!, /booted 1 more time/);
  // Without a reset, any boot is a restart.
  assert.equal(evaluateCheck({ name: "stable", noRestart: true, reset: false }, log("t=200", ...boot)).pass, false);
});

test("a metric must stay in range, and change when it is a live reading", () => {
  const live = log("t=200 temp=40.1", "t=400 temp=40.3", "t=600 temp=40.2");
  assert.equal(evaluateCheck({ name: "temp", metric: { pattern: "temp=(-?[\\d.]+)", min: 10, max: 80, changes: true, atLeast: 3 } }, live).pass, true);
  const stuck = evaluateCheck({ name: "temp", metric: { pattern: "temp=(-?[\\d.]+)", changes: true } }, log("temp=0", "temp=0"));
  assert.equal(stuck.pass, false);
  assert.match(stuck.details.at(-1)!, /every value was 0, not a live reading/);
  const out = evaluateCheck({ name: "temp", metric: { pattern: "temp=(-?[\\d.]+)", max: 30 } }, live);
  assert.match(out.details[0]!, /^FAIL metric in \[-∞, 30\]: 3 values from 40.1 to 40.3/);
  assert.match(evaluateCheck({ name: "temp", metric: { pattern: "temp=(\\d+)", atLeast: 5 } }, live).details[0]!, /3 value\(s\), expected at least 5/);
});

test("a silent board cannot be judged, and checks that say nothing are caught before running", () => {
  assert.equal(evaluateCheck({ name: "x", expect: ["a"] }, []).pass, null);
  assert.deepEqual(checkProblems({ name: "x" }), ["x: says nothing to check (expect, forbid, noRestart or metric)"]);
  assert.match(checkProblems({ name: "x", expect: ["("] })[0]!, /not a valid regular expression/);
  assert.match(checkProblems({ name: "x", metric: { pattern: "temp=\\d+" } })[0]!, /capture group/);
});

test("the report reads like the acceptance list", () => {
  const text = renderChecks([
    { name: "temperature keeps updating", pass: true, details: ["PASS metric changes"] },
    { name: "runs without restarting", pass: false, details: ["FAIL no restart: the board booted 1 more time(s) while watched"] },
    { name: "after power loss", pass: null, details: ["the board printed nothing while watched"] },
  ]);
  assert.match(text, /^\[PASS\] temperature keeps updating$/m);
  assert.match(text, /^\[FAIL\] runs without restarting$/m);
  assert.match(text, /^\[----\] after power loss$/m);
  assert.match(text, /1\/3 checks pass\.$/);
});
