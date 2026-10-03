import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hashValue } from "@patchcad/shared";
import { CadBackend, KernelClient, buildBom } from "@patchcad/backend-cad";
import { EventBus, cookOne, type DomainBackend, type LlmProvider } from "@patchcad/engine";
import { codeFile, loadProject } from "./project.js";

/** A failed cook must never replace the committed part: not in the store,
 *  not in the version's code file on disk, not in what export or the BOM see. */

const V1 = "from build123d import *\n\ndef build(p):\n    return Box(10, 10, 10)\n";
const BAD = "from build123d import *\n\ndef build(p):\n    return Box(10, 10, 10) - Box(20, 20, 20)\n";

const pose = { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] };
const plate = (cooked: boolean) => ({
  id: "plate",
  kind: "part",
  title: "Plate",
  spec: "a plate",
  contract: {
    name: "plate",
    summary: "",
    params: [],
    provides: [],
    requires: [],
    payload: {
      units: "mm",
      process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
      ports: [],
      envelope: { volumes: [{ kind: "box", pose, dims: [10, 10, 10] }], clearance: 0.4 },
    },
    hash: "",
  },
  artifact: cooked ? { code: "", testCode: "", hash: hashValue(V1) } : null,
  thread: cooked ? [{ role: "user", content: "make it hollow", at: Date.now() }] : [],
  status: cooked ? "ready" : "planned",
  version: cooked ? 1 : 0,
  history: cooked ? [{ version: 1, contractHash: "", artifactHash: hashValue(V1), cause: "generate", at: 1 }] : [],
});

async function project(cooked: boolean) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "patchcad-failed-cook-"));
  const doc = {
    schemaVersion: 1,
    id: "p",
    backend: "cad",
    brief: { goal: "a plate", constraints: [], clarifications: [] },
    nodes: { plate: plate(cooked) },
    edges: [],
    assembly: { entryNodeId: "plate" },
    rev: 0,
  };
  await writeFile(path.join(dir, "patchcad.json"), JSON.stringify(doc), "utf8");
  if (cooked) {
    await mkdir(path.dirname(codeFile(dir, "plate", 1, "py")), { recursive: true });
    await writeFile(codeFile(dir, "plate", 1, "py"), V1, "utf8");
  }
  return loadProject(dir, new EventBus());
}

/** Every draft fails G1, so the budget runs out code-invalid. */
const failing: DomainBackend<unknown> = {
  id: "cad",
  maxAttempts: 2,
  planning: { nodeKinds: [], payloadSchema: z.unknown(), graphLints: [], architectGuidance: "" },
  buildGeneratePrompt: () => ({ system: "", messages: [{ role: "user", content: "go" }], schema: z.object({ code: z.string() }), role: "generator" }),
  buildRepairPrompt: () => ({ system: "", messages: [{ role: "user", content: "fix" }], schema: z.object({ code: z.string() }), role: "repair" }),
  execute: async () => ({ ok: false, stage: "G1", report: "boom", score: 1 }),
  verify: async () => ({ ok: true, stage: "verify", report: "" }),
  classifyFailure: () => "code-invalid",
  assemble: async () => {},
  globalCheck: async () => ({ ok: true, problems: [] }),
};
const provider: LlmProvider = {
  id: "stub",
  complete: async () => ({ data: { code: BAD }, usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "stub" }) as never,
};

/** Wait out the store's debounced persist. */
const settle = () => new Promise((r) => setTimeout(r, 700));

async function exportedCode(doc: Parameters<CadBackend["exportGeometry"]>[0], dir: string): Promise<string[]> {
  const kernel = new KernelClient();
  let codes: string[] = [];
  kernel.export = async (parts) => {
    codes = parts.map((p) => p.code);
    return { ok: true, hash: "e" };
  };
  await new CadBackend({ kernel }).exportGeometry(doc, { root: path.join(dir, "workspace") }, { format: "stl" });
  return codes;
}

describe("a failed cook", () => {
  it("leaves a ready v1 part, its code file and its export untouched", async () => {
    const p = await project(true);
    await expect(cookOne({ store: p.store, backend: failing, provider, workspace: { root: path.join(p.dir, "workspace") } }, "plate")).rejects.toThrow();
    await settle();

    const node = p.store.node("plate");
    expect(node.status).toBe("error_code");
    expect(node.version).toBe(1);
    expect(node.artifact?.code).toBe(V1);
    expect(node.lastFailed).toMatchObject({ code: BAD, stage: "G1" });
    expect(await readFile(codeFile(p.dir, "plate", 1, "py"), "utf8")).toBe(V1);
    expect(await exportedCode(p.store.doc, p.dir)).toEqual([V1]);
  });

  it("on a first cook leaves no artifact, no code file, and a BOM row saying not generated", async () => {
    const p = await project(false);
    await expect(cookOne({ store: p.store, backend: failing, provider, workspace: { root: path.join(p.dir, "workspace") } }, "plate")).rejects.toThrow();
    await settle();

    const node = p.store.node("plate");
    expect(node.status).toBe("error_code");
    expect(node.artifact).toBeNull();
    expect(node.lastFailed?.code).toBe(BAD);
    expect(existsSync(codeFile(p.dir, "plate", 0, "py"))).toBe(false);
    expect(buildBom(p.store.doc).notGenerated).toEqual([{ nodeId: "plate", title: "Plate", class: "print", status: "error_code" }]);
    expect(await exportedCode(p.store.doc, p.dir)).toEqual([]);
  });
});
