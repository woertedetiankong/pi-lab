import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCommand, checkWrite, simpleCommands, writeTargets } from "../src/guard.ts";

const home = "/Users/dev";
const cwd = "/work/fw";
const env = { IDF_PATH: "/Users/dev/.espressif/v6.0.1/esp-idf" };
const roots = ["/Users/dev/.espressif", "/Users/dev/.platformio", "/opt/homebrew"];
const cmd = (c: string) => checkCommand(c, cwd, roots, home, env);

test("tokenizer keeps redirections apart and splits on operators", () => {
  assert.deepEqual(simpleCommands("source ~/a.sh >/dev/null 2>&1 && idf.py build | tail -3"), [
    ["source", "~/a.sh", ">", "/dev/null", "2>&1"], ["idf.py", "build"], ["tail", "-3"],
  ]);
  assert.deepEqual(simpleCommands(`sed -i 's/a b/c;d/' "x y.c"; echo ok`), [["sed", "-i", "s/a b/c;d/", "x y.c"], ["echo", "ok"]]);
});

test("write targets", () => {
  assert.deepEqual(writeTargets(["sed", "-i", "s/a/b/", "f.c"]), ["f.c"]);
  assert.deepEqual(writeTargets(["cp", "a", "b", "dest/"]), ["dest/"]);
  assert.deepEqual(writeTargets(["echo", "x", ">>", "log.txt"]), ["log.txt"]);
  assert.deepEqual(writeTargets(["cat", "a", ">", "/dev/null", "2>&1"]), []);
  assert.deepEqual(writeTargets(["grep", "-rn", "x", "/Users/dev/.espressif"]), []);
});

test("everyday commands pass", () => {
  for (const c of [
    "source ~/.espressif/v6.0.1/esp-idf/export.sh >/dev/null 2>&1 && idf.py build 2>&1 | tail -3",
    "grep -rn nvs_flash_init $IDF_PATH/components/nvs_flash/src/ | head",
    "sed -n '1,80p' $IDF_PATH/components/nvs_flash/src/nvs_api.cpp",
    "cp $IDF_PATH/components/nvs_flash/src/nvs_page.cpp /tmp/nvs_page.cpp.bak",
    "cp $IDF_PATH/examples/get-started/blink/main/blink.c main/",
    "idf.py -p /dev/cu.usbmodem101 flash",
    "python tools/serial_capture.py --seconds 8 > /tmp/log.txt",
    "python3 -m venv .venv && .venv/bin/pip install pypdf",
    "esptool.py --port /dev/cu.usbmodem101 read_flash 0x9000 0x6000 nvs.bin",
    "espefuse.py --port /dev/cu.usbmodem101 summary",
  ]) assert.equal(cmd(c), undefined, c);
});

test("what benchmark agents did is held back", () => {
  assert.match(cmd("cp /tmp/nvs_page.cpp.bak $IDF_PATH/components/nvs_flash/src/nvs_page.cpp")!.reason, /toolchain/);
  assert.match(cmd("sed -i 's/ESP_LOGD/ESP_LOGI/' ~/.espressif/v6.0.1/esp-idf/components/nvs_flash/src/nvs_page.cpp")!.reason, /toolchain/);
  assert.match(cmd("python3 -m pip install --break-system-packages pypdf --quiet")!.reason, /system Python/);
  assert.match(cmd("source ~/.espressif/v6.0.1/esp-idf/export.sh >/dev/null 2>&1; pip install pypdf 2>&1 | tail -3")!.reason, /shared Python/);
  assert.ok(checkWrite("/Users/dev/.espressif/v6.0.1/esp-idf/components/nvs_flash/src/nvs_api.cpp", cwd, roots));
  assert.equal(checkWrite("main/main.c", cwd, roots), undefined);
  assert.equal(checkWrite("/tmp/scratch.c", cwd, roots), undefined);
});

test("irreversible chip operations are marked as hardware", () => {
  for (const c of ["espefuse.py --port /dev/cu.usbmodem101 burn_efuse JTAG_DISABLE", "espefuse burn-key BLOCK_KEY0 key.bin", "idf.py efuse-burn", "espsecure.py generate_signing_key k.pem"]) {
    assert.equal(cmd(c)?.hardware, true, c);
  }
});
