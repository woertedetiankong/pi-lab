import assert from "node:assert/strict";
import { test } from "node:test";
import { crashAddresses, formatFrames } from "../src/crash.ts";

test("addresses from crash lines", () => {
  assert.deepEqual(crashAddresses("Backtrace: 0x4037a73f:0x3fc98d70 0x4200854d:0x3fc98d90 0x40379ae5:0x3fc98db0 |<-CORRUPTED"), ["0x4037a73f", "0x4200854d", "0x40379ae5"]);
  assert.deepEqual(crashAddresses("abort() was called at PC 0x4037a73f on core 0"), ["0x4037a73f"]);
  assert.deepEqual(crashAddresses("PC      : 0x42008a40  PS      : 0x00060630  A0      : 0x82008b5c"), ["0x42008a40"]);
  assert.equal(crashAddresses("I (100) app: value=0x42008a40"), undefined);
  assert.equal(crashAddresses("accel x=0.1"), undefined);
});

test("frames read relative to the project", () => {
  const out = "0x4200854d: wr at /work/fw/main/main.c:12 (discriminator 2)\n0x40379ae5: abort at /Users/x/.espressif/v6.0.1/esp-idf/components/newlib/src/abort.c:38\n0x40000000: ?? ??:0\n";
  assert.deepEqual(formatFrames(out, "/work/fw"), [
    "0x4200854d: wr at main/main.c:12",
    "0x40379ae5: abort at IDF components/newlib/src/abort.c:38",
    "0x40000000: ?? ??:0",
  ]);
});
