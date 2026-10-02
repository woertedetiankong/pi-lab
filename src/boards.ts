// Board packs: what pi-lab knows about a specific board. A pack is a folder under boards/ with board.json (pins,
// buses, quirks, the datasheets it uses) and notes/ (verified lessons, in pi-kb's note format).
// The structured part shapes the prompt; datasheets and notes go to pi-kb when it is installed.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLabConfig, updateLabConfig } from "./project-config.ts";

export interface BoardPack {
  id: string;
  name: string;
  vendor?: string;
  url?: string;
  chip?: string;
  match?: { usb?: { vid: string; pid: string }[]; chip?: string };
  console?: string;
  sources?: Record<string, string>;
  buses?: { name: string; sda: number; scl: number; source?: string; devices?: { name: string; address: string; source?: string; note?: string }[] }[];
  pins?: { function: string; gpio: number | string; source?: string }[];
  buttons?: string;
  quirks?: string[];
  docs?: { title: string; file: string; url: string }[];
  notes?: string[];
  /** Folder the pack was loaded from. */
  dir: string;
}

export const BOARDS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "boards");

export function loadPacks(dir = BOARDS_DIR): BoardPack[] {
  let ids: string[];
  try { ids = readdirSync(dir); } catch { return []; }
  return ids.flatMap(id => {
    try { return [{ ...JSON.parse(readFileSync(join(dir, id, "board.json"), "utf8")), dir: join(dir, id) } as BoardPack]; }
    catch { return []; }
  });
}

/** Packs whose USB ids match a connected device ("303a:1001"). Many boards share a chip's ids, so this only narrows it down. */
export function candidates(packs: BoardPack[], usbIds: string[]): BoardPack[] {
  const ids = new Set(usbIds.map(id => id.toLowerCase()));
  return packs.filter(p => p.match?.usb?.some(u => ids.has(`${hex(u.vid)}:${hex(u.pid)}`)));
}

const hex = (s: string) => Number(s).toString(16).padStart(4, "0");

/** The board chosen for a project, kept in .pi/lab.json at the project root. */
export function projectBoard(root: string): string | undefined {
  return readLabConfig(root).board;
}

export function setProjectBoard(root: string, id: string | undefined): void {
  updateLabConfig(root, { board: id });
}

/** What the model is told about the board: short, with where each fact came from when it was not measured. */
export function describePack(pack: BoardPack, docsAt?: string): string {
  const lines = [`Board: ${pack.name}${pack.chip ? ` (${pack.chip})` : ""}${pack.url ? `, ${pack.url}` : ""}.`];
  if (pack.console) lines.push(`Console: ${pack.console === "usb-serial-jtag" ? "the chip's native USB-Serial/JTAG port (no USB-UART bridge)" : pack.console}.`);
  for (const bus of pack.buses ?? []) {
    const devices = (bus.devices ?? []).map(d => `${d.name} at ${d.address}${d.note ? ` (${d.note})` : ""}`).join("; ");
    lines.push(`${bus.name}: SDA=GPIO${bus.sda}, SCL=GPIO${bus.scl}${mark(bus.source)}${devices ? `. ${devices}` : ""}`);
  }
  for (const pin of pack.pins ?? []) lines.push(`${pin.function}: GPIO ${pin.gpio}${mark(pin.source)}`);
  if (pack.buttons) lines.push(pack.buttons);
  if (pack.quirks?.length) lines.push("Known quirks of this board:", ...pack.quirks.map(q => `- ${q}`));
  if (pack.docs?.length) {
    lines.push(`Datasheets: ${pack.docs.map(d => d.title).join(", ")}${docsAt ? `; ${docsAt}` : ""}.`);
  }
  return lines.join("\n");
}

const mark = (source?: string) => (source && source !== "board" ? ` [from ${source}]` : "");

/** Local copies of the pack's datasheets, downloaded once (they are not ours to redistribute). */
export function docsDir(pack: BoardPack, home = homedir()): string {
  return join(home, ".pi", "agent", "pi-lab", "boards", pack.id, "docs");
}

export type Fetch = (url: string, file: string) => Promise<boolean>;

export async function ensureDocs(pack: BoardPack, fetchFile: Fetch, home = homedir()): Promise<{ title: string; path: string }[]> {
  const dir = docsDir(pack, home);
  mkdirSync(dir, { recursive: true });
  const found: { title: string; path: string }[] = [];
  for (const doc of pack.docs ?? []) {
    const path = join(dir, doc.file);
    if (existsSync(path) || (await fetchFile(doc.url, path).catch(() => false))) found.push({ title: doc.title, path });
  }
  return found;
}

export const notePaths = (pack: BoardPack) => (pack.notes ?? []).map(n => join(pack.dir, n)).filter(p => existsSync(p));

/** The event pi-kb listens to: put these files on a shelf named after the board. */
export const BOARD_EVENT = "pi-lab:board";
export interface BoardEvent {
  name: string;
  files: { path: string; note: boolean }[];
}
