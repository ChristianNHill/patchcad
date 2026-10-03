import { describe, expect, it } from "vitest";
import { architectOutputToGraph, reexpandGraph, type ArchitectOutput } from "@patchcad/engine";
import { CadBackend, type CadContractPayload } from "./index.js";
import { cadJointRuleLint, expandJoints, jointErrors, staleJoints } from "./expand.js";
import { solveAssembly } from "./assembly.js";
import { boundDependents, resolvePose } from "./bindings.js";
import { buildBom } from "./bom.js";
import { hardwareAllowances } from "./g5.js";

/** Expansion turns intent into graph, so its tests read the graph: which
 *  nodes, which host ports, which edges, and whether every CAD lint is happy
 *  with what came out. */

const face = (name: string, z: number, size = 30, zAxis: [number, number, number] = [0, 0, 1]) => ({
  name, type: "FLAT_FACE" as const, pose: { origin: [0, 0, z], zAxis, xAxis: [1, 0, 0] }, params: { size },
});

function part(id: string, h: number, ports: ReturnType<typeof face>[], extra: Partial<CadContractPayload> = {}, d = 40) {
  return {
    id, kind: "part", title: id, spec: id,
    contract: {
      name: id, summary: id,
      params: [{ type: "number" as const, name: "thickness", description: "", default: h }],
      provides: ports.map((p) => ({ key: p.name, type: p.type, description: "" })),
      requires: [],
      payload: {
        units: "mm", process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 }, ports,
        envelope: { volumes: [{ kind: "cylinder", pose: { origin: [0, 0, h / 2], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, d, h }], clearance: 0.4 },
        paramBindings: {}, ...extra,
      },
    },
  };
}

/** A base whose top face holds a lid, both plates. */
function plates(joint: Record<string, unknown>, lidH = 10, baseH = 6): ArchitectOutput {
  const lid = part("lid", lidH, [face("base_face", 0, 30, [0, 0, -1])]);
  return {
    nodes: [part("base", baseH, [face("lid_face", "param(base.thickness)" as never)]), lid] as never,
    edges: [],
    entryNodeId: "base",
    rationale: "",
    design: "",
    joints: [{
      id: "j1", a: { node: "base", port: "lid_face" }, b: { node: "lid", port: "base_face" },
      intent: "removable", load: "light", access: "both_sides", wallA: "param(base.thickness)", wallB: "param(lid.thickness)",
      ...joint,
    }],
  } as ArchitectOutput;
}

const graphOf = (out: ArchitectOutput) => architectOutputToGraph(out, "t", "cad", "g", "mm");
const lintAll = (out: ArchitectOutput) => {
  const g = graphOf(out);
  return new CadBackend().planning.graphLints.flatMap((l) => l.run(g));
};
const ports = (out: ArchitectOutput, id: string) =>
  (out.nodes.find((n) => n.id === id)!.contract.payload as CadContractPayload).ports.map((p) => `${p.name}:${p.type}`);
const param = (out: ArchitectOutput, id: string, name: string) =>
  out.nodes.find((n) => n.id === id)!.contract.params.find((p) => p.name === name)?.default;

