// pi-lab's settings for a project, kept in .pi/lab.json at the project root: the board pack, the serial port and baud.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LabConfig {
  board?: string;
  serial?: { port?: string; baud?: number };
}

const file = (root: string) => join(root, ".pi", "lab.json");

export function readLabConfig(root: string): LabConfig {
  try { return JSON.parse(readFileSync(file(root), "utf8")); } catch { return {}; }
}

/** Merge `patch` into the project's settings; undefined values remove a setting. */
export function updateLabConfig(root: string, patch: Partial<LabConfig>): LabConfig {
  const config: Record<string, unknown> = { ...readLabConfig(root) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete config[key]; else config[key] = value;
  }
  mkdirSync(dirname(file(root)), { recursive: true });
  writeFileSync(file(root), JSON.stringify(config, null, 2) + "\n");
  return config as LabConfig;
}

/** Baud rates offered in the panel; any positive integer is accepted. */
export const BAUDS = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600, 1500000, 2000000];
export const DEFAULT_BAUD = 115200;
