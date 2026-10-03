import { describe, expect, it } from "vitest";
import {
  JOINT_RULES, SNAP_ENABLED, beltCenter, beltLength, gt2PitchD, jointEscapes, pickDrive, pickThread, railHoles, selectJoint,
  type JointDecision, type JointInput,
} from "./joints.js";

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
    ["M2p printed pin when allowed, e-clipped", { motion: "revolute", allowPrinted: true }, "M2p", ["pin_clip:eclip:4"]],
    ["M2d a separate pin when the walls are too thin for bushings", { motion: "revolute", wallA: 7.7, wallB: 7.7, shaftHint: 3 }, "M2d", ["pin:dowel:3x12"]],
    ["P1 short light slide on LM8UU", { motion: "prismatic", strokeMm: 60, wallA: 12, wallB: 30 }, "P1", ["rod:shaft:8", "linear_bearing:lm_uu:LM8UU"]],
    ["P2 long slide on a rail, screwed down into inserts", { motion: "prismatic", strokeMm: 200, load: "medium" }, "P2",
      ["rail:mgn_rail:MGN12x250", "carriage:mgn_carriage:MGN12C", "rail_screw:button:M3x6", "rail_insert:heatset_short:M3"]],
    ["D1 fast driven rotor on a brushless", { motion: "revolute", driven: true, speedClass: "high", duty: "continuous", wallB: 8 }, "D1", ["motor:brushless:2204"]],
    ["DB a 2:1 belt reduction", { motion: "revolute", driven: true, ratio: 2, wallA: 14, wallB: 8, wallMotor: 6 }, "DB", [
      "bearing_a:bearing:625", "bearing_b:bearing:625", "shaft:d_shaft:5", "collar:collar:5", "spacer:washer:M5",
      "motor:nema17:NEMA17", "motor_pulley:gt2_pulley:20T-5", "driven_pulley:gt2_pulley:40T-5", "belt:gt2_loop:6x158",
    ]],
    ["DG a 2:1 spur pair at high torque", { motion: "revolute", driven: true, ratio: 2, torqueClass: "high", wallA: 14, wallB: 8, wallMotor: 6 }, "DG", [
      "bearing_a:bearing:625", "bearing_b:bearing:625", "shaft:d_shaft:5", "collar:collar:5", "spacer:washer:M5",
      "motor:nema17:NEMA17", "motor_gear:spur_gear:m1.5", "driven_gear:spur_gear:m1.5",
    ]],
    ["PL short driven slide on a lead screw", { motion: "prismatic", driven: true, strokeMm: 100, wallA: 10, wallB: 30 }, "PL", [
      "motor:nema17:NEMA17", "coupler:coupler:5x8", "lead_screw:lead_screw:T8x150", "lead_nut:lead_nut:T8", "rod:shaft:8", "linear_bearing:lm_uu:LM8UU",
    ]],
    ["PB fast driven slide on a belt", { motion: "prismatic", driven: true, strokeMm: 100, speedClass: "high", wallA: 8, wallB: 10, wallMotor: 6 }, "PB", [
      "rail:mgn_rail:MGN9x150", "carriage:mgn_carriage:MGN9C", "rail_screw:button:M3x6", "rail_insert:heatset_short:M3",
      "motor:nema17:NEMA17", "motor_pulley:gt2_pulley:20T-5", "idler:gt2_idler:20T-5", "idler_washer:washer:M5",
      "idler_screw:button:M5x20", "idler_insert:heatset_std:M5", "belt:gt2_belt:6x434",
    ]],
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
    const untested = JOINT_RULES.map((r) => r.id).filter((id) => !covered.has(id) && id !== "R7");
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

  it("a ratio or an offset motor is a belt, and a gear pair when it must push hard or turn slowly", () => {
    const d = (i: Partial<JointInput>) => pickDrive({ ...base, motion: "revolute", driven: true, ...i }).coupling;
    expect(d({ ratio: 3 })).toBe("gt2");
    expect(d({ centerMm: 50 })).toBe("gt2");
    expect(d({ ratio: 1 })).toBe("direct");
    expect(d({ ratio: 3, torqueClass: "high" })).toBe("gear");
    expect(d({ centerMm: 50, speedClass: "low" })).toBe("gear");
  });
});

