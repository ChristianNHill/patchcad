import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BEARING_DIAMETER,
  FDM_FIT_BANDS_MM,
  FDM_FIT_CUT_MM,
  MACHINED_FIT_BANDS_MM,
  MACHINED_FIT_CUT_MM,
  FDM_SLIP_FIT_MM,
  fitCut,
  SEAT_POSE,
  engagementLength,
  groundingLines,
  majorDiameter,
  seatBand,
  threadEngagementVolume,
} from "./grounding.js";
import { METRIC } from "./registry.js";
import { HARDWARE_PORT_TYPES } from "./index.js";

/** Each of these numbers was measured in this repo before it was written down.
 *  The tests assert the measurement, not the arithmetic. */
describe("grounded facts match what the probes and gates actually measured", () => {
  it("reproduces the thread-engagement volume G5 reported", () => {
    // G5 on two-plate-bolted: "m4-screw and m4-nut occupy the same space:
    // 12.8 mm³". That is the whole reason the clash gate needed an exemption.
    expect(threadEngagementVolume("M4", METRIC.M4!.nutH)).toBeCloseTo(12.8, 1);
  });

  it("puts the seat band where the real probe's boundary is", () => {
    // Measured on cad-clamp's M4 screw: 4.5, 5.5, 6.5, 6.9 pass; 7.5, 8.0 fail.
    const band = seatBand("fastener", "M4")!;
    expect(band.min).toBe(4);
    expect(band.max).toBe(7);
    for (const ok of [4.5, 5.5, 6.5, 6.9]) {
      expect(ok > band.min && ok <= band.max, `${ok} should be inside`).toBe(true);
    }
    for (const bad of [7.5, 8.0]) {
      expect(bad > band.max, `${bad} should be outside`).toBe(true);
    }
  });

  it("recommends the value cad-clamp actually uses for M4", () => {
    // The hand-authored reference declares ring_diameter 5.5, so a derived
    // recommendation that disagreed with it would be wrong by definition.
    expect(seatBand("fastener", "M4")!.recommended).toBe(5.5);
  });

  it("faces the seat out of the material, which is the sign that cost two nodes", () => {
    expect(SEAT_POSE.zAxis).toEqual([0, 0, -1]);
    expect(SEAT_POSE.origin).toEqual([0, 0, 0]);
  });

  it("keeps insert and tapped holes distinct, because confusing them measures the wrong feature", () => {
    // A heat-set insert is pressed into a hole sized for its own OD. The tap
    // diameter is for threading plastic directly, which is the ALTERNATIVE to an
    // insert, not part of one. Asserted against METRIC directly — the HOLE_FOR
    // lambdas that used to wrap it had no caller but this test.
    expect(METRIC.M4!.insertD).toBe(5.6);
    expect(METRIC.M4!.tap).toBe(3.3);
    expect(METRIC.M4!.clearance).toBe(4.5);
    expect(METRIC.M4!.insertD).not.toBe(METRIC.M4!.tap);
  });

  it("names the slip fit in the direction people get backwards", () => {
    expect(FDM_SLIP_FIT_MM).toBe(0.3);
  });

  it("covers every hardware kind the seat lint checks", () => {
    for (const kind of Object.keys(BEARING_DIAMETER)) {
      for (const thread of Object.keys(METRIC)) {
        const band = seatBand(kind, thread);
        expect(band, `${kind} ${thread}`).not.toBeNull();
        expect(band!.min).toBeLessThan(band!.max);
        expect(band!.recommended).toBeGreaterThan(band!.min);
        expect(band!.recommended).toBeLessThanOrEqual(band!.max);
      }
    }
  });

  it("returns an engagement length for the kinds a screw threads into, and null otherwise", () => {
    expect(engagementLength("nut", "M4")).toBe(METRIC.M4!.nutH);
    expect(engagementLength("insert", "M4")).toBe(METRIC.M4!.insertL);
    // The part's own family: a short insert engages 4mm, not the standard 8.1.
    expect(engagementLength("insert", "M4", "heatset_short")).toBe(4);
    expect(engagementLength("fastener", "M4")).toBeNull();
    // Wood inserts are sold by length: their dims row has none.
    expect(engagementLength("insert", "M6", "wood_insert", 12)).toBe(12);
    expect(engagementLength("insert", "M6", "wood_insert")).toBeGreaterThan(0);
  });

  it("refuses a designation it cannot read rather than guessing", () => {
    expect(() => majorDiameter("banana")).toThrow(/metric thread/);
    expect(seatBand("fastener", "M99")).toBeNull();
    expect(seatBand("part", "M4")).toBeNull();
  });

  it("renders every thread into the guidance, with the pose and the fit", () => {
    const text = groundingLines().join("\n");
    for (const t of Object.keys(METRIC)) expect(text).toContain(`${t}: clearance hole`);
    expect(text).toContain("zAxis [0,0,-1]");
    expect(text).toContain("0.3mm SMALLER");
    expect(text).toContain("not a clash");
  });
});

