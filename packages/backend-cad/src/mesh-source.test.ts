import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphDoc } from "@patchcad/shared";
import { EventBus, GraphStore, cookOne } from "@patchcad/engine";
import { CadBackend } from "./index.js";
import { KernelClient } from "./kernel.js";
import { DEFAULT_BUILD_VOLUME_MM, meshFitRequest, meshNodeCode, prepareMeshNode, splitPiecesFor, type MeshSource } from "./mesh-source.js";

/** Phase 6.4 on the CAD side: guidance and lint follow mesh availability, and
 *  a mesh node cooks as generate → fit → load_import with the gates on top. */

const FIXTURE_GLB = path.join(import.meta.dirname, "fixtures", "blob.glb");

const pose = (origin: number[], zAxis = [0, 0, 1]) => ({ origin, zAxis, xAxis: [1, 0, 0] });

function meshGraph(dims = [30, 30, 40]) {
  return GraphDoc.parse({
    schemaVersion: 1,
    id: "g",
    backend: "cad",
    brief: { goal: "a blob figurine", refs: [{ hash: "0123456789abcdef", view: "front" }] },
    nodes: {
      body: {
        id: "body",
        kind: "part",
        title: "Body",
        spec: "",
        contract: {
          name: "body",
          summary: "",
          params: [],
          provides: [],
          requires: [],
          payload: {
            units: "mm",
            process: { kind: "FDM" },
            geometrySource: "mesh",
            visualRef: "a rounded egg standing upright",
            ports: [{ name: "base", type: "FLAT_FACE", pose: pose([0, 0, 0], [0, 0, -1]), params: { size: 10 } }],
            envelope: { volumes: [{ kind: "box", pose: pose([0, 0, dims[2]! / 2]), dims }] },
          },
          hash: "",
        },
        status: "planned",
      },
    },
    edges: [],
    assembly: { entryNodeId: "body" },
  });
}

/** Counts calls; returns the fixture GLB. */
function fakeSource(): MeshSource & { calls: number } {
  return {
    calls: 0,
    async generate() {
      this.calls += 1;
      return { glb: await readFile(FIXTURE_GLB), usd: 0.4 };
    },
  };
}

/** A kernel that fits by writing a placeholder PLY and passes every gate. */
function fakeKernel() {
  const k = {
    fits: 0,
    executed: [] as string[],
    async meshFit() {
      k.fits += 1;
      const dir = await mkdtemp(path.join(os.tmpdir(), "patchcad-fit-"));
      await writeFile(path.join(dir, "mesh.ply"), "ply");
      return { ok: true as const, dir, file: "mesh.ply", scale: 25, watertight: true, bbox: { min: [0, 0, 0], max: [1, 1, 1] }, faces: 4, notes: [] };
    },
    async execute(code: string) {
      k.executed.push(code);
      return { ok: true as const, hash: "h", cached: false, glb: "", measurements: { volume_mm3: 1000, ports: [] } };
    },
  };
  return k;
}

const lintProblems = (backend: CadBackend, g: GraphDoc) =>
  backend.planning.graphLints.flatMap((l) => l.run(g)).filter((p) => p.includes("geometrySource"));

describe("mesh availability", () => {
  it("flips the architect guidance, and keeps it stable per configuration", () => {
    const off = new CadBackend().planning.architectGuidance;
    const on = new CadBackend({ meshSource: fakeSource() }).planning.architectGuidance;
    expect(off).toContain("Mesh generation is NOT AVAILABLE");
    expect(on).toContain("Mesh generation IS AVAILABLE");
    expect(on).not.toContain("NOT AVAILABLE");
    expect(new CadBackend({ meshSource: fakeSource() }).planning.architectGuidance).toBe(on);
  });

  it("toggles the mesh-source lint", () => {
    const g = meshGraph();
    expect(lintProblems(new CadBackend(), g).join("\n")).toContain("mesh generation not configured");
    expect(lintProblems(new CadBackend({ meshSource: fakeSource() }), g)).toEqual([]);
    g.brief.refs = [];
    expect(lintProblems(new CadBackend({ meshSource: fakeSource() }), g).join("\n")).toContain("no reference image");
  });
});

