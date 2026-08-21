import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import {
  cadEnvelopeCoherentLint,
  cadFastenerJustifiedLint,
  cadFlatFaceSizeLint,
  cadProbedPortsLint,
} from "./index.js";

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

/** A part with an explicit envelope and ports, for the geometry-coherence lints.
 *  Both defects below are real ones from the 5mm-sphere plan. */
function envNode(
  id: string,
  volumes: unknown[],
  ports: { name: string; type: string; origin?: number[]; params?: Record<string, unknown> }[] = [],
) {
  const n = node(id, "part", []);
  // payloadBase's literal types pin volumes to boxes; these fixtures use
  // cylinders, so the payload is replaced wholesale.
  (n.contract as { payload: unknown }).payload = {
    ...payloadBase,
    ports: ports.map((p) => ({
      name: p.name,
      type: p.type,
      pose: { ...pose, origin: p.origin ?? [0, 0, 0] },
      params: p.params ?? {},
    })),
    envelope: { volumes, clearance: 0.4 },
  };
  return n;
}

const cyl = (z: number, d: number, h: number) => ({
  kind: "cylinder",
  pose: { ...pose, origin: [0, 0, z] },
  d,
  h,
});

describe("cad-envelope-coherent lint", () => {
  it("passes a single volume with its ports inside", () => {
    const g = graph([envNode("base", [cyl(0, 24, 8)], [{ name: "top", type: "FLAT_FACE", origin: [0, 0, 4] }])], []);
    expect(cadEnvelopeCoherentLint.run(g)).toEqual([]);
  });

  it("passes volumes that overlap", () => {
    const g = graph([envNode("base", [cyl(0, 24, 8), cyl(4, 24, 4)])], []);
    expect(cadEnvelopeCoherentLint.run(g)).toEqual([]);
  });

  it("flags disjoint volumes — a part cannot span the gap", () => {
    // display-base declared exactly this: z [-8,0] and z [3.25,4.75].
    const g = graph([envNode("base", [cyl(-4, 24, 8), cyl(4, 24, 1.5)])], []);
    const problems = cadEnvelopeCoherentLint.run(g);
    expect(problems.some((p) => p.includes("disjoint"))).toBe(true);
  });

  it("flags a port outside its own node's envelope", () => {
    const g = graph([
      envNode("base", [cyl(-4, 24, 8), cyl(4, 24, 1.5)], [{ name: "seat", type: "FLAT_FACE", origin: [0, 0, 1.8] }]),
    ], []);
    expect(cadEnvelopeCoherentLint.run(g).some((p) => p.includes('port "seat"'))).toBe(true);
  });

  it("does not judge where the origin sits — base-at-origin is a valid frame", () => {
    // l-bracket is modelled base-on-z=0, and imported pieces keep their source
    // model's frame entirely. Neither is a defect.
    const g = graph([envNode("bracket", [cyl(15, 30, 30)]), envNode("piece", [cyl(96, 40, 94)])], []);
    expect(cadEnvelopeCoherentLint.run(g)).toEqual([]);
  });

  it("skips registry hardware, which never faces G4", () => {
    const n = envNode("screw", [cyl(-4, 8, 8), cyl(40, 8, 8)]);
    n.kind = "fastener";
    expect(cadEnvelopeCoherentLint.run(graph([n], []))).toEqual([]);
  });
});

describe("cad-port-params lint", () => {
  it("accepts a declared face size, and the aliases models reach for", () => {
    for (const params of [{ size: 4 }, { faceSize: 4 }, { flatWidth: 1.5 }, { ring_diameter: 5.5 }]) {
      const g = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "f", type: "FLAT_FACE", params }])], []);
      expect(cadFlatFaceSizeLint.run(g), JSON.stringify(params)).toEqual([]);
    }
  });

  it("flags a flat face with no size — the probe used to invent 4mm", () => {
    const g = graph([
      envNode("p", [cyl(0, 20, 10)], [{ name: "seat", type: "FLAT_FACE", params: { seatDiameter: 5.3 } }]),
    ], []);
    const problems = cadFlatFaceSizeLint.run(g);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("declares no face size");
    expect(problems[0]).toContain("seatDiameter");
  });

  it("flags a hole with no diameter", () => {
    const g = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "h", type: "CLEARANCE_HOLE", params: {} }])], []);
    expect(cadFlatFaceSizeLint.run(g)[0]).toContain("declares no diameter");
  });

  it("leaves port types it has no probe for alone", () => {
    const g = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "s", type: "SLOT", params: {} }])], []);
    expect(cadFlatFaceSizeLint.run(g)).toEqual([]);
  });
});

describe("cadProbedPortsLint", () => {
  it("rejects a port type no gate can measure", () => {
    const g = graph([node("wall", "part", [{ name: "tongue", type: "GROOVE" }])], []);
    const problems = cadProbedPortsLint.run(g);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("GROOVE");
    expect(problems[0]).toContain("featureless block");
  });

  it("accepts every port type the kernel probes", () => {
    for (const type of ["CLEARANCE_HOLE", "BORE", "SCREW_SEAT", "SCREW_BOSS", "FLAT_FACE"]) {
      const g = graph([node("p", "part", [{ name: "i", type }])], []);
      expect(cadProbedPortsLint.run(g), type).toEqual([]);
    }
  });

  it("names every unprobed port, not just the first", () => {
    const g = graph(
      [node("wall", "part", [{ name: "a", type: "SLOT" }, { name: "b", type: "LIP" }])],
      [],
    );
    expect(cadProbedPortsLint.run(g)).toHaveLength(2);
  });

  // Registry hardware declares no ports and is exact by construction; the other
  // four lints skip it the same way.
  it("skips registry hardware", () => {
    const g = graph([node("m4", "fastener", [{ name: "x", type: "SHAFT" }])], []);
    expect(cadProbedPortsLint.run(g)).toEqual([]);
  });
});
