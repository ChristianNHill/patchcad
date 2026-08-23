import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { boundDependents, resolveParamBindings } from "./bindings.js";

/** T1 resolution is pure graph → values: no kernel, no LLM, no I/O. */

const payloadBase = {
  units: "mm",
  process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
  ports: [],
  envelope: { volumes: [{ kind: "box", pose: { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims: [10, 10, 10] }], clearance: 0.4 },
};

function makeGraph(bracketBindings: Record<string, string>, plateParams: Record<string, number | string> = {}) {
  const node = (id: string, params: { name: string; default: number | string; type?: string }[], bindings = {}) => ({
    id,
    kind: "part",
    title: id,
    spec: "",
    contract: {
      name: id,
      summary: "",
      params: params.map((p) => ({ type: p.type ?? "number", name: p.name, description: "", default: p.default })),
      provides: [],
      requires: [],
      payload: { ...payloadBase, paramBindings: bindings },
      hash: "",
    },
    params: id === "plate" ? plateParams : {},
    artifact: null,
    thread: [],
    status: "ready",
    version: 1,
    history: [],
    cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
  });
  return GraphDoc.parse({
    schemaVersion: 1,
    id: "t1",
    backend: "cad",
    brief: { goal: "", constraints: [], clarifications: [] },
    nodes: {
      plate: node("plate", [
        { name: "hole_diameter", default: 4.5 },
        { name: "thread", default: "M4", type: "string" },
      ]),
      bracket: node("bracket", [{ name: "hole_diameter", default: 4.5 }], bracketBindings),
    },
    edges: [],
    assembly: { entryNodeId: "plate" },
    rev: 0,
  });
}

describe("T1 param bindings", () => {
  it("copies an upstream param (override beats default)", () => {
    const graph = makeGraph({ hole_diameter: "param:plate.hole_diameter" }, { hole_diameter: 5 });
    const { resolved, problems } = resolveParamBindings(graph, "bracket");
    expect(problems).toEqual([]);
    expect(resolved.hole_diameter).toBe(5);
  });

  it("falls back to the contract default when no override is set", () => {
    const graph = makeGraph({ hole_diameter: "param:plate.hole_diameter" });
    expect(resolveParamBindings(graph, "bracket").resolved.hole_diameter).toBe(4.5);
  });

  it("looks up clearance diameters from the metric table", () => {
    const graph = makeGraph({ hole_diameter: "clearance:M4" });
    expect(resolveParamBindings(graph, "bracket").resolved.hole_diameter).toBe(4.5);
  });

  it("chains clearance through an upstream thread param", () => {
    const graph = makeGraph({ hole_diameter: "clearance:param:plate.thread" }, { thread: "M5" });
    expect(resolveParamBindings(graph, "bracket").resolved.hole_diameter).toBe(5.5);
  });

  it("reports instead of guessing on bad expressions", () => {
    const graph = makeGraph({ hole_diameter: "param:ghost.size" });
    const { resolved, problems } = resolveParamBindings(graph, "bracket");
    expect(resolved).toEqual({});
    expect(problems[0]).toContain("resolves to nothing");
  });

  it("finds the bound dependents of a changed node", () => {
    const graph = makeGraph({ hole_diameter: "clearance:param:plate.thread" });
    expect(boundDependents(graph, "plate")).toEqual(["bracket"]);
    expect(boundDependents(graph, "bracket")).toEqual([]);
  });

  it("selects the largest thread that fits a drilled hole", () => {
    for (const [hole, thread] of [
      [4.5, "M4"],
      [5.5, "M5"],
      [3.4, "M3"],
      [4.9, "M4"], // between M4 and M5 clearances → stay at M4
    ] as const) {
      const graph = makeGraph({ thread: "threadForHole:param:plate.hole_diameter" }, { hole_diameter: hole });
      expect(resolveParamBindings(graph, "bracket").resolved.thread, `Ø${hole}`).toBe(thread);
    }
  });

  it("rejects holes smaller than any thread's clearance", () => {
    const graph = makeGraph({ thread: "threadForHole:param:plate.hole_diameter" }, { hole_diameter: 2 });
    expect(resolveParamBindings(graph, "bracket").problems[0]).toContain("below every known thread");
  });

  it("derives screw length from the clamped stack, snapped UP to standard sizes", () => {
    // stack = plate.hole_diameter stand-in params: use expr over two params
    const graph = makeGraph(
      { hole_diameter: "screwLength: param(plate.hole_diameter) + param(bracket.hole_diameter) + 4" },
      { hole_diameter: 5 }, // 5 + 4.5 + 4 = 13.5 → snaps to 16
    );
    expect(resolveParamBindings(graph, "bracket").resolved.hole_diameter).toBe(16);
  });

  it("re-derives when the upstream stack changes (the user's fan-plate → screw case)", () => {
    const bindings = { hole_diameter: "screwLength: param(plate.hole_diameter) + 4" };
    const thin = makeGraph(bindings, { hole_diameter: 4 }); // 8 → 8
    const thick = makeGraph(bindings, { hole_diameter: 14 }); // 18 → 20
    expect(resolveParamBindings(thin, "bracket").resolved.hole_diameter).toBe(8);
    expect(resolveParamBindings(thick, "bracket").resolved.hole_diameter).toBe(20);
  });

  it("evaluates arithmetic with precedence and parens, and reports bad refs", () => {
    const graph = makeGraph({ hole_diameter: "expr: (param(plate.hole_diameter) + 1) * 2 - 3" }, { hole_diameter: 5 });
    expect(resolveParamBindings(graph, "bracket").resolved.hole_diameter).toBe(9);
    const bad = makeGraph({ hole_diameter: "expr: param(ghost.x) + 1" });
    expect(resolveParamBindings(bad, "bracket").problems[0]).toContain("param(ghost.x) is missing");
  });

  it("finds dependents referenced via expr syntax too", () => {
    const graph = makeGraph({ hole_diameter: "screwLength: param(plate.hole_diameter) + 4" });
    expect(boundDependents(graph, "plate")).toEqual(["bracket"]);
  });
});

// eslint-disable-next-line import/first
import { cadPortConsistencyLint } from "./index.js";

describe("cad-port-consistency lint", () => {
  it("flags contract/edge port names missing from the payload geometry", () => {
    const graph = makeGraph({});
    // give plate a contract port with no payload counterpart + a bad edge
    graph.nodes.plate!.contract.provides.push({ key: "arm_pad", type: "FLAT_FACE", description: "" });
    graph.edges.push({ id: "e0", from: "plate", fromPort: "arm_pad", to: "bracket", toPort: "ghost_port" });
    const problems = cadPortConsistencyLint.run(graph);
    expect(problems.some((p) => p.includes('contract port "arm_pad"'))).toBe(true);
    expect(problems.some((p) => p.includes('"ghost_port" is not a payload port name'))).toBe(true);
  });

  it("stays quiet when names agree", () => {
    const graph = makeGraph({});
    expect(cadPortConsistencyLint.run(graph)).toEqual([]);
  });
});