describe("mesh fit request", () => {
  it("is the envelope's box plus each FLAT_FACE as a plane", () => {
    const g = meshGraph();
    expect(meshFitRequest(g, g.nodes.body!)).toEqual({
      box: { center: [0, 0, 20], dims: [30, 30, 40] },
      flats: [{ name: "base", origin: [0, 0, 0], normal: [0, 0, -1], size: 10 }],
    });
  });
});

describe("prepareMeshNode", () => {
  it("pays for a mesh once and re-fits it for free when the envelope moves", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "patchcad-mesh-"));
    const source = fakeSource();
    const kernel = fakeKernel();
    const run = (g: GraphDoc) =>
      prepareMeshNode({ node: g.nodes.body!, graph: g, projectDir, kernel: kernel as unknown as KernelClient, source });

    expect(await run(meshGraph())).toEqual({ usd: 0.4 });
    expect(await readFile(path.join(projectDir, "meshgen", "body.glb"))).toEqual(await readFile(FIXTURE_GLB));
    expect(await readFile(path.join(projectDir, "imports", "body.ply"), "utf8")).toBe("ply");

    expect(await run(meshGraph())).toBeNull(); // same contract: nothing to do
    expect(kernel.fits).toBe(1);

    expect(await run(meshGraph([40, 40, 50]))).toBeNull(); // re-fit, no new mesh
    expect(kernel.fits).toBe(2);
    expect(source.calls).toBe(1);
  });

  it("refuses a mesh node with no stored mesh and no source", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "patchcad-mesh-"));
    const g = meshGraph();
    await expect(
      prepareMeshNode({ node: g.nodes.body!, graph: g, projectDir, kernel: fakeKernel() as unknown as KernelClient }),
    ).rejects.toThrow("not configured");
  });
});

describe("mesh node cook", () => {
  it("generates, fits, commits load_import code and bills the node", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "patchcad-mesh-"));
    await mkdir(path.join(projectDir, ".preview"));
    const kernel = fakeKernel();
    const backend = new CadBackend({ kernel: kernel as unknown as KernelClient, meshSource: fakeSource() });
    const store = new GraphStore(meshGraph(), new EventBus(), async () => {});
    const trap = { id: "trap", complete: () => Promise.reject(new Error("no LLM for a mesh node")) };

    await cookOne({ store, backend, provider: trap, workspace: { root: path.join(projectDir, ".preview") } }, "body");

    const node = store.node("body");
    expect(node.status).toBe("ready");
    expect(node.artifact?.code).toBe(meshNodeCode(node));
    expect(kernel.executed).toEqual([meshNodeCode(node)]);
    expect(node.cost).toMatchObject({ calls: 1, usd: 0.4 });
    expect(node.history.at(-1)?.cause).toBe("registry");
  });
});

// Live: the real kernel fits the fixture and the real gates pass it.
// PATCHCAD_KERNEL_LIVE=1, against PATCHCAD_KERNEL_PORT (8621).
describe.skipIf(process.env.PATCHCAD_KERNEL_LIVE !== "1")("mesh node through the real kernel", () => {
  it("fits the fixture into the envelope and passes G0–G4", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "patchcad-mesh-"));
    await mkdir(path.join(projectDir, ".preview"));
    const backend = new CadBackend({ kernel: new KernelClient(), meshSource: fakeSource() });
    const store = new GraphStore(meshGraph(), new EventBus(), async () => {});
    const trap = { id: "trap", complete: () => Promise.reject(new Error("no LLM for a mesh node")) };
    await cookOne({ store, backend, provider: trap, workspace: { root: path.join(projectDir, ".preview") } }, "body");
    expect(store.node("body").status).toBe("ready");
  }, 60_000);
});

describe("splitPiecesFor", () => {
  it("leaves a mesh that fits alone, in any axis-aligned orientation", () => {
    expect(splitPiecesFor([240, 100, 60], DEFAULT_BUILD_VOLUME_MM)).toBe(1);
    expect(splitPiecesFor([60, 300, 100], [100, 320, 80])).toBe(1);
  });
  it("cuts the longest axis into the fewest slabs that fit", () => {
    expect(splitPiecesFor([600, 120, 80], DEFAULT_BUILD_VOLUME_MM)).toBe(3);
  });
  it("gives up when another axis is too big for any number of slabs", () => {
    expect(splitPiecesFor([600, 400, 300], DEFAULT_BUILD_VOLUME_MM)).toBeNull();
  });
});
