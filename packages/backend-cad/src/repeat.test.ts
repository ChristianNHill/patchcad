import { describe, expect, it } from "vitest";
import { architectOutputToGraph, reexpandGraph, type ArchitectOutput } from "@patchcad/engine";
import { CadBackend, type CadContractPayload } from "./index.js";
import { expandRepeats } from "./repeat.js";

const pose = (origin: (number | string)[], zAxis: number[] = [0, 0, 1]) => ({ origin, zAxis, xAxis: [1, 0, 0] });
const node = (id: string, ports: unknown[], envelope: unknown, params: { name: string; default: number }[] = []) => ({
  id, kind: "part", title: id, spec: id,
  contract: {
    name: id, summary: id,
    params: params.map((p) => ({ type: "number" as const, description: "", ...p })),
    provides: (ports as { name: string; type: string }[]).map((p) => ({ key: p.name, type: p.type, description: "" })),
    requires: [],
    payload: { units: "mm", process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 }, ports, envelope: { volumes: [envelope], clearance: 0.4 }, paramBindings: {} },
  },
});

/** A post with a bracket station repeated up it, and one bracket node. */
function post(count = 6): ArchitectOutput {
  return {
    nodes: [
      node("post", [
        { name: "station", type: "SHAFT", pose: pose([0, 0, 300]), params: { diameter: 16 }, repeat: { count, step: [0, 0, "param(post.pitch)"] } },
      ], { kind: "cylinder", pose: pose([0, 0, 1250]), d: 16, h: 2500 }, [{ name: "pitch", default: 400 }]),
      node("bracket", [
        { name: "bore", type: "BORE", pose: pose([0, 0, 0], [0, 0, -1]), params: { diameter: 16.4 } },
      ], { kind: "box", pose: pose([0, 0, 0]), dims: [30, 300, 20] }),
    ],
    edges: [{ from: "post", fromPort: "station", to: "bracket", toPort: "bore" }],
    entryNodeId: "post", rationale: "", design: "",
    joints: [{ id: "clamp", a: { node: "post", port: "station" }, b: { node: "bracket", port: "bore" }, intent: "serviceable" }],
  } as unknown as ArchitectOutput;
}

describe("repeated ports", () => {
  it("mints <name>_1..N at origin + k·step and repeats edges and joints onto each", () => {
    const out = expandRepeats(post());
    const ports = (out.nodes[0]!.contract.payload as CadContractPayload).ports;
    expect(ports.map((p) => p.name)).toEqual(["station_1", "station_2", "station_3", "station_4", "station_5", "station_6"]);
    expect(ports.map((p) => p.pose.origin[2])).toEqual([300, "(300) + (param(post.pitch))", "(300) + 2 * (param(post.pitch))", "(300) + 3 * (param(post.pitch))", "(300) + 4 * (param(post.pitch))", "(300) + 5 * (param(post.pitch))"]);
    expect(ports.some((p) => "repeat" in p)).toBe(false);
    expect(out.nodes[0]!.contract.provides.map((p) => p.key)).toEqual(ports.map((p) => p.name));
    expect(out.edges.map((e) => e.fromPort)).toEqual(ports.map((p) => p.name));
    expect((out.joints as { id: string; a: { port: string } }[]).map((j) => `${j.id}:${j.a.port}`)).toEqual(ports.map((p, k) => `clamp-${k + 1}:${p.name}`));
  });

  it("places the one bracket node at every level", () => {
    const g = architectOutputToGraph(expandRepeats({ ...post(), joints: [] } as ArchitectOutput), "t", "cad", "g", "mm");
    const { instances, problems } = new CadBackend().solveScene(g);
    expect(problems).toEqual([]);
    expect(instances.bracket!.map((m) => Math.round(m[14]!))).toEqual([300, 700, 1100, 1500, 1900, 2300]);
  });

  it("re-expanding an expanded graph changes nothing", () => {
    const g = architectOutputToGraph(new CadBackend().planning.expandPlan!({ ...post(), joints: [] } as ArchitectOutput), "t", "cad", "g", "mm");
    const r = reexpandGraph(g, new CadBackend() as never)!;
    expect(r.changed).toEqual([]);
    expect(r.added).toEqual([]);
  });
});

describe("a bracket clamped at every level (C1)", () => {
  const plan = (joint: Record<string, unknown>) => {
    const out = post();
    out.joints = [{ id: "clamp", a: { node: "post", port: "station" }, b: { node: "bracket", port: "bore" }, intent: "serviceable", motion: "fixed", load: "light", access: "one_side", wallA: 16, wallB: 6, ...joint }] as never;
    return new CadBackend().planning.expandPlan!(out);
  };

  it("thumb screw when it moves by hand (M5: M6 starts at 8mm, the wall is 6), one set riding every copy", () => {
    const out = plan({ toolFree: true });
    const joints = out.joints as { id: string; expanded?: string }[];
    expect(joints.map((j) => j.expanded)).toEqual(Array(6).fill("C1|screw=thumb_screw:M5"));
    // The later levels ride the first level's set: one screw node.
    expect(out.nodes.filter((n) => n.kind === "fastener").map((n) => n.id)).toEqual(["clamp-1_screw"]);
    const g = architectOutputToGraph(out, "t", "cad", "g", "mm");
    const { instances, problems } = new CadBackend().solveScene(g);
    expect(problems).toEqual([]);
    expect(instances["clamp-1_screw"]).toHaveLength(6);
    expect(new CadBackend().planning.graphLints.flatMap((l) => l.run(g)).filter((m) => /clamp|bracket|post/.test(m))).toEqual([]);
  });

  it("set screw by default, and a DIN 705 collar under a medium load", () => {
    expect((plan({}).joints as { expanded?: string }[])[0]!.expanded).toBe("C1|screw=set_screw:M6");
    expect((plan({ load: "medium" }).joints as { expanded?: string }[])[0]!.expanded).toBe("C1|screw=set_screw:M6|collar=collar:16");
  });

  it("a wall too thin for any stocked length says so", () => {
    const out = plan({ toolFree: true, wallB: 3 });
    expect((out.joints as { expanded?: string; failed?: string }[])[0]!.expanded).toBeUndefined();
  });
});
