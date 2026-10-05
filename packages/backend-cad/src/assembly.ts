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

/** A point through a rigid transform. */
export function transformPoint(m: Mat4, p: readonly number[]): [number, number, number] {
  return [0, 1, 2].map((r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!) as [
    number,
    number,
    number,
  ];
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
  /** The revolute joint this mate puts its part on. A second such mate on a
   *  part already placed (a lid on two hinges, a cradle on two bearings)
   *  constrains only the axis: the lines must agree, and where each joint
   *  sits along it, and the turn about it, stay free. */
  axis?: string;
  /** The turn about this mate's axis is free: it is chosen so another mate
   *  onto the same part, whose other end is already placed, lines up (a far
   *  end block on two rods). */
  clockFree?: boolean;
}

/** How far two mates may disagree about where a part goes before it is a
 *  problem. Loose enough to absorb float error through a BFS chain of
 *  transforms, tight enough that a feature visibly missing its partner is
 *  reported. */
const MATE_CONSISTENCY_TOL_MM = 0.05;

/** sin of the angle under which two axes count as parallel. */
const AXIS_PARALLEL_TOL = 1e-4;

/** How far `p`'s z line is from `q`'s: the larger of q's origin off p's line
 *  and the angle between them as an offset 100mm along. 0 when collinear. */
function axisOffset(p: Mat4, q: Mat4): number {
  const z = [p[8]!, p[9]!, p[10]!];
  const d = [q[12]! - p[12]!, q[13]! - p[13]!, q[14]! - p[14]!];
  const along = d[0]! * z[0]! + d[1]! * z[1]! + d[2]! * z[2]!;
  const radial = Math.hypot(...d.map((v, i) => v - along * z[i]!));
  const sin = Math.hypot(...cross([p[8]!, p[9]!, p[10]!], [q[8]!, q[9]!, q[10]!]));
  return Math.max(radial, sin > AXIS_PARALLEL_TOL ? 100 * sin : 0);
}

/**
 * Turn `placed` (a node just placed by a clock-free mate whose world frame is
 * `axis`) about that mate's axis so the first other mate onto the node whose
 * far end is already placed meets it. Unchanged when there is none.
 */
function clockTo(placed: Mat4, axis: Mat4, id: string, mates: AssemblyMate[], by: AssemblyMate, byId: Map<string, AssemblyNode>, world: Record<string, Mat4>): Mat4 {
  for (const m of mates) {
    if (m === by || (m.toNode !== id && m.fromNode !== id)) continue;
    const [own, ownPort, other, otherPort] = m.toNode === id ? [m.toNode, m.toPort, m.fromNode, m.fromPort] : [m.fromNode, m.fromPort, m.toNode, m.toPort];
    const p = byId.get(own)?.ports[ownPort];
    const q = byId.get(other)?.ports[otherPort];
    if (!p || !q || !(other in world)) continue;
    const z = [axis[8]!, axis[9]!, axis[10]!];
    const o = [axis[12]!, axis[13]!, axis[14]!];
    const radial = (pt: number[]) => {
      const d = pt.map((v, i) => v - o[i]!);
      const along = d[0]! * z[0]! + d[1]! * z[1]! + d[2]! * z[2]!;
      return d.map((v, i) => v - along * z[i]!);
    };
    const [u, w] = [radial(transformPoint(placed, p.origin)), radial(transformPoint(world[other]!, q.origin))];
    if (Math.hypot(...u) < 1e-6 || Math.hypot(...w) < 1e-6) return placed;
    const c = cross(u as [number, number, number], w as [number, number, number]);
    const theta = Math.atan2(c[0] * z[0]! + c[1] * z[1]! + c[2] * z[2]!, u[0]! * w[0]! + u[1]! * w[1]! + u[2]! * w[2]!);
    // Rz(theta) in the mate's frame, conjugated into the world.
    const [cs, sn] = [Math.cos(theta), Math.sin(theta)];
    const rz: Mat4 = [cs, sn, 0, 0, -sn, cs, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return mul(mul(mul(axis, rz), invertRigid(axis)), placed);
  }
  return placed;
}

/**
 * A part held between two others by two of its own ports (a slat between two
 * side panels) whose second port misses its seat only ALONG the line between
 * its ports is the wrong length, not misplaced: say so in those words.
 * Undefined when the miss is not along that line (a wrong pose).
 */
function spanConflict(
  mate: AssemblyMate, portA: Pose, portB: Pose, from: Mat4, to: Mat4,
  byId: Map<string, AssemblyNode>, placedByPort: Record<string, string>, placer: string | undefined,
): string | undefined {
  const own = byId.get(mate.toNode)!.ports[placedByPort[mate.toNode] ?? ""];
  // Both seats on one part is a hole-spacing mismatch, not a loop.
  if (!own || !placer || placer === mate.fromNode) return undefined;
  const p = transformPoint(to, own.origin);
  const q = transformPoint(to, portB.origin);
  const seat = transformPoint(from, portA.origin);
  const line = q.map((v, i) => v - p[i]!);
  const length = Math.hypot(...line);
  // Ports a few mm apart (a nut's two faces) say nothing about a span.
  if (length < 10) return undefined;
  const u = line.map((v) => v / length);
  const miss = seat.map((v, i) => v - q[i]!);
  const along = miss[0]! * u[0]! + miss[1]! * u[1]! + miss[2]! * u[2]!;
  if (Math.hypot(...miss.map((v, i) => v - along * u[i]!)) > MATE_CONSISTENCY_TOL_MM + 0.01 * Math.abs(along)) return undefined;
  return `${mate.toNode} spans ${Math.abs(along).toFixed(2)}mm ${along > 0 ? "less" : "more"} than the gap between ${placer} and ${mate.fromNode} (its ${placedByPort[mate.toNode]} on ${placer}, its ${mate.toPort} ${along > 0 ? "short of" : "past"} ${mate.fromNode}.${mate.fromPort}): make it ${along > 0 ? "longer" : "shorter"} by that much, or bind its length to that gap.`;
}

/**
 * BFS from the root: each mate places the consumer relative to its provider.
 * Returns world matrices per node. A node mated twice keeps its first
 * placement, and the extra mate is CHECKED against it rather than dropped —
 * that is where a two-hole bracket whose second hole is 10mm out shows up.
 * Unreached nodes are reported: identity is a fallback so the viewport has a
 * matrix, not a placement.
 *
 * `mateOrigins[i]` is where mate i's two ports meet in world space — on the
 * pose that mate actually placed, copies included — or null when it placed
 * nothing. G5 checks the parts touch there.
 */
export function solveAssembly(
  nodes: AssemblyNode[],
  mates: AssemblyMate[],
  rootId: string,
  /** Nodes that ride whatever placed them (a joint's nut in its leg): one
   *  more copy for each further copy of that part. */
  carried: (id: string) => boolean = () => false,
): {
  world: Record<string, Mat4>;
  instances: Record<string, Mat4[]>;
  problems: string[];
  mateOrigins: ([number, number, number] | null)[];
} {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const world: Record<string, Mat4> = {};
  /** Nodes in the order the BFS placed them. */
  const order: string[] = [];
  /** Every pose a node is placed at. world[id] is always the first of these. */
  const instances: Record<string, Mat4[]> = {};
  /** Which of a node's OWN ports the mate that placed it seated on. */
  const placedByPort: Record<string, string> = {};
  const placedBy: Record<string, AssemblyMate> = {};
  const problems: string[] = [];
  const used = new Set<AssemblyMate>();
  const origins = new Map<AssemblyMate, [number, number, number]>();
  const mateOrigins = () => mates.map((m) => origins.get(m) ?? null);
  if (!byId.has(rootId)) return { world, instances, problems: [`root node "${rootId}" not found`], mateOrigins: mateOrigins() };

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
      if (mate.clockFree) world[placingId] = clockTo(world[placingId]!, mul(world[placedId]!, poseToMat(portA)), placingId, mates, mate, byId, world);
      origins.set(mate, transformPoint(world[placedId]!, portA.origin));
      placedByPort[placingId] = placingPortKey;
      placedBy[placingId] = mate;
      order.push(placingId);
      queue.push(placingId);
    }
  }

  // OVER-CONSTRAINT IS A FINDING, NOT A NO-OP. A mate whose both ends were
  // already placed by other mates used to be skipped by the loop guard above
  // and never mentioned — the docstring claimed it was reported, and it was
  // not. Silence there means a bracket bolted through two holes can align on
  // the first and be arbitrarily far out on the second, with the assembly
  // reporting clean. So compute what this mate WOULD have given and compare.
  const redundant: AssemblyMate[] = [];
  /** Which node placed each extra copy, beside `instances`. */
  const copyBy: Record<string, string[]> = {};
  for (const mate of mates) {
    if (used.has(mate)) continue;
    const a = byId.get(mate.fromNode);
    const b = byId.get(mate.toNode);
    if (!a || !b || !(mate.fromNode in world) || !(mate.toNode in world)) continue;
    const portA = a.ports[mate.fromPort];
    const portB = b.ports[mate.toPort];
    if (!portA || !portB) continue;
    // INSTANCING BEFORE CONTRADICTION. One physical feature cannot sit in two
    // places at once, so a mate that re-seats a node through the very port that
    // already placed it is not a disagreement — it asks for another COPY of that
    // part at the new provider port. That is how four identical arms hang off one
    // plate from a single node: one consumer seat, four provider seats. A second
    // bolt through a DIFFERENT hole is still over-constraint, and still reported
    // by the check below, which is the case that check was written for.
    if (placedByPort[mate.toNode] === mate.toPort) {
      (instances[mate.toNode] ??= []).push(mul(world[mate.fromNode]!, mateTransform(portA, portB)));
      (copyBy[mate.toNode] ??= []).push(mate.fromNode);
      origins.set(mate, transformPoint(world[mate.fromNode]!, portA.origin));
      continue;
    }
    if (placedByPort[mate.fromNode] === mate.fromPort) {
      (instances[mate.fromNode] ??= []).push(mul(world[mate.toNode]!, mateTransform(portB, portA)));
      (copyBy[mate.fromNode] ??= []).push(mate.toNode);
      origins.set(mate, transformPoint(world[mate.toNode]!, portB.origin));
      continue;
    }
    redundant.push(mate);
  }
  // Every copy exists now, so a mate on a different port of an instanced part
  // is checked against the copy it meets: the crate's four end slats, each
  // placed by its right end, had their left ends judged against the first
  // slat at the far end of the crate (472mm "off").
  const copies = (id: string) => [world[id]!, ...(instances[id] ?? [])];
  for (const mate of redundant) {
    const portA = byId.get(mate.fromNode)!.ports[mate.fromPort]!;
    const portB = byId.get(mate.toNode)!.ports[mate.toPort]!;
    if (mate.axis) {
      // Both port frames in the world, as the mate's two ends sit now.
      const off = axisOffset(mul(world[mate.fromNode]!, poseToMat(portA)), mul(world[mate.toNode]!, poseToMat(portB)));
      const first = placedBy[mate.toNode]?.axis ?? placedBy[mate.fromNode]?.axis;
      // No contact query: the part need not reach this joint's hub point.
      if (off > MATE_CONSISTENCY_TOL_MM) {
        problems.push(
          `${mate.axis} axis is ${off.toFixed(2)}mm off ${first ? `${first}'s axis` : `the axis already solved for ${mate.toNode}`} (mate ${mate.fromNode}.${mate.fromPort} → ${mate.toNode}.${mate.toPort}). Coaxial joints on one part must share one line: move ${mate.toNode}.${mate.toPort} or ${mate.fromNode}'s joint port onto it. Where each sits along the axis is free.`,
        );
      }
      continue;
    }
    // Positional disagreement only: it is the number a user can act on, and a
    // pure rotation mismatch still moves the mated features apart. A
    // clock-free mate's part was turned to meet another, so there the two
    // port frames are compared, origin and line, not the part's pose.
    let best = { off: Infinity, from: world[mate.fromNode]!, to: world[mate.toNode]!, k: 0 };
    for (const from of copies(mate.fromNode)) {
      for (const [k, to] of copies(mate.toNode).entries()) {
        const expected = mul(from, mateTransform(portA, portB));
        const [pa, pb] = [mul(from, poseToMat(portA)), mul(to, poseToMat(portB))];
        const off = mate.clockFree
          ? Math.max(axisOffset(pa, pb), Math.hypot(pa[12]! - pb[12]!, pa[13]! - pb[13]!, pa[14]! - pb[14]!))
          : Math.hypot(expected[12]! - to[12]!, expected[13]! - to[13]!, expected[14]! - to[14]!);
        if (off < best.off) best = { off, from, to, k };
      }
    }
    if (best.off > MATE_CONSISTENCY_TOL_MM) {
      const by = placedBy[mate.toNode];
      const placer = best.k ? copyBy[mate.toNode]?.[best.k - 1] : by && (by.fromNode === mate.toNode ? by.toNode : by.fromNode);
      problems.push(spanConflict(mate, portA, portB, best.from, best.to, byId, placedByPort, placer) ??
        `mate ${mate.fromNode}.${mate.fromPort} → ${mate.toNode}.${mate.toPort} disagrees with the placement already solved for ${mate.toNode} by ${best.off.toFixed(2)}mm. Both parts are positioned by another mate, so this one cannot be satisfied — the two features will not line up.`,
      );
    } else {
      origins.set(mate, transformPoint(best.from, portA.origin));
    }
  }

  // COPIES CARRY WHAT HANGS ON THEM. A nut seated in a leg is placed from that
  // leg's first copy only; the leg's other copies got none, and the round
  // stool's four joints stacked four nut sets on leg #0 (27 G5 clashes). The
  // same holds for any part mated to nothing but the copied part and what
  // hangs below it: the spaghetti shelf's rods and feet sat on bracket #0
  // only (6 parts placed of 26). A part also mated elsewhere is one part, held
  // between them, and stays single.
  // In placement order, so a carried node's own carried nodes follow it.
  const parentOf = (id: string) => {
    const by = placedBy[id];
    return by ? (by.fromNode === id ? by.toNode : by.fromNode) : undefined;
  };
  const below = (id: string, other: string) => {
    for (let cur: string | undefined = other; cur; cur = parentOf(cur)) if (cur === id) return true;
    return false;
  };
  const hangsOn = (id: string, parent: string) =>
    mates.every((m) => (m.fromNode !== id && m.toNode !== id) || [m.fromNode, m.toNode].every((n) => n === id || n === parent || below(id, n)));
  for (const id of order) {
    const by = placedBy[id];
    if (!by || !(carried(id) || hangsOn(id, parentOf(id)!))) continue;
    const parent = by.fromNode === id ? by.toNode : by.fromNode;
    const extra = instances[parent] ?? [];
    if (!extra.length) continue;
    const local = invertRigid(world[parent]!);
    const own = [world[id]!, ...(instances[id] ?? []).filter((_, k) => copyBy[id]?.[k] === parent)];
    for (const copy of extra) for (const m of own) (instances[id] ??= []).push(mul(copy, mul(local, m)));
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
  // world[id] is the primary pose; extras collected above follow it.
  for (const n of nodes) instances[n.id] = [world[n.id]!, ...(instances[n.id] ?? [])];
  return { world, instances, problems, mateOrigins: mateOrigins() };
}


/**
 * A joint that moves: where its axis is in the world, how far it travels, and
 * which nodes travel with it. Revolute limits are degrees about the axis,
 * prismatic limits millimetres along it; the solved pose is the joint at 0.
 * The scene records these beside the rigid poses, and G5 sweeps the moving
 * nodes through the limits. `coupled` are the parts a drive turns with it,
 * each group about its own axis at `ratio` degrees per unit of the joint's
 * travel (a motor gear at -z_driven/z_motor, a lead screw at 360/lead).
 */
export interface KinematicJoint {
  id: string;
  type: "revolute" | "prismatic";
  origin: [number, number, number];
  direction: [number, number, number];
  limits: [number, number];
  moving: string[];
  /** `frame`: turns only in the sweep's own frame (a planetary's ring and
   *  housing, swept from the carrier), never in the world. */
  coupled?: { origin: [number, number, number]; direction: [number, number, number]; ratio: number; moving: string[]; frame?: boolean }[];
  /** Parts that turn in the world but hold still in the sweep's frame: a
   *  planetary's carrier, the output. */
  turnsInWorld?: string[];
}

/** A joint's axis declared in one node's frame: a port pose, and which of its
 *  axes the motion is about (z for a shaft or a rod, x for a rail). */
export interface JointAxisDef {
  id: string;
  type: KinematicJoint["type"];
  node: string;
  pose: Pose;
  axis: "x" | "z";
  limits: [number, number];
  moving: string[];
  /** Coupled groups, each about the z axis of its own pose in the same node's frame. */
  coupled?: { pose: Pose; ratio: number; moving: string[] }[];
}

/**
 * One joint per placed copy of the node that carries the axis, and `moving`
 * names placed COPIES (`node`, `node#1`, …, the keys G5 poses parts under).
 * Taking the axis from `world[node]` alone swung copies 2..n of an instanced
 * rotor around copy 1's axis, and G5 reported clashes no real rotor has. Each
 * moving copy goes with the nearest axis copy, so four rotors on four arm
 * copies turn about four axes, and four blades on one hub all turn about it.
 */
export function kinematicJoints(
  defs: JointAxisDef[],
  world: Record<string, Mat4>,
  instances: Record<string, Mat4[]> = {},
): KinematicJoint[] {
  const built = defs.map((d) => {
    const copies = instances[d.node] ?? (world[d.node] ? [world[d.node]!] : []);
    return copies.map((placed): KinematicJoint => {
      const axis = (pose: Pose, col: number) => {
        const m = mul(placed, poseToMat(pose));
        const direction = [m[col]!, m[col + 1]!, m[col + 2]!].map((v) => Math.round(v * 1e6) / 1e6) as [number, number, number];
        return { origin: transformPoint(m, [0, 0, 0]), direction };
      };
      const coupled = d.coupled?.map((c) => ({ ...axis(c.pose, 8), ratio: c.ratio, moving: [] as string[] }));
      return { id: d.id, type: d.type, ...axis(d.pose, d.axis === "x" ? 0 : 8), limits: d.limits, moving: [], ...(coupled?.length ? { coupled } : {}) };
    });
  });
  // A node several joints move (one wheel node on two axles) goes copy by
  // copy to the nearest axis of any of them, so a rear wheel never swings
  // about the front axle. A node placed once goes with every joint that moves
  // it (a carriage on two rods slides with both), and a joint whose axis rides
  // another's moving side (an elbow on a shoulder) never competes with it:
  // the shoulder carries the whole forearm, and the elbow swings it too.
  const nested = (k: number, m: number) => defs[k]!.moving.includes(defs[m]!.node) || defs[m]!.moving.includes(defs[k]!.node);
  const claimants = (n: string, k: number) =>
    (instances[n]?.length ?? 1) <= 1 ? built[k]! : defs.flatMap((d, m) => (d.moving.includes(n) && (m === k || !nested(k, m)) ? built[m]! : []));
  return defs.flatMap((d, k) => {
    const joints = built[k]!;
    const assign = (nodes: string[], group: (j: KinematicJoint) => Pick<KinematicJoint, "origin" | "direction" | "moving">, pool: (n: string) => KinematicJoint[]) => {
      for (const n of nodes) {
        const placed = instances[n] ?? (world[n] ? [world[n]!] : []);
        if (!placed.length) group(joints[0]!).moving.push(n);
        placed.forEach((m, i) => {
          const at = transformPoint(m, [0, 0, 0]);
          const nearest = pool(n).reduce((best, j) => (axisDistance(group(j), at) < axisDistance(group(best), at) ? j : best));
          if (joints.includes(nearest)) group(nearest).moving.push(i === 0 ? n : `${n}#${i}`);
        });
      }
    };
    if (!joints.length) return [];
    assign(d.moving, (j) => j, (n) => claimants(n, k));
    d.coupled?.forEach((c, g) => assign(c.moving, (j) => j.coupled![g]!, () => joints));
    return joints;
  });
}

function axisDistance(axis: { origin: readonly number[]; direction: readonly number[] }, p: readonly number[]): number {
  const rel = p.map((v, i) => v - axis.origin[i]!);
  const along = rel.reduce((sum, v, i) => sum + v * axis.direction[i]!, 0);
  return Math.hypot(...rel.map((v, i) => v - along * axis.direction[i]!));
}
