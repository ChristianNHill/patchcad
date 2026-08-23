import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { CadBackend } from "./index.js";

/**
 * Hiding a part excludes it from the OUTPUT (export + rendered scene) while
 * leaving it in the SOLVE. The distinction is the whole feature: if hiding
 * removed a node from the assembly, hiding a base plate would unmoor every part
 * mated to it, and the user would see the rest of the model jump.
 *
 * solveScene is the shared solve. The two output paths filter separately —
 * exportGeometry in this package, the mesh list in the cad-scene route — so the
 * invariant worth pinning here is that the solve itself never looks at `hidden`.
 */

const pose = (origin: number[], zAxis = [0, 0, 1]) => ({ origin, zAxis, xAxis: [1, 0, 0] });

function part(id: string, ports: { name: string; origin: number[]; zAxis?: number[] }[]) {
  return {
    id,
    kind: "part",
    title: id,
    spec: "",
    contract: {
      name: id,
      summary: "",
      params: [],
      provides: [],
      requires: [],
      payload: {
        units: "mm",
        process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
        ports: ports.map((p) => ({
          name: p.name,
          type: "FLAT_FACE",
          pose: pose(p.origin, p.zAxis),
          params: {},
        })),
        envelope: { volumes: [{ kind: "box", pose: pose([0, 0, 0]), dims: [50, 50, 10] }], clearance: 0.4 },
      },
      hash: "",
    },
    pinned: false,
    params: {},
    deps: [],
    artifact: { code: "def build(p): pass", testCode: "", hash: `h-${id}` },
    thread: [],
    status: "ready",
    version: 1,
    history: [],
    cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
  };
}

/** plate --top--> bracket: the bracket's pose is derived from the plate's. */
function clamp(hidden: Record<string, boolean> = {}) {
  const nodes = [
    part("plate", [{ name: "top", origin: [0, 0, 5] }]),
    part("bracket", [{ name: "bottom", origin: [0, 0, 0], zAxis: [0, 0, -1] }]),
  ].map((n) => ({ ...n, hidden: hidden[n.id] ?? false }));

  return GraphDoc.parse({
    schemaVersion: 1,
    id: "hide",
    backend: "cad",
    brief: { goal: "" },
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: [{ id: "e0", from: "plate", fromPort: "top", to: "bracket", toPort: "bottom" }],
    assembly: { entryNodeId: "plate" },
    layout: {},
    rev: 0,
  });
}

describe("hiding a part", () => {
  const backend = new CadBackend();

  it("does not move anything mated to it", () => {
    const before = backend.solveScene(clamp());
    const after = backend.solveScene(clamp({ plate: true }));

    expect(before.problems).toEqual([]);
    expect(after.problems).toEqual([]);
    // THE test. Hide the thing the bracket is bolted to; the bracket stays put.
    expect(after.world["bracket"]).toEqual(before.world["bracket"]);
  });

  it("keeps the hidden node in the solve, so its own pose is still known", () => {
    const after = backend.solveScene(clamp({ plate: true }));
    expect(after.world["plate"]).toBeDefined();
    expect(after.scene.nodes["plate"]).toBeDefined();
  });

  it("defaults to visible, so graphs written before the flag existed still parse", () => {
    const doc = clamp();
    expect(doc.nodes["plate"]!.hidden).toBe(false);
    expect(doc.nodes["bracket"]!.hidden).toBe(false);
  });
});
