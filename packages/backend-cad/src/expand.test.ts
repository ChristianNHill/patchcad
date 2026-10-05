import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { architectOutputToGraph, reexpandGraph, type ArchitectOutput } from "@patchcad/engine";
import { CadBackend, type CadContractPayload } from "./index.js";
import { familyDims } from "./catalog.js";
import { cadJointRuleLint, expandJoints, graphMates, jointAxes, jointErrors, jointInput, staleJoints } from "./expand.js";
import { reachableTravel, statedTravel } from "./plan-geometry.js";
import { solveAssembly } from "./assembly.js";
import { boundDependents, resolvePose } from "./bindings.js";
import { buildBom } from "./bom.js";
import { hardwareAllowances, threadAllowances } from "./g5.js";
import { meshSourceLint } from "./mesh-source.js";
import { assemblyPlanDefects } from "./feasibility.js";

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
    // the web between the two seats gets the shaft's slip bore (two-link-arm's 23mm³)
    expect(ports(out, "base")).toEqual(["rotor_face:FLAT_FACE", "j1_seat_a:BEARING_SEAT", "j1_seat_b:BEARING_SEAT", "j1_shaft_bore:BORE"]);
    expect(ports(out, "rotor")).toEqual(["base_face:FLAT_FACE", "j1_hub:HUB_BORE"]);
    expect(param(out, "base", "j1_seat_od")).toBe(16);
    expect(param(out, "rotor", "j1_flat")).toBe(2);
    // A slip hub says how far its shaft runs in too: asm-knob-dshaft's 10mm
    // bore took a shaft cut for its whole height (G3 now reads the floor).
    const hub = (out.nodes.find((n) => n.id === "rotor")!.contract.payload as CadContractPayload).ports.find((p) => p.name === "j1_hub")!;
    expect(hub.params).toMatchObject({ depth: "param(rotor.thickness)" });
    expect(hub.params).not.toHaveProperty("fit");
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
    ["N20 direct drive", { motion: "revolute", driven: true, speedClass: "low", torqueClass: "high", duty: "continuous" }, 4, 8],
    ["MG996R direct drive, two holes per tab", { motion: "revolute", driven: true, speedClass: "low", torqueClass: "medium" }, 4, 6],
    ["STS3215 direct drive, standing on a's face", { motion: "revolute", driven: true, speedClass: "low", torqueClass: "high" }, 4, 6],
    ["NEMA 14 direct drive as stated", { motion: "revolute", driven: true, prefer: { family: "nema14" } }, 6, 10],
    ["a dowel through a thin b", { intent: "alignment", prefer: { family: "dowel", key: "5" } }, 20, 6],
    ["threaded-rod stud as stated", { intent: "serviceable", prefer: { family: "threaded_rod", key: "M6" } }, 40, 40],
    ["wood: dowel screw as stated", { prefer: { family: "dowel_screw", key: "6" } }, 50, 60],
    ["wood: chipboard screw as stated", { prefer: { family: "chipboard", key: "4" } }, 18, 40],
    ["wood: machine screw into a wood insert as stated", { threadHint: "M6", prefer: { family: "wood_insert", key: "M6" } }, 18, 40],
    ["wood: glued furniture dowels", { intent: "alignment" }, 18, 40],
    ["wood: confirmat", { intent: "permanent" }, 16, 60],
    ["wood: cam lock and dowels", { lateral: 18 }, 18, 60],
  ];
  for (const [label, joint, wa, wb] of cases) {
    it(label, () => {
      const plan = plates(joint, wb, wa);
      // A rail's screws sit along its whole length, inside the part it is on.
      if (label.startsWith("rail")) Object.assign((plan.nodes[0]!.contract.payload as CadContractPayload).envelope.volumes[0]!, { d: 300 });
      // The STS3215's case screws reach ~30 from its axis, a NEMA 17's and an
      // MG996R's tab screws ~25: a plate that holds them (the pattern lint).
      if (/^(STS3215|NEMA 17 direct|MG996R)/.test(label)) Object.assign((plan.nodes[0]!.contract.payload as CadContractPayload).envelope.volumes[0]!, { d: 80 });
      if (label.startsWith("wood")) {
        for (const n of plan.nodes) {
          const p = n.contract.payload as CadContractPayload;
          p.process.kind = "CNC";
          p.sourcing = { class: "fabricate", process: "cnc", material: "18mm MDF" };
        }
      }
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

  it("a motor whose screw pattern overhangs its part fails the plan, not the cook", () => {
    // asm-belt-turntable: the base's NEMA 17 holes landed past its edge, and
    // five generation rounds could not cut them in air.
    const out = expandJoints(plates({ motion: "revolute", driven: true, precise: true }, 10, 6));
    expect(lintAll(out)).toEqual([expect.stringMatching(/^base: MOTOR_MOUNT "j1_motor_mount" puts 4 of its 4 Ø3\.4 holes outside base's envelope/)]);
  });
});

describe("planetary stage", () => {
  const g = GraphDoc.parse(JSON.parse(readFileSync(new URL("./fixtures/real-planetary-gearbox-graph.json", import.meta.url), "utf8")));
  const joints = new CadBackend().solveScene(g).joints;

  it("is swept in its carrier's frame: sun φ, planets −zs/zp·φ on their pins, the ring and all that holds it −zs/zr·φ", () => {
    // 9T sun, 9T planets, 27T ring: the planets' own joints and the sun's
    // mesh couplings are replaced by one sweep.
    expect(joints.map((j) => j.id)).toEqual(["j-motor"]);
    const [motor] = joints;
    expect(motor!.moving).toEqual(["sun-gear"]);
    const planets = motor!.coupled!.filter((c) => c.moving.some((k) => k.startsWith("planet-gear")));
    expect(planets.map((c) => c.moving[0]).sort()).toEqual(["planet-gear", "planet-gear#1", "planet-gear#2"]);
    // About each pin's own axis, which points down: +1 there is −1 about +z.
    for (const c of planets) expect(c.ratio * c.direction[2]).toBe(-1);
    const ring = motor!.coupled!.find((c) => c.frame)!;
    expect(ring.ratio).toBe(-0.3333);
    expect(ring.moving).toEqual(expect.arrayContaining(["housing", "j-motor_motor", "m3-rod#3", "m3-nut"]));
    expect(ring.moving).not.toContain("carrier");
    expect(motor!.turnsInWorld!.sort()).toEqual(["carrier", "j-planet-1_pin", "j-planet-2_pin", "j-planet-3_pin"]);
  });

  it("lets each tie rod share its thread with its nut", () => {
    expect(threadAllowances(g).map((x) => `${x.a}|${x.b}`)).toContain("m3-rod|m3-nut");
  });

  it("flags the hand-posed tie rods: a catalog rod runs 0..L from its end", () => {
    expect(assemblyPlanDefects(g).filter((d) => /off the rod/.test(d.message)).map((d) => d.node)).toEqual(["m3-rod"]);
  });
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
    const mesh = hardwareAllowances(g).filter((a) => [a.a, a.b].includes("j1_driven_gear"));
    expect(mesh).toEqual([{ a: "j1_motor_gear", b: "j1_driven_gear", volume_mm3: expect.any(Number) }]);
    expect(mesh[0]!.volume_mm3).toBeLessThan(1);
  });

  it("a lead screw: motor, coupler and screw on the axis, b on the nut, the guide rod beside", () => {
    const out = driven({ motion: "prismatic", driven: true, strokeMm: 100 }, 10, 30);
    expect(lintAll(out)).toEqual([]);
    expect(out.edges.some((e) => e.from === "base" && e.to === "lid")).toBe(false);
    const at = solved(out);
    // a 10mm base: the shaft tip 14 up, so the coupler sits 2 off the face
    expect(at("j1_coupler")).toEqual([[0, 0, 12]]);
    expect(at("j1_lead_screw")).toEqual([[0, 0, 24.5]]);
    expect(at("lid")).toEqual([[0, 0, 41.5]]); // 31.5 over the face: gap 2, coupler, the nut's flange, 1mm
    expect(at("j1_lead_nut")).toEqual([[0, 0, 41.5]]);
    expect(at("j1_rod")).toEqual([[20, 0, 1.2]]);
    expect(at("j1_linear_bearing")).toEqual([[20, 0, 41.5]]);
    expect(param(out, "j1_rod", "length")).toBe(170.3); // socket 8.8 + 31.5 + stroke 100 + b 30
    const { scene } = new CadBackend().solveScene(graphOf(out));
    expect(scene.joints).toEqual([expect.objectContaining({
      type: "prismatic", direction: [0, 0, 1], limits: [0, 100], moving: ["lid", "j1_lead_nut", "j1_linear_bearing"],
      coupled: [{ origin: [0, 0, 10], direction: [0, 0, 1], ratio: 45, moving: ["j1_coupler", "j1_lead_screw"] }],
    })]);
  });

  it("a lead screw whose b another slide places only puts its nut on the screw's line (asm-lead-screw-lift)", () => {
    // The architect's plan: PL (guided, so no rod of its own) and a P1 guide
    // rod, both on the platform. P1 placed it 1mm off the base; the nut wanted
    // it at PL's 30.5 rest height: "lift_lead_nut spans 29.50mm more …".
    const plan = JSON.parse(readFileSync(new URL("./fixtures/asm-lead-screw-lift-draft.json", import.meta.url), "utf8")) as ArchitectOutput;
    const g = graphOf(expandJoints(plan));
    const nodes = Object.values(g.nodes).map((n) => ({ id: n.id, ports: Object.fromEntries((n.contract.payload as CadContractPayload).ports.map((p) => [p.name, resolvePose(g, p.pose)])) }));
    expect(solveAssembly(nodes, graphMates(g), "base").problems).toEqual([]);
  });

  it("a lead screw lifting an 8mm platform: the LM8UU sits in a boss under it (asm-lead-screw-lift)", () => {
    const out = driven({ motion: "prismatic", driven: true, strokeMm: 120 }, 8, 8);
    expect(lintAll(out)).toEqual([]);
    const seat = (out.nodes[1]!.contract.payload as CadContractPayload).ports.find((p) => p.name === "j1_lm_seat")!;
    expect(seat.pose.origin).toEqual([expect.any(Number), 0, -17.2]); // the boss face, 17.2 below the platform toward a
  });

  it("a lead screw from a 3mm end plate: the guide rod's socket stands in a boss on the plate", () => {
    const out = driven({ motion: "prismatic", driven: true, strokeMm: 100 }, 3, 30);
    expect(lintAll(out)).toEqual([]);
    const rod = (out.nodes[0]!.contract.payload as CadContractPayload).ports.find((p) => p.name === "j1_rod")!;
    expect(rod.params).toMatchObject({ depth: "(param(base.thickness)) + 5" }); // 3 + 5 = 8
    const at = solved(out);
    expect(at("j1_rod")).toEqual([[20, 0, 1.2]]); // boss top 9.2, socket 8
    expect(param(out, "j1_rod", "length")).toBe(170.3); // the shaft tip 21 up lifts the coupler to 9
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
  return { g, ...solveAssembly(nodes, graphMates(g), out.entryNodeId) };
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

describe("the butt hinge whose brief pins a slip bore in both knuckles", () => {
  // "turn on a separate 3mm pin through 3.2mm knuckle bores": a's Ø3.2 BORE
  // is on the pin's axis, so a press hole there would be a second hole.
  const bore = { name: "pin_bore", type: "BORE", pose: { origin: [0, 0, 0], zAxis: [0, 0, -1], xAxis: [1, 0, 0] }, params: { diameter: 3.2 } };
  const out = expandJoints({
    ...plates({}),
    nodes: [
      part("leaf-a", 7.7, [face("knuckle", 7.7, 6), bore as never]),
      part("leaf-b", 7.7, [face("knuckle", 0, 6, [0, 0, -1])]),
    ] as never,
    entryNodeId: "leaf-a",
    joints: [{
      id: "hinge", a: { node: "leaf-a", port: "knuckle" }, b: { node: "leaf-b", port: "knuckle" },
      intent: "permanent", motion: "revolute", load: "light", wallA: 7.7, wallB: 7.7, shaftHint: 3,
    }],
  } as ArchitectOutput);

  it("turns the pin in a's declared bore instead of pressing it into a second hole", () => {
    const hole = (id: string, name: string) => (out.nodes.find((n) => n.id === id)!.contract.payload as CadContractPayload).ports.find((p) => p.name === name)!.params;
    expect(hole("leaf-a", "hinge_pin_a")).toMatchObject({ fit: "slip" });
    expect(hole("leaf-b", "hinge_pin_b")).toMatchObject({ fit: "slip" });
    expect(out.joints![0]!.expanded).toBe("M2d|pin=dowel:3|slipA");
    expect(lintAll(out)).toEqual([]);
  });
});

describe("revolute travel derived from the parts' envelopes", () => {
  // Two flat 40×30×3 leaves on one Ø7 knuckle line along x at y = 11.5, the
  // eval's hinge: a's middle knuckle, b's two either side, leaves opposite.
  const pose = (origin: number[], zAxis: number[], xAxis: number[]) => ({ origin, zAxis, xAxis });
  const leaf = (id: string, knuckles: [number, number, number?][], z: number[], x: number[]) =>
    part(id, 3, [{ name: "knuckle_face", type: "FLAT_FACE", pose: pose([4, 11.5, 0], z, x), params: { size: 6 } }] as never, {
      envelope: {
        volumes: [
          { kind: "box", pose: pose([0, -3.4, 0], [0, 0, 1], [1, 0, 0]), dims: [40, 23.2, 3] },
          ...knuckles.map(([at, h, d = 7]) => ({ kind: "cylinder", pose: pose([at, 11.5, 0], [1, 0, 0], [0, 1, 0]), d, h })),
        ],
        clearance: 0.4,
      } as never,
    });
  const hinge = (joint: Record<string, unknown> = {}, knuckleA: [number, number, number?] = [0, 8]) =>
    expandJoints({
      ...plates({}),
      nodes: [leaf("leaf-a", [knuckleA], [1, 0, 0], [0, -1, 0]), leaf("leaf-b", [[7.8, 7.6], [-7.8, 7.6]], [-1, 0, 0], [0, 1, 0])] as never,
      entryNodeId: "leaf-a",
      joints: [{
        id: "hinge", a: { node: "leaf-a", port: "knuckle_face" }, b: { node: "leaf-b", port: "knuckle_face" },
        intent: "removable", motion: "revolute", load: "light", wallA: 7.6, wallB: 7.6, shaftHint: 3, ...joint,
      }],
    } as ArchitectOutput);

  it("stops two flat leaves short of folding into each other, both ways", () => {
    const j = hinge().joints![0] as { limits?: [number, number]; limitsSource?: string };
    expect(j.limitsSource).toBe("derived");
    const [lo, hi] = j.limits!;
    for (const v of [-lo, hi]) {
      expect(v).toBeGreaterThanOrEqual(90);
      expect(v).toBeLessThanOrEqual(170);
    }
    expect(new CadBackend().solveScene(graphOf(hinge())).joints.find((x) => x.id === "hinge")?.limits).toEqual(j.limits);
  });

  it("re-derives its own limits but keeps stated ones, and lints stated ones past the stops", () => {
    const again = expandJoints(hinge());
    expect(again.joints![0]).toEqual(hinge().joints![0]);
    const stated = hinge({ limits: [-180, 180] });
    expect((stated.joints![0] as { limitsSource?: string }).limitsSource).toBeUndefined();
    expect(lintAll(stated).some((p) => /joint hinge states limits \[-180, 180\]°, but the parts' envelopes only reach/.test(p))).toBe(true);
    expect(lintAll(hinge()).filter((p) => p.includes("limits"))).toEqual([]);
  });

  it("holds a continuous joint to a full turn: a rotor keeps ±180°, a hinge cannot spin", () => {
    const rotor = JSON.parse(readFileSync(new URL("../../../examples/cad-rotor/patchcad.json", import.meta.url), "utf8")) as GraphDoc;
    expect(new CadBackend().solveScene(rotor).joints.filter((x) => x.type === "revolute").map((x) => x.limits)).toContainEqual([-180, 180]);
    // A knuckle that holds two bearings: 16 deep behind the face, Ø20 round them.
    const spinning = hinge({ duty: "continuous", wallA: 14, wallB: 8, shaftHint: 5 }, [-4, 16, 20]);
    expect(spinning.joints![0]!.expanded).toMatch(/^M1\|/);
    expect(lintAll(spinning).some((p) => p.startsWith("joint hinge is continuous"))).toBe(true);
    // The old Ø7 × 8 knuckle cannot: the rule says so instead of seating bearings outside it.
    expect(lintAll(hinge({ duty: "continuous", wallA: 14, wallB: 8, shaftHint: 5 })).some((p) => /M1 wallA 14\.0 runs past a: its envelope holds only 8\.0/.test(p))).toBe(true);
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

  it("lists each gear as a spur_gear of its module, one row per tooth count", () => {
    // asm-hand-winch: "15T pinion" became a BOM row of family "15T", and the 45T gear merged into it.
    const g = graphOf(out);
    for (const n of Object.values(g.nodes)) n.artifact = { code: "x" } as never;
    expect(buildBom(g).buy.map((r) => [r.description, r.qty])).toEqual([["spur_gear m1 z20", 1], ["spur_gear m1 z40", 1]]);
  });

  it("turns gears riding joints with their shafts, each joint coupled to the other's", () => {
    // asm-hand-winch: the drum joint swept its gear into a frozen pinion, and
    // the mesh joint turned each gear round a shaft that held still.
    const onShaft = (id: string, teeth: number) => {
      const g = gear(id, teeth);
      g.contract.payload.ports = [{ name: "hub_face", type: "FLAT_FACE", pose: { origin: [0, 0, -3], zAxis: [0, 0, -1], xAxis: [1, 0, 0] }, params: { size: 12 } }] as never;
      return g;
    };
    const seat = (name: string, x: number) => ({ ...face(name, 0, 12), pose: { origin: [x, 0, 0], zAxis: [0, 0, 1] as [number, number, number], xAxis: [1, 0, 0] } });
    const box = { volumes: [{ kind: "box", pose: { origin: [0, 0, -10], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims: [80, 40, 20] }], clearance: 0.4 };
    const joint = (id: string, port: string, b: string) => ({ id, a: { node: "base", port }, b: { node: b, port: "hub_face" }, intent: "permanent", motion: "revolute", duty: "continuous", load: "light", wallA: 20, wallB: 6, shaftHint: 5 });
    const g = graphOf(expandJoints({
      ...plates({}), entryNodeId: "base", edges: [],
      nodes: [part("base", 20, [seat("s20", -20), seat("s40", 10)], { envelope: box as never }), onShaft("gear-20t", 20), onShaft("gear-40t", 40)] as never,
      joints: [joint("j20", "s20", "gear-20t"), joint("j40", "s40", "gear-40t")],
    } as ArchitectOutput));
    const joints = new CadBackend().solveScene(g).joints;
    expect(joints.map((j) => j.id)).toEqual(["j20", "j40"]);
    const [j20, j40] = joints;
    expect(j20!.coupled).toEqual([expect.objectContaining({ ratio: -0.5, moving: expect.arrayContaining(["gear-40t", "j40_shaft"]) })]);
    expect(j40!.coupled).toEqual([expect.objectContaining({ ratio: -2, moving: expect.arrayContaining(["gear-20t", "j20_shaft"]) })]);
  });

  it("leaves gears that do not mesh alone", () => {
    const apart = structuredClone(out);
    ((apart.nodes[0]!.contract.payload as CadContractPayload).ports[1]!.pose.origin as number[])[0] = 14;
    apart.nodes[2]!.contract.params = apart.nodes[2]!.contract.params.filter((p) => p.name !== "phase");
    expect(param(expandJoints(apart), "gear-40t", "phase")).toBeUndefined();
  });
});

/** A lid on two hinges along one line (x), both joints facing +x: the
 *  magnet-hinged box and the pan-tilt cradle on two bearings. */
function twoHinges(lidR: [number, number, number]) {
  const at = (name: string, o: [number, number, number], z: [number, number, number]) => ({ name, type: "FLAT_FACE" as const, pose: { origin: o, zAxis: z, xAxis: [0, 1, 0] as [number, number, number] }, params: { size: 12 } });
  const env = (o: number[], dims: number[]) => ({ volumes: [{ kind: "box" as const, pose: { origin: o, zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims }], clearance: 0.4 });
  const box = part("box", 20, [at("hinge_l", [-30, 25, 20], [1, 0, 0]), at("hinge_r", [30, 25, 20], [1, 0, 0])], { envelope: env([0, 0, 10], [100, 50, 20]) as never });
  // The lid sits on the box's rim at travel 0, its knuckles on its back edge.
  const lid = part("lid", 6, [at("knuckle_l", [0, 0, 0], [-1, 0, 0]), at("knuckle_r", lidR, [-1, 0, 0])], { envelope: env([30, -24, 3], [70, 50, 6]) as never });
  const joint = (id: string, s: "l" | "r") => ({
    id, a: { node: "box", port: `hinge_${s}` }, b: { node: "lid", port: `knuckle_${s}` },
    intent: "permanent", motion: "revolute", load: "light", wallA: 10, wallB: 8, shaftHint: 3,
  });
  return { ...plates({}), nodes: [box, lid] as never, entryNodeId: "box", joints: [joint("hinge-left", "l"), joint("hinge-right", "r")] } as ArchitectOutput;
}

describe("a servo's face ring", () => {
  const sts = () => {
    const plan = plates({ motion: "revolute", driven: true, speedClass: "low", torqueClass: "high" }, 6, 4);
    Object.assign((plan.nodes[0]!.contract.payload as CadContractPayload).envelope.volumes[0]!, { d: 80 });
    return expandJoints(plan);
  };
  it("stays inside the STS3215's nearest case screw (real-robot-arm)", () => {
    // 2 × (nearest M2 clearance hole from the axis − 1.2 − 0.6), from the catalog row
    const r = familyDims("sts3215", "STS3215")!;
    const sx = Number(r.bodyL) / 2 - Number(r.bossD) / 2;
    const cx = Number(r.holeX ?? 0) - sx;
    const near = Math.min(...[-1, 1].flatMap((a) => [-1, 1].map((b) => Math.hypot(cx + (a * Number(r.holePitch)) / 2, (b * Number(r.holeRowPitch)) / 2))));
    const face = (sts().nodes[0]!.contract.payload as CadContractPayload).ports.find((p) => p.name === "lid_face")!;
    expect(face.params.ring_diameter).toBeCloseTo(Math.min(Number(r.splineD) + 4, 2 * (near - 1.2 - 0.6)), 3);
  });
  it("screws b to the horn and the case to a, and seats b on the horn's face (real-robot-arm)", () => {
    const out = sts();
    const screws = (role: string) => out.nodes.find((n) => n.id === `j1_${role}`)!;
    expect(param(out, "j1_case_screw", "sku")).toMatch(/M2/);
    expect(param(out, "j1_horn_screw", "sku")).toMatch(/M3/);
    expect(out.edges.filter((e) => e.to === "j1_case_screw")).toHaveLength(4);
    expect(out.edges.filter((e) => e.to === "j1_horn_screw")).toHaveLength(4);
    expect(screws("horn_screw").contract.payload).toBeDefined();
    expect(ports(out, "lid")).toEqual(expect.arrayContaining(["j1_horn_head_1:CLEARANCE_HOLE"]));
    expect((out.nodes[1]!.contract.payload as CadContractPayload).ports.find((p) => p.name === "j1_hub")!.type).toBe("FLAT_FACE");
    expect(lintAll(out)).toEqual([]);
  });
});

describe("one leg node in four joints (real-round-stool)", () => {
  // Each joint minted its own nut set on leg #0: 27 G5 clashes, copies 1-3 bare.
  const stool = () => {
    const at = (name: string, x: number, y: number, z: number, dz: 1 | -1) => ({ name, type: "FLAT_FACE" as const, pose: { origin: [x, y, z], zAxis: [0, 0, dz] as [number, number, number], xAxis: [1, 0, 0] as [number, number, number] }, params: { size: 30 } });
    const box = (o: number[], dims: number[]) => ({ volumes: [{ kind: "box", pose: { origin: o, zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims }], clearance: 0.4 });
    const spots = [[-60, -60], [60, -60], [-60, 60], [60, 60]];
    const seat = part("seat", 6, spots.map(([x, y], k) => at(`leg_${k}`, x!, y!, 0, -1)), { envelope: box([0, 0, 3], [200, 200, 6]) as never });
    const leg = part("leg", 10, [at("top", 0, 0, 0, 1)], { envelope: box([0, 0, -5], [40, 40, 10]) as never });
    return expandJoints({
      ...plates({}), nodes: [seat, leg] as never, entryNodeId: "seat",
      joints: spots.map((_, k) => ({ id: `leg${k}`, a: { node: "seat", port: `leg_${k}` }, b: { node: "leg", port: "top" }, intent: "permanent", load: "medium", access: "both_sides", count: 3, pitch: 16, wallA: 6, wallB: 10 })),
    } as ArchitectOutput);
  };
  it("seats one nut set in the leg and carries it to every copy; each joint keeps its own screws", () => {
    const out = stool();
    expect(out.joints!.map((j) => (j as { expanded?: string }).expanded?.split("|")[0])).toEqual(["R5", "R5", "R5", "R5"]);
    expect(out.nodes.filter((n) => n.kind === "nut").map((n) => n.id)).toEqual(["leg0_nut"]);
    expect(out.nodes.filter((n) => n.kind === "fastener")).toHaveLength(4);
    const g = graphOf(out);
    const nodes = Object.values(g.nodes).map((n) => ({ id: n.id, ports: Object.fromEntries((n.contract.payload as CadContractPayload).ports.map((p) => [p.name, resolvePose(g, p.pose)])) }));
    const { instances, problems } = solveAssembly(nodes, graphMates(g), "seat", (id) => /^leg\d_/.test(id));
    expect(problems).toEqual([]);
    expect(instances["leg"]).toHaveLength(4);
    expect(instances["leg0_nut"]).toHaveLength(12); // 3 per leg
    const legsWithNuts = new Set(instances["leg0_nut"]!.map((m) => `${Math.sign(m[12]!)},${Math.sign(m[13]!)}`));
    expect(legsWithNuts.size).toBe(4);
    // leg1's screws thread into the carried nut, an allowed overlap
    expect(threadAllowances(g).some((x) => x.a === "leg1_screw" && x.b === "leg0_nut")).toBe(true);
    expect(lintAll(out)).toEqual([]);
  });
});

describe("a screw pattern on a narrow face", () => {
  // real-round-stool: 3 screws at pitch 35 as a triangle put tap_1 on the edge
  // of a 110×40 leg arm ("needs 10.5mm of depth, measured 0.60").
  const arm = (lidBox: [number, number]) => {
    const plan = plates({ count: 3, pitch: 35, load: "medium" }, 30, 20);
    const box = (dims: [number, number], h: number, z: number) => ({ volumes: [{ kind: "box", pose: { origin: [0, 0, z], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims: [...dims, h] }], clearance: 0.4 });
    (plan.nodes[0]!.contract.payload as CadContractPayload).envelope = box([110, 40], 20, 10) as never;
    (plan.nodes[1]!.contract.payload as CadContractPayload).envelope = box(lidBox, 30, 15) as never;
    const out = expandJoints(plan);
    return (out.nodes[0]!.contract.payload as CadContractPayload).ports.filter((p) => p.name.startsWith("j1_head")).map((p) => (p.pose.origin as number[]).slice(0, 2));
  };
  it("lays them in a row along the face's long side", () => {
    expect(arm([110, 40])).toEqual([[-35, 0], [0, 0], [35, 0]]);
  });
  it("keeps the ring where the row does not fit either", () => {
    expect(arm([40, 40]).map(([x, y]) => Math.round(Math.hypot(x!, y!) * 100) / 100)).toEqual([20.21, 20.21, 20.21]);
  });
});

describe("a shaft whose length is an expression", () => {
  it("gets an envelope as long as the shaft, not a 2mm stub (two-link-arm)", () => {
    const out = expandJoints(plates({ motion: "revolute", wallA: 14, wallB: 8 }, 8, 14));
    const shaft = out.nodes.find((n) => n.id === "j1_shaft")!;
    const length = shaft.contract.params.find((p) => p.name === "length")!.default as number;
    const [vol] = (shaft.contract.payload as CadContractPayload).envelope.volumes as { h?: number }[];
    expect(length).toBeGreaterThan(10);
    expect(vol!.h).toBeGreaterThanOrEqual(length);
  });
});

describe("a stand that folds flat (real-folding-phone-stand)", () => {
  it("must close fully: the derived [-80, 0] that G5 found the parts collide at is a plan problem", () => {
    expect(statedTravel("a phone stand that folds flat to 12mm thick")).toBe(180);
    expect(statedTravel("a box whose lid opens 0 to 110 degrees")).toBe(110);
    const raw = JSON.parse(readFileSync(new URL("./fixtures/real-folding-phone-stand.json", import.meta.url), "utf8"));
    const g = GraphDoc.parse(raw.graph ?? raw);
    const problems = new CadBackend().planning.graphLints.flatMap((l) => l.run(g));
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/^joint hinge: the brief states 180° of travel, but its limits \[-80, 0\]° cover 80°/)]));
  });
});

describe("travel: a magnitude, the direction is expansion's", () => {
  const limitsOf = (travel?: number) => {
    const plan = twoHinges([63, 0, 0]);
    for (const j of plan.joints!) Object.assign(j, travel ? { travel } : {});
    return expandJoints(plan).joints!.map((j) => (j as { limits?: number[] }).limits);
  };
  it("turns the way the parts allow, from rest", () => {
    const [lo, hi] = limitsOf()[0] as [number, number];
    expect(limitsOf(10)[0]).toEqual(hi >= 10 ? [0, 10] : [-10, 0]);
    // more than the open side reaches, but the other side does: that side
    const far = Math.max(hi, -lo!);
    const near = Math.min(hi!, -lo!);
    if (far > near) expect(limitsOf(Math.floor(far))[0]).toEqual(hi >= -lo! ? [0, Math.floor(far)] : [-Math.floor(far), 0]);
  });
  it("keeps explicit limits, and the lint states the frame and offers travel", () => {
    const plan = twoHinges([63, 0, 0]);
    for (const j of plan.joints!) Object.assign(j, { limits: [-300, 300] });
    const problems = lintAll(expandJoints(plan));
    expect(problems.find((p) => p.includes("states limits [-300, 300]"))).toMatch(/degrees about a\.port's \+z .* right-handed, 0 being the pose the mates place.*travel: <degrees>/);
  });
});

describe("derived travel is clamped to the travel the brief states", () => {
  // asm-hinged-box: derived [-35, 145]°, the lid hit the box at 145°; the brief asks 0 to 110.
  const sweep = (limits: [number, number], goal: string, derived = true) => {
    const g = graphOf(expandJoints(twoHinges([63, 0, 0])));
    for (const j of g.joints) Object.assign(j, { limits, limitsSource: derived ? "derived" : undefined });
    g.brief = { ...g.brief, goal };
    return jointAxes(g)[0]!.limits;
  };
  it("sweeps the stated span from rest, toward the side that reaches it", () => {
    expect(sweep([-35, 145], "a lid that opens from 0 to 110 degrees")).toEqual([0, 110]);
    expect(sweep([-145, 35], "a lid that opens from 0 to 110 degrees")).toEqual([-110, 0]);
  });
  it("leaves stated limits, a brief with no travel, and a reach short of it alone", () => {
    expect(sweep([-35, 145], "a lid that opens from 0 to 110 degrees", false)).toEqual([-35, 145]);
    expect(sweep([-35, 145], "a lid on a hinge")).toEqual([-35, 145]);
    expect(sweep([-35, 90], "a lid that opens from 0 to 110 degrees")).toEqual([-35, 90]);
  });
});

describe("a second joint on an axis already solved constrains only the axis", () => {
  it("leaves each hinge's place along the line free", () => {
    // 63 between the lid's knuckles against 60 on the box: 3mm along the axis.
    const out = expandJoints(twoHinges([63, 0, 0]));
    expect(solved(out).problems).toEqual([]);
    expect(lintAll(out)).toEqual([]);
  });

  it("names the joints and the offset when the lines disagree", () => {
    const { problems } = solved(expandJoints(twoHinges([60, 2.1, 0])));
    expect(problems).toEqual([expect.stringMatching(/^hinge-right axis is 2\.10mm off hinge-left's axis/)]);
  });
});

describe("real-product leftovers", () => {
  it("a part's min_wall assertion is the wall its joints leave (asm-hinged-box)", () => {
    const out = plates({ motion: "revolute", wallA: 24, wallB: 16, shaftHint: 3 }, 16, 24);
    const box = out.nodes[0]!.contract.payload as CadContractPayload;
    box.assertions = [{ kind: "min_wall", mm: 2.4 }];
    (out.nodes[1]!.contract.payload as CadContractPayload).process.minWall = 1.6;
    const inp = jointInput(graphOf(out), out.joints![0] as never);
    expect(inp).toMatchObject({ minWallA: 2.4, minWall: 1.6 });
  });

  it("a lead screw whose moving body rides wheels of its own mints no guide rod (real-linear-actuator)", () => {
    const slide = (wheels: boolean) => {
      const out = plates({ motion: "prismatic", driven: true, strokeMm: 100 }, 30, 10);
      out.nodes.push(part("wheel", 10, [face("hub", 0)]) as never);
      (out.nodes[1]!.contract.payload as CadContractPayload).ports.push(face("axle", 30) as never);
      if (wheels) out.joints!.push({ id: "w1", a: { node: "lid", port: "axle" }, b: { node: "wheel", port: "hub" }, intent: "serviceable", motion: "revolute", duty: "continuous", load: "light", access: "both_sides", wallA: 10, wallB: 10 } as never);
      return out;
    };
    expect(jointInput(graphOf(slide(true)), slide(true).joints![0] as never)).toMatchObject({ guided: true });
    // Wheels on a spacer fixed under the moving body still guide it.
    const spaced = slide(false);
    spaced.nodes.push(part("spacer", 10, [face("top", 10), face("axle", 0)]) as never);
    spaced.joints!.push({ id: "f1", a: { node: "lid", port: "axle" }, b: { node: "spacer", port: "top" }, intent: "permanent", load: "light", access: "both_sides", wallA: 10, wallB: 10 } as never);
    spaced.joints!.push({ id: "w1", a: { node: "spacer", port: "axle" }, b: { node: "wheel", port: "hub" }, intent: "serviceable", motion: "revolute", duty: "continuous", load: "light", access: "both_sides", wallA: 10, wallB: 10 } as never);
    expect(jointInput(graphOf(spaced), spaced.joints![0] as never)).toMatchObject({ guided: true });
    expect(jointInput(graphOf(slide(false)), slide(false).joints![0] as never)).toMatchObject({ guided: false });
    const ids = (out: ArchitectOutput) => out.nodes.map((n) => n.id);
    expect(ids(expandJoints(slide(true)))).not.toContain("j1_rod");
    expect(ids(expandJoints(slide(true)))).toContain("j1_lead_nut");
    expect(ids(expandJoints(slide(false)))).toEqual(expect.arrayContaining(["j1_rod", "j1_linear_bearing"]));
  });

  /** A tilt cradle between a yoke's two arms on x, one stated F623 a side. */
  const yoke = (prefer: Record<string, string> = { family: "bearing_flanged", key: "F623" }, duty = "occasional", half = 38.5, wallB: number = 8) => {
    const at = (name: string, x: number, dir: 1 | -1) => ({ name, type: "FLAT_FACE" as const, pose: { origin: [x, 0, 0], zAxis: [dir, 0, 0] as [number, number, number], xAxis: [0, 1, 0] as [number, number, number] }, params: { size: 12 } });
    const box = (o: number[], dims: number[]) => ({ kind: "box" as const, pose: { origin: o, zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims });
    const frame = part("yoke", 10, [at("arm_l", -40, 1), at("arm_r", 40, -1)], { envelope: { volumes: [box([-45, 0, 0], [10, 30, 30]), box([45, 0, 0], [10, 30, 30]), box([0, 0, -19], [100, 30, 10])], clearance: 0.4 } as never });
    const cradle = part("cradle", 8, [at("end_l", -half, -1), at("end_r", half, 1)], { envelope: { volumes: [box([0, 0, 0], [2 * half, 16, 16])], clearance: 0.4 } as never });
    const joint = (s: "l" | "r") => ({
      id: `tilt-${s}`, a: { node: "yoke", port: `arm_${s}` }, b: { node: "cradle", port: `end_${s}` },
      intent: "serviceable", motion: "revolute", duty, load: "light", wallA: 10, wallB, prefer,
    });
    return expandJoints({ ...plates({}), nodes: [frame, cradle] as never, entryNodeId: "yoke", joints: [joint("l"), joint("r")] } as ArchitectOutput);
  };

  it("puts one 608 in each support, a collar each side of each wall, the shaft through the web (asm-hand-winch)", () => {
    // an 8mm collar inside each arm: the drum is 64 long between the collars
    const out = yoke({ family: "bearing", key: "608" }, "continuous", 32);
    expect(out.joints!.map((j) => (j as { expanded?: string }).expanded)).toEqual([
      "M1p|bearing_a=bearing:608|shaft=d_shaft:8|collar=collar:8",
      "M1p|bearing_a=bearing:608|shaft=d_shaft:8|collar=collar:8",
    ]);
    expect(ports(out, "yoke")).toEqual(expect.arrayContaining(["tilt_l_seat_a:BEARING_SEAT", "tilt_l_keep:FLAT_FACE", "tilt_l_shaft_bore:BORE"]));
    const { instances, problems } = solved(out);
    expect(problems).toEqual([]);
    // the outer collar on the arm's outer face, x = -50
    expect(instances["tilt-l_collar"]!.map(at3)).toEqual(expect.arrayContaining([[-50, 0, 0]]));
    expect(instances["cradle"]!.map(at3)).toEqual([[0, 0, 0]]);
    expect(lintAll(out)).toEqual([]);
  });

  it("asm-hand-winch: each face's shaft stops at b's middle, and a b too long for the gap is a plan problem", () => {
    // wallB the drum's whole length from each end: the two stubs met at its centre (1678mm³)
    const out = yoke({ family: "bearing", key: "608" }, "continuous", 32, 64);
    const len = (id: string) => out.nodes.find((n) => n.id === id)!.contract.params.find((p) => p.name === "length")!.default as number;
    expect(len("tilt-l_shaft")).toBeLessThanOrEqual(16 + 10 + 31.5 + 0.01);
    // the 18:43 cook: the drum spans the plates' whole gap, two 8mm collars inside it
    const g = GraphDoc.parse(JSON.parse(readFileSync(new URL("./fixtures/asm-hand-winch-graph-3.json", import.meta.url), "utf8")));
    const problems = new CadBackend().planning.graphLints.flatMap((l) => l.run(g)).filter((p) => p.includes("between its faces"));
    expect(problems).toEqual([expect.stringMatching(/^drum is [\d.]+ between its faces, but .* each put 8\/8 of collar/)]);
    // the yokes that fit stay quiet
    expect(lintAll(yoke({ family: "bearing", key: "608" }, "continuous", 32)).filter((p) => p.includes("between its faces"))).toEqual([]);
  });

  it("a b held on two faces turns the other face's shaft with it, never its bearings", () => {
    const g = graphOf(yoke({ family: "bearing", key: "608" }, "continuous", 32));
    const left = jointAxes(g).find((a) => a.id === "tilt-l")!;
    expect(left.moving).toEqual(expect.arrayContaining(["cradle", "tilt-l_shaft", "tilt-r_shaft"]));
    expect(left.moving).not.toContain("tilt-r_bearing_a");
  });

  it("asm-hand-winch: a drum boss through the gear's bore is a plan problem, not a repair round", () => {
    const lint = (file: string) => {
      const g = GraphDoc.parse(JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")));
      return new CadBackend().planning.graphLints.flatMap((l) => l.run(g)).filter((p) => p.includes("bore for"));
    };
    // 10-19 cook: G5 805mm³ rope-drum/drum-gear at rest
    expect(lint("./fixtures/asm-hand-winch-graph-2.json")).toEqual([expect.stringMatching(/^rope-drum runs Ø14\.0 through drum-gear's Ø8 bore for .*mm along its axis/)]);
    // 09-50 cook: the gear on the shaft past the drum's end, nothing through it
    expect(lint("./fixtures/asm-hand-winch-graph.json")).toEqual([]);
  });

  it("asm-hand-winch: both drum joints turn the pinion, and cranking turns the drum's both shafts", () => {
    // The 2026-10-04 cook: j-pinion swept the drum into j-drum-l's (frozen) shaft.
    const g = GraphDoc.parse(JSON.parse(readFileSync(new URL("./fixtures/asm-hand-winch-graph.json", import.meta.url), "utf8")));
    const joints = new CadBackend().solveScene(g).scene.joints;
    const coupledTo = (id: string) => joints.find((j) => j.id === id)!.coupled?.flatMap((c) => c.moving) ?? [];
    expect(coupledTo("j-drum-l")).toContain("pinion-gear");
    expect(coupledTo("j-drum-r")).toContain("pinion-gear");
    expect(coupledTo("j-pinion")).toEqual(expect.arrayContaining(["rope-drum", "big-gear", "j-drum-l_shaft", "j-drum-r_shaft"]));
    // j-drum-r turns about -y, the big gear's own z is +y: the pinion's ratio
    // flips with it. At -3 the kernel sweep met teeth every 20° (the "-122°" and
    // "118°" clashes); at +3 it clears a full turn.
    const drumR = joints.find((j) => j.id === "j-drum-r")!;
    expect(drumR.direction).toEqual([0, -1, 0]);
    expect(drumR.coupled!.find((c) => c.moving.includes("pinion-gear"))!.ratio).toBe(3);
  });

  it("seats one flanged bearing in each arm and hangs the cradle between them (real-pan-tilt-head)", () => {
    const out = yoke();
    expect(out.joints!.map((j) => (j as { expanded?: string }).expanded)).toEqual([
      "M1f|bearing=bearing_flanged:F623|shaft=d_shaft:3|spacer=washer:M3",
      "M1f|bearing=bearing_flanged:F623|shaft=d_shaft:3|spacer=washer:M3",
    ]);
    expect(ports(out, "yoke")).toEqual(expect.arrayContaining(["tilt_l_seat_a:BEARING_SEAT", "tilt_r_seat_a:BEARING_SEAT"]));
    const { instances, problems } = solved(out);
    expect(problems).toEqual([]);
    // Flange on the arm's face (x = ±40), the washer on it, the cradle on the washer.
    expect(instances["tilt-l_bearing"]!.map(at3)).toEqual([[-40, 0, 0]]);
    expect(instances["tilt-l_spacer"]!.map(at3)).toEqual([[-39, 0, 0]]);
    expect(instances["cradle"]!.map(at3)).toEqual([[0, 0, 0]]);
    expect(lintAll(out)).toEqual([]);
  });
});

describe("a wheel rolling on a part that holds still", () => {
  // Continuous wheels whose rims sit 0.5 into a floor plate under the body:
  // the linear actuator's V-wheels on their rail, the spool holder's rollers.
  const rolling = () => {
    const out = car("four");
    for (const j of out.joints!) (j as { duty?: string }).duty = "continuous";
    const body = out.nodes[0]!.contract.payload as CadContractPayload;
    body.ports.push({ name: "floor", type: "FLAT_FACE", pose: { origin: [0, 0, 0], zAxis: [0, 0, -1], xAxis: [1, 0, 0] }, params: { size: 20 } } as never);
    const floor = part("floor", 4, [face("top", 0)], { envelope: { volumes: [{ kind: "box", pose: { origin: [0, 0, -2 + 4.5], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims: [200, 100, 4] }], clearance: 0.4 } as never });
    // floor top 4.5 below the body's bottom; the Ø30 wheels on the z=10 axles reach 5 below it
    (floor.contract.payload as { envelope: { volumes: { pose: { origin: number[] } }[] } }).envelope.volumes[0]!.pose.origin = [0, 0, -2 - 4.5];
    out.nodes.push(floor as never);
    out.edges.push({ from: "body", fromPort: "floor", to: "floor", toPort: "top" });
    return expandJoints(out);
  };

  it("turns a full circle: a round part spinning about its own axis sweeps only itself", () => {
    const g = graphOf(rolling());
    for (const def of jointAxes(g)) expect(reachableTravel(g, def)).toEqual([-180, 180]);
    expect(lintAll(rolling()).filter((p) => p.includes("continuous"))).toEqual([]);
  });
});

describe("a slide whose two rods are held by an end block at each end", () => {
  // asm-linear-slide: one end-block node "placed at both ends" was placed once.
  const at = (name: string, y: number, z: number, dir: 1 | -1) => ({ name, type: "FLAT_FACE" as const, pose: { origin: [0, y, z], zAxis: [0, 0, dir] as [number, number, number], xAxis: [1, 0, 0] }, params: { size: 12 } });
  const block = (id: string, h: number, z: number, dir: 1 | -1) => part(id, h, [at(`${id}_l`, 15, z, dir), at(`${id}_r`, -15, z, dir)], {}, 50);
  const slide = () => {
    const joint = (s: "l" | "r") => ({
      id: `rod-${s}`, a: { node: "near", port: `near_${s}` }, b: { node: "carriage", port: `carriage_${s}` }, far: { node: "far", port: `far_${s}` },
      intent: "serviceable", motion: "prismatic", load: "light", wallA: 15, wallB: 40, strokeMm: 100,
    });
    return expandJoints({ ...plates({}), nodes: [block("near", 15, 15, 1), block("carriage", 40, 0, -1), block("far", 15, 0, -1)] as never, entryNodeId: "near", joints: [joint("l"), joint("r")] } as ArchitectOutput);
  };

  it("puts the far block on the rods' far ends, with a socket for each", () => {
    const out = slide();
    expect(ports(out, "far")).toEqual(expect.arrayContaining(["rod_l_rod_far:BORE", "rod_r_rod_far:BORE"]));
    const { instances, problems } = solved(out);
    expect(problems).toEqual([]);
    // near face 15, + 1 + stroke 100 + carriage 40
    expect(instances["far"]!.map(at3)).toEqual([[0, 0, 156]]);
    expect(lintAll(out).filter((p) => p.includes("rod-") || p.includes("far"))).toEqual([]);
  });

  it("turns the far block about the first rod until the second rod meets its socket", () => {
    // asm-linear-slide: the far block's ports clocked 180° from the rods' frames
    // put its second socket 60mm off the second rod.
    const out = slide();
    const far = out.nodes.find((n) => n.id === "far")!.contract.payload as CadContractPayload;
    for (const p of far.ports) p.pose = { ...p.pose, origin: [0, -(p.pose.origin as number[])[1]!, 0], xAxis: [-1, 0, 0] };
    expect(solved(expandJoints(out)).problems).toEqual([]);
  });

  it("refuses a far end that is a again", () => {
    const out = slide();
    for (const j of out.joints!) (j as { far?: { node: string } }).far!.node = "near";
    expect(lintAll(out).some((p) => /far must name the far end block as its own node/.test(p))).toBe(true);
  });
});

describe("a drum on its shaft between two plates", () => {
  // asm-hand-winch: a drum "filling the gap" between the plates, 8mm out past
  // its collar, ran 7mm into the far plate; G5 found it after the cook.
  const winch = (length: number) => {
    const plate = (x: number) => ({ kind: "box" as const, pose: { origin: [x, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims: [16, 60, 80] });
    const frame = part("frame", 16, [{ name: "drum_l", type: "FLAT_FACE", pose: { origin: [-44, 0, 0], zAxis: [1, 0, 0], xAxis: [0, 1, 0] }, params: { size: 30 } }] as never, {
      envelope: { volumes: [plate(-52), plate(52)], clearance: 0.4 } as never,
    });
    const drum = part("drum", length, [face("end_l", -length / 2, 30, [0, 0, -1])], {
      envelope: { volumes: [{ kind: "cylinder", pose: { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, d: 40, h: length }], clearance: 0.4 } as never,
    });
    return expandJoints({
      ...plates({}), nodes: [frame, drum] as never, entryNodeId: "frame",
      joints: [{ id: "j-drum", a: { node: "frame", port: "drum_l" }, b: { node: "drum", port: "end_l" }, intent: "serviceable", motion: "revolute", duty: "continuous", load: "medium", wallA: 16, wallB: length, shaftHint: 8 }],
    } as ArchitectOutput);
  };

  it("says how far a drum runs into the far plate past its collar", () => {
    expect(winch(87).joints![0]!.expanded).toMatch(/^M1\|/);
    expect(lintAll(winch(87)).filter((p) => p.includes("both claim"))).toEqual([expect.stringMatching(/^drum and frame both claim 7\.\dmm of joint j-drum's axis/)]);
    expect(lintAll(winch(70)).filter((p) => p.includes("both claim"))).toEqual([]);
  });
});

describe("a wheel on its own bearings, on an axle fixed in a thin plate", () => {
  // real-linear-actuator: 24mm V-wheels on two 625s each, a 3mm gantry plate.
  const gantry = (wheels: 1 | 4, rail = false) => {
    const at = (name: string, x: number, y: number) => ({ name, type: "FLAT_FACE" as const, pose: { origin: [x, y, 0], zAxis: [0, 0, -1] as [number, number, number], xAxis: [1, 0, 0] }, params: { size: 12 } });
    const spots = [[-40, -30], [40, -30], [-40, 30], [40, 30]].slice(0, wheels);
    const plate = part("plate", 3, spots.map(([x, y], k) => at(`wheel_${k}`, x!, y!)), {
      envelope: { volumes: [
        { kind: "box", pose: { origin: [0, 0, 1.5], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims: [127, 88, 3] },
        // a rail between the wheel rows, 1mm off each rim
        ...(rail ? [{ kind: "box", pose: { origin: [0, 0, -6], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims: [127, 34, 12.5] }] : []),
      ], clearance: 0.4 } as never,
    });
    const wheel = part("v-wheel", 12, [face("hub_face", 0, 12, [0, 0, 1])], {
      envelope: { volumes: [{ kind: "cylinder", pose: { origin: [0, 0, -6], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, d: 24, h: 12 }], clearance: 0.4 } as never,
    });
    return expandJoints({
      ...plates({}), nodes: [plate, wheel] as never, entryNodeId: "plate",
      joints: spots.map((_, k) => ({ id: `wheel-${k}`, a: { node: "plate", port: `wheel_${k}` }, b: { node: "v-wheel", port: "hub_face" }, intent: "serviceable", motion: "revolute", duty: "continuous", load: "medium", wallA: 3, wallB: 12, shaftHint: 5, prefer: { family: "bearing", key: "625" } })),
    } as ArchitectOutput);
  };

  it("seats the bearings in the wheel and turns them with it", () => {
    const out = gantry(1);
    expect(out.joints![0]!.expanded).toMatch(/^M1h\|.*hub_bearing_a=bearing:625/);
    expect(ports(out, "v-wheel")).toEqual(expect.arrayContaining(["wheel_0_seat_a:BEARING_SEAT", "wheel_0_seat_b:BEARING_SEAT"]));
    expect(ports(out, "plate")).toContain("wheel_0_axle:HUB_BORE");
    // The axle places the wheel through its face port: an edge needs it required (real-linear-actuator's plan declared it provided).
    expect(out.nodes.find((n) => n.id === "v-wheel")!.contract.requires.map((p) => p.key)).toContain("hub_face");
    const { problems, instances } = solved(out);
    expect(problems).toEqual([]);
    // the wheel's face 1mm past the plate's underside
    expect(instances["v-wheel"]!.map(at3)).toEqual([[-40, -30, -1]]);
    const [axis] = new CadBackend().solveScene(graphOf(out)).joints;
    expect(axis!.moving).toEqual(expect.arrayContaining(["v-wheel", "wheel-0_hub_bearing_a", "wheel-0_hub_bearing_b"]));
    expect(axis!.moving.some((m) => m.includes("axle"))).toBe(false);
    expect(lintAll(out)).toEqual([]);
  });

  it("a wheel too thin for two takes one bearing at its far face, the axle through a bore (real-spool-holder)", () => {
    const plate = part("plate", 7, [face("gear_0", 0, 30, [0, 0, -1])]);
    const gear = part("gear", 9, [face("hub_face", 0, 30, [0, 0, 1])], {
      envelope: { volumes: [{ kind: "cylinder", pose: { origin: [0, 0, -4.5], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, d: 30, h: 9 }], clearance: 0.4 } as never,
    });
    const out = expandJoints({
      ...plates({}), nodes: [plate, gear] as never, entryNodeId: "plate",
      joints: [{ id: "gear-0", a: { node: "plate", port: "gear_0" }, b: { node: "gear", port: "hub_face" }, intent: "serviceable", motion: "revolute", duty: "continuous", load: "light", wallA: 7, wallB: 9, prefer: { family: "bearing", key: "608" } }],
    } as ArchitectOutput);
    expect(out.joints![0]!.expanded).toBe("M1h|hub_bearing_b=bearing:608|axle_shaft=d_shaft:8|axle_collar=collar:8");
    expect(ports(out, "gear")).toEqual(expect.arrayContaining(["gear_0_seat_b:BEARING_SEAT", "gear_0_axle_bore:BORE"]));
    expect(ports(out, "gear")).not.toContain("gear_0_seat_a:BEARING_SEAT");
    expect(solved(out).problems).toEqual([]);
    expect(lintAll(out)).toEqual([]);
  });

  it("a repair that echoes the minted hardware back, slugged, re-expands clean (real-linear-actuator)", () => {
    const first = gantry(4);
    const slug = (id: string) => id.replace(/_/g, "-");
    // What the slugger makes of a model echoing its expanded plan: minted ids
    // with "-" for "_", edges kept, the wheel's minted seat ports gone, and
    // joints as the model wrote them, unexpanded.
    const echo = structuredClone(first);
    const minted = new Set(echo.nodes.filter((n) => n.id.includes("_")).map((n) => n.id));
    for (const n of echo.nodes) if (minted.has(n.id)) n.id = slug(n.id);
    echo.edges = echo.edges.map((e) => ({ ...e, from: minted.has(e.from) ? slug(e.from) : e.from, to: minted.has(e.to) ? slug(e.to) : e.to }));
    const wheel = echo.nodes.find((n) => n.id === "v-wheel")!;
    (wheel.contract.payload as CadContractPayload).ports = (wheel.contract.payload as CadContractPayload).ports.filter((p) => p.name === "hub_face");
    wheel.contract.provides = wheel.contract.provides.filter((p) => p.key === "hub_face");
    echo.joints = (echo.joints as { expanded?: string; minted?: string[] }[]).map(({ expanded: _e, minted: _m, ...j }) => j) as never;
    const again = expandJoints(echo);
    expect(again.nodes.filter((n) => n.id.includes("-hub-bearing"))).toEqual([]);
    expect(lintAll(again)).toEqual([]);
  });

  it("seats one bearing set in the wheel and carries it to every copy (real-round-stool, real-linear-actuator)", () => {
    // Was: each joint's bearings, all four sets on wheel #0.
    const out = gantry(4);
    expect(out.nodes.filter((n) => n.kind === "bearing").map((n) => n.id)).toEqual(["wheel-0_hub_bearing_a", "wheel-0_hub_bearing_b"]);
    const g = graphOf(out);
    const nodes = Object.values(g.nodes).map((n) => ({ id: n.id, ports: Object.fromEntries((n.contract.payload as CadContractPayload).ports.map((p) => [p.name, resolvePose(g, p.pose)])) }));
    const { instances, problems } = solveAssembly(nodes, graphMates(g), "plate", (id) => id.startsWith("wheel-"));
    expect(problems).toEqual([]);
    expect(instances["wheel-0_hub_bearing_a"]!.map(at3).map(([x, y]) => [x, y])).toEqual(expect.arrayContaining([[-40, -30], [40, -30], [-40, 30], [40, 30]]));
    // every axle still its own, from the plate
    expect(out.nodes.filter((n) => n.id.endsWith("_axle_shaft"))).toHaveLength(4);
    expect(lintAll(out)).toEqual([]);
  });

  it("puts one wheel node at four plate positions", () => {
    const { problems, instances } = solved(gantry(4));
    expect(problems).toEqual([]);
    expect(instances["v-wheel"]).toHaveLength(4);
  });

  it("turns each copy of the wheel a full circle about its own axle, not about the first one's", () => {
    // real-linear-actuator: the other three copies swept about wheel-0's axle into the plate.
    const g = graphOf(gantry(4, true));
    for (const def of jointAxes(g)) expect(reachableTravel(g, def)).toEqual([-180, 180]);
    expect(lintAll(gantry(4, true)).filter((p) => p.includes("continuous"))).toEqual([]);
  });
});
