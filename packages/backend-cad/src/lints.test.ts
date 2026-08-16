import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { cadFastenerJustifiedLint } from "./index.js";

/** Plan-time lint: pure graph → problems. No kernel, no LLM, no I/O. */

const pose = { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] };
const payloadBase = {
  units: "mm",
  process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
  ports: [],
  envelope: { volumes: [{ kind: "box", pose, dims: [10, 10, 10] }], clearance: 0.4 },
};

function node(id: string, kind: string, ports: { name: string; type: string }[]) {
  return {
    id,
    kind,
    title: id,
    spec: "",
    contract: {
      name: id,
      summary: "",
      params: [],
      provides: [],
      requires: [],
      payload: { ...payloadBase, ports: ports.map((p) => ({ ...p, pose, params: {} })) },
      hash: "",
    },
    pinned: false,
    params: {},
    deps: [],
    artifact: null,
    thread: [],
    status: "ready",
    version: 1,
    history: [],
    cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
  };
}

function graph(
  nodes: ReturnType<typeof node>[],
  edges: { from: string; fromPort: string; to: string; toPort: string }[],
) {
  return GraphDoc.parse({
    schemaVersion: 1,
    id: "lint",
    backend: "cad",
    brief: { goal: "", constraints: [], clarifications: [] },
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: edges.map((e, i) => ({ id: `e${i}`, ...e })),
    assembly: { entryNodeId: nodes[0]!.id },
    layout: {},
    rev: 0,
  });
}

const plateWithHole = () => node("plate", "part", [{ name: "hole", type: "CLEARANCE_HOLE" }]);
const plateNoHole = () => node("plate", "part", [{ name: "face", type: "FLAT_FACE" }]);
const screw = () => node("screw", "fastener", [{ name: "head_seat", type: "FLAT_FACE" }]);

describe("cad-fastener-justified lint", () => {
  it("passes a screw seated in a hole port", () => {
    const g = graph([plateWithHole(), screw()], [{ from: "plate", fromPort: "hole", to: "screw", toPort: "head_seat" }]);
    expect(cadFastenerJustifiedLint.run(g)).toEqual([]);
  });

  it("flags a screw wired to nothing", () => {
    const problems = cadFastenerJustifiedLint.run(graph([plateWithHole(), screw()], []));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("wired to nothing");
  });

  it("flags a screw whose only neighbour has no hole to fasten into", () => {
    const g = graph([plateNoHole(), screw()], [{ from: "plate", fromPort: "face", to: "screw", toPort: "head_seat" }]);
    const problems = cadFastenerJustifiedLint.run(g);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("none of which declare");
  });

  it("leaves fastener-free designs alone", () => {
    expect(cadFastenerJustifiedLint.run(graph([plateNoHole()], []))).toEqual([]);
  });
});
