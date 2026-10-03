import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { planPreview } from "./plan-geometry.js";

/** The approval preview: envelopes posed by the plan's own mates. */

const pose = (origin: number[], zAxis = [0, 0, 1]) => ({ origin, zAxis, xAxis: [1, 0, 0] });
const node = (id: string, payload: Record<string, unknown>) => ({
  id, kind: "part", title: id, spec: "", status: "planned",
  contract: { name: id, summary: "", params: [], provides: [], requires: [], payload: { units: "mm", process: { kind: "FDM" }, ...payload }, hash: "" },
});

describe("planPreview", () => {
  it("poses each envelope primitive through the mates", () => {
    const g = GraphDoc.parse({
      schemaVersion: 1,
      id: "g",
      backend: "cad",
      brief: { goal: "" },
      nodes: {
        base: node("base", {
          ports: [{ name: "top", type: "FLAT_FACE", pose: pose([0, 0, 5]), params: { size: 10 } }],
          envelope: { volumes: [{ kind: "box", pose: pose([0, 0, 2.5]), dims: [40, 40, 5] }] },
        }),
        head: node("head", {
          geometrySource: "mesh",
          ports: [{ name: "seat", type: "FLAT_FACE", pose: pose([0, 0, 0], [0, 0, -1]), params: { size: 10 } }],
          envelope: { volumes: [{ kind: "cylinder", pose: pose([0, 0, 10]), d: 20, h: 20 }] },
        }),
      },
      edges: [{ id: "e", from: "base", fromPort: "top", to: "head", toPort: "seat" }],
      assembly: { entryNodeId: "base" },
    });
    const { nodes, problems } = planPreview(g);
    expect(problems).toEqual([]);
    const head = nodes.find((n) => n.id === "head")!;
    expect(head.geometrySource).toBe("mesh");
    expect(head.primitives).toHaveLength(1);
    expect(head.primitives[0]!.size).toEqual([20, 20, 20]);
    // Seated on the base's top face (z 5), the cylinder's centre is 10 above it.
    expect(head.primitives[0]!.matrix.slice(12, 15).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 15]);
    expect(nodes.find((n) => n.id === "base")!.primitives[0]!.kind).toBe("box");
  });
});
