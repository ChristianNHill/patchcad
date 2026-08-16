/** Dev smoke for the TS verifier: run with `pnpm tsx src/verify-smoke.ts`. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "@patchcad/engine";
import { typecheckNode } from "@patchcad/backend-code";
import { loadProject } from "./project.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// A fixture rather than an examples/ project on purpose: the welcome screen
// lists everything under examples/, and this web-code graph is a verifier
// control, not something a user of the CAD studio should be offered.
const projectDir = path.resolve(here, "..", "fixtures", "shop");

const { store } = await loadProject(projectDir, new EventBus());
const ws = { root: path.join(projectDir, ".preview") };

// Positive control: every hand-written shop node should typecheck.
for (const node of Object.values(store.doc.nodes)) {
  const result = await typecheckNode(node, store.doc, ws);
  console.log(`${result.ok ? "✓" : "✗"} ${node.id}: ${result.ok ? "clean" : result.report.split("\n")[0]}`);
}

// Negative control: bad import symbol + undefined identifier must fail.
const broken = structuredClone(store.doc.nodes["header"]!);
broken.artifact = {
  code: `import { useTokensTypo } from "@nodes/theme";\nexport function Header() { return <div>{missingVar}</div>; }`,
  testCode: "",
  hash: "x",
};
const bad = await typecheckNode(broken, store.doc, ws);
console.log(`negative control ${bad.ok ? "✗ FAILED TO FAIL" : "✓ correctly failed"}:`);
console.log("  " + bad.report.split("\n").join("\n  "));
