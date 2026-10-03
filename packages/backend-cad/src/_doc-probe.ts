import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { GraphDoc } from "@patchcad/shared";
import { CadBackend, assemblyInstructions } from "./index.js";
const out = process.env.OUT!;
const only = process.argv[2];
for (const ex of only ? [only] : ["cad-joints", "cad-rotor", "cad-belt-drive", "cad-clamp"]) {
  const root = new URL(`../../../examples/${ex}/`, import.meta.url);
  const g = GraphDoc.parse(JSON.parse(readFileSync(new URL("patchcad.json", root), "utf8")));
  for (const n of Object.values(g.nodes)) {
    const f = new URL(`nodes/${n.id}/v1.code.py`, root);
    if (existsSync(f)) n.artifact = { ...n.artifact!, code: readFileSync(f, "utf8") };
  }
  const cad = new CadBackend();
  const t = Date.now();
  const r = await assemblyInstructions(g, cad.solveScene(g), cad.kernel, {});
  console.log(`\n## ${ex} ${Date.now() - t}ms pages=${r.pages.length} err=${r.error ?? ""}`);
  for (const s of r.sequence.steps) console.log(` ${s.n}. ${s.title} | ${s.notes.join(" / ")}`);
  console.log(" problems:", r.sequence.sequenceProblems);
  if (r.pdf) writeFileSync(`${out}/${ex}.pdf`, Buffer.from(await (await fetch(`${cad.kernel.baseUrl}${r.pdf}`)).arrayBuffer()));
}
