import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { architectOutputToGraph, reexpandGraph, type ArchitectOutput } from "@patchcad/engine";
import { CadBackend, type CadContractPayload } from "./index.js";
import { cadJointRuleLint, expandJoints, jointErrors, staleJoints } from "./expand.js";
import { solveAssembly } from "./assembly.js";
import { boundDependents, resolvePose } from "./bindings.js";
import { buildBom } from "./bom.js";
import { hardwareAllowances } from "./g5.js";
import { meshSourceLint } from "./mesh-source.js";

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
    // Too thin for any insert, it takes a through-bolt (R3 last); reachable
    // from one side only, nothing fits, which is not stale: the joint keeps
    // its hardware and the shortfall is reported instead.
    g.nodes.lid!.contract.params[0]!.default = 3;
    expect(staleJoints(g)).toEqual(["j1"]);
    (g.joints[0] as unknown as { access: string }).access = "one_side";
    expect(staleJoints(g)).toEqual([]);
    expect(jointErrors(g)).toEqual([expect.stringContaining("j1: R4 wallB 3.0 < insert 5.8 + 1.2")]);
  });
});

describe("a joint no rule can make", () => {
  it("mints nothing, and the lint names the wall", () => {
    const out = expandJoints(plates({ access: "one_side" }, 3));
    expect(out.nodes.map((n) => n.id)).toEqual(["base", "lid"]);
    expect(cadJointRuleLint.run(graphOf(out))).toEqual([expect.stringContaining("j1: R4 wallB 3.0 < insert 5.8 + 1.2")]);
  });

  it("names the declaration that would fit before a thicker wall", () => {
    const [problem] = cadJointRuleLint.run(graphOf(expandJoints(plates({ access: "one_side" }, 3))));
    expect(problem).toContain("Declare access both_sides for R3's M3×16 through-bolt, nut and washers; or thicken the wall it names.");
  });

  it("never asks to thicken a wall the brief states", () => {
    const g = graphOf(expandJoints(plates({ access: "one_side" }, 3)));
    g.brief.goal = "a lid 3mm thick screwed onto a base";
    const [problem] = cadJointRuleLint.run(g);
    expect(problem).toContain("The brief states wallB 3.0: keep it. Declare access both_sides");
    expect(problem).not.toContain("thicken");
  });
});

