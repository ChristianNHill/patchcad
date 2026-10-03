// usage: tsx _results-seq.ts <results.json>... — sequence every cooked graph in them
import { readFileSync } from "node:fs";
import { GraphDoc } from "@patchcad/shared";
import { CadBackend, assemblyInstructions } from "./index.js";
const only = process.env.ONLY;
for (const file of process.argv.slice(2)) {
  for (const r of JSON.parse(readFileSync(file, "utf8")).results ?? []) {
    if (!r.graph || (only && r.id !== only)) continue;
    const g = GraphDoc.parse(r.graph);
    const cad = new CadBackend();
    const t = Date.now();
    const out = await assemblyInstructions(g, cad.solveScene(g), cad.kernel, { render: false });
    const s = out.sequence;
    console.log(`\n## ${r.id} (${Object.keys(g.nodes).length} nodes) ${s.steps.length} steps, ${Date.now() - t}ms, base=${s.base}, subs=${s.subassemblies.map((x) => x.title).join("; ") || "none"}`);
    for (const st of s.steps) console.log(`  ${st.n}. [${st.action}] ${st.title}`);
    if (s.sequenceProblems.length) console.log("  PROBLEMS:\n   - " + s.sequenceProblems.join("\n   - "));
  }
}
