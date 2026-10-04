import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import type { ArchitectOutput } from "@patchcad/engine";
import { honours, selectJoint, type JointDecision, type JointInput } from "./joints.js";
import { cadJointRuleLint, expandJoints, jointAxes, jointDecisions } from "./expand.js";
import { kinematicJoints } from "./assembly.js";
import { cadPlanGeometryLint, solvePlan, statedTravel } from "./plan-geometry.js";
import { resolveDim } from "./bindings.js";
import type { CadContractPayload } from "./index.js";

/** The assembly benchmark's failing plans (evals/cases/assembly, run
 *  2026-10-03), one test per joint-side failure they showed. */
const evals = JSON.parse(readFileSync(new URL("./fixtures/assembly-evals.json", import.meta.url), "utf8")) as Record<string, unknown>;
const graph = (id: string) => GraphDoc.parse(structuredClone(evals[id]));
const ok = (i: JointInput) => {
  const d = selectJoint(i);
  if ("error" in d) throw new Error(d.error);
  return d as JointDecision;
};
const parts = (d: JointDecision) => d.parts.map((p) => `${p.family}:${p.key}`);

describe("stated hardware is binding", () => {
  // asm-pipe-clamp: "two M5 through-bolts with hex nuts and washers" got heat-set inserts.
  const clamp: JointInput = { intent: "removable", load: "medium", access: "both_sides", wallA: 15, wallB: 15, processA: "FDM", processB: "FDM", threadHint: "M5" };
  it("a stated through-bolt is a through-bolt, nut and washers, not an insert", () => {
    expect(ok(clamp).rule).toBe("R4");
    const d = ok({ ...clamp, prefer: { recipe: "R3" } });
    expect(d.rule).toBe("R3");
    expect(parts(d)).toEqual(expect.arrayContaining(["hex_nut:M5", "washer:M5"]));
    expect(parts(ok({ ...clamp, threadHint: undefined, prefer: { family: "hex_nut", key: "M5" } }))).toContain("hex_nut:M5");
  });

  it("Ø4 dowels stay Ø4 (shaftHint or prefer), on asm-dowel-alignment's own plan", () => {
    const g = graph("asm-dowel-alignment");
    expect(parts(jointDecisions(g)[0]!.decision as JointDecision)).toEqual(["dowel:4"]);
    delete (g.joints[0] as { shaftHint?: number }).shaftHint;
    (g.joints[0] as { prefer?: unknown }).prefer = { family: "dowel", key: "4" };
    expect(parts(jointDecisions(g)[0]!.decision as JointDecision)).toEqual(["dowel:4"]);
  });

  // asm-belt-turntable: "through a GT2 belt" at low speed got a spur pair.
  const table: JointInput = {
    intent: "serviceable", motion: "revolute", duty: "continuous", driven: true, speedClass: "low", load: "light", access: "both_sides",
    wallA: 30, wallB: 12, wallMotor: 12, ratio: 2, processA: "FDM", processB: "FDM",
  };
  it("a stated GT2 belt is a belt; a centre no stocked loop reaches is an error naming it, never a gear pair", () => {
    expect(ok(table).rule).toBe("DG");
    expect(parts(ok({ ...table, prefer: { family: "gt2_pulley" } }))).toEqual(expect.arrayContaining(["gt2_pulley:20T-5", "gt2_pulley:40T-5"]));
    const d = selectJoint({ ...table, centerMm: 50, prefer: { family: "gt2_pulley" } });
    expect("error" in d && d.error).toMatch(/stated gt2_pulley: DB .*ask for centerMm/);
  });

  // asm-hand-winch: "608 bearings" in 12mm plates got 688s.
  const winch: JointInput = { intent: "serviceable", motion: "revolute", duty: "continuous", load: "medium", access: "both_sides", wallA: 12, wallB: 20, shaftHint: 8, processA: "FDM", processB: "FDM" };
  it("stated 608 bearings are 608s, or a shortfall that names them", () => {
    expect(parts(ok(winch))).toContain("bearing:688");
    const d = selectJoint({ ...winch, prefer: { family: "bearing", key: "608" } });
    expect("error" in d && d.error).toMatch(/stated bearing 608: M1 wallA 12\.0 < 2 × bearing width 7\.0/);
    expect(parts(ok({ ...winch, wallA: 16, prefer: { family: "bearing", key: "608" } }))).toContain("bearing:608");
    expect(selectJoint({ ...winch, prefer: { family: "bearing", key: "609x" } })).toMatchObject({ error: expect.stringMatching(/no bearing "609x"/) });
  });

  it("honours: the lint's check that a decision is the stated hardware", () => {
    const d = ok(clamp);
    expect(honours(d, { recipe: "R3" })).toBe(false);
    expect(honours(d, { family: "heatset_std", key: "M5" })).toBe(true);
    expect(honours(d, { family: "heatset_std", key: "M4" })).toBe(false);
  });
});