describe("belt and gear drives", () => {
  const drive = { motion: "revolute" as const, driven: true, wallA: 14, wallB: 8, wallMotor: 6 };

  it("snaps the belt to a stocked loop and solves the centre back from it", () => {
    const d = ok({ ...drive, ratio: 2 });
    const [p20, p40] = [gt2PitchD(20), gt2PitchD(40)];
    // The least centre puts the motor body clear of bearing_b's housing
    // (21.15 + 8 + 2·1.2 + 1 = 32.55), which a 122 loop cannot reach: 158.
    expect(beltLength(32.55, p20, p40)).toBeGreaterThan(122);
    expect(beltLength(d.dims.center!, p20, p40)).toBeCloseTo(158, 1);
    expect(beltCenter(beltLength(40, p20, p40), p20, p40)).toBeCloseTo(40, 9);
    expect(d.dims.center).toBeCloseTo(48.58, 2);
  });

  it("takes centerMm as the belt's least centre, and a centre no loop reaches falls to a spur pair", () => {
    expect(ok({ ...drive, centerMm: 60 })).toMatchObject({ rule: "DB", dims: { center: 63, teethMotor: 16, teethDriven: 16 } });
    const compact = ok({ ...drive, centerMm: 30 });
    expect(compact.rule).toBe("DG");
    expect(compact.dims.center).toBe(33); // m1, 33T:33T, the nearest that clears the motor
  });

  it("puts a spur pair at m·(z1+z2)/2, stepping the module up until it clears the motor", () => {
    // m1 tops out at 41 teeth: 20:40 is a 30mm centre, short of 32.55.
    const d = ok({ ...drive, ratio: 2, torqueClass: "high" });
    expect(d.dims).toMatchObject({ module: 1.5, teethMotor: 17, teethDriven: 34, center: 38.25, thickness: 9, phase: 0 });
    expect(d.reasons.join(" ")).toContain("a light load needs m1");
  });

  it("turns an even motor gear half a tooth, so a gap faces the driven gear's tooth", () => {
    const even = ok({ ...drive, ratio: 1, centerMm: 34, torqueClass: "high" });
    expect(even.dims).toMatchObject({ module: 1, teethMotor: 34, teethDriven: 34, center: 34 });
    expect(even.dims.phase).toBeCloseTo(180 / 34, 2);
  });

  it("a heavy drive takes module 2 on a Ø10 shaft, the upper collar spacing its gear when no washer is stocked", () => {
    const d = ok({ ...drive, load: "heavy", wallA: 24, wallB: 12 });
    expect(d.rule).toBe("DG");
    expect(d.dims.module).toBe(2);
    expect(d.parts.find((p) => p.role === "spacer")).toEqual({ role: "spacer", family: "collar", key: "10" });
  });

  it("a housing too thick for the motor shaft names wallMotor", () => {
    const r = selectJoint({ ...base, ...drive, id: "j2", wallMotor: undefined, wallA: 20, ratio: 2 });
    expect((r as { error: string }).error).toMatch(/DB the NEMA 17 shaft ends 4\.0 above a's face.*wallMotor/);
  });
});

describe("driven slides", () => {
  const slide = { motion: "prismatic" as const, driven: true, wallA: 10, wallB: 30, wallMotor: 6 };

  it("a lead screw when short and not fast, a belt when long or fast", () => {
    expect(ok({ ...slide, strokeMm: 300 }).rule).toBe("PL");
    expect(ok({ ...slide, strokeMm: 100, speedClass: "high" }).rule).toBe("PB");
    expect(ok({ ...slide, strokeMm: 320, load: "none" }).rule).toBe("PB");
  });

  it("a lead screw reaches b's top at full stroke, on a stocked length", () => {
    const d = ok({ ...slide, strokeMm: 100 });
    expect(d.dims).toMatchObject({ z0: 30.5, screwStart: 13.5, lead: 8 });
    // 30.5 - 13.5 + 100 + 30 = 147 → the 150 stock.
    expect(d.parts.find((p) => p.role === "lead_screw")!.length).toBe(150);
  });
});

describe("rail screws", () => {
  it("one per counterbored hole, centred like the rail's own holes", () => {
    expect(railHoles("MGN9", 150)).toEqual([-60, -40, -20, 0, 20, 40, 60]);
    expect(railHoles("MGN12", 250)).toEqual([-112.5, -87.5, -62.5, -37.5, -12.5, 12.5, 37.5, 62.5, 87.5, 112.5]);
  });

  it("tap a machined a, insert a printed one, by the fixed-joint rules", () => {
    const rail = { motion: "prismatic" as const, strokeMm: 200, wallA: 8 };
    expect(roles(ok({ ...rail, processA: "CNC" })).slice(2)).toEqual(["rail_screw:button:M3x8"]);
    expect(roles(ok({ ...rail, wallA: 10 })).slice(2)).toEqual(["rail_screw:button:M3x10", "rail_insert:heatset_std:M3"]);
    const thin = selectJoint({ ...base, ...rail, wallA: 3 });
    expect((thin as { error: string }).error).toContain("P2 MGN9 rail screws: R4 a's wall 3.0 < insert 5.8 + 1.2; a's wall 3.0 < short insert 3.0 + 1.2");
  });
});

describe("no rule fits", () => {
  it("names the shortfall the architect has to fix", () => {
    const r = selectJoint({ ...base, id: "j3", wallB: 3, access: "one_side" });
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

});

describe("eval fixes", () => {
  it("a thin printed b reachable from both sides takes a through-bolt at any load", () => {
    for (const load of ["none", "light", "medium"] as const) {
      const d = ok({ load, wallA: 4, wallB: 4, threadHint: "M4" });
      expect(d.rule).toBe("R3");
      expect(roles(d)).toEqual(["screw:shcs:M4x16", "nut:hex_nut:M4", "washer_a:washer:M4", "washer_b:washer:M4"]);
      expect(d.reasons[0]).toContain("printed b too thin for an insert or a nut trap");
    }
    // R4 and R5 still come first where they fit.
    expect(ok({ wallB: 10 }).rule).toBe("R4");
    expect(ok({ intent: "permanent", wallA: 4, wallB: 8 }).rule).toBe("R5");
  });

  it("a one-sided thin joint names access both_sides as its way out", () => {
    const i = { ...base, wallA: 4, wallB: 4, access: "one_side" as const, threadHint: "M4" };
    expect("error" in selectJoint(i)).toBe(true);
    expect(jointEscapes(i)).toEqual(["declare access both_sides for R3's M4×16 through-bolt, nut and washers"]);
  });

  it("the butt hinge: 3mm leaves, Ø3 pin, 7.7mm knuckles", () => {
    // Bushings need 2 × 4 + 1.2 of knuckle; M2p has no Ø3 e-clip unless allowed
    // to print; a catalog pin pressed in one knuckle turns in the other.
    const d = ok({ id: "hinge", motion: "revolute", intent: "permanent", wallA: 7.7, wallB: 7.7, shaftHint: 3 });
    expect(d.rule).toBe("M2d");
    expect(d.recipe).toBe("pin");
    expect(d.dims).toEqual({ d: 3, length: 12, press: 4.5, run: 7.5 });
    // Without a hint the pin steps down from the load's Ø5 to what fits.
    expect(roles(ok({ motion: "revolute", wallA: 6, wallB: 4 }))).toEqual(["pin:dowel:4x10"]);
    // Too thin even for a pin: the shortfall says so.
    const r = selectJoint({ ...base, id: "h", motion: "revolute", wallA: 2, wallB: 2 });
    expect((r as { error: string }).error).toContain("M2d walls 2.0/2.0: no Ø5/Ø4/Ø3/Ø2.5/Ø2 pin");
  });

  it("a slip bore a already declares on the axis turns the pin there too", () => {
    // The eval's hinge: 7.6 knuckles and the brief's Ø3.2 bores for a Ø3 pin.
    const d = ok({ motion: "revolute", wallA: 7.6, wallB: 7.6, shaftHint: 3, boreA: 3.2 });
    expect([d.rule, ...roles(d)]).toEqual(["M2d", "pin:dowel:3x12"]);
    expect(d.dims).toEqual({ d: 3, length: 12, press: 4.4, run: 7.6, slipA: 1 });
    // A bore no stocked pin slips in leaves the press fit alone.
    expect(ok({ motion: "revolute", wallA: 7.6, wallB: 7.6, shaftHint: 3, boreA: 4 }).dims.slipA).toBeUndefined();
  });

  it("DIN 6799 clips reach Ø2-3 shafts, so a printed Ø3 pin is e-clipped", () => {
    expect(roles(ok({ motion: "revolute", allowPrinted: true, shaftHint: 3, wallB: 4 }))).toEqual(["pin_clip:eclip:1.9"]);
    expect(roles(ok({ motion: "revolute", allowPrinted: true, shaftHint: 2, wallB: 4 }))).toEqual(["pin_clip:eclip:1.2"]);
  });
});

describe("audit fixes", () => {
  it("a shaft the catalog does not stock is a shortfall, not a crash at expansion", () => {
    const r = selectJoint({ ...base, motion: "revolute", duty: "continuous", wallA: 20, shaftHint: 7 });
    expect((r as { error: string }).error).toContain("M1 no Ø7 shaft stocked");
  });

  it("a metal b too thin to tap takes a through-bolt, at any load", () => {
    const d = ok({ processB: "CNC", wallA: 3, wallB: 2 });
    expect(d.rule).toBe("R3");
    expect(d.thread).toBe("M3");
    expect(d.reasons[0]).toContain("metal b too thin to tap");
  });

  it("snap fits are tried before the nut traps", () => {
    const ids = JOINT_RULES.map((r) => r.id);
    expect(ids.indexOf("R7")).toBeLessThan(ids.indexOf("R5"));
  });
});

describe("determinism", () => {
  it("the same joint gives the same decision every time", () => {
    const inputs: Partial<JointInput>[] = [{}, { load: "heavy", wallA: 6, wallB: 6 }, { motion: "revolute", duty: "continuous", wallA: 14 }];
    for (const i of inputs) expect(JSON.stringify(selectJoint({ ...base, ...i }))).toBe(JSON.stringify(selectJoint({ ...base, ...i })));
  });
});