describe("a removable plate joint", () => {
  const out = expandJoints(plates({ count: 2, pitch: 16 }));

  it("mints the screw and insert with deterministic ids and catalog SKUs", () => {
    expect(out.nodes.map((n) => n.id)).toEqual(["base", "lid", "j1_screw", "j1_insert"]);
    expect(param(out, "j1_screw", "sku")).toBe("ISO7380-M3");
    expect(param(out, "j1_screw", "length")).toBe(12);
    expect(param(out, "j1_insert", "sku")).toBe("HEATSET-M3");
  });

  it("adds the host features to both parts, bound to the hardware by T1", () => {
    expect(ports(out, "base")).toEqual(["lid_face:FLAT_FACE", "j1_head_1:CLEARANCE_HOLE", "j1_head_2:CLEARANCE_HOLE"]);
    expect(ports(out, "lid")).toEqual(["base_face:FLAT_FACE", "j1_pocket_1:INSERT_POCKET", "j1_pocket_2:INSERT_POCKET"]);
    const lid = out.nodes[1]!.contract.payload as CadContractPayload;
    expect(lid.paramBindings).toEqual({
      j1_insert_d: "hw:insertHoleD:param:j1_insert.sku",
      j1_pocket: "expr: param(j1_screw.length) - (param(base.thickness)) - (0) + 0.5",
    });
    expect(param(out, "lid", "j1_insert_d")).toBe(4);
    expect(param(out, "lid", "j1_pocket")).toBe(6.5);
    expect(param(out, "base", "j1_clear")).toBe(3.4);
  });

  it("wires a face mate and one edge per screw, reusing the instancing pattern", () => {
    expect(out.edges).toEqual([
      { from: "base", fromPort: "lid_face", to: "lid", toPort: "base_face" },
      { from: "base", fromPort: "j1_head_1", to: "j1_screw", toPort: "head" },
      { from: "base", fromPort: "j1_head_2", to: "j1_screw", toPort: "head" },
      { from: "lid", fromPort: "j1_pocket_1", to: "j1_insert", toPort: "seat" },
      { from: "lid", fromPort: "j1_pocket_2", to: "j1_insert", toPort: "seat" },
    ]);
  });

  it("passes every CAD lint", () => {
    expect(lintAll(out)).toEqual([]);
  });

  it("puts each screw through its hole and into its insert", () => {
    const g = graphOf(out);
    const nodes = Object.values(g.nodes).map((n) => ({
      id: n.id,
      ports: Object.fromEntries((n.contract.payload as CadContractPayload).ports.map((p) => [p.name, resolvePose(g, p.pose)])),
    }));
    const { instances, problems } = solveAssembly(nodes, g.edges.map((e) => ({ fromNode: e.from, fromPort: e.fromPort, toNode: e.to, toPort: e.toPort })), "base");
    expect(problems).toEqual([]);
    const at = (id: string) => instances[id]!.map((m) => [m[12], m[13], m[14]].map((v) => Math.round(v! * 100) / 100));
    expect(at("j1_screw")).toEqual([[-8, 0, 0], [8, 0, 0]]); // head on the base's underside
    expect(at("j1_insert")).toEqual([[-8, 0, 6], [8, 0, 6]]); // flange flush with the lid's face
    expect(at("lid")).toEqual([[0, 0, 6]]);
  });

  it("is idempotent: expanding twice gives the same plan", () => {
    expect(expandJoints(out)).toEqual(out);
  });

  it("records the decision, so a stale one can be found later", () => {
    const g = graphOf(out);
    expect(g.joints[0]).toMatchObject({ id: "j1", expanded: expect.stringContaining("R4|screw=button:M3") });
    expect(staleJoints(g)).toEqual([]);
    g.nodes.lid!.contract.params[0]!.default = 6; // too thin for a standard insert now
    expect(staleJoints(g)).toEqual(["j1"]);
    // Too thin for any insert is not stale: the joint keeps its hardware and
    // the shortfall is reported instead.
    g.nodes.lid!.contract.params[0]!.default = 3;
    expect(staleJoints(g)).toEqual([]);
    expect(jointErrors(g)).toEqual([expect.stringContaining("j1: R4 wallB 3.0 < insert 5.8 + 1.2")]);
  });
});

describe("a joint no rule can make", () => {
  it("mints nothing, and the lint names the wall", () => {
    const out = expandJoints(plates({}, 3));
    expect(out.nodes.map((n) => n.id)).toEqual(["base", "lid"]);
    expect(cadJointRuleLint.run(graphOf(out))).toEqual([expect.stringContaining("j1: R4 wallB 3.0 < insert 5.8 + 1.2")]);
  });
});

describe("hardware nobody owns", () => {
  it("a bearing with no joint and no seat is a lint", () => {
    const out = plates({});
    out.joints = [];
    out.nodes.push({ ...part("loose-bearing", 7, []), kind: "bearing" } as never);
    expect(cadJointRuleLint.run(graphOf(out))).toEqual([expect.stringContaining("loose-bearing: a bearing that no joint owns")]);
  });
});

