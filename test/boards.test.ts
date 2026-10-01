import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseIoreg } from "../src/board.ts";
import { candidates, describePack, ensureDocs, loadPacks, notePaths, projectBoard, setProjectBoard } from "../src/boards.ts";

const packs = loadPacks();
const stick = packs.find(p => p.id === "m5sticks3")!;

test("the M5StickS3 pack loads with its notes", () => {
  assert.ok(stick, "m5sticks3 pack");
  assert.equal(notePaths(stick).length, 4);
  for (const note of notePaths(stick)) assert.match(readFileSync(note, "utf8"), /^---\ntitle: /, note);
});

test("USB ids narrow the candidates", () => {
  assert.deepEqual(candidates(packs, ["303a:1001"]).map(p => p.id), ["m5sticks3"]);
  assert.deepEqual(candidates(packs, ["05ac:8104", "1a86:7523"]), []);
});

test("ioreg properties in either order", () => {
  const ioreg = `+-o Root  <class IORegistryEntry>
  | +-o USB JTAG_serial debug unit@01100000
  |       "idVendor" = 12346
  |       "idProduct" = 4097
  | +-o Some Hub@01000000
  |       "idProduct" = 33028
  |       "idVendor" = 1452
  | +-o Device without ids@02000000
  |       "USB Product Name" = "x"`;
  assert.deepEqual(parseIoreg(ioreg), ["303a:1001", "05ac:8104"]);
});

test("the prompt names the measured bus and marks what came from docs", () => {
  const text = describePack(stick, "on the knowledge base shelf \"M5StickS3\"");
  assert.match(text, /internal I2C: SDA=GPIO47, SCL=GPIO48\. BMI270 IMU at 0x68/);
  assert.match(text, /external I2C \(Grove \/ Hat\): SDA=GPIO9, SCL=GPIO10 \[from m5unified\]/);
  assert.match(text, /Known quirks of this board:\n- Opening its USB serial port/);
  assert.match(text, /Datasheets: BMI270 datasheet; on the knowledge base shelf "M5StickS3"/);
});

test("the board is saved per project, next to other settings", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-proj-"));
  assert.equal(projectBoard(root), undefined);
  setProjectBoard(root, "m5sticks3");
  assert.equal(projectBoard(root), "m5sticks3");
  const file = join(root, ".pi", "lab.json");
  writeFileSync(file, JSON.stringify({ board: "m5sticks3", other: 1 }));
  setProjectBoard(root, undefined);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { other: 1 });
});

test("datasheets are fetched once and kept", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-lab-home-"));
  let fetches = 0;
  const fetchFile = async (_url: string, file: string) => { fetches++; writeFileSync(file, "%PDF"); return true; };
  const first = await ensureDocs(stick, fetchFile, home);
  assert.equal(first.length, 1);
  assert.ok(existsSync(first[0]!.path));
  await ensureDocs(stick, fetchFile, home);
  assert.equal(fetches, 1);
  const failing = await ensureDocs(stick, async () => false, mkdtempSync(join(tmpdir(), "pi-lab-home-")));
  assert.deepEqual(failing, []);
});
