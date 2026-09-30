import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { compare, isFirmwareFile, isFlashCommand, type Run, sourceState } from "../src/firmware.ts";

test("flash commands are recognised, build commands are not", () => {
  for (const c of ["idf.py -p /dev/ttyUSB0 flash monitor", "pio run -t upload", "west flash", "openocd -f board.cfg -c 'program build/app.elf verify reset exit'",
    "probe-rs download --chip STM32F407VG app.elf", "esptool.py --chip esp32 write_flash 0x1000 app.bin", "st-flash write app.bin 0x8000000",
    "STM32_Programmer_CLI -c port=SWD -w app.hex -v -rst", "nrfjprog --program app.hex --sectorerase", "make flash", "cargo flash --chip nRF52840_xxAA"]) {
    assert.ok(isFlashCommand(c), c);
  }
  for (const c of ["idf.py build", "pio run", "west build -b nrf52840dk", "make -j8", "cat flash.c", "git log --grep flash"]) {
    assert.ok(!isFlashCommand(c), c);
  }
});

test("firmware files", () => {
  assert.ok(isFirmwareFile("main/app_main.c"));
  assert.ok(isFirmwareFile("CMakeLists.txt"));
  assert.ok(isFirmwareFile("boards/prj.conf"));
  assert.ok(isFirmwareFile("sdkconfig.defaults"));
  assert.ok(!isFirmwareFile("README.md"));
  assert.ok(!isFirmwareFile("docs/notes.txt"));
});

const exec = promisify(execFile);
const runIn = (cwd: string): Run => async (command, args) => {
  try {
    const { stdout } = await exec(command, args, { cwd });
    return { stdout, code: 0 };
  } catch (error) {
    return { stdout: "", code: (error as { code?: number }).code ?? 1 };
  }
};

test("fingerprint changes with firmware edits only, and works from a subdirectory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-"));
  const git = (...args: string[]) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  await git("init", "-q");
  writeFileSync(join(dir, "main.c"), "int main(void) { return 0; }\n");
  await git("add", ".");
  await git("commit", "-qm", "init");
  const run = runIn(dir);

  const flashed = (await sourceState(run))!;
  const flash = { at: Date.now(), command: "make flash", ...flashed };
  assert.equal(compare(flash, await sourceState(run)).kind, "synced");

  writeFileSync(join(dir, "README.md"), "docs\n");
  assert.equal(compare(flash, await sourceState(run)).kind, "synced", "docs do not make firmware stale");

  writeFileSync(join(dir, "main.c"), "int main(void) { return 1; }\n");
  const edited = await sourceState(run);
  assert.equal(compare(flash, edited).kind, "stale");
  assert.match(edited!.source, /\+ 1 changed file$/);

  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "new.c"), "void f(void) {}\n");
  const fromSub = await sourceState(runIn(join(dir, "src")));
  assert.equal(fromSub!.fingerprint, (await sourceState(run))!.fingerprint);
  writeFileSync(join(dir, "src", "new.c"), "void f(void) { for (;;); }\n");
  assert.notEqual((await sourceState(run))!.fingerprint, fromSub!.fingerprint, "untracked file content counts");
});

test("outside git the state is unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-nogit-"));
  assert.equal(await sourceState(runIn(dir)), undefined);
  assert.equal(compare(undefined, undefined).kind, "unknown");
});
