// Builds the knowledge base the pi-lab-kb agent gets: the BMI270 datasheet, imported with pi-kb.
// Usage: node bench/make-kb.mjs [kb dir]   (default /tmp/pi-lab-bench/kb; pi-kb checkout at ../pi-knowledge)
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bench = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? "/tmp/pi-lab-bench/kb";
const piKb = process.env.PI_KB_SRC ?? join(bench, "..", "..", "pi-knowledge");
const datasheet = join(bench, "docs-cache", "BMI270-datasheet.pdf");
if (!existsSync(datasheet)) throw new Error(`missing ${datasheet}: run bench/prepare.sh imu-zeros first`);

const { KnowledgeBase } = await import(join(piKb, "src", "kb.ts"));
rmSync(dir, { recursive: true, force: true });
const kb = new KnowledgeBase(dir);
const result = await kb.addFile(datasheet);
console.log("import:", result.status, result.doc?.title ?? "", result.doc?.pages ?? "", "pages");
for (const q of ["INTERNAL_STATUS", "ACC_RANGE", "initialization sequence config file", "PWR_CONF adv_power_save"]) {
  const hits = kb.search(q, { limit: 3 });
  console.log(`search "${q}":`, hits.map(h => `p.${h.page ?? h.pageStart ?? "?"}`).join(" ") || "(none)");
}
kb.close();