describe("two thin printed plates bolted face to face", () => {
  // The two-plate-bolted eval: 4mm plates, one M4, both faces reachable. R4
  // and R5 need thicker plates; R3's through-bolt is the fallback.
  const out = expandJoints(plates({ threadHint: "M4" }, 4, 4));

  it("takes a through-bolt, nut and washers, with a clearance hole in each plate", () => {
    expect(out.nodes.map((n) => n.id)).toEqual(["base", "lid", "j1_screw", "j1_nut", "j1_washer_b", "j1_washer_a"]);
    expect(param(out, "j1_screw", "length")).toBe(16);
    expect(ports(out, "base")).toContain("j1_head:CLEARANCE_HOLE");
    expect(ports(out, "lid")).toContain("j1_back:CLEARANCE_HOLE");
    expect(param(out, "lid", "j1_clear")).toBe(4.5);
  });

  it("passes every CAD lint", () => {
    expect(lintAll(out)).toEqual([]);
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
      // A rail's screws sit along its whole length, inside the part it is on.
      if (label.startsWith("rail")) Object.assign((plan.nodes[0]!.contract.payload as CadContractPayload).envelope.volumes[0]!, { d: 300 });
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
      { id: "j1", type: "revolute", origin: [0, 0, 14], direction: [0, 0, 1], limits: [-180, 180], moving: ["rotor", "j1_shaft", "j1_collar", "j1_collar#1"] },
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
      { joint: "j1", type: "revolute", origin: [0, 0, 14], direction: [0, 0, 1], limits: [-180, 180], moving: ["rotor", "j1_shaft", "j1_collar", "j1_collar#1"] },
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

describe("drives", () => {
  /** A base whose top is the joint face and a lid driven against it. */
  const driven = (joint: Record<string, unknown>, baseH: number, lidH: number, baseD = 200) =>
    expandJoints({
      ...plates({}),
      nodes: [part("base", baseH, [face("top", baseH)], {}, baseD), part("lid", lidH, [face("bottom", 0, 30, [0, 0, -1])])] as never,
      joints: [{
        id: "j1", a: { node: "base", port: "top" }, b: { node: "lid", port: "bottom" }, intent: "permanent", load: "light", access: "both_sides",
        wallA: "param(base.thickness)", wallB: "param(lid.thickness)", ...joint,
      }],
    } as ArchitectOutput);
  const solved = (out: ArchitectOutput) => {
    const g = graphOf(out);
    const nodes = Object.values(g.nodes).map((n) => ({
      id: n.id,
      ports: Object.fromEntries((n.contract.payload as CadContractPayload).ports.map((p) => [p.name, resolvePose(g, p.pose)])),
    }));
    const r = solveAssembly(nodes, g.edges.map((e) => ({ fromNode: e.from, fromPort: e.fromPort, toNode: e.to, toPort: e.toPort })), "base");
    expect(r.problems).toEqual([]);
    return (id: string) => r.instances[id]!.map((m) => [m[12], m[13], m[14]].map((v) => Math.round(v! * 100) / 100));
  };

  it("a belt drive: spindle, spacer, motor beside it, two pulleys level, and the loop between them", () => {
    const out = driven({ motion: "revolute", driven: true, ratio: 2, wallMotor: 6 }, 14, 8);
    expect(out.nodes.map((nd) => `${nd.id}:${nd.kind}`).slice(2)).toEqual([
      "j1_bearing_a:bearing", "j1_bearing_b:bearing", "j1_collar:collar", "j1_spacer:washer", "j1_shaft:shaft",
      "j1_motor:motor", "j1_motor_pulley:pulley", "j1_driven_pulley:pulley", "j1_belt:belt",
    ]);
    expect(lintAll(out)).toEqual([]);
    expect(param(out, "j1_belt", "sku")).toBe("GT2L-6");
    expect(param(out, "j1_belt", "length")).toBe(158);
    expect(param(out, "j1_belt", "center")).toBe(48.58);
    expect(ports(out, "base")).toContain("j1_motor_mount:MOTOR_MOUNT");
    const at = solved(out);
    expect(at("j1_motor")).toEqual([[48.58, 0, 8]]); // in its 6mm pocket under the 14mm housing
    expect(at("j1_motor_pulley")).toEqual([[48.58, 0, 15]]);
    expect(at("j1_driven_pulley")).toEqual([[0, 0, 15]]); // on the spacer washer, level with the motor's
    expect(at("j1_spacer")).toEqual([[0, 0, 14]]);
    expect(at("j1_collar")).toEqual([[0, 0, 0]]); // one collar now, under bearing_b
    expect(at("j1_belt")).toEqual([[48.58, 0, 23.5]]); // the rims' middle less half the belt width
    expect(at("lid")).toEqual([[0, 0, 32]]);
  });

  it("the belt runs from the motor back to the driven axis, and the motor pulley turns with b at the ratio", () => {
    const g = graphOf(driven({ motion: "revolute", driven: true, ratio: 2, wallMotor: 6 }, 14, 8));
    const { scene } = new CadBackend().solveScene(g);
    const belt = (scene.nodes as unknown as Record<string, { matrix: number[] }>).j1_belt!;
    expect(belt.matrix[0]).toBeCloseTo(-1); // its +x points from the motor at x=48.58 to the spindle at 0
    expect(scene.joints).toEqual([{
      id: "j1", type: "revolute", origin: [0, 0, 14], direction: [0, 0, 1], limits: [-180, 180],
      moving: ["lid", "j1_shaft", "j1_collar", "j1_spacer", "j1_driven_pulley"],
      coupled: [{ origin: [48.58, 0, 14], direction: [0, 0, 1], ratio: 2, moving: ["j1_motor_pulley"] }],
    }]);
  });

  it("a gear drive: the pair at m·(z1+z2)/2, level, counter-rotating, and G5 allows their mesh", () => {
    const out = driven({ motion: "revolute", driven: true, ratio: 2, torqueClass: "high", wallMotor: 6 }, 14, 8);
    expect(lintAll(out)).toEqual([]);
    const gear = (id: string) => Object.fromEntries(["module", "teeth", "thickness", "bore", "flat", "phase"].map((k) => [k, param(out, id, k)]));
    expect(gear("j1_motor_gear")).toEqual({ module: 1.5, teeth: 17, thickness: 9, bore: 5, flat: 2, phase: 0 });
    expect(gear("j1_driven_gear")).toEqual({ module: 1.5, teeth: 34, thickness: 9, bore: 5, flat: 2, phase: 0 });
    const at = solved(out);
    expect(at("j1_motor_gear")).toEqual([[38.25, 0, 19.5]]); // centred gears, 9 thick, on the 15 plane
    expect(at("j1_driven_gear")).toEqual([[0, 0, 19.5]]);
    expect(at("lid")).toEqual([[0, 0, 25]]);
    const g = graphOf(out);
    expect(new CadBackend().solveScene(g).scene.joints[0]!.coupled).toEqual([
      { origin: [38.25, 0, 14], direction: [0, 0, 1], ratio: -2, moving: ["j1_motor_gear"] },
    ]);
    const mesh = hardwareAllowances(g).filter((a) => [a.a, a.b].includes("j1_motor_gear"));
    expect(mesh).toEqual([{ a: "j1_motor_gear", b: "j1_driven_gear", volume_mm3: expect.any(Number) }]);
    expect(mesh[0]!.volume_mm3).toBeLessThan(1);
  });

  it("a lead screw: motor, coupler and screw on the axis, b on the nut, the guide rod beside", () => {
    const out = driven({ motion: "prismatic", driven: true, strokeMm: 100 }, 10, 30);
    expect(lintAll(out)).toEqual([]);
    expect(out.edges.some((e) => e.from === "base" && e.to === "lid")).toBe(false);
    const at = solved(out);
    expect(at("j1_coupler")).toEqual([[0, 0, 11]]);
    expect(at("j1_lead_screw")).toEqual([[0, 0, 23.5]]);
    expect(at("lid")).toEqual([[0, 0, 40.5]]); // 30.5 over the face: coupler, the nut's flange, 1mm
    expect(at("j1_lead_nut")).toEqual([[0, 0, 40.5]]);
    expect(at("j1_rod")).toEqual([[20, 0, 1.2]]);
    expect(at("j1_linear_bearing")).toEqual([[20, 0, 40.5]]);
    expect(param(out, "j1_rod", "length")).toBe(169.3); // socket 8.8 + 30.5 + stroke 100 + b 30
    const { scene } = new CadBackend().solveScene(graphOf(out));
    expect(scene.joints).toEqual([expect.objectContaining({
      type: "prismatic", direction: [0, 0, 1], limits: [0, 100], moving: ["lid", "j1_lead_nut", "j1_linear_bearing"],
      coupled: [{ origin: [0, 0, 10], direction: [0, 0, 1], ratio: 45, moving: ["j1_coupler", "j1_lead_screw"] }],
    })]);
  });

  it("a belt carriage: rail screwed down at every hole, motor and idler past its ends, b slotted over the belt", () => {
    const out = driven({ motion: "prismatic", driven: true, strokeMm: 100, speedClass: "high", wallMotor: 6 }, 8, 10, 400);
    expect(lintAll(out)).toEqual([]);
    expect(ports(out, "lid")).toContain("j1_belt_slot:SLOT");
    expect(out.edges.filter((e) => e.to === "j1_rail_screw")).toHaveLength(7);
    const at = solved(out);
    expect(at("j1_rail_screw")).toEqual([-60, -40, -20, 0, 20, 40, 60].map((x) => [x, 0, 11])); // heads on MGN9's counterbore floors
    expect(at("j1_rail_insert")).toEqual([-60, -40, -20, 0, 20, 40, 60].map((x) => [x, 0, 8]));
    expect(at("j1_motor_pulley")).toEqual([[-98.15, 19.49, 9]]);
    expect(at("j1_idler_washer")).toEqual([[98.15, 19.49, 15]]); // on its 7mm boss
    expect(at("j1_idler")).toEqual([[98.15, 19.49, 16]]);
    expect(at("j1_belt")).toEqual([[-98.15, 19.49, 17.5]]);
    expect(param(out, "j1_belt", "length")).toBe(434);
    expect(param(out, "lid", "j1_belt_slot") ?? null).toBe(null);
    const slot = (out.nodes[1]!.contract.payload as CadContractPayload).ports.find((p) => p.name === "j1_belt_slot")!;
    expect(slot.params).toEqual({ width: 2.38, depth: 6 });
  });
});

describe.each(["cad-belt-drive", "cad-joints"])("examples/%s", (example) => {
  const root = new URL(`../../../examples/${example}/`, import.meta.url);
  const g = GraphDoc.parse(JSON.parse(readFileSync(new URL("patchcad.json", root), "utf8")));

  it("is the plan its joint expands to today, and every lint passes", () => {
    expect(staleJoints(g)).toEqual([]);
    expect(new CadBackend().planning.graphLints.flatMap((l) => l.run(g))).toEqual([]);
  });

  it("keeps the registry's own code for every piece of hardware", () => {
    const backend = new CadBackend();
    for (const n of Object.values(g.nodes)) {
      const code = backend.deterministicArtifact(n)?.code;
      if (code) expect(readFileSync(new URL(`nodes/${n.id}/v1.code.py`, root), "utf8")).toBe(code);
    }
  });
});

describe("audit fixes", () => {
  it("a joint id that prefixes an architect's port strips only what the joint minted", () => {
    const plan = plates({});
    const base = plan.nodes[0]!.contract.payload as CadContractPayload;
    base.ports.push({ ...base.ports[0]!, name: "j1_face", pose: { ...base.ports[0]!.pose, origin: [5, 0, 6] } } as never);
    const out = expandJoints(plan);
    expect(ports(out, "base")).toContain("j1_face:FLAT_FACE");
    expect(out.joints![0]).toMatchObject({ expanded: expect.stringContaining("R4"), minted: expect.arrayContaining(["j1_head", "j1_clear"]) });
    // Only names on the two parts: the hardware's own "head" and "seat" go with the hardware.
    for (const name of ["j1_face", "head", "seat"]) expect((out.joints![0] as unknown as { minted: string[] }).minted).not.toContain(name);
    const again = expandJoints(out);
    expect(again).toEqual(out);
    expect(ports(again, "base")).toContain("j1_face:FLAT_FACE");
  });

  it("a recipe that throws strips what it began and the lint says why", () => {
    const plan = plates({});
    const lid = plan.nodes[1]!.contract.payload as CadContractPayload;
    lid.ports[0]!.pose = { ...lid.ports[0]!.pose, xAxis: ["param(lid.thickness)", 0, 0] } as never;
    const out = expandJoints(plan);
    expect(out.nodes.map((nd) => nd.id)).toEqual(["base", "lid"]);
    expect(ports(out, "base")).toEqual(["lid_face:FLAT_FACE"]);
    expect(cadJointRuleLint.run(graphOf(out))).toEqual([
      expect.stringContaining("R4 could not be expanded: a joint port's axes must be numbers"),
    ]);
  });

  it("the rod socket of a slide has a depth to stop the cut at", () => {
    const out = expandJoints(plates({ motion: "prismatic", strokeMm: 40 }, 30, 12));
    const rod = (out.nodes[0]!.contract.payload as CadContractPayload).ports.find((p) => p.name === "j1_rod")!;
    expect(rod.params.depth).toBe("(param(base.thickness)) - 1.2");
    expect(ports(out, "lid")).toContain("j1_lm_seat:LINEAR_BEARING_SEAT");
  });

  it("a joint may end on a mesh node: the features it mints are the rules', not the architect's", () => {
    const plan = plates({});
    (plan.nodes[1]!.contract.payload as CadContractPayload).geometrySource = "mesh";
    const g = graphOf(expandJoints(plan));
    g.brief.refs = [{ hash: "abc", mask: false }];
    expect(meshSourceLint(true).run(g)).toEqual([]);
  });

  it("a printed pin carries its e-clip in a probed groove past b", () => {
    const out = expandJoints(plates({ motion: "revolute", allowPrinted: true }, 8, 6));
    expect(lintAll(out)).toEqual([]);
    const groove = (out.nodes[0]!.contract.payload as CadContractPayload).ports.find((p) => p.name === "j1_clip_groove")!;
    expect(groove.params).toEqual({ diameter: 4, width: 0.74, shaft_diameter: 5 });
    // On the pin's axis, half a groove past b's far face.
    expect(groove.pose.origin).toEqual([0, 0, "(param(base.thickness)) + ((param(lid.thickness)) + 0.37)"]);
    expect(param(out, "j1_pin_clip", "sku")).toBe("DIN6799-4");
    expect(expandJoints(out)).toEqual(out);
  });

  it("a rail sits on a RAIL_MOUNT land whose holes are its screws'", () => {
    const plan = plates({ motion: "prismatic", strokeMm: 200, load: "medium" }, 10, 6);
    Object.assign((plan.nodes[0]!.contract.payload as CadContractPayload).envelope.volumes[0]!, { d: 300 });
    const out = expandJoints(plan);
    const mount = (out.nodes[0]!.contract.payload as CadContractPayload).ports.find((p) => p.name === "j1_rail_mount")!;
    expect(mount).toMatchObject({ type: "RAIL_MOUNT", params: { width: 12, length: 250, pitch: 25, count: 10, hole_diameter: "param(base.j1_rail_insert_d)" } });
    expect(out.edges.filter((e) => e.fromPort === "j1_rail_mount").map((e) => e.to)).toEqual(["j1_rail", "j1_carriage"]);
  });
});

/** Solved world poses of a plan, every placed copy. */
function solved(out: ArchitectOutput) {
  const g = graphOf(out);
  const nodes = Object.values(g.nodes).map((n) => ({
    id: n.id,
    ports: Object.fromEntries((n.contract.payload as CadContractPayload).ports.map((p) => [p.name, resolvePose(g, p.pose)])),
  }));
  return { g, ...solveAssembly(nodes, g.edges.map((e) => ({ fromNode: e.from, fromPort: e.fromPort, toNode: e.to, toPort: e.toPort })), out.entryNodeId) };
}
const at3 = (m: number[]) => [m[12], m[13], m[14]].map((v) => Math.round(v! * 100) / 100);

describe("the butt hinge: a catalog pin pressed in one knuckle, turning in the other", () => {
  // The hinge-revolute eval: 3mm leaves, a Ø3 pin, 7.7mm knuckles.
  const out = expandJoints({
    ...plates({}),
    nodes: [
      part("leaf-a", 7.7, [face("knuckle", 7.7, 6)]),
      part("leaf-b", 7.7, [face("knuckle", 0, 6, [0, 0, -1])]),
    ] as never,
    entryNodeId: "leaf-a",
    joints: [{
      id: "hinge", a: { node: "leaf-a", port: "knuckle" }, b: { node: "leaf-b", port: "knuckle" },
      intent: "permanent", motion: "revolute", load: "light", wallA: 7.7, wallB: 7.7, shaftHint: 3,
    }],
  } as ArchitectOutput);

  it("mints the pin and a DOWEL_HOLE in each knuckle at the pin's nominal Ø, fit by port", () => {
    expect(out.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual(["leaf-a:part", "leaf-b:part", "hinge_pin:dowel"]);
    expect(param(out, "hinge_pin", "length")).toBe(12);
    const hole = (id: string, name: string) => (out.nodes.find((n) => n.id === id)!.contract.payload as CadContractPayload).ports.find((p) => p.name === name)!.params;
    expect(hole("leaf-a", "hinge_pin_a")).toEqual({ diameter: "param(leaf-a.hinge_pin_d)", depth: 4.5, fit: "press" });
    // 0.2mm would be left under a 7.5 bore in a 7.7 knuckle: it goes through.
    expect(hole("leaf-b", "hinge_pin_b")).toEqual({ diameter: "param(leaf-b.hinge_pin_d)", depth: 7.7, fit: "slip" });
    expect(param(out, "leaf-a", "hinge_pin_d")).toBe(3);
    expect(lintAll(out)).toEqual([]);
  });

  it("seats the pin across the knuckles and lets b turn on it", () => {
    const { g, instances, problems } = solved(out);
    expect(problems).toEqual([]);
    // Centred on its origin: 4.5 in a, 7.5 in b, from a's face at 7.7.
    expect(at3(instances["hinge_pin"]![0]!)).toEqual([0, 0, 9.2]);
    expect(at3(instances["leaf-b"]![0]!)).toEqual([0, 0, 7.7]);
    expect(hardwareAllowances(g).map((x) => `${x.a}|${x.b}`)).toEqual(["leaf-a|hinge_pin"]);
    const axes = new CadBackend().solveScene(g).joints;
    expect(axes.map((j) => [j.id, j.moving])).toEqual([["hinge", ["leaf-b"]]]);
  });
});

/** A body with a wheel face on each side of two axles, y = ±25. */
function car(wheels: "four" | "one", hubFit?: "press") {
  const side = (name: string, x: number, s: 1 | -1) => ({ name, type: "FLAT_FACE" as const, pose: { origin: [x, 25 * s, 10], zAxis: [0, s, 0] as [number, number, number], xAxis: [1, 0, 0] }, params: { size: 12 } });
  const box = { volumes: [{ kind: "box" as const, pose: { origin: [0, 0, 10], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims: [100, 50, 20] }], clearance: 0.4 };
  const body = part("body", 20, [side("seat_fl", 40, 1), side("seat_fr", 40, -1), side("seat_rl", -40, 1), side("seat_rr", -40, -1)], { envelope: box as never });
  const wheel = (id: string) => part(id, 10, [face("hub_face", 0, 12, [0, 0, -1])], {}, 30);
  const ids = { fl: "wheel-fl", fr: "wheel-fr", rl: "wheel-rl", rr: "wheel-rr" };
  const joint = (k: keyof typeof ids) => ({
    id: k, a: { node: "body", port: `seat_${k}` }, b: { node: wheels === "four" ? ids[k] : "wheel", port: "hub_face" },
    intent: "permanent", motion: "revolute", load: "light", wallA: 50, wallB: 10, ...(hubFit ? { hubFit } : {}),
  });
  return {
    ...plates({}),
    nodes: [body, ...(wheels === "four" ? Object.values(ids).map(wheel) : [wheel("wheel")])] as never,
    entryNodeId: "body",
    joints: (["fl", "fr", "rl", "rr"] as const).map(joint),
  } as ArchitectOutput;
}

describe("wheels each side of a body share one axle per pair", () => {
  const out = expandJoints(car("four", "press"));

  it("mints one axle, two bushings and a collar per pair, none for the far wheel", () => {
    expect(out.nodes.map((n) => n.id).filter((id) => id.includes("_"))).toEqual([
      "fl_bushing_a", "fl_bushing_b", "fl_collar", "fl_shaft", "rl_bushing_a", "rl_bushing_b", "rl_collar", "rl_shaft",
    ]);
    expect(out.joints!.map((j) => (j as { shared?: string }).shared)).toEqual([undefined, "fl", undefined, "rl"]);
    // far wheel 10 + collar 6 + body 50 + collar 6 + near wheel 10
    expect(param(out, "fl_shaft", "length")).toBe(82);
    expect(ports(out, "body")).toEqual(expect.arrayContaining(["fl_seat_a:BUSHING_BORE", "fl_seat_b:BUSHING_BORE"]));
    expect(ports(out, "wheel-fr")).toEqual(["hub_face:FLAT_FACE", "fr_hub:HUB_BORE"]);
    expect(lintAll(out)).toEqual([]);
    expect(expandJoints(out)).toEqual(out);
  });

  it("presses each wheel's hub onto the axle when the joint says so", () => {
    const hub = (out.nodes.find((n) => n.id === "wheel-fr")!.contract.payload as CadContractPayload).ports.find((p) => p.name === "fr_hub")!;
    expect(hub.params).toMatchObject({ fit: "press", depth: 10, flat: "param(wheel-fr.fr_flat)" });
    const { g } = solved(out);
    expect(hardwareAllowances(g).filter((x) => x.b === "fl_shaft" || x.a === "fl_shaft").map((x) => `${x.a}|${x.b}`)).toEqual(
      expect.arrayContaining(["wheel-fl|fl_shaft", "wheel-fr|fl_shaft", "fl_shaft|fl_bushing_a", "fl_shaft|fl_bushing_b"]),
    );
  });

  it("puts the bushings in the body's two faces and the wheels outside the collars", () => {
    const { instances, problems } = solved(out);
    expect(problems).toEqual([]);
    expect(instances["fl_bushing_a"]!.map(at3)).toEqual([[40, 25, 10]]);
    expect(instances["fl_bushing_b"]!.map(at3)).toEqual([[40, -25, 10]]);
    expect(instances["fl_collar"]!.map(at3)).toEqual([[40, 25, 10], [40, -25, 10]]);
    expect(instances["wheel-fl"]!.map(at3)).toEqual([[40, 31, 10]]);
    expect(instances["wheel-fr"]!.map(at3)).toEqual([[40, -31, 10]]);
    expect(instances["fl_shaft"]!.map(at3)).toEqual([[40, -41, 10]]);
  });

  it("turns both wheels of an axle with the near joint's sweep", () => {
    const axes = new CadBackend().solveScene(graphOf(out)).joints;
    expect(axes.map((j) => j.id)).toEqual(["fl", "rl"]);
    expect(axes[0]!.moving).toEqual(expect.arrayContaining(["wheel-fl", "wheel-fr", "fl_shaft", "fl_collar"]));
    expect(axes[0]!.moving).not.toContain("rl_shaft");
  });
});

describe("one wheel node placed four times by four joints", () => {
  const out = expandJoints(car("one"));

  it("seats every joint on one hub port, so each further mate is a copy", () => {
    expect(ports(out, "wheel")).toEqual(["hub_face:FLAT_FACE", "fl_hub:HUB_BORE"]);
    expect(out.edges.filter((e) => e.to === "wheel")).toEqual([
      { from: "fl_shaft", fromPort: "hub", to: "wheel", toPort: "fl_hub" },
      { from: "fl_shaft", fromPort: "hub_b", to: "wheel", toPort: "fl_hub" },
      { from: "rl_shaft", fromPort: "hub", to: "wheel", toPort: "fl_hub" },
      { from: "rl_shaft", fromPort: "hub_b", to: "wheel", toPort: "fl_hub" },
    ]);
    expect(lintAll(out)).toEqual([]);
    const { instances, problems } = solved(out);
    expect(problems).toEqual([]);
    expect(instances["wheel"]!.map(at3)).toEqual([[40, 31, 10], [40, -31, 10], [-40, 31, 10], [-40, -31, 10]]);
  });

  it("sweeps each copy about its own axle", () => {
    const axes = new CadBackend().solveScene(graphOf(out)).joints;
    const wheels = (k: number) => axes[k]!.moving.filter((m) => m.startsWith("wheel"));
    expect(wheels(0)).toEqual(["wheel", "wheel#1"]);
    expect(wheels(1)).toEqual(["wheel#2", "wheel#3"]);
    expect(axes[0]!.moving).not.toContain("rl_shaft");
  });
});

describe("two gears the plan meshes without a joint", () => {
  // The spur-gear-pair eval: 20T and 40T, m1, on two pins 30 apart.
  const gear = (id: string, teeth: number) => ({
    id, kind: "gear", title: id, spec: id,
    contract: {
      name: id, summary: id,
      params: [["module", 1], ["teeth", teeth], ["pressure_angle", 20], ["thickness", 6], ["bore", 5]].map(([name, v]) => ({ type: "number" as const, name, description: "", default: v })),
      provides: [], requires: [{ key: "bore", type: "BORE", description: "" }],
      payload: {
        units: "mm", process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
        ports: [{ name: "bore", type: "BORE", pose: { origin: [0, 0, -3], zAxis: [0, 0, -1], xAxis: [1, 0, 0] }, params: { diameter: 5 } }],
        envelope: { volumes: [{ kind: "cylinder", pose: { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, d: 44, h: 6 }], clearance: 0.4 },
        paramBindings: {},
      },
    },
  });
  const pin = (name: string, x: number) => ({ name, type: "SHAFT" as const, pose: { origin: [x, 0, 2], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, params: { diameter: 4.7, length: 8 } });
  const out = expandJoints({
    ...plates({}),
    nodes: [part("base", 4, [pin("pin_small", -20) as never, pin("pin_large", 10) as never], {}, 80), gear("gear-20t", 20), gear("gear-40t", 40)] as never,
    edges: [
      { from: "base", fromPort: "pin_small", to: "gear-20t", toPort: "bore" },
      { from: "base", fromPort: "pin_large", to: "gear-40t", toPort: "bore" },
    ],
    joints: [],
  } as ArchitectOutput);

  it("turns the second gear half a tooth so a gap faces the first's tooth", () => {
    expect(param(out, "gear-20t", "phase")).toBeUndefined();
    expect(param(out, "gear-40t", "phase")).toBe(4.5);
    expect(expandJoints(out)).toEqual(out);
  });

  it("is a mesh G5 sweeps, coupled at the ratio, and allowed the mesh band", () => {
    const g = graphOf(out);
    const { joints } = new CadBackend().solveScene(g);
    expect(joints).toEqual([{
      id: "mesh:gear-20t:gear-40t", type: "revolute", origin: [-20, 0, 5], direction: [0, 0, 1], limits: [-180, 180], moving: ["gear-20t"],
      coupled: [{ origin: [10, 0, 5], direction: [0, 0, 1], ratio: -0.5, moving: ["gear-40t"] }],
    }]);
    expect(hardwareAllowances(g)).toEqual([{ a: "gear-20t", b: "gear-40t", volume_mm3: expect.closeTo(0.18, 3) }]);
  });

  it("leaves gears that do not mesh alone", () => {
    const apart = structuredClone(out);
    ((apart.nodes[0]!.contract.payload as CadContractPayload).ports[1]!.pose.origin as number[])[0] = 14;
    apart.nodes[2]!.contract.params = apart.nodes[2]!.contract.params.filter((p) => p.name !== "phase");
    expect(param(expandJoints(apart), "gear-40t", "phase")).toBeUndefined();
  });
});
