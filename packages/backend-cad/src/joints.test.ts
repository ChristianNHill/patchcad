import { describe, expect, it } from "vitest";
import { JOINT_RULES, SNAP_ENABLED, pickDrive, pickThread, selectJoint, type JointDecision, type JointInput } from "./joints.js";

/** The rules are a table, so the tests are too: one row per rule, each the
 *  smallest joint that reaches it, then the fall-through and determinism. */

const base: JointInput = {
  intent: "removable",
  load: "light",
  access: "both_sides",
  wallA: 5,
  wallB: 10,
  processA: "FDM",
  processB: "FDM",
};
const ok = (i: Partial<JointInput>) => {
  const d = selectJoint({ ...base, ...i });
  if ("error" in d) throw new Error(d.error);
  return d as JointDecision;
};
const roles = (d: JointDecision) => d.parts.map((p) => `${p.role}:${p.family}:${p.key}${p.length ? `x${p.length}` : ""}`);

describe("selectJoint: one row per rule", () => {
  const rows: [string, Partial<JointInput>, string, string[]][] = [
    ["R1 dowel", { intent: "alignment", wallA: 8, wallB: 8 }, "R1", ["dowel:dowel:3x10"]],
    ["R1b printed peg when the walls are too thin", { intent: "alignment", wallA: 2, wallB: 3 }, "R1b", []],
    ["R2 tapped into machined b", { processB: "CNC", wallB: 8 }, "R2", ["screw:button:M3x10"]],
    ["R3 heavy through-bolt", { load: "heavy", wallA: 6, wallB: 6 }, "R3", ["screw:shcs:M5x25", "nut:hex_nut:M5", "washer_a:washer:M5", "washer_b:washer:M5"]],
    ["R4 heat-set insert", {}, "R4", ["screw:button:M3x12", "insert:heatset_std:M3"]],
    ["R4 short insert in a thinner wall", { wallB: 5 }, "R4", ["screw:button:M3x8", "insert:heatset_short:M3"]],
    ["R5 axial nut trap", { intent: "permanent", load: "medium", wallA: 4, wallB: 8 }, "R5", ["screw:button:M4x12", "nut:hex_nut:M4"]],
    ["R6 side nut trap", { intent: "permanent", load: "medium", access: "one_side", wallA: 4, wallB: 10, lateral: 12 }, "R6", ["screw:button:M4x12", "nut:hex_nut:M4"]],
    ["M1 rotor on two bearings", { motion: "revolute", duty: "continuous", wallA: 14, wallB: 8 }, "M1", ["bearing_a:bearing:625", "bearing_b:bearing:625", "shaft:d_shaft:5", "collar:collar:5"]],
    ["M2 occasional pivot on bushings", { motion: "revolute", wallA: 12, wallB: 8 }, "M2", ["bushing_a:bushing:5x8x5", "bushing_b:bushing:5x8x5", "shaft:d_shaft:5", "collar:collar:5"]],
    ["M2p printed pin when allowed", { motion: "revolute", allowPrinted: true }, "M2p", []],
    ["P1 short light slide on LM8UU", { motion: "prismatic", strokeMm: 60, wallA: 12, wallB: 30 }, "P1", ["rod:shaft:8", "linear_bearing:lm_uu:LM8UU"]],
    ["P2 long slide on a rail", { motion: "prismatic", strokeMm: 200, load: "medium" }, "P2", ["rail:mgn_rail:MGN12x250", "carriage:mgn_carriage:MGN12C"]],
    ["D1 fast driven rotor on a brushless", { motion: "revolute", driven: true, speedClass: "high", duty: "continuous", wallB: 8 }, "D1", ["motor:brushless:2204"]],
  ];
  for (const [label, input, rule, parts] of rows) {
    it(label, () => {
      const d = ok(input);
      expect(d.rule).toBe(rule);
      expect(roles(d)).toEqual(parts);
    });
  }

  it("every rule in the table is exercised above", () => {
    const covered = new Set(rows.map((r) => r[2]));
    const untested = JOINT_RULES.map((r) => r.id).filter((id) => !covered.has(id) && !["R7", "PD"].includes(id));
    expect(untested).toEqual([]);
  });

  it("R4 recesses the head when the wall has room, and never taps plastic", () => {
    const d = ok({ wallA: 10, wallB: 12 });
    expect(d.head).toBe("shcs");
    expect(d.dims.recess).toBeCloseTo(3.4);
    expect(d.parts.some((p) => p.family === "heatset_std")).toBe(true);
    // A printed b never gets a tapped hole, whatever the load.
    for (const load of ["none", "light", "medium", "heavy"] as const) {
      const r = selectJoint({ ...base, load });
      if (!("error" in r)) expect(r.recipe).not.toBe("tapped");
    }
  });

  it("flush asks for a countersunk head", () => {
    expect(ok({ flush: true, wallA: 6 }).head).toBe("csk");
  });

  it("M1 always takes two bearings and says why", () => {
    const d = ok({ motion: "revolute", load: "medium", wallA: 20 });
    expect(d.parts.filter((p) => p.family === "bearing")).toHaveLength(2);
    expect(d.reasons.join(" ")).toMatch(/one cannot take a moment load/);
    expect(d.parts[0]!.key).toBe("628"); // Ø8 for medium, the largest OD that fits twice in 20
  });
});

