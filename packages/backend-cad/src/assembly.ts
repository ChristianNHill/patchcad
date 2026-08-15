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

export interface MateDofs {
  /** rotation about A's port z-axis, radians */
  clock?: number;
  /** separation along A's port +z (out of A's material), mm — gasket thickness etc. */
  offset?: number;
  /** slide in A's port plane (its x / y axes), mm */
  u?: number;
  v?: number;
}

/** All DOFs are expressed in A's port frame (applied before the flip), so
 * their signs read naturally off the provider's declared pose. */
export function mateTransform(portA: Pose, portB: Pose, dofs: MateDofs = {}): Mat4 {
  const { clock = 0, offset = 0, u = 0, v = 0 } = dofs;
  const c = Math.cos(clock);
  const s = Math.sin(clock);
  const rz: Mat4 = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const slide: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, u, v, offset, 1];
  let m = mul(poseToMat(portA), slide);
  m = mul(m, rz);
  m = mul(m, FLIP_X);
  return mul(m, invertRigid(poseToMat(portB)));
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
  dofs?: MateDofs;
}

/**
 * BFS from the root: each mate places the consumer relative to its provider.
 * Returns world matrices per node. Unreached nodes sit at identity (floating
 * parts are legal, just unmated). A node mated twice keeps its first placement
 * — the second mate is reported for the (future) consistency check.
 */
export function solveAssembly(
  nodes: AssemblyNode[],
  mates: AssemblyMate[],
  rootId: string,
): { world: Record<string, Mat4>; problems: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const world: Record<string, Mat4> = {};
  const problems: string[] = [];
  if (!byId.has(rootId)) return { world, problems: [`root node "${rootId}" not found`] };

  world[rootId] = IDENTITY;
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const mate of mates) {
      const isForward = mate.fromNode === current && !(mate.toNode in world);
      const isReverse = mate.toNode === current && !(mate.fromNode in world);
      if (!isForward && !isReverse) continue;
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
      const rel = isForward
        ? mateTransform(portA, portB, mate.dofs)
        : mateTransform(portA, portB, mate.dofs); // symmetric: A is always the already-placed side
      world[placingId] = mul(world[placedId]!, rel);
      queue.push(placingId);
    }
  }

  for (const n of nodes) {
    if (!(n.id in world)) world[n.id] = IDENTITY;
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
