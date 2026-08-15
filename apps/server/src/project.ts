import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { GraphDoc, hashValue } from "@patchcad/shared";
import { EventBus, GraphStore } from "@patchcad/engine";

/**
 * Project folder layout (git-friendly):
 *
 *   <project>/patchcad.json        GraphDoc minus code bodies
 *   <project>/nodes/<id>/v<N>.code.tsx   (web-code) / .py (cad)
 *   <project>/nodes/<id>/v<N>.test.tsx
 *   <project>/.preview/            regenerable workspace (gitignored)
 */

export interface LoadedProject {
  dir: string;
  store: GraphStore;
}

/** Node code files carry the domain's native extension. */
export function codeExt(backendId: string): string {
  return backendId === "cad" ? "py" : "tsx";
}

export function codeFile(dir: string, nodeIdValue: string, version: number, ext = "tsx"): string {
  return path.join(dir, "nodes", nodeIdValue, `v${version}.code.${ext}`);
}

export async function loadProject(dir: string, bus: EventBus): Promise<LoadedProject> {
  const raw = await readFile(path.join(dir, "patchcad.json"), "utf8");
  const graph = GraphDoc.parse(JSON.parse(raw));

  const ext = codeExt(graph.backend);

  // Rehydrate artifact code from node files.
  for (const node of Object.values(graph.nodes)) {
    const file = codeFile(dir, node.id, node.version, ext);
    if (existsSync(file)) {
      const code = await readFile(file, "utf8");
      const testFile = file.replace(/\.code\.(\w+)$/, ".test.$1");
      const testCode = existsSync(testFile) ? await readFile(testFile, "utf8") : "";
      node.artifact = { ...node.artifact, code, testCode, hash: hashValue(code) };
    }
  }

  const persist = async (g: GraphDoc) => {
    // Strip code bodies from the JSON doc; they live in per-version files.
    const lean = structuredClone(g);
    for (const node of Object.values(lean.nodes)) {
      if (node.artifact) node.artifact = { ...node.artifact, code: "", testCode: "" };
    }
    await writeFile(path.join(dir, "patchcad.json"), JSON.stringify(lean, null, 2), "utf8");
    // Write current-version code files for nodes that have artifacts.
    for (const node of Object.values(g.nodes)) {
      if (!node.artifact?.code) continue;
      const file = codeFile(dir, node.id, node.version, ext);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, node.artifact.code, "utf8");
      if (node.artifact.testCode) {
        await writeFile(file.replace(/\.code\.(\w+)$/, ".test.$1"), node.artifact.testCode, "utf8");
      }
    }
  };

  const store = new GraphStore(graph, bus, persist);
  return { dir, store };
}
