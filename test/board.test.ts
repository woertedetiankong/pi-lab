import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildErrors, findIdfExport, findPorts, flashFailure, projectKind, toolchainPrefix } from "../src/board.ts";

const temp = () => mkdtempSync(join(tmpdir(), "pi-lab-board-"));

test("finds board-like serial ports only", () => {
  const dev = temp();
  const names = process.platform === "darwin"
    ? ["cu.usbmodem101", "cu.Bluetooth-Incoming-Port", "cu.debug-console", "cu.usbserial-0001", "tty.usbmodem101"]
    : ["ttyACM0", "ttyS0", "ttyUSB0", "tty1"];
  for (const n of names) writeFileSync(join(dev, n), "");
  const found = findPorts(dev).map(p => p.split("/").pop()).sort();
  assert.deepEqual(found, process.platform === "darwin" ? ["cu.usbmodem101", "cu.usbserial-0001"] : ["ttyACM0", "ttyUSB0"]);
});

test("ESP-IDF: IDF_PATH first, else the newest install", () => {
  const home = temp();
  for (const v of ["v5.4", "v6.0.1", "v5.10"]) {
    mkdirSync(join(home, ".espressif", v, "esp-idf"), { recursive: true });
    writeFileSync(join(home, ".espressif", v, "esp-idf", "export.sh"), "");
  }
  assert.equal(findIdfExport({}, home), join(home, ".espressif", "v6.0.1", "esp-idf", "export.sh"));
  const custom = join(home, "idf");
  mkdirSync(custom);
  writeFileSync(join(custom, "export.sh"), "");
  assert.equal(findIdfExport({ IDF_PATH: custom }, home), join(custom, "export.sh"));
  assert.equal(findIdfExport({}, temp()), undefined);
  assert.match(toolchainPrefix("esp-idf", {}, home), /^source '.*v6\.0\.1\/esp-idf\/export\.sh' >\/dev\/null 2>&1 && $/);
});

test("project kind", () => {
  const idf = temp();
  writeFileSync(join(idf, "CMakeLists.txt"), "include($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(x)\n");
  assert.equal(projectKind(idf), "esp-idf");
  const pio = temp();
  writeFileSync(join(pio, "platformio.ini"), "[env:x]\n");
  assert.equal(projectKind(pio), "platformio");
  assert.equal(projectKind(temp()), undefined);
});

test("flash failures and build errors", () => {
  assert.equal(flashFailure("A fatal error occurred: Failed to connect to ESP32-S3: No serial data received."), "no-connect");
  assert.equal(flashFailure("could not open port /dev/cu.usbmodem101: [Errno 16] Resource busy"), "port-busy");
  assert.equal(flashFailure("main.c:12:5: error: 'x' undeclared\nninja: build stopped: subcommand failed."), "build");
  const log = "[1/9] Building C object\n/p/main/main.c:12:5: error: 'x' undeclared\n/p/main/main.c:12:5: error: 'x' undeclared\nninja: build stopped: subcommand failed.\n";
  assert.equal(buildErrors(log), "/p/main/main.c:12:5: error: 'x' undeclared");
});