describe("stated travel", () => {
  it("reads one travel off the brief", () => {
    expect(statedTravel("so the lid opens from 0 to 110 degrees")).toBe(110);
    expect(statedTravel("each joint swinging at least 120 degrees")).toBe(120);
    expect(statedTravel("a 120x80x6mm base, 2:1, 15-tooth")).toBeUndefined();
  });

  // asm-hinged-box: limits [70, 180] swept the lid's web into the box's back
  // wall at 180. Its knuckle cylinder had x = z, which dropped the lid's whole
  // envelope from the sweep, so the plan lint never saw it.
  it("catches the hinged box closing into itself at plan time; the two-link arm passes", () => {
    expect(cadPlanGeometryLint.run(graph("asm-hinged-box"))).toEqual([expect.stringMatching(/hinge states limits \[70, 180\]°, but .* reach \[-35, 160\]/)]);
    expect(cadPlanGeometryLint.run(graph("asm-two-link-arm"))).toEqual([]);
  });

  it("derived or stated limits narrower than the brief's travel are a lint", () => {
    const g = graph("asm-two-link-arm");
    (g.joints[1] as { limits?: number[] }).limits = [-50, 50];
    expect(cadPlanGeometryLint.run(g)).toEqual([expect.stringMatching(/joint elbow: the brief states 120° of travel, but its limits \[-50, 50\]° cover 100°/)]);
  });
});

const facePort = (g: GraphDoc, node: string, name: string) => (g.nodes[node]!.contract.payload as CadContractPayload).ports.find((p) => p.name === name)!;
const asOut = (g: GraphDoc) =>
  ({ nodes: Object.values(g.nodes).map((n) => ({ id: n.id, kind: n.kind, title: n.title, spec: n.spec, contract: n.contract })), edges: g.edges, joints: g.joints, entryNodeId: g.assembly.entryNodeId }) as unknown as ArchitectOutput;
const asGraph = (g: GraphDoc, out: ArchitectOutput) =>
  GraphDoc.parse({ ...g, nodes: Object.fromEntries(out.nodes.map((n) => [n.id, { ...g.nodes[n.id], ...n, params: {} }])), edges: out.edges.map((e, k) => ({ id: `e${k}`, ...e })), joints: out.joints });

describe("face rings fit their face", () => {
  // asm-dowel-alignment: two dowels 48 apart put a Ø52 ring on a 40mm face.
  it("a pattern too wide for an outside ring gets one inside it, clamped to the face", () => {
    const g = graph("asm-dowel-alignment");
    const x = asGraph(g, expandJoints(asOut(g)));
    for (const node of ["mold-bottom", "mold-top"]) {
      const ring = resolveDim(x, facePort(x, node, "parting_face").params.ring_diameter as number | string);
      expect(ring).toBeLessThanOrEqual(40 - 2.4);
      expect(ring / 2).toBeLessThan(24 - 2); // inside the Ø4 holes at ±24
    }
    expect(cadJointRuleLint.run(x)).toEqual([]);
  });

  it("lints a ring wider than its face", () => {
    const g = graph("asm-dowel-alignment");
    const x = asGraph(g, expandJoints(asOut(g)));
    facePort(x, "mold-top", "parting_face").params.ring_diameter = 52;
    expect(cadJointRuleLint.run(x)).toEqual([expect.stringMatching(/mold-top.parting_face's probe ring is Ø52.0, but the face holds only Ø40.0/)]);
  });
});

describe("kinematic chains", () => {
  // asm-two-link-arm: the shoulder swung elbow_pin but left the forearm hung
  // on it behind, because the elbow, nearer, claimed the forearm.
  it("an upstream joint carries everything downstream of it, through further joints", () => {
    const g = graph("asm-two-link-arm");
    const { world, instances } = solvePlan(g);
    const [shoulder, elbow] = kinematicJoints(jointAxes(g), world, instances);
    expect(shoulder!.moving).toEqual(expect.arrayContaining(["upper-arm", "elbow_pin", "forearm"]));
    expect(elbow!.moving).toEqual(["forearm"]);
  });
});

describe("one port pair, one joint", () => {
  // asm-linear-slide: j1 and j2 named the same pair and minted two rods on one axis.
  it("lints two joints on one port pair, and slides refuse count", () => {
    const problems = cadJointRuleLint.run(graph("asm-linear-slide"));
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/joints j1 and j2 both join end-block.rod_face to carriage.end_face_neg/)]));
    const slide = selectJoint({ intent: "serviceable", motion: "prismatic", load: "light", access: "both_sides", wallA: 12, wallB: 40, strokeMm: 100, count: 2, processA: "FDM", processB: "FDM" });
    expect("error" in slide && slide.error).toMatch(/P1 one rod per joint, not count 2.*P2 one rail per joint/);
  });
});

