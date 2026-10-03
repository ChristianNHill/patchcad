import { describe, expect, it } from "vitest";
import { fmtMm, measure, sectionOffset, sectionPlane, type Vec3 } from "./measure";

describe("measure", () => {
  it("gives the straight-line distance and the midpoint", () => {
    const m = measure({ point: [0, 0, 0], normal: null }, { point: [3, 4, 0], normal: null });
    expect(m.distance).toBe(5);
    expect(m.mid).toEqual([1.5, 2, 0]);
    expect(m.faceGap).toBeNull();
  });

  it("reads the gap between parallel faces, not the diagonal between the clicks", () => {
    // Two sides of a 4mm wall, clicked 10mm apart along the wall.
    const m = measure({ point: [0, 0, 0], normal: [0, 0, -1] }, { point: [10, 0, 4], normal: [0, 0, 1] });
    expect(m.distance).toBeCloseTo(Math.hypot(10, 4));
    expect(m.faceGap).toBeCloseTo(4);
  });

  it("handles unnormalized normals", () => {
    const m = measure({ point: [0, 0, 0], normal: [0, 0, 5] }, { point: [1, 1, 2], normal: [0, 0, 2] });
    expect(m.faceGap).toBeCloseTo(2);
  });

  it("has no face gap when the faces are not parallel", () => {
    const m = measure({ point: [0, 0, 0], normal: [0, 0, 1] }, { point: [5, 0, 0], normal: [1, 0, 0] });
    expect(m.faceGap).toBeNull();
  });
});

describe("fmtMm", () => {
  it("keeps two decimals under 100mm and one above", () => {
    expect(fmtMm(4)).toBe("4.00 mm");
    expect(fmtMm(123.456)).toBe("123.5 mm");
  });
});

describe("sectionPlane", () => {
  const keeps = (axis: 0 | 1 | 2, offset: number, p: Vec3) => {
    const { normal, constant } = sectionPlane(axis, offset);
    return normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] + constant >= 0;
  };

  it("keeps what lies below the offset on its axis", () => {
    expect(keeps(2, 10, [0, 0, 5])).toBe(true);
    expect(keeps(2, 10, [0, 0, 15])).toBe(false);
    expect(keeps(0, -3, [-4, 99, 99])).toBe(true);
    expect(keeps(0, -3, [-2, 0, 0])).toBe(false);
  });

  it("maps the slider across the bounds and clamps it", () => {
    expect(sectionOffset([0, -10, 0], [10, 30, 5], 1, 0.25)).toBe(0);
    expect(sectionOffset([0, -10, 0], [10, 30, 5], 1, 2)).toBe(30);
  });
});