describe("thread and drive choice", () => {
  it("light M3, medium M4, heavy M5, M6/M8 only over 3·d walls", () => {
    expect(pickThread({ ...base, load: "light" }).thread).toBe("M3");
    expect(pickThread({ ...base, load: "medium" }).thread).toBe("M4");
    expect(pickThread({ ...base, load: "heavy" }).thread).toBe("M5");
    expect(pickThread({ ...base, load: "heavy", wallA: 18, wallB: 20 }).thread).toBe("M6");
    expect(pickThread({ ...base, load: "heavy", wallA: 24, wallB: 30 }).thread).toBe("M8");
    expect(pickThread({ ...base, load: "heavy", threadHint: "m4" }).thread).toBe("M4");
  });

  it("servo, N20, brushless and NEMA 17 by speed and torque", () => {
    const d = (i: Partial<JointInput>) => pickDrive({ ...base, motion: "revolute", driven: true, ...i });
    expect(d({ speedClass: "low", duty: "occasional" }).motor.family).toBe("sg90");
    expect(d({ speedClass: "low", torqueClass: "high" }).motor.family).toBe("n20");
    expect(d({ speedClass: "high" }).motor.family).toBe("brushless");
    expect(d({ precise: true }).motor.family).toBe("nema17");
    expect(d({ speedClass: "medium" })).toMatchObject({ motor: { family: "nema17" }, coupling: "direct" });
    expect(d({ load: "heavy" }).coupling).toBe("gear");
  });
});

describe("no rule fits", () => {
  it("names the shortfall the architect has to fix", () => {
    const r = selectJoint({ ...base, id: "j3", wallB: 3 });
    expect(r).toEqual({ error: expect.stringContaining("j3: R4 wallB 3.0 < insert 5.8 + 1.2") });
    expect((r as { error: string }).error).toContain("short insert 3.0 + 1.2");
  });

  it("a bearing joint in a thin housing says how thick it must be", () => {
    const r = selectJoint({ ...base, id: "rotor", motion: "revolute", duty: "continuous", wallA: 8 });
    expect((r as { error: string }).error).toMatch(/^rotor: M1 wallA 8\.0 < 2 × bearing width 5\.0 \+ 1\.2/);
  });

  it("snap fits stay off behind their flag", () => {
    expect(SNAP_ENABLED).toBe(false);
    const r = selectJoint({ ...base, intent: "permanent", access: "one_side", wallB: 10 });
    expect((r as { error: string }).error).toContain("R7 snap fits are disabled");
  });

  it("a driven slide is refused rather than guessed", () => {
    const r = selectJoint({ ...base, motion: "prismatic", driven: true });
    expect((r as { error: string }).error).toContain("PD");
  });
});

describe("determinism", () => {
  it("the same joint gives the same decision every time", () => {
    const inputs: Partial<JointInput>[] = [{}, { load: "heavy", wallA: 6, wallB: 6 }, { motion: "revolute", duty: "continuous", wallA: 14 }];
    for (const i of inputs) expect(JSON.stringify(selectJoint({ ...base, ...i }))).toBe(JSON.stringify(selectJoint({ ...base, ...i })));
  });
});
