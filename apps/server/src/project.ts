import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { GraphDoc, hashValue, type NodeRecord } from "@patchcad/shared";
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

/** `ext` is required on purpose. It defaulted to "tsx", which silently made
 *  every caller a web-code caller: CAD nodes store .py, so an omitted argument
 *  looked for a file that never exists and failed as "no stored code". */
export function codeFile(dir: string, nodeIdValue: string, version: number, ext: string): string {
  return path.join(dir, "nodes", nodeIdValue, `v${version}.code.${ext}`);
}

/** The values a node builds with: contract defaults under the user's edits. */
export function effectiveParams(node: Pick<NodeRecord, "contract" | "params">): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const p of node.contract.params) params[p.name] = p.default;
  return Object.assign(params, node.params);
}

/** A project dir name: the goal, kebab-cased, plus a time suffix. */
export function slugify(goal: string): string {
  const base = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return `${base || "project"}-${Date.now().toString(36)}`;
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