describe("fit cut targets for the generator", () => {
  const num = (v: number | string) => (typeof v === "number" ? v : undefined);
  const cut = (type: string, params: Record<string, number | string>) => fitCut({ type, params }, num);

  it("sits mid-band of what the G3 probes accept", () => {
    // press [d-0.1, d], slip [d+0.05, d+0.25], magnet [d+0.05, d+0.2], nut [af, af+0.4]
    expect(FDM_FIT_CUT_MM).toEqual({ press: -0.05, slip: 0.15, magnet: 0.125, nutTrapAf: 0.2 });
  });

  it("works the cut out from the nominal size each port declares", () => {
    expect(cut("DOWEL_HOLE", { diameter: 3, depth: 6, fit: "press" })).toBe("cut Ø 2.95 (diameter 3 − 0.05, press)");
    expect(cut("BEARING_SEAT", { od: 22, width: 7, fit: "slip" })).toContain("Ø 22.15 (od 22 + 0.15, slip); pocket ≥ width deep on a shoulder lip ≥ 1 mm");
    expect(cut("BUSHING_BORE", { od: 12, length: 10 })).toBe("cut Ø 11.95 (od 12 − 0.05, press)");
    expect(cut("MAGNET_POCKET", { diameter: 6, depth: 3 })).toBe("cut Ø 6.125 (diameter 6 + 0.125, magnet)");
    expect(cut("NUT_TRAP", { af: 5.5, depth: 2.4, entry: "axial" })).toBe("cut across the flats 5.7 (af 5.5 + 0.2, nutTrapAf)");
    expect(cut("HUB_BORE", { diameter: 5 })).toBe("cut Ø 5.15 (diameter 5 + 0.15, slip)");
    // The toy car's wheels cut a D-bore with the flat on +y, which the probe read as Ø4.53.
    expect(cut("HUB_BORE", { diameter: 5, fit: "press", flat: 2 })).toBe(
      "cut Ø 4.95 (diameter 5 − 0.05, press); interference is tiny on FDM, do not undersize; D-flat 2 mm from the axis along this port's +x, never another side",
    );
    expect(cut("MOTOR_MOUNT", { pilot_diameter: 22, hole_diameter: 3.4, pcd: 43.84, count: 4 })).toBe("cut Ø 22.15 (pilot_diameter 22 + 0.15, slip)");
    expect(cut("INSERT_POCKET", { diameter: 4, depth: 5.8 })).toContain("depth + 0.3");
    expect(cut("THREADED_HOLE", { thread: "M4", depth: 8 })).toBe("cut Ø 3.3 (tap drill for M4)");
    expect(cut("THREADED_HOLE", { thread: "M99" })).toBeNull();
    expect(cut("FLAT_FACE", {})).toBeNull();
  });

  it("uses the tighter machined midpoints for cnc, sheet metal and laser", () => {
    // press [d-0.05, d], slip [d, d+0.05], magnet [d, d+0.1]
    expect(fitCut({ type: "DOWEL_HOLE", params: { diameter: 3, fit: "slip" } }, num, true)).toBe("cut Ø 3.025 (diameter 3 + 0.025, slip)");
    expect(fitCut({ type: "MAGNET_POCKET", params: { diameter: 6 } }, num, true)).toBe("cut Ø 6.05 (diameter 6 + 0.05, magnet)");
  });

  it("falls back to the rule when a size is an unresolved expression", () => {
    expect(cut("DOWEL_HOLE", { diameter: "param(x.d)", fit: "slip" })).toBe("cut Ø diameter + 0.15");
  });
});

/** The cut constants are claims about gates.py: each must be its band's
 *  midpoint, and the bands must be the ones the probes grade against. */
describe("fit bands agree with the kernel", () => {
  const gates = readFileSync(new URL("../kernel/src/patchcad_kernel/gates.py", import.meta.url), "utf8");
  const pyBands = (name: string) => {
    const m = gates.match(new RegExp(`^${name} = \\{([^}]*)\\}`, "m"));
    if (!m) throw new Error(`${name} not found in gates.py`);
    return Object.fromEntries(
      [...m[1]!.matchAll(/"(\w+)": \(([-\d.]+), ([-\d.]+)\)/g)].map((x) => [x[1]!, [Number(x[2]), Number(x[3])]]),
    );
  };
  const slop = Number(gates.match(/^NUT_TRAP_SLOP_MM = ([\d.]+)/m)?.[1]);

  it("FDM and machined bands match gates.py FIT_BANDS and MACHINED_FIT_BANDS", () => {
    for (const [ts, py] of [
      [FDM_FIT_BANDS_MM, pyBands("FIT_BANDS")],
      [MACHINED_FIT_BANDS_MM, pyBands("MACHINED_FIT_BANDS")],
    ] as const) {
      const { nutTrapAf, ...probed } = ts;
      expect(probed).toEqual(py);
      expect(nutTrapAf).toEqual([0, slop]);
    }
  });

  it("cuts every fit at its band midpoint", () => {
    for (const [cuts, bands] of [
      [FDM_FIT_CUT_MM, FDM_FIT_BANDS_MM],
      [MACHINED_FIT_CUT_MM, MACHINED_FIT_BANDS_MM],
    ] as const) {
      for (const [fit, [lo, hi]] of Object.entries(bands)) {
        expect(cuts[fit as keyof typeof cuts], fit).toBeCloseTo((lo + hi) / 2, 9);
      }
    }
  });

  it("HARDWARE_PORT_TYPES matches gates.py HARDWARE_PROBES", () => {
    const m = gates.match(/^HARDWARE_PROBES = \{([^}]*)\}/m);
    expect(m, "HARDWARE_PROBES not found in gates.py").toBeTruthy();
    const keys = [...m![1]!.matchAll(/"(\w+)":/g)].map((x) => x[1]!).sort();
    expect([...HARDWARE_PORT_TYPES].sort()).toEqual(keys);
  });
});
