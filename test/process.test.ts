import assert from "node:assert/strict";
import { test } from "node:test";
import { CAREFUL_GUIDELINES, carefulMessage, CORE_GUIDELINES, escalation, TOOL_CALLS_BEFORE_CAREFUL } from "../src/process.ts";

const quiet = { toolCalls: 3, flashes: 1, unsettled: false, ledgerUsed: false };

test("a task that goes straight to a fix stays light", () => {
  assert.equal(escalation(quiet), undefined);
  assert.equal(escalation({ ...quiet, toolCalls: TOOL_CALLS_BEFORE_CAREFUL - 1 }), undefined);
});

test("a task that resists turns careful, and says why", () => {
  assert.match(escalation({ ...quiet, flashes: 2 })!, /second flash/);
  assert.match(escalation({ ...quiet, unsettled: true })!, /answered differently/);
  assert.match(escalation({ ...quiet, ledgerUsed: true })!, /debug ledger/);
  assert.match(escalation({ ...quiet, toolCalls: TOOL_CALLS_BEFORE_CAREFUL })!, /20 tool calls/);
});

test("light guidance points to experiments; the ledger rules come only in careful mode", () => {
  const light = CORE_GUIDELINES.join("\n");
  assert.match(light, /board_experiment/);
  assert.doesNotMatch(light, /lab_ledger|verify_fact/);
  const careful = carefulMessage("the second flash");
  assert.match(careful, /^pi-lab: switching to careful mode because the second flash\./);
  for (const line of CAREFUL_GUIDELINES) assert.ok(careful.includes(line));
  // The rule the bench showed was over-applied: reproducing is for building on a fact, and host-side changes need no rebuild.
  assert.match(careful, /not as a closing ritual/);
  assert.match(careful, /host-side scripts and tools, the same run again/);
});
