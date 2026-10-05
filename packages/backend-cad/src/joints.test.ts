import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog.js";
import {
  JOINT_RULES, SNAP_ENABLED, materialClass, beltCenter, beltLength, gt2PitchD, jointEscapes, pickDrive, pickThread, railHoles, selectJoint,
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
/** Two MDF panels, machined: a CNC b that is wood is never tapped. */
const WOOD: Partial<JointInput> = { processA: "CNC", processB: "CNC", materialA: "18mm MDF", materialB: "birch plywood" };
const roles = (d: JointDecision) => d.parts.map((p) => `${p.role}:${p.family}:${p.key}${p.length ? `x${p.length}` : ""}`);

describe("selectJoint: one row per rule", () => {
  const rows: [string, Partial<JointInput>, string, string[]][] = [
    ["R1 dowel", { intent: "alignment", wallA: 8, wallB: 8 }, "R1", ["dowel:dowel:3x10"]],
    ["W4 dowel screw, leg into a top, as stated", { ...WOOD, wallA: 50, wallB: 400, prefer: { family: "dowel_screw", key: "6" } }, "W4", ["stud:dowel_screw:6x60"]],
    ["W5 chipboard screw, as stated", { ...WOOD, wallA: 18, wallB: 40, prefer: { family: "chipboard", key: "4" } }, "W5", ["screw:chipboard:4x35"]],
    ["W6 machine screw into a wood insert, as stated", { ...WOOD, wallA: 18, wallB: 40, threadHint: "M6", prefer: { family: "wood_insert", key: "M6" } }, "W6", ["screw:shcs:M6x20", "insert:wood_insert:M6x10"]],
    ["R8 threaded-rod stud, as stated", { intent: "serviceable", wallA: 50, wallB: 400, prefer: { family: "threaded_rod", key: "M6" } }, "R8", ["stud:threaded_rod:M6x30"]],
    ["R1b printed peg when the walls are too thin", { intent: "alignment", wallA: 2, wallB: 3 }, "R1b", []],
    ["R2 tapped into machined b", { processB: "CNC", wallB: 8 }, "R2", ["screw:button:M3x10"]],
    ["R3 heavy through-bolt", { load: "heavy", wallA: 6, wallB: 6 }, "R3", ["screw:shcs:M5x25", "nut:hex_nut:M5", "washer_a:washer:M5", "washer_b:washer:M5"]],
    ["R4 heat-set insert", {}, "R4", ["screw:button:M3x12", "insert:heatset_std:M3"]],
    ["R4 short insert in a thinner wall", { wallB: 5 }, "R4", ["screw:button:M3x8", "insert:heatset_short:M3"]],
    ["R5 axial nut trap", { intent: "permanent", load: "medium", wallA: 4, wallB: 8 }, "R5", ["screw:button:M4x12", "nut:hex_nut:M4"]],
    ["R6 side nut trap", { intent: "permanent", load: "medium", access: "one_side", wallA: 4, wallB: 10, lateral: 12 }, "R6", ["screw:button:M4x12", "nut:hex_nut:M4"]],
    ["M1 rotor on two bearings", { motion: "revolute", duty: "continuous", wallA: 14, wallB: 8 }, "M1", ["bearing_a:bearing:625", "bearing_b:bearing:625", "shaft:d_shaft:5", "collar:collar:5"]],
    ["M1h V-wheel on its own bearings, axle in a 3mm plate", { motion: "revolute", duty: "continuous", wallA: 3, wallB: 12 }, "M1h", ["hub_bearing_a:bearing:625", "hub_bearing_b:bearing:625", "axle_shaft:d_shaft:5", "axle_collar:collar:5"]],
    ["M1h one 608 in a thin light gear, axle in a 7mm plate", { motion: "revolute", duty: "continuous", load: "light", wallA: 7, wallB: 9, prefer: { family: "bearing", key: "608" } }, "M1h", ["hub_bearing_b:bearing:608", "axle_shaft:d_shaft:8", "axle_collar:collar:8"]],
    ["M1p winch drum between 6mm plates, one 608 in each", { motion: "revolute", duty: "continuous", wallA: 9, wallB: 30, pairedB: true, prefer: { family: "bearing", key: "608" } }, "M1p", ["bearing_a:bearing:608", "shaft:d_shaft:8", "collar:collar:8"]],
    ["M1f cradle between two supports, one flanged bearing each", { motion: "revolute", wallA: 8, wallB: 8, pairedB: true, prefer: { family: "bearing_flanged" } }, "M1f", ["bearing:bearing_flanged:F625", "shaft:d_shaft:5", "spacer:washer:M5"]],
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
    ["W1 wood panels align on glued furniture dowels", { ...WOOD, intent: "alignment", wallA: 18, wallB: 40 }, "W1", ["dowel:wood_dowel:6x25"]],
    ["W2 a removable wood panel joint on a cam lock and two dowels", { ...WOOD, wallA: 18, wallB: 300, lateral: 18 }, "W2",
      ["cam:cam_lock:15", "cam_bolt:cam_bolt:34", "dowel:wood_dowel:6x25"]],
    ["W3 a permanent wood panel joint on a confirmat", { ...WOOD, intent: "permanent", wallA: 16, wallB: 300 }, "W3", ["screw:confirmat:7x50"]],
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

  it("wood is never tapped: a cam lock needs b's panel thickness, else a confirmat", () => {
    const d = ok({ ...WOOD, wallA: 18, wallB: 300 });
    expect(d.rule).toBe("W3");
    expect(d.dims).toMatchObject({ drillA: 7, drillB: 5, pilotDepth: 33 });
    expect(ok({ ...WOOD, wallA: 18, wallB: 300, lateral: 18, roomA: 40 }).parts.map((p) => p.family)).toEqual(["cam_lock", "cam_bolt"]);
    expect(ok({ ...WOOD, wallA: 18, wallB: 40, lateral: 18 }).dims.distance).toBe(24);
    for (const load of ["none", "light", "medium"] as const) expect(ok({ ...WOOD, load, wallA: 16, wallB: 300 }).recipe).not.toBe("tapped");
  });

  it("flush asks for a countersunk head", () => {
    expect(ok({ flush: true, wallA: 6 }).head).toBe("csk");
  });

  it("M1 always takes two bearings and says why", () => {
    const d = ok({ motion: "revolute", duty: "continuous", load: "medium", wallA: 20 });
    expect(d.parts.filter((p) => p.family === "bearing")).toHaveLength(2);
    expect(d.reasons.join(" ")).toMatch(/one cannot take a moment load/);
    expect(d.parts[0]!.key).toBe("628"); // Ø8 for medium, the largest OD that fits twice in 20
  });

  it("an occasional pivot under a medium load turns on a pin or bushings, not bearings", () => {
    // extruder idler arm and latch: bearing×2 + collar + shaft for a pivot that barely moves
    const d = ok({ motion: "revolute", load: "medium", wallA: 30, wallB: 10 });
    expect(d.rule).toMatch(/^M2/);
    expect(d.parts.some((p) => p.family === "bearing")).toBe(false);
    expect(ok({ motion: "revolute", load: "heavy", wallA: 30, wallB: 12 }).rule).toBe("M1");
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
    expect(d({ speedClass: "low", torqueClass: "high", duty: "continuous" }).motor.family).toBe("n20");
    // An occasional servo joint picks its servo by torque.
    expect(d({ speedClass: "low", torqueClass: "medium" }).motor).toMatchObject({ family: "mg996r", key: "MG996R" });
    expect(d({ speedClass: "low", torqueClass: "high" }).motor).toMatchObject({ family: "sts3215", key: "STS3215" });
    // A stated servo or NEMA 14 drives b directly, whatever the classes say.
    expect(d({ speedClass: "high", prefer: { family: "sts3215" } })).toMatchObject({ motor: { family: "sts3215" }, coupling: "direct" });
    expect(d({ prefer: { family: "nema14", key: "nema14" } }).motor).toMatchObject({ family: "nema14", key: "NEMA14" });
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
    // The motor's 6mm pocket puts its shaft tip 18 up: the coupler rises to 6
    // so the screw starts at the shaft's tip, never inside it.
    expect(d.dims).toMatchObject({ gap: 6, z0: 35.5, screwStart: 18.5, lead: 8 });
    // 35.5 - 18.5 + 100 + 30 = 147 → the 150 stock.
    expect(ok({ ...slide, strokeMm: 100, wallMotor: undefined, wallA: 12 }).dims).toMatchObject({ gap: 1, z0: 30.5, screwStart: 13.5 });
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
    const r = selectJoint({ ...base, id: "rotor", motion: "revolute", duty: "continuous", wallA: 6 });
    expect((r as { error: string }).error).toMatch(/^rotor: M1 wallA 6\.0 < 2 × bearing width 2\.5 \+ 1\.2/);
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

describe("real-product leftovers", () => {
  // asm-hinged-box: Ø9 knuckles, the architect's min_wall 2.4 on the box.
  const hinge: Partial<JointInput> = { motion: "revolute", wallA: 24, wallB: 16, shaftHint: 3, roomA: 9, prefer: { family: "shaft", key: "3" } };

  it("a joint leaves the wall its part asserts: a min_wall 2.4 knuckle has no room for a bushing", () => {
    expect(ok(hinge).rule).toBe("M2");
    expect([ok({ ...hinge, minWallA: 2.4 }).rule, ...roles(ok({ ...hinge, minWallA: 2.4 }))]).toEqual(["M2d", "pin:dowel:3x30"]);
    // b's stated wall does not shrink a's room.
    expect(ok({ ...hinge, minWall: 2.4, minWallA: 1.2 }).rule).toBe("M2");
    // A stated bushing that no longer fits is a shortfall naming the wall.
    const r = selectJoint({ ...base, ...hinge, prefer: { family: "bushing", key: "3x6" }, minWallA: 2.4 });
    expect((r as { error: string }).error).toContain("M2 room around the axis in a Ø9.0 < bushing OD 6.0 + 2 × 2.4");
  });

  // real-pan-tilt-head: a tilt cradle between two supports on two F623s.
  const idle: Partial<JointInput> = { motion: "revolute", intent: "serviceable", wallA: 10, wallB: 8, prefer: { family: "bearing_flanged", key: "F623" } };

  it("a stated flanged bearing on a paired support takes one, the flange holding b", () => {
    const d = ok({ ...idle, pairedB: true });
    expect([d.rule, ...roles(d)]).toEqual(["M1f", "bearing:bearing_flanged:F623", "shaft:d_shaft:3", "spacer:washer:M3"]);
    expect(d.dims).toMatchObject({ d: 3, width: 4, flange: 1, gap: 0.5 });
    // One flanged bearing alone cannot hold b both ways: M1's pair it is.
    expect([ok(idle).rule, ...roles(ok(idle)).slice(0, 2)]).toEqual(["M1", "bearing_a:bearing_flanged:F623", "bearing_b:bearing_flanged:F623"]);
    // A support too thin for the bearing says so.
    const r = selectJoint({ ...base, ...idle, pairedB: true, wallA: 4, wallB: 8 });
    expect((r as { error: string }).error).toContain("M1f wallA 4.0 < flanged bearing width 4.0 + 1.2");
  });

  it("a lead screw's 3mm end plate keeps its wall: a boss on its face holds the guide rod (real-linear-actuator)", () => {
    const d = ok({ motion: "prismatic", driven: true, strokeMm: 100, wallA: 3, wallB: 30, prefer: { family: "lead_screw", key: "T8" } });
    expect(d.rule).toBe("PL");
    expect(d.dims).toMatchObject({ boss: 6.2, bossD: 14.4, socket: 8 });
    expect(ok({ motion: "prismatic", driven: true, strokeMm: 100, wallA: 10, wallB: 30 }).dims.boss).toBe(0);
  });

  it("a lead screw on a body that rides its own guide takes no rod, so a thin b is no shortfall", () => {
    const d = ok({ motion: "prismatic", driven: true, strokeMm: 100, wallA: 3, wallB: 10, guided: true });
    expect(roles(d)).toEqual(["motor:nema17:NEMA17", "coupler:coupler:5x8", "lead_screw:lead_screw:T8x150", "lead_nut:lead_nut:T8"]);
    expect(d.dims.boss).toBe(0);
    // Unguided, the same thin b carries its LM8UU in a boss.
    expect(ok({ motion: "prismatic", driven: true, strokeMm: 100, wallA: 3, wallB: 10 }).dims.lmBoss).toBe(15.2);
  });

  it("asm-lead-screw-lift: an 8mm platform carries its LM8UU in a boss, and the motor reads wallA", () => {
    const lift = { motion: "prismatic" as const, driven: true, strokeMm: 120, wallA: 8, wallB: 8 };
    const d = ok(lift);
    expect(d.dims).toMatchObject({ lmBoss: 17.2, lmBossD: 21.4 });
    // the boss clears the coupler: guide ≥ 19/2 + 21.4/2 + 1, + 1.2
    expect(d.dims.guide).toBeGreaterThanOrEqual(22.4);
    // a wallMotor thicker than a (an offset drive's) no longer starves the coupler
    expect(ok({ ...lift, wallMotor: 20 }).rule).toBe("PL");
    // a real pocket thinner than a still counts, and the message names the wall it read
    const r = selectJoint({ ...base, ...lift, wallA: 20 });
    expect((r as { error: string }).error).toContain("(a is 20.0 thick where the motor mounts)");
  });

  it("asm-hand-winch: a stated 608 on one plate fails M1 and names the far support's joint as the way out", () => {
    const drum = { ...base, id: "jd", motion: "revolute" as const, wallA: 9, wallB: 30, prefer: { family: "bearing", key: "608" } };
    expect((selectJoint(drum) as { error: string }).error).toContain("M1 wallA 9.0 < 2 × bearing width 7.0 + 1.2");
    expect(jointEscapes(drum)[0]).toMatch(/^declare b's joint on its far support too .* for M1p's Ø8 shaft on one 608 here/);
    expect(ok({ ...drum, pairedB: true }).rule).toBe("M1p");
    // a drum 60 long declared wallB 60 from each end: each shaft stops at the middle
    expect(ok({ ...drum, wallB: 60, pairedB: true, pairSpan: 60 }).dims.engage).toBe(29.5);
    expect(ok({ ...drum, wallB: 20, pairedB: true, pairSpan: 60 }).dims.engage).toBeUndefined();
  });

  it("a driven joint honours stated flanged bearings in its spindle", () => {
    const d = ok({ ...idle, driven: true, ratio: 64 / 21, torqueClass: "high", wallA: 12 });
    expect(d.rule).toBe("DG");
    expect(roles(d).slice(0, 2)).toEqual(["bearing_a:bearing_flanged:F623", "bearing_b:bearing_flanged:F623"]);
    // The driven gear clears the flange: the spacer sits on the inner race, fw proud.
    expect(d.dims.gap).toBe(1.5);
  });
});

describe("material classes (real-step-stool)", () => {
  it("reads a part's material string as wood, metal or plastic", () => {
    expect(materialClass("beech hardwood", "CNC")).toBe("wood");
    expect(materialClass("Birch Plywood", "CNC")).toBe("wood");
    expect(materialClass("18mm MDF", "CNC")).toBe("wood");
    expect(materialClass("particle board", "CNC")).toBe("wood");
    expect(materialClass("bamboo", "FDM")).toBe("wood");
    expect(materialClass("6061 aluminium", "CNC")).toBe("metal");
    expect(materialClass("brass", "CNC")).toBe("metal");
    expect(materialClass(undefined, "CNC")).toBe("metal");
    expect(materialClass("PETG", "FDM")).toBe("plastic");
  });

  it("never taps a wood part: M6 connector screws into beech rails take a cross-dowel nut", () => {
    const stool = { processA: "CNC" as const, processB: "CNC" as const, materialA: "beech hardwood", materialB: "beech hardwood", wallA: 30, wallB: 40, threadHint: "M6", access: "one_side" as const, lateral: 30 };
    // removable: a cam lock first; permanent, past the confirmat's reach: a cross-dowel nut
    expect(ok(stool).rule).toBe("W2");
    const d = ok({ ...stool, intent: "permanent" });
    expect([d.rule, d.recipe, d.thread]).toEqual(["R6", "side_nut_trap", "M6"]);
    // A metal a on a wood b is still not tapped into the wood.
    expect(ok({ ...stool, materialA: "steel" }).rule).not.toBe("R2");
    // Into metal it is.
    expect(ok({ ...stool, materialB: "aluminium", wallB: 20 }).rule).toBe("R2");
  });
});

describe("stated hardware every family can be", () => {
  // real-side-table (dowel_screw 6, threaded_rod M6) and real-step-stool
  // (wood_dowel 8 on printed parts) failed: binding prefer, no rule used them.
  it("every catalog family is in some rule's uses, but the few that never join two parts", () => {
    const used = new Set(JOINT_RULES.flatMap((r) => r.uses));
    // A seal, a magnet catch and a board standoff are placed in their own
    // pockets by the plan; a wire nail is not stocked as a joint yet.
    // v_wheel is a kit the architect places as a node (the wheel joints seat it).
    expect(Object.keys(CATALOG.families).filter((f) => !used.has(f))).toEqual(["wire_nail", "v_wheel", "disc_magnet", "oring", "standoff"]);
  });

  it("a heat-set insert stated for wood is refused, naming the wood insert (real-step-stool)", () => {
    const r = selectJoint({ ...base, id: "j-seat", ...WOOD, materialB: "beech hardwood", wallA: 18, wallB: 40, prefer: { family: "heatset_std", key: "M6" } });
    expect((r as { error: string }).error).toBe("j-seat: stated heatset_std M6: heat-set inserts are pressed into molten thermoplastic, and b (beech hardwood) is wood: state wood_insert M6 (a hex-drive threaded insert for wood) instead");
    // in plastic it is still the heat-set insert
    expect(ok({ wallB: 12, prefer: { family: "heatset_std", key: "M3" } }).rule).toBe("R4");
  });

  it("a family no rule uses says so plainly instead of asking for room", () => {
    const r = selectJoint({ ...base, id: "j", prefer: { family: "standoff", key: "M3" } });
    expect((r as { error: string }).error).toBe("j: stated standoff M3: no joint rule supports standoff yet");
  });

  it("stated furniture dowels glue printed parts too", () => {
    const d = ok({ intent: "alignment", wallA: 30, wallB: 30, prefer: { family: "wood_dowel", key: "8" } });
    expect([d.rule, ...roles(d)]).toEqual(["W1", "dowel:wood_dowel:8x45"]);
  });

  it("a dowel engages 1·d in each part: the organiser's Ø5 pin in an 8mm top", () => {
    const d = ok({ intent: "alignment", wallA: 99, wallB: 8, prefer: { family: "dowel", key: "5" } });
    expect([d.rule, ...roles(d)]).toEqual(["R1", "dowel:dowel:5x16"]);
    expect(d.dims).toMatchObject({ press: 9.7, depthA: 10.2, depthB: 6.8 }); // 6.8 + 1.2 ≤ 8: blind
    // a 6mm plate is too thin for a blind Ø5: the hole goes through it
    const t = ok({ intent: "alignment", wallA: 99, wallB: 6, prefer: { family: "dowel", key: "5" } });
    expect(t.dims).toMatchObject({ depthB: 6 });
    expect(t.reasons.join(" ")).toContain("through b");
    // never through both: two thin plates take a printed peg
    expect(ok({ intent: "alignment", wallA: 3, wallB: 3 }).rule).toBe("R1b");
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