describe("a spinning rotor", () => {
  const out = expandJoints({
    ...plates({}),
    nodes: [
      part("base", 14, [face("rotor_face", 14)]),
      part("rotor", 8, [face("base_face", 0, 20, [0, 0, -1])], {}, 120),
    ] as never,
    joints: [{
      id: "j1", a: { node: "base", port: "rotor_face" }, b: { node: "rotor", port: "base_face" },
      intent: "permanent", motion: "revolute", duty: "continuous", load: "light", access: "both_sides",
      wallA: "param(base.thickness)", wallB: "param(rotor.thickness)",
    }],
  } as ArchitectOutput);

  it("expands to a shaft, two bearings and a collar", () => {
    expect(out.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual([
      "base:part", "rotor:part", "j1_bearing_a:bearing", "j1_bearing_b:bearing", "j1_collar:collar", "j1_shaft:shaft",
    ]);
    expect(param(out, "j1_bearing_a", "sku")).toBe("BRG-625");
    expect(param(out, "j1_shaft", "sku")).toBe("DSHAFT-5");
    expect(param(out, "j1_shaft", "length")).toBe(34); // 2 collars of 6 + housing 14 + hub 8
    expect(ports(out, "base")).toEqual(["rotor_face:FLAT_FACE", "j1_seat_a:BEARING_SEAT", "j1_seat_b:BEARING_SEAT"]);
    expect(ports(out, "rotor")).toEqual(["base_face:FLAT_FACE", "j1_hub:HUB_BORE"]);
    expect(param(out, "base", "j1_seat_od")).toBe(16);
    expect(param(out, "rotor", "j1_flat")).toBe(2);
  });

  it("places the rotor through the shaft, clear of the housing, and passes every lint", () => {
    expect(lintAll(out)).toEqual([]);
    const g = graphOf(out);
    const nodes = Object.values(g.nodes).map((n) => ({
      id: n.id,
      ports: Object.fromEntries((n.contract.payload as CadContractPayload).ports.map((p) => [p.name, resolvePose(g, p.pose)])),
    }));
    const { instances, problems } = solveAssembly(nodes, g.edges.map((e) => ({ fromNode: e.from, fromPort: e.fromPort, toNode: e.to, toPort: e.toPort })), "base");
    expect(problems).toEqual([]);
    const z = (id: string) => instances[id]!.map((m) => Math.round(m[14]! * 100) / 100);
    expect(z("rotor")).toEqual([20]); // housing top 14 + one collar 6
    expect(z("j1_collar")).toEqual([14, 0]);
    expect(z("j1_shaft")).toEqual([-6]);
  });

  // The rotor hangs on the shaft by its hub, so two loads cross the bearings:
  // weight pushes the shaft down and lift (or a child pulling the rotor) pulls
  // it up. One stop per direction: the upper collar carries the hub onto
  // bearing_a's inner race, the lower one holds the shaft up against
  // bearing_b's. Each copy's ORIGIN is its bearing's, because both sit on the
  // bearing's outer face; the bodies run away from each other.
  it("puts one collar outside each bearing, never inside one, and orders two", () => {
    expect(out.joints![0]!.expanded).toBe("M1|bearing_a=bearing:625|bearing_b=bearing:625|shaft=d_shaft:5|collar=collar:5");
    expect(out.edges.filter((e) => e.to === "j1_collar")).toEqual([
      { from: "j1_bearing_a", fromPort: "bore", to: "j1_collar", toPort: "seat" },
      { from: "j1_bearing_b", fromPort: "bore", to: "j1_collar", toPort: "seat" },
    ]);
    const g = graphOf(out);
    const nodes = Object.values(g.nodes).map((n) => ({
      id: n.id,
      ports: Object.fromEntries((n.contract.payload as CadContractPayload).ports.map((p) => [p.name, resolvePose(g, p.pose)])),
    }));
    const { instances } = solveAssembly(nodes, g.edges.map((e) => ({ fromNode: e.from, fromPort: e.fromPort, toNode: e.to, toPort: e.toPort })), "base");
    // Registry bodies run 0..h along their own +z (registry.ts).
    const span = (m: number[], h: number) => [m[14]!, m[14]! + m[10]! * h].sort((a, b) => a - b) as [number, number];
    const bearings = ["j1_bearing_a", "j1_bearing_b"].map((id) => span(instances[id]![0]!, 5));
    const collars = instances.j1_collar!.map((m) => span(m, 6));
    expect(bearings).toEqual([[9, 14], [0, 5]]);
    expect(collars).toEqual([[14, 20], [-6, 0]]);
    for (const [c0, c1] of collars) for (const [b0, b1] of bearings) expect(Math.min(c1, b1) - Math.max(c0, b0)).toBeLessThanOrEqual(1e-9);
    for (const n of Object.values(g.nodes)) (n as { artifact?: unknown }).artifact = { code: "registry" };
    expect(buildBom(g).buy.find((r) => r.sku === "COLLAR-5")).toMatchObject({ qty: 2, nodes: ["j1_collar"] });
    // A collar shares no material with a bearing by design, so G5 allows none.
    expect(hardwareAllowances(g).filter((a) => [a.a, a.b].includes("j1_collar"))).toEqual([]);
  });
});

describe("every recipe expands to a plan the CAD lints accept", () => {
  const cases: [string, Record<string, unknown>, number, number][] = [
    ["tapped (machined b)", {}, 6, 10],
    ["through-bolt", { load: "heavy" }, 6, 6],
    ["axial nut trap", { intent: "permanent", load: "medium" }, 4, 8],
    ["side nut trap", { intent: "permanent", load: "medium", access: "one_side", lateral: 14 }, 4, 10],
    ["countersunk into an insert", { flush: true }, 6, 10],
    ["dowels", { intent: "alignment", count: 2, pitch: 16 }, 8, 8],
    ["printed pegs", { intent: "alignment" }, 2, 3],
    ["bushing pivot", { motion: "revolute", wallA: 14 }, 14, 8],
    ["printed pin pivot", { motion: "revolute", allowPrinted: true }, 6, 8],
    ["rod slide", { motion: "prismatic", strokeMm: 40 }, 12, 30],
    ["rail slide", { motion: "prismatic", strokeMm: 200, load: "medium" }, 6, 10],
    ["NEMA 17 direct drive", { motion: "revolute", driven: true, precise: true }, 6, 10],
    ["brushless direct drive", { motion: "revolute", driven: true, speedClass: "high", duty: "continuous" }, 6, 10],
    ["servo direct drive", { motion: "revolute", driven: true, speedClass: "low" }, 4, 6],
    ["N20 direct drive", { motion: "revolute", driven: true, speedClass: "low", torqueClass: "high" }, 4, 8],
  ];
  for (const [label, joint, wa, wb] of cases) {
    it(label, () => {
      const plan = plates(joint, wb, wa);
      if (label.startsWith("tapped")) {
        const lid = plan.nodes[1]!.contract.payload as CadContractPayload;
        lid.process.kind = "CNC";
        lid.sourcing = { class: "fabricate", process: "cnc", material: "6061-T6 aluminium" };
      }
      const out = expandJoints(plan);
      expect(out.joints![0]).toHaveProperty("expanded");
      expect(lintAll(out)).toEqual([]);
    });
  }
});

describe("re-expansion on a live graph", () => {
  const backend = new CadBackend();
  const live = () => {
    const g = graphOf(expandJoints(plates({})));
    for (const n of Object.values(g.nodes)) n.status = "ready";
    return g;
  };

  it("a wall too thin for the standard insert swaps in the short one, dirtying exactly what changed", () => {
    const g = live();
    g.nodes.lid!.contract.params[0]!.default = 6;
    expect(staleJoints(g)).toEqual(["j1"]);
    const r = reexpandGraph(g, backend)!;
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    // The lid's pocket is the same Ø, and its depth is a T1 param, so the lid
    // itself re-executes on new values rather than regenerating.
    expect(r.changed.map((c) => c.id).sort()).toEqual(["j1_insert", "j1_screw"]);
    expect(r.graph.nodes.j1_insert!.contract.params.find((p) => p.name === "sku")!.default).toBe("HEATSET-S-M3");
    expect(staleJoints(r.graph)).toEqual([]);
    // Statuses are the caller's: re-expansion only reports.
    expect(r.graph.nodes.lid!.status).toBe("ready");
  });

  it("T1 re-resolves the screw before the pocket that reads its length", () => {
    expect(boundDependents(live(), "base")).toEqual(["j1_screw", "lid"]);
  });

  it("a wall that only moves the screw length is T1's, not a re-expansion", () => {
    const g = live();
    g.nodes.base!.contract.params[0]!.default = 4; // clamp shrinks: 12 → 10, same parts
    expect(staleJoints(g)).toEqual([]);
  });

  it("changing intent to alignment trades the screw for dowels", () => {
    const g = live();
    Object.assign(g.joints[0]!, { intent: "alignment" });
    const r = reexpandGraph(g, backend)!;
    expect(r.removed.sort()).toEqual(["j1_insert", "j1_screw"]);
    expect(r.added).toEqual(["j1_dowel"]);
    expect(r.dirty).toContain("base");
    expect(new CadBackend().planning.graphLints.flatMap((l) => l.run(r.graph))).toEqual([]);
  });
});

describe("kinematic joints and the swept G5", () => {
  const rotorPlan = () =>
    expandJoints({
      ...plates({}),
      nodes: [part("base", 14, [face("rotor_face", 14)]), part("rotor", 8, [face("base_face", 0, 20, [0, 0, -1])], {}, 120)] as never,
      joints: [{
        id: "j1", a: { node: "base", port: "rotor_face" }, b: { node: "rotor", port: "base_face" },
        intent: "permanent", motion: "revolute", duty: "continuous", load: "light", access: "both_sides", wallA: 14, wallB: 8,
      }],
    } as ArchitectOutput);

  it("records the revolute joint's world axis, limits and moving parts in the scene", () => {
    const { scene } = new CadBackend().solveScene(graphOf(rotorPlan()));
    expect(scene.joints).toEqual([
      { id: "j1", type: "revolute", origin: [0, 0, 14], direction: [0, 0, 1], limits: [-180, 180], moving: ["rotor", "j1_shaft", "j1_collar"] },
    ]);
  });

  it("records a rail's axis along the rail, with the carriage's travel either side", () => {
    const { scene } = new CadBackend().solveScene(graphOf(expandJoints(plates({ motion: "prismatic", strokeMm: 200, load: "medium" }))));
    expect(scene.joints).toEqual([
      expect.objectContaining({ type: "prismatic", direction: [1, 0, 0], limits: [-107.65, 107.65], moving: ["lid", "j1_carriage"] }),
    ]);
  });

  it("sends the sweeps to the kernel, and a swept hit becomes a finding on the joint", async () => {
    const g = graphOf(rotorPlan());
    for (const n of Object.values(g.nodes)) n.artifact = { code: `# ${n.id}`, testCode: "", hash: n.id };
    const calls: Record<string, unknown>[] = [];
    const kernel = {
      clash: async (_parts: unknown, opts: Record<string, unknown>) => {
        calls.push(opts);
        return {
          ok: true,
          clash: {
            parts: 6, pairs_tested: 3, clashes: [], contacts: [], errors: [],
            swept: [{ joint: "j1", a: "rotor", b: "base", volume_mm3: 48, at: [0, 45, 20], travel: 87 }],
          },
        };
      },
    } as never;
    const res = await new CadBackend({ kernel }).globalCheck(g, { root: "/tmp/patchcad-sweep" });
    expect(calls[0]!.sweeps).toEqual([
      { joint: "j1", type: "revolute", origin: [0, 0, 14], direction: [0, 0, 1], limits: [-180, 180], moving: ["rotor", "j1_shaft", "j1_collar"] },
    ]);
    expect(res.ok).toBe(false);
    expect(res.findings).toEqual([
      expect.objectContaining({ nodeA: "rotor", nodeB: "base", kind: "swept", message: expect.stringContaining("joint j1 carries rotor into base at 87°") }),
    ]);
  });
});

describe("cooking a joint's hardware", () => {
  it("costs zero LLM calls, and its mate frames are never probed", async () => {
    const { GraphStore, EventBus, cookNodes } = await import("@patchcad/engine");
    const out = expandJoints(plates({ count: 2, pitch: 16 }));
    const graph = graphOf(out);
    const requests: { code: string; ports: unknown[]; solids?: number }[] = [];
    const kernel = {
      execute: async (code: string, _params: unknown, contract?: { ports?: unknown[]; solids?: number }) => {
        requests.push({ code, ports: contract?.ports ?? [], solids: contract?.solids });
        return { ok: true, hash: "h", cached: false, glb: "", measurements: { volume_mm3: 1, ports: [] } };
      },
    } as never;
    let calls = 0;
    const provider = { id: "never", complete: async () => { calls++; throw new Error("hardware must not call a model"); } } as never;
    const store = new GraphStore(graph, new EventBus(), async () => {});
    const summary = await cookNodes({ store, backend: new CadBackend({ kernel }), provider, workspace: { root: "/tmp/x" } }, ["j1_screw", "j1_insert"]);
    expect(calls).toBe(0);
    expect(summary.succeeded.sort()).toEqual(["j1_insert", "j1_screw"]);
    expect(store.doc.nodes.j1_screw!.history.at(-1)!.cause).toBe("registry");
    expect(requests.every((r) => r.ports.length === 0 && r.solids === 1)).toBe(true);
    expect(requests.some((r) => r.code.includes("RegularPolygon") || r.code.includes("Cylinder"))).toBe(true);
  });
});
