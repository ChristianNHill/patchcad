import { describe, expect, it } from "vitest";
import { invertRigid, mateTransform, mul, poseToMat, solveAssembly, IDENTITY, type Mat4 } from "./assembly.js";
import type { NumericPose as Pose } from "./bindings.js";

/** Mating two +z-out port frames must bring them coincident and opposed —
 * the whole mate table rides on this one transform. */

const closeTo = (a: number[], b: number[], tol = 1e-9) =>
  a.every((v, i) => Math.abs(v - b[i]!) < tol);

const topFace = (z: number): Pose => ({ origin: [0, 0, z], zAxis: [0, 0, 1], xAxis: [1, 0, 0] });

/** Apply a rigid transform to a point. Lived in assembly.ts as an exported
 *  "test/probe helper" with no production caller; it belongs here. */
function apply(m: Mat4, p: [number, number, number]): [number, number, number] {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

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

describe("solveAssembly reports what it cannot solve", () => {
  const flat = (o: [number, number, number], z: [number, number, number] = [0, 0, 1]) => ({
    origin: o,
    zAxis: z,
    xAxis: [1, 0, 0] as [number, number, number],
  });

  it("reports a node no mate positions, instead of silently stacking it at the origin", () => {
    const { world, problems } = solveAssembly(
      [
        { id: "plate", ports: { top: flat([0, 0, 5]) } },
        { id: "orphan", ports: { bottom: flat([0, 0, 0], [0, 0, -1]) } },
      ],
      [],
      "plate",
    );
    // Identity is still returned — the viewport needs a matrix for every node.
    expect(world.orphan).toEqual(IDENTITY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("orphan");
    expect(problems[0]).toContain("not positioned by any mate");
  });

  it("says nothing about the root of a single-part graph", () => {
    const { problems } = solveAssembly([{ id: "solo", ports: {} }], [], "solo");
    expect(problems).toEqual([]);
  });

  it("accepts a second mate that agrees with the placement already solved", () => {
    // Two holes 20mm apart on both parts: consistent, so both mates are satisfiable.
    const { problems } = solveAssembly(
      [
        { id: "plate", ports: { a: flat([0, 0, 5]), b: flat([20, 0, 5]) } },
        { id: "bracket", ports: { a: flat([0, 0, 0], [0, 0, -1]), b: flat([20, 0, 0], [0, 0, -1]) } },
      ],
      [
        { fromNode: "plate", fromPort: "a", toNode: "bracket", toPort: "a" },
        { fromNode: "plate", fromPort: "b", toNode: "bracket", toPort: "b" },
      ],
      "plate",
    );
    expect(problems).toEqual([]);
  });

  it("reports a second mate that disagrees, with the distance", () => {
    // The bracket's second hole is 10mm off, so the two mates cannot both hold.
    // This used to be skipped in silence while the assembly reported clean.
    const { problems } = solveAssembly(
      [
        { id: "plate", ports: { a: flat([0, 0, 5]), b: flat([20, 0, 5]) } },
        { id: "bracket", ports: { a: flat([0, 0, 0], [0, 0, -1]), b: flat([30, 0, 0], [0, 0, -1]) } },
      ],
      [
        { fromNode: "plate", fromPort: "a", toNode: "bracket", toPort: "a" },
        { fromNode: "plate", fromPort: "b", toNode: "bracket", toPort: "b" },
      ],
      "plate",
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("disagrees");
    expect(problems[0]).toContain("10.00mm");
  });
});

describe("solveAssembly instancing", () => {
  // One arm node, four seats on the plate: the repeated-part case the node
  // model could not express before (a quadcopter frame rendered one arm).
  const seat = (x: number, y: number): Pose => ({ origin: [x, y, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] });
  const plate = { id: "plate", ports: { s_a: seat(10, 0), s_b: seat(-10, 0), s_c: seat(0, 10), s_d: seat(0, -10) } };
  const arm = { id: "arm", ports: { root: seat(0, 0) } };
  const toArm = (port: string) => ({ fromNode: "plate", fromPort: port, toNode: "arm", toPort: "root" });

  it("repeats a part when several provider ports mate to the SAME consumer port", () => {
    const { instances, problems } = solveAssembly(
      [plate, arm],
      [toArm("s_a"), toArm("s_b"), toArm("s_c"), toArm("s_d")],
      "plate",
    );
    expect(problems).toEqual([]);
    expect(instances.arm).toHaveLength(4);
    // Each copy sits on the seat that placed it.
    const origins = instances.arm!.map((m) => [m[12], m[13]]);
    for (const want of [[10, 0], [-10, 0], [0, 10], [0, -10]]) {
      expect(origins.some((o) => closeTo(o as number[], want, 1e-9))).toBe(true);
    }
    // The primary pose leads the list and still matches world.
    expect(instances.arm![0]).toEqual(instances.arm![0]);
    expect(instances.plate).toHaveLength(1);
  });

  it("still reports over-constraint when the second mate uses a DIFFERENT port", () => {
    // Two holes that do not line up: a real contradiction, not a copy.
    const bracket = { id: "bracket", ports: { h_a: seat(0, 0), h_b: seat(5, 0) } };
    const { instances, problems } = solveAssembly(
      [plate, bracket],
      [
        { fromNode: "plate", fromPort: "s_a", toNode: "bracket", toPort: "h_a" },
        { fromNode: "plate", fromPort: "s_c", toNode: "bracket", toPort: "h_b" },
      ],
      "plate",
    );
    expect(instances.bracket).toHaveLength(1);
    expect(problems.join(" ")).toMatch(/disagrees with the placement/);
  });
});
