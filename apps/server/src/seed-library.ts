import path from "node:path";
import { readFile } from "node:fs/promises";
import { GraphDoc } from "@patchcad/shared";
import { contractHash } from "@patchcad/engine";
import { FileLibrary } from "./library.js";
import { codeFile } from "./project.js";

/**
 * Dev utility: seed the node library from an existing project's ready nodes.
 *   pnpm exec tsx src/seed-library.ts <projectDir>
 * Only unspecialized nodes (empty thread) are captured — same policy the
 * cook scheduler applies on commit.
 */

async function main() {
  const dir = path.resolve(process.argv[2] ?? "");
  if (!dir) {
    console.error("usage: tsx src/seed-library.ts <projectDir>");
    process.exit(1);
  }
  const graph = GraphDoc.parse(JSON.parse(await readFile(path.join(dir, "patchcad.json"), "utf8")));
  const library = new FileLibrary();
  let captured = 0;
  for (const node of Object.values(graph.nodes)) {
    if (node.status !== "ready" || node.thread.length > 0) continue;
    let code: string;
    try {
      code = await readFile(codeFile(dir, node.id, node.version), "utf8");
    } catch {
      console.warn(`skip ${node.id}: no code file for v${node.version}`);
      continue;
    }
    // Persisted files may carry stale/empty hashes; compute like the store does.
    const hash = contractHash(node.contract);
    await library.capture(graph.backend, hash, {
      code,
      testCode: node.artifact?.testCode ?? "",
      kind: node.kind,
      title: node.title,
      // Carrying the contract is what makes an entry usable as a worked
      // example. Re-running this over existing projects backfills entries
      // captured before the field existed, which are otherwise fast-path only.
      contract: { ...node.contract, hash },
    });
    captured += 1;
    console.log(`captured ${node.id} (${hash})`);
  }
  console.log(`seeded ${captured} node(s) from ${dir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
