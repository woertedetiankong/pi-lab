import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAction, emptyLedger, type Ledger, renderLedger, similar } from "../src/ledger.ts";

const apply = (ledger: Ledger, ...acts: Parameters<typeof applyAction>[1][]) => acts.reduce((l, a) => applyAction(l, a).ledger, ledger);

test("ids increase per kind and survive removal", () => {
  let l = apply(emptyLedger(), { action: "add_fact", text: "I2C clock is 400 kHz" }, { action: "add_hypothesis", text: "pull-ups too weak" }, { action: "add_hypothesis", text: "timing register wrong" });
  assert.deepEqual(l.facts.map(f => f.id), ["F1"]);
  assert.deepEqual(l.hypotheses.map(h => h.id), ["H1", "H2"]);
  l = apply(l, { action: "remove", id: "H1" }, { action: "add_hypothesis", text: "sensor needs config blob" });
  assert.deepEqual(l.hypotheses.map(h => h.id), ["H2", "H3"]);
});

test("settling a hypothesis requires evidence", () => {
  const l = apply(emptyLedger(), { action: "add_hypothesis", text: "pull-ups too weak" });
  const refused = applyAction(l, { action: "update", id: "H1", status: "ruled_out" });
  assert.equal(refused.changed, false);
  const done = applyAction(l, { action: "update", id: "H1", status: "ruled_out", evidence: "scope shows 300 ns rise time" });
  assert.equal(done.ledger.hypotheses[0]!.status, "ruled_out");
});

test("re-adding a ruled-out idea is refused unless forced", () => {
  const l = apply(emptyLedger(), { action: "add_hypothesis", text: "I2C pull-up resistors too weak" }, { action: "update", id: "H1", status: "ruled_out", evidence: "rise time fine" });
  const again = applyAction(l, { action: "add_hypothesis", text: "the pull-up resistors on I2C are too weak" });
  assert.equal(again.changed, false);
  assert.match(again.message, /H1/);
  assert.equal(applyAction(l, { action: "add_hypothesis", text: "the pull-up resistors on I2C are too weak", force: true }).changed, true);
  assert.equal(applyAction(l, { action: "add_hypothesis", text: "BMI270 config file not uploaded" }).changed, true);
});

test("similarity works for Chinese text", () => {
  assert.ok(similar("I2C 上拉电阻太弱", "上拉电阻不够 I2C"));
  assert.ok(!similar("I2C 上拉电阻太弱", "SPI 时钟分频错误"));
});

test("render shows target, firmware and status marks", () => {
  const l = apply(emptyLedger(), { action: "set_target", text: "STM32F407" }, { action: "add_hypothesis", text: "clock wrong" }, { action: "update", id: "H1", status: "confirmed", evidence: "RCC_CFGR=0x0" });
  const text = renderLedger(l, "board runs a3f2");
  assert.match(text, /Target: STM32F407/);
  assert.match(text, /Firmware: board runs a3f2/);
  assert.match(text, /\[✓\] H1 clock wrong \(evidence: RCC_CFGR=0x0\)/);
});
