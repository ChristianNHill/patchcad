import type { NumericPose as Pose } from "./bindings.js";

/**
 * Static assembly resolution. Parts are modeled in their LOCAL frame; edges
 * mate a provider port on A to a consumer port on B with ONE universal
 * closed-form transform (design doc, mate table):
 *
 *   T_world(B) = T_world(A) · T(port_a) · Flip · Rz(clock) · Tz(offset) · Txy(u,v) · T(port_b)⁻¹
 *
 * Flip is a π rotation about the port X axis so the two +z-out port frames
 * face each other. Mate types differ only in which DOFs (clock/offset/u/v)
 * are free; every free DOF must carry an explicit value — the resolver never
 * guesses. Column-major 4×4, rigid transforms only.
 */

export type Mat4 = number[]; // 16, column-major

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** Inverse of a rigid transform: (Rᵀ, -Rᵀt). Column-major: R[r][c] = m[c*4+r]. */
export function invertRigid(m: Mat4): Mat4 {
  const t = [m[12]!, m[13]!, m[14]!];
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[c * 4 + r] = m[r * 4 + c]!; // transpose
    }
    out[12 + r] = -(m[r * 4 + 0]! * t[0]! + m[r * 4 + 1]! * t[1]! + m[r * 4 + 2]! * t[2]!);
  }
  out[15] = 1;
  return out;
}

function unit(v: [number, number, number]): [number, number, number] {
  const n = Math.hypot(...v);
  if (n < 1e-9) throw new Error("pose axis has zero length");
  return [v[0] / n, v[1] / n, v[2] / n];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Port pose → matrix whose columns are x, y = z×x, z, origin (kernel re-orthonormalizes the same way). */
export function poseToMat(pose: Pose): Mat4 {
  const z = unit(pose.zAxis);
  const rawX = unit(pose.xAxis);
  const dot = rawX[0] * z[0] + rawX[1] * z[1] + rawX[2] * z[2];
  const x = unit([rawX[0] - dot * z[0], rawX[1] - dot * z[1], rawX[2] - dot * z[2]]);
  const y = cross(z, x);
  const o = pose.origin;
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1];
}

/** π about local X: z → -z, y → -y — mating frames face each other. */
const FLIP_X: Mat4 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

/** Face two ports at each other: A's frame, flipped, times B's inverse. */
export function mateTransform(portA: Pose, portB: Pose): Mat4 {
  return mul(mul(poseToMat(portA), FLIP_X), invertRigid(poseToMat(portB)));
}

export interface AssemblyNode {
  id: string;
  ports: Record<string, Pose>;
}

export interface AssemblyMate {
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
}

/** How far two mates may disagree about where a part goes before it is a
 *  problem. Loose enough to absorb float error through a BFS chain of
 *  transforms, tight enough that a feature visibly missing its partner is
 *  reported. */
const MATE_CONSISTENCY_TOL_MM = 0.05;

/**
 * BFS from the root: each mate places the consumer relative to its provider.
 * Returns world matrices per node. A node mated twice keeps its first
 * placement, and the extra mate is CHECKED against it rather than dropped —
 * that is where a two-hole bracket whose second hole is 10mm out shows up.
 * Unreached nodes are reported: identity is a fallback so the viewport has a
 * matrix, not a placement.
 */
export function solveAssembly(
  nodes: AssemblyNode[],
  mates: AssemblyMate[],
  rootId: string,
): { world: Record<string, Mat4>; problems: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const world: Record<string, Mat4> = {};
  const problems: string[] = [];
  const used = new Set<AssemblyMate>();
  if (!byId.has(rootId)) return { world, problems: [`root node "${rootId}" not found`] };

  world[rootId] = IDENTITY;
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const mate of mates) {
      const isForward = mate.fromNode === current && !(mate.toNode in world);
      const isReverse = mate.toNode === current && !(mate.fromNode in world);
      if (!isForward && !isReverse) continue;
      used.add(mate);
      const [placedId, placingId, placedPortKey, placingPortKey] = isForward
        ? [mate.fromNode, mate.toNode, mate.fromPort, mate.toPort]
        : [mate.toNode, mate.fromNode, mate.toPort, mate.fromPort];
      const placed = byId.get(placedId);
      const placing = byId.get(placingId);
      if (!placed || !placing) {
        problems.push(`mate references unknown node ${placed ? placingId : placedId}`);
        continue;
      }
      const portA = placed.ports[placedPortKey];
      const portB = placing.ports[placingPortKey];
      if (!portA || !portB) {
        problems.push(`mate ${placedId}.${placedPortKey} → ${placingId}.${placingPortKey}: missing port`);
        continue;
      }
      // Symmetric: A is always the already-placed side, so direction does not
      // change the transform.
      world[placingId] = mul(world[placedId]!, mateTransform(portA, portB));
      queue.push(placingId);
    }
  }

  // OVER-CONSTRAINT IS A FINDING, NOT A NO-OP. A mate whose both ends were
  // already placed by other mates used to be skipped by the loop guard above
  // and never mentioned — the docstring claimed it was reported, and it was
  // not. Silence there means a bracket bolted through two holes can align on
  // the first and be arbitrarily far out on the second, with the assembly
  // reporting clean. So compute what this mate WOULD have given and compare.
  for (const mate of mates) {
    if (used.has(mate)) continue;
    const a = byId.get(mate.fromNode);
    const b = byId.get(mate.toNode);
    if (!a || !b || !(mate.fromNode in world) || !(mate.toNode in world)) continue;
    const portA = a.ports[mate.fromPort];
    const portB = b.ports[mate.toPort];
    if (!portA || !portB) continue;
    const expected = mul(world[mate.fromNode]!, mateTransform(portA, portB));
    const actual = world[mate.toNode]!;
    // Positional disagreement only: it is the number a user can act on, and a
    // pure rotation mismatch still moves the mated features apart.
    const off = Math.hypot(expected[12]! - actual[12]!, expected[13]! - actual[13]!, expected[14]! - actual[14]!);
    if (off > MATE_CONSISTENCY_TOL_MM) {
      problems.push(
        `mate ${mate.fromNode}.${mate.fromPort} → ${mate.toNode}.${mate.toPort} disagrees with the placement already solved for ${mate.toNode} by ${off.toFixed(2)}mm. Both parts are positioned by another mate, so this one cannot be satisfied — the two features will not line up.`,
      );
    }
  }

  // A NODE NOTHING PLACED IS NOT AT THE ORIGIN, IT IS UNPLACED. Falling back to
  // identity silently drops it wherever the root already is, so a part whose
  // mate could not be solved appears buried inside another one and the assembly
  // still reports clean. Identity remains the fallback — the viewport needs a
  // matrix for every node — but it is now a reported problem rather than a
  // decision made in silence. A single-part graph has nothing to mate, so its
  // one node being the root is not a problem.
  for (const n of nodes) {
    if (!(n.id in world)) {
      world[n.id] = IDENTITY;
      problems.push(
        `${n.id} is not positioned by any mate — it defaults to the origin, which is almost certainly inside another part. Wire it to a neighbour's port, or make it the assembly root.`,
      );
    }
  }
  return { world, problems };
}

/** Apply a rigid transform to a point — test/probe helper. */
export function apply(m: Mat4, p: [number, number, number]): [number, number, number] {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}