describe("a stated pin is any pin of that Ø", () => {
  // asm-two-link-arm and asm-hinged-box live: "on 4mm steel pins" came back
  // as prefer {family: shaft} and every rule's D-shaft or dowel was refused.
  it("a stated shaft accepts the rules' D-shaft or dowel pin of that Ø", () => {
    const pivot: JointInput = { intent: "serviceable", motion: "revolute", load: "light", access: "both_sides", wallA: 6, wallB: 6, processA: "FDM", processB: "FDM" };
    expect(parts(ok({ ...pivot, prefer: { family: "shaft", key: "4" } }))).toEqual(["dowel:4"]);
    expect(parts(ok({ ...pivot, wallA: 12, prefer: { family: "shaft", key: "4" } }))).toContain("d_shaft:4");
  });
});

describe("a part on two parallel slides", () => {
  // asm-linear-slide live, one joint per rod: the carriage went with the
  // nearer rod's sweep only, so the other rod's LM8UU slid out through it.
  it("slides with both joints", () => {
    const g = graph("asm-linear-slide-2rods");
    const { world, instances } = solvePlan(g);
    const joints = kinematicJoints(jointAxes(g), world, instances);
    expect(joints).toHaveLength(2);
    for (const j of joints) expect(j.moving).toContain("carriage");
  });
});

describe("gear tooth counts past 41", () => {
  const drive: JointInput = {
    intent: "serviceable", motion: "revolute", driven: true, torqueClass: "high", load: "medium", access: "both_sides",
    wallA: 14, wallB: 8, wallMotor: 6, processA: "FDM", processB: "FDM",
  };
  it("a 1:4 reduction at the load's m1.5 builds with a 68T wheel instead of erroring", () => {
    const d = ok({ ...drive, ratio: 4 });
    expect([d.rule, d.dims.module, d.dims.teethMotor, d.dims.teethDriven]).toEqual(["DG", 1.5, 17, 68]);
  });
  it("a ratio 41 teeth reach keeps its module and count: the cap never buys a smaller module", () => {
    const d = ok({ ...drive, ratio: 2 });
    expect(d.dims.module).toBe(1.5);
    expect(d.dims.teethDriven).toBeLessThanOrEqual(41);
  });
});

describe("one axis, one joint", () => {
  // asm-hand-winch live: jc1 (pinion sleeve) and jc3 (crank arm) both turned
  // about the crank axis, each with its own shaft, bearings and collars.
  it("lints two motion joints on one axis of a that would not share an axle", () => {
    expect(cadJointRuleLint.run(graph("asm-hand-winch"))).toEqual(expect.arrayContaining([expect.stringMatching(/joints jc1 and jc3 both turn about one axis of frame/)]));
    expect(cadJointRuleLint.run(graph("asm-two-link-arm"))).toEqual([]);
  });
});

describe("a stated part keeps the usual rule order", () => {
  // asm-hinged-box live: "a 3mm steel pin" as prefer {shaft 3} went to M1
  // bearings, the first rule that can use a shaft, past the light hinge's pin.
  it("a light hinge on a stated 3mm pin is a bushing pivot or a pin, never bearings", () => {
    const hinge: JointInput = { intent: "permanent", motion: "revolute", load: "light", access: "both_sides", wallA: 35, wallB: 35, shaftHint: 3, processA: "FDM", processB: "FDM" };
    expect(ok({ ...hinge, prefer: { family: "shaft", key: "3" } }).rule).toBe(ok(hinge).rule);
    expect(ok(hinge).rule).not.toBe("M1");
  });
});
