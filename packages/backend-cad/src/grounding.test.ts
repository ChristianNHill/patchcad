import { describe, expect, it } from "vitest";
import {
  BEARING_DIAMETER,
  FDM_SLIP_FIT_MM,
  SEAT_POSE,
  engagementLength,
  groundingLines,
  majorDiameter,
  seatBand,
  threadEngagementVolume,
} from "./grounding.js";
import { METRIC } from "./registry.js";

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
    expect(engagementLength("fastener", "M4")).toBeNull();
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
