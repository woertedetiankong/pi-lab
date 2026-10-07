// Builds the knowledge bases a scenario's pi-lab-kb* agents get, imported with pi-kb, from scenarios/<scenario>/KB.json
// (paths relative to bench/):
//   kb          the scenario's datasheets ("docs"; may be none)          (pi-lab-kb)
//   kb-note     + a note that has the answer ("note")                     (pi-lab-kb-note)
//   kb-partial  + a note that is only partly right ("partial")            (pi-lab-kb-partial)
// Usage: node bench/make-kb.mjs <scenario> [base dir]   (default /tmp/pi-lab-bench/kbs; pi-kb checkout at ../pi-kb)
// The knowledge bases land in <base dir>/<scenario>/<kb|kb-note|kb-partial>.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bench = dirname(fileURLToPath(import.meta.url));
const [scenario, base = "/tmp/pi-lab-bench/kbs"] = process.argv.slice(2);
const spec = scenario && join(bench, "scenarios", scenario, "KB.json");
if (!spec || !existsSync(spec)) {
  console.error("usage: node bench/make-kb.mjs <scenario> [base dir]   (the scenario needs a KB.json)");
  process.exit(2);
}
const { docs = [], note, partial, probes = [] } = JSON.parse(readFileSync(spec, "utf8"));
const path = p => join(bench, p);
for (const file of [...docs, note, partial].filter(Boolean).map(path)) {
  if (!existsSync(file)) throw new Error(`missing ${file}${file.includes("docs-cache") ? `: run bench/prepare.sh ${scenario} first` : ""}`);
}
const variants = { kb: [], "kb-note": note ? [note] : [], "kb-partial": partial ? [partial] : [] };

const piKb = process.env.PI_KB_SRC ?? join(bench, "..", "..", "pi-kb");
const { KnowledgeBase } = await import(join(piKb, "src", "kb.ts"));
for (const [name, notes] of Object.entries(variants)) {
  if (name !== "kb" && !notes.length) continue;
  const dir = join(base, scenario, name);
  console.log(`== ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  const kb = new KnowledgeBase(dir);
  for (const doc of docs) {
    const r = await kb.addFile(path(doc));
    console.log("import:", r.status, r.doc?.title ?? "", r.doc?.pages ?? "", "pages");
  }
  for (const n of notes) {
    const r = await kb.addFile(path(n), { wiki: true });
    console.log("note:", r.status, r.doc?.title ?? r.message ?? "");
  }
  for (const q of probes) {
    const hits = kb.search(q, { limit: 3 });
    console.log(`search "${q}":`, hits.map(h => (h.collection === "wiki" ? `note "${h.title}"` : `p.${h.page ?? h.pageStart ?? "?"}`)).join(" ") || "(none)");
  }
  kb.close();
}
