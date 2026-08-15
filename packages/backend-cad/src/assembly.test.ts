import { describe, expect, it } from "vitest";
import { apply, invertRigid, mateTransform, mul, poseToMat, solveAssembly, IDENTITY } from "./assembly.js";
import type { NumericPose as Pose } from "./bindings.js";

/** Mating two +z-out port frames must bring them coincident and opposed —
 * the whole mate table rides on this one transform. */

const closeTo = (a: number[], b: number[], tol = 1e-9) =>
  a.every((v, i) => Math.abs(v - b[i]!) < tol);

const topFace = (z: number): Pose => ({ origin: [0, 0, z], zAxis: [0, 0, 1], xAxis: [1, 0, 0] });

describe("mateTransform", () => {
  it("brings the two port origins coincident with opposed z", () => {
    const portA = topFace(2.5); // plate A top face
    const portB = topFace(3); // plate B top face (B is 6 thick)
    const t = mateTransform(portA, portB);
    // B's port origin lands on A's port origin…
    expect(closeTo(apply(t, [0, 0, 3]), [0, 0, 2.5])).toBe(true);
    // …and B's +z (out of B) now points along A's -z: a point 1mm above B's
    // port (outside B) maps to 1mm outside A's face too.
    expect(closeTo(apply(t, [0, 0, 4]), [0, 0, 1.5])).toBe(true);
  });

  it("offset separates along the mate axis", () => {
    const t = mateTransform(topFace(0), topFace(0), { offset: 2 });
    expect(closeTo(apply(t, [0, 0, 0]), [0, 0, 2])).toBe(true);
  });

  it("clock spins about the mate axis", () => {
    const t = mateTransform(topFace(0), topFace(0), { clock: Math.PI / 2 });
    const p = apply(t, [5, 0, 0]); // point along B's local +x
    expect(Math.abs(p[2])).toBeLessThan(1e-9);
    expect(Math.hypot(p[0], p[1])).toBeCloseTo(5, 9);
    expect(Math.abs(p[0])).toBeLessThan(1e-9); // rotated onto ±y
  });

  it("u/v slide in the mate plane", () => {
    const t = mateTransform(topFace(0), topFace(0), { u: 3, v: -4 });
    const p = apply(t, [0, 0, 0]);
    expect(Math.hypot(p[0], p[1])).toBeCloseTo(5, 9);
    expect(Math.abs(p[2])).toBeLessThan(1e-9);
  });

  it("invertRigid: M · M⁻¹ = I for a ROTATED pose (the identity-rotation trap)", () => {
    const pose: Pose = { origin: [3, -2, 7], zAxis: [0, 1, 0], xAxis: [0, 0, 1] };
    const m = poseToMat(pose);
    const roundTrip = mul(m, invertRigid(m));
    expect(closeTo(roundTrip, IDENTITY, 1e-9)).toBe(true);
  });

  it("reassembles cut pieces in place: opposed x-facing ports at the same point → identity", () => {
    // Exactly the imported-STL case: both halves live in the source file's
    // coordinates; mating their shared cut face must move NOTHING.
    const a: Pose = { origin: [-20, 1.14, 1.385], zAxis: [1, 0, 0], xAxis: [0, 0, 1] };
    const b: Pose = { origin: [-20, 1.14, 1.385], zAxis: [-1, 0, 0], xAxis: [0, 0, 1] };
    const t = mateTransform(a, b);
    expect(closeTo(t, IDENTITY, 1e-9)).toBe(true);
  });
});

describe("solveAssembly", () => {
  const plate = { id: "plate", ports: { hole: topFace(2.5) } };
  const bracket = {
    id: "bracket",
    ports: { base_hole: { origin: [0, -7, 4], zAxis: [0, 0, 1], xAxis: [1, 0, 0] } as Pose },
  };
  const screw = { id: "screw", ports: { seat: topFace(0) } };

  it("places a chain of mates via BFS from the root", () => {
    const { world, problems } = solveAssembly(
      [plate, bracket, screw],
      [
        { fromNode: "plate", fromPort: "hole", toNode: "bracket", toPort: "base_hole" },
        { fromNode: "bracket", fromPort: "base_hole", toNode: "screw", toPort: "seat" },
      ],
      "plate",
    );
    expect(problems).toEqual([]);
    expect(world.plate).toEqual(IDENTITY);
    // bracket's base_hole must land on the plate hole
    expect(closeTo(apply(world.bracket!, [0, -7, 4]), [0, 0, 2.5], 1e-9)).toBe(true);
    // screw seat mates onto the bracket's (now-placed) base_hole
    expect(closeTo(apply(world.screw!, [0, 0, 0]), [0, 0, 2.5], 1e-9)).toBe(true);
  });

  it("reports missing ports instead of guessing", () => {
    const { problems } = solveAssembly(
      [plate, bracket],
      [{ fromNode: "plate", fromPort: "nope", toNode: "bracket", toPort: "base_hole" }],
      "plate",
    );
    expect(problems.some((p) => p.includes("missing port"))).toBe(true);
  });

  it("leaves unmated parts at identity", () => {
    const { world } = solveAssembly([plate, screw], [], "plate");
    expect(world.screw).toEqual(IDENTITY);
  });
});
