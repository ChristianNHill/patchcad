/**
 * Plan-time geometric lint: solve the PLAN's assembly from its declared ports
 * and pose each node's envelope, before a single part is generated. Three
 * defects are visible from the contracts alone, and each used to cost a full
 * cook to discover:
 *
 *  - two parts that are not mated to each other but whose envelopes
 *    interpenetrate once the mates have placed them;
 *  - two MATED parts that share most of their envelope away from the mate's
 *    axis: a revolute mate whose two frames agree lays one hinge leaf flat on
 *    top of the other;
 *  - a node the mates never place (it lands at the origin);
 *  - a port whose +z points INTO its own envelope. The convention is +z OUT of
 *    the mating face, so a flipped port mates its part on the wrong side of
 *    its partner, and the generator is asked to build a face the wrong way up.
 *
 * Envelopes are claims, not geometry, so the checks are conservative: a part
 * wholly inside another's envelope is left alone (a hollow enclosure's
 * envelope is a solid box, and what sits inside it is the point), and only
 * overlap beyond PLAN_OVERLAP_TOL_MM is reported.
 */
import type { GraphDoc } from "@patchcad/shared";
import { HARDWARE_PORT_TYPES, type CadContractPayload } from "./index.js";
import { IDENTITY, kinematicJoints, mul, poseToMat, solveAssembly, type JointAxisDef, type Mat4 } from "./assembly.js";
import { resolveDim, resolvePose } from "./bindings.js";
import { FASTENING_HARDWARE, REGISTRY_HARDWARE } from "./registry.js";
import { graphMates, isJointHardware, jointAxes, jointDecisions } from "./expand.js";

/** Envelopes carry slack around the part; touching neighbours may overlap by it. */
export const PLAN_OVERLAP_TOL_MM = 1.0;

/** A mated pair may share material around the mate's axis (a peg in its
 *  socket, knuckles interleaved on their pin); past this fraction of the
 *  smaller part's envelope shared AWAY from it, one part is on top of the other. */
export const MATED_OVERLAP_FRACTION = 0.25;

/** How far either side of a port origin the inward test steps. */
const PORT_STEP_MM = 0.5;

/** Ports whose material lies behind the face, on -z. A SHAFT or a boss
 *  stands OUT along +z, so its own material is legitimately in front.
 *  Hardware host features are cut into the part from the port's face too
 *  (read at call time: index.ts imports this module). */
const FACE_PORTS = new Set(["FLAT_FACE", "CLEARANCE_HOLE", "BORE", "SCREW_SEAT", "HOLE_PATTERN", "GROOVE", "SLOT"]);
const isFacePort = (type: string) => FACE_PORTS.has(type) || HARDWARE_PORT_TYPES.has(type);

type Vec3 = [number, number, number];
type Prim = CadContractPayload["envelope"]["volumes"][number];

/** A posed primitive: centre, unit axes, half-extents along them. A cylinder
 *  is its bounding box here, except where `round` says to test it radially. */
export interface Obb {
  c: Vec3;
  axes: [Vec3, Vec3, Vec3];
  half: Vec3;
  round: boolean;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** One placed copy's envelope primitives in the world, or [] when an
 *  expression does not resolve. */
export function posedEnvelope(graph: GraphDoc, nodeId: string, world: Mat4): Obb[] {
  try {
    return ((graph.nodes[nodeId]?.contract.payload as CadContractPayload | undefined)?.envelope?.volumes ?? []).map((v) => obb(graph, world, v));
  } catch {
    return [];
  }
}

function obb(graph: GraphDoc, world: Mat4, prim: Prim): Obb {
  const pose = resolvePose(graph, prim.pose);
  // A cylinder's x is arbitrary, and one written along its own axis (a hinge
  // knuckle, x = z = [1,0,0]) threw, which dropped the node's whole envelope
  // and left the travel sweep blind to the box the lid closed into.
  if (prim.kind === "cylinder" && Math.hypot(...cross(pose.zAxis, pose.xAxis)) < 1e-9 * Math.hypot(...pose.zAxis) * Math.hypot(...pose.xAxis)) {
    pose.xAxis = Math.abs(pose.zAxis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  }
  const m = mul(world, poseToMat(pose));
  const col = (i: number): Vec3 => [m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!];
  const half: Vec3 =
    prim.kind === "box"
      ? (prim.dims.map((d) => resolveDim(graph, d) / 2) as Vec3)
      : [resolveDim(graph, prim.d) / 2, resolveDim(graph, prim.d) / 2, resolveDim(graph, prim.h) / 2];
  return { c: col(3), axes: [col(0), col(1), col(2)], half, round: prim.kind === "cylinder" };
}

export function contains(b: Obb, p: Vec3, margin = 0): boolean {
  const d = sub(p, b.c);
  const local = b.axes.map((a) => dot(d, a));
  if (Math.abs(local[2]!) > b.half[2] + margin) return false;
  if (b.round) return Math.hypot(local[0]!, local[1]!) <= b.half[0] + margin;
  return Math.abs(local[0]!) <= b.half[0] + margin && Math.abs(local[1]!) <= b.half[1] + margin;
}

/** Overlap depth by separating axes: the smallest overlap over the 15
 *  candidate axes, negative when the boxes are apart. */
function penetration(a: Obb, b: Obb): number {
  const axes: Vec3[] = [...a.axes, ...b.axes];
  for (const u of a.axes) {
    for (const v of b.axes) {
      const c = cross(u, v);
      const n = Math.hypot(...c);
      if (n > 1e-6) axes.push([c[0] / n, c[1] / n, c[2] / n]);
    }
  }
  const d = sub(b.c, a.c);
  let depth = Infinity;
  for (const l of axes) {
    const r = (o: Obb) => o.axes.reduce((s, ax, i) => s + o.half[i]! * Math.abs(dot(ax, l)), 0);
    depth = Math.min(depth, r(a) + r(b) - Math.abs(dot(d, l)));
  }
  return depth;
}

function corners(o: Obb): Vec3[] {
  const out: Vec3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const k = [sx * o.half[0], sy * o.half[1], sz * o.half[2]];
        out.push([0, 1, 2].map((i) => o.c[i]! + o.axes[0][i]! * k[0]! + o.axes[1][i]! * k[1]! + o.axes[2][i]! * k[2]!) as Vec3);
      }
  return out;
}

const volume = (o: Obb) => (o.round ? Math.PI : 4) * o.half[0] * o.half[1] * 2 * o.half[2];

/** Volume of the smaller primitive that is also inside the larger and kept
 *  by `keep`, by a grid over the smaller one. */
function sharedVolume(a: Obb, b: Obb, keep: (p: Vec3) => boolean, n = 12): number {
  const [small, big] = volume(a) <= volume(b) ? [a, b] : [b, a];
  const at = (i: number) => ((i + 0.5) / n) * 2 - 1;
  let hits = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++) {
        const u = [at(i) * small.half[0], at(j) * small.half[1], at(k) * small.half[2]];
        const p = [0, 1, 2].map((r) => small.c[r]! + small.axes[0][r]! * u[0]! + small.axes[1][r]! * u[1]! + small.axes[2][r]! * u[2]!) as Vec3;
        if (contains(small, p) && contains(big, p) && keep(p)) hits++;
      }
  return (hits / n ** 3) * small.half[0] * small.half[1] * small.half[2] * 8;
}

const within = (inner: Obb, outer: Obb) => corners(inner).every((p) => contains({ ...outer, round: false }, p, PLAN_OVERLAP_TOL_MM));

/** A cylinder's box overstates it by up to r·(√2 − 1) at the corners — 33mm
 *  on a 160mm rotor disc — so a pair involving one is only reported when a
 *  grid over the smaller primitive finds a point at least the tolerance deep
 *  inside both actual shapes. */
function deepPointShared(a: Obb, b: Obb): boolean {
  const size = (o: Obb) => o.half[0] * o.half[1] * o.half[2];
  const [small, big] = size(a) <= size(b) ? [a, b] : [b, a];
  const n = 16;
  const at = (i: number) => ((i + 0.5) / n) * 2 - 1;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++) {
        const u = [at(i) * small.half[0], at(j) * small.half[1], at(k) * small.half[2]];
        const p = [0, 1, 2].map((r) => small.c[r]! + small.axes[0][r]! * u[0]! + small.axes[1][r]! * u[1]! + small.axes[2][r]! * u[2]!) as Vec3;
        if (contains(small, p, -PLAN_OVERLAP_TOL_MM) && contains(big, p, -PLAN_OVERLAP_TOL_MM)) return true;
      }
  return false;
}

/** Sweep step for revolute travel, degrees. */
const TRAVEL_STEP_DEG = 5;

/**
 * How far a revolute joint's moving parts can turn from rest, each way, before
 * their envelopes run into a part that holds still: the largest contiguous
 * range around 0, in TRAVEL_STEP_DEG steps, [-180, 180] when nothing stops it.
 * What two parts already share at rest is the baseline, so only NEW shared
 * volume blocks. Inside the widest envelope cylinder on the axis is the
 * knuckle zone, where real parts interleave and relieve each other while
 * their envelopes all claim the axis; it is left out, with no tolerance on
 * top, because two leaves meet first just outside it. Hardware is left out,
 * as in the overlap lint.
 */
export function reachableTravel(graph: GraphDoc, def: JointAxisDef): [number, number] {
  const { world, instances } = solvePlan(graph);
  // Every axis, so a node placed on several (one wheel node, four axles)
  // turns here only in the copy this axis claims: the other three copies
  // swung about the first axle into the rail (real-linear-actuator).
  const others = (graph.joints ?? []).length ? jointAxes(graph).filter((a) => a.id !== def.id) : [];
  const axis = kinematicJoints([{ ...def, limits: [-180, 180] }, ...others], world, instances).find((a) => a.id === def.id);
  if (!axis) return [-180, 180];
  const o = axis.origin as Vec3;
  const d = axis.direction as Vec3;
  const part = (id: string) => !FASTENING_HARDWARE.has(graph.nodes[id]?.kind ?? "") && !isJointHardware(graph, id) && !REGISTRY_HARDWARE.has(graph.nodes[id]?.kind ?? "");
  const moving = new Set(def.moving.map((k) => k.split("#")[0]!));
  const prims = (ids: string[]) => ids.filter(part).flatMap((id) => (instances[id] ?? []).flatMap((w) => posedEnvelope(graph, id, w)));
  const copy = (key: string) => instances[key.split("#")[0]!]?.[Number(key.split("#")[1] ?? 0)];
  const turning = axis.moving.filter((k) => part(k.split("#")[0]!) && copy(k)).flatMap((k) => posedEnvelope(graph, k.split("#")[0]!, copy(k)!));
  const still = prims(Object.keys(graph.nodes).filter((id) => !moving.has(id)));
  if (turning.length === 0 || still.length === 0) return [-180, 180];
  const offAxis = (c: Vec3) => sub(c, o).map((v, i) => v - dot(sub(c, o), d) * d[i]!) as Vec3;
  const onAxis = (c: Obb) => c.round && Math.abs(Math.abs(dot(c.axes[2], d)) - 1) < 1e-3 && Math.hypot(...offAxis(c.c)) < PLAN_OVERLAP_TOL_MM;
  // A round part spinning about its own axis sweeps exactly its own shape (a
  // V-wheel on its rail, a spool roller): every pose is the rest pose, whose
  // contact the overlap lints judge with their tolerance.
  if (turning.every(onAxis)) return [-180, 180];
  const coaxial = [...turning, ...still].filter(onAxis);
  const r = Math.max(0, ...coaxial.map((c) => c.half[0]));
  const outside = (p: Vec3) => Math.hypot(...offAxis(p)) > r;
  const turn = (v: Vec3, deg: number): Vec3 => {
    const a = (deg * Math.PI) / 180;
    const k = cross(d, v);
    return [0, 1, 2].map((i) => v[i]! * Math.cos(a) + k[i]! * Math.sin(a) + d[i]! * dot(d, v) * (1 - Math.cos(a))) as Vec3;
  };
  const shared = (deg: number) => {
    let total = 0;
    for (const m of turning) {
      const t: Obb = { ...m, c: [0, 1, 2].map((i) => o[i]! + turn(sub(m.c, o), deg)[i]!) as Vec3, axes: m.axes.map((x) => turn(x, deg)) as Obb["axes"] };
      for (const s of still) if (penetration(t, s) > 0) total += sharedVolume(t, s, outside, 24);
    }
    return total;
  };
  const rest = shared(0);
  const slack = Math.max(1, 0.002 * turning.reduce((v, x) => v + volume(x), 0));
  const reach = (sign: 1 | -1) => {
    for (let deg = TRAVEL_STEP_DEG; deg <= 180; deg += TRAVEL_STEP_DEG) {
      // One step short of the last clear sample: envelopes are sampled, and
      // G5 sweeps the real parts to the stop.
      if (shared(sign * deg) > rest + slack) return sign * Math.max(0, deg - 2 * TRAVEL_STEP_DEG);
    }
    return sign * 180;
  };
  return [reach(-1), reach(1)];
}

/** The travel a brief states, degrees: "opens from 0 to 110 degrees" or
 *  "swinging at least 120°". Undefined when it states none, or several
 *  different ones (which joint each means is not ours to guess). */
export function statedTravel(goal: string): number | undefined {
  const deg = String.raw`\s*(?:°|deg(?:rees?)?\b)`;
  const spans = new Set<number>();
  for (const m of goal.matchAll(new RegExp(String.raw`(-?\d+(?:\.\d+)?)(?:${deg})?\s*(?:to|-|–|\.\.)\s*(-?\d+(?:\.\d+)?)${deg}`, "gi"))) spans.add(Number(m[2]) - Number(m[1]));
  for (const m of goal.matchAll(new RegExp(String.raw`at least\s+(\d+(?:\.\d+)?)${deg}`, "gi"))) spans.add(Number(m[1]));
  return spans.size === 1 ? [...spans][0] : undefined;
}

/** Solve the plan the same way the cook will (CadBackend.solveScene). */
export function solvePlan(graph: GraphDoc) {
  const nodes = Object.values(graph.nodes).map((n) => {
    const ports: Record<string, ReturnType<typeof resolvePose>> = {};
    for (const p of (n.contract.payload as CadContractPayload | undefined)?.ports ?? []) {
      try {
        ports[p.name] = resolvePose(graph, p.pose);
      } catch {
        // unresolvable pose expression — the solver reports the missing port
      }
    }
    return { id: n.id, ports };
  });
  return solveAssembly(nodes, graphMates(graph), graph.assembly.entryNodeId);
}

/** One envelope primitive, posed in the world: a unit box or unit cylinder
 *  (axis z, centred) scaled by `size` then placed by the column-major
 *  `matrix`, as three.js reads it. */
export interface PreviewPrimitive {
  kind: "box" | "cylinder";
  size: [number, number, number];
  matrix: number[];
}

/** The plan's envelopes, posed by its mates: what approval previews, with
 *  no model and no kernel. A node whose expressions do not resolve is left
 *  out rather than drawn wrong; the lint above names it. */
export function planPreview(graph: GraphDoc) {
  const { instances, problems } = solvePlan(graph);
  const nodes = Object.values(graph.nodes).map((n) => {
    const payload = n.contract.payload as CadContractPayload | undefined;
    const primitives: PreviewPrimitive[] = [];
    try {
      for (const w of instances[n.id] ?? []) {
        for (const v of payload?.envelope?.volumes ?? []) {
          const size: [number, number, number] =
            v.kind === "box"
              ? (v.dims.map((d) => resolveDim(graph, d)) as [number, number, number])
              : [resolveDim(graph, v.d), resolveDim(graph, v.d), resolveDim(graph, v.h)];
          primitives.push({ kind: v.kind, size, matrix: mul(w, poseToMat(resolvePose(graph, v.pose))) });
        }
      }
    } catch {
      primitives.length = 0;
    }
    return { id: n.id, title: n.title, kind: n.kind, geometrySource: payload?.geometrySource ?? "parametric", primitives };
  });
  return { nodes, problems };
}

/** What holds a pair together, as the port whose z is the mate's axis: each
 *  edge between them, and each joint declared between them. A joint may place
 *  b only through its minted hardware (a bearing pivot has no a-b edge), and
 *  judging those two as strangers flagged every hinge's interleaved knuckles. */
function matesOf(graph: GraphDoc, x: string, y: string): { from: string; fromPort: string }[] {
  const pair = (p: string, q: string) => (p === x && q === y) || (p === y && q === x);
  return [
    ...graph.edges.filter((e) => pair(e.from, e.to)),
    ...(graph.joints ?? []).filter((j) => pair(j.a.node, j.b.node)).map((j) => ({ from: j.a.node, fromPort: j.a.port })),
  ];
}

/**
 * Two mated parts sharing envelope away from the mate. Around each mate's axis
 * (the port's z through its origin) sharing is the design, out to the widest
 * envelope cylinder on that axis, or the port's own size, plus the tolerance.
 * A part inside a much larger envelope is a hollow host's content, as above.
 */
function matedOverlap(
  graph: GraphDoc,
  instances: Record<string, Mat4[]>,
  a: { key: string; id: string; boxes: Obb[] },
  b: { key: string; id: string; boxes: Obb[] },
): string | null {
  const axes: { o: Vec3; z: Vec3; r: number }[] = [];
  for (const e of matesOf(graph, a.id, b.id)) {
    const port = (graph.nodes[e.from]?.contract.payload as CadContractPayload | undefined)?.ports.find((p) => p.name === e.fromPort);
    if (!port) continue;
    let pose: ReturnType<typeof resolvePose>;
    try {
      pose = resolvePose(graph, port.pose);
    } catch {
      continue;
    }
    const size = ["diameter", "od", "ring_diameter"].map((k) => Number(port.params[k])).find((v) => Number.isFinite(v)) ?? 0;
    for (const w of instances[e.from] ?? []) {
      const m = mul(w, poseToMat(pose));
      const o: Vec3 = [m[12]!, m[13]!, m[14]!];
      const z: Vec3 = [m[8]!, m[9]!, m[10]!];
      const coaxial = [...a.boxes, ...b.boxes].filter(
        (c) => c.round && Math.abs(Math.abs(dot(c.axes[2], z)) - 1) < 1e-3 && Math.hypot(...cross(sub(c.c, o), z)) < PLAN_OVERLAP_TOL_MM,
      );
      axes.push({ o, z, r: Math.max(size / 2, ...coaxial.map((c) => c.half[0])) + PLAN_OVERLAP_TOL_MM });
    }
  }
  if (axes.length === 0) return null;
  const awayFromMates = (p: Vec3) => axes.every(({ o, z, r }) => Math.hypot(...cross(sub(p, o), z)) > r);
  let shared = 0;
  for (const pa of a.boxes) {
    for (const pb of b.boxes) {
      const [small, big] = volume(pa) <= volume(pb) ? [pa, pb] : [pb, pa];
      if (within(small, big) && volume(small) < volume(big) / 2) continue;
      if (penetration(pa, pb) > PLAN_OVERLAP_TOL_MM) shared += sharedVolume(pa, pb, awayFromMates);
    }
  }
  const smaller = Math.min(...[a, b].map((x) => x.boxes.reduce((s, o) => s + volume(o), 0)));
  if (smaller <= 0 || shared <= MATED_OVERLAP_FRACTION * smaller) return null;
  return `${a.key} and ${b.key} are mated, but once placed about ${shared.toFixed(0)}mm³ of their envelopes (${Math.round((100 * shared) / smaller)}% of the smaller) coincide away from the mate's axis: the mate lays one part on top of the other. For a revolute joint (a hinge), the two parts face away from each other at travel 0: flip the mated port's xAxis (or zAxis) on one of them so they sit on opposite sides of the axis. Otherwise fix that port's pose or the envelope.`;
}

/** Recipes that put b on a shaft or pin past a.port, never inside a. */
const OFF_A_RECIPES = new Set(["bearings", "bushings", "pin", "hub_bearings", "flanged_bearing"]);

/**
 * A revolute joint's two parts claiming one stretch of its axis. The
 * near-axis zone is exempt from the mated-overlap check (envelopes all claim
 * it), but b rides its shaft past a.port, a collar's width out, so b's
 * envelope deep inside a's ON the axis is b running into a's far wall: the
 * winch drum "filling the gap" between the plates, 8mm out past the collar.
 */
function axisClaims(graph: GraphDoc, instances: Record<string, Mat4[]>): string[] {
  const problems: string[] = [];
  const recipes = new Map(jointDecisions(graph).flatMap(({ joint, decision }) => ("error" in decision ? [] : [[joint.id, decision.recipe] as const])));
  for (const def of jointAxes(graph)) {
    const j = graph.joints?.find((x) => x.id === def.id);
    if (def.type !== "revolute" || !j || !OFF_A_RECIPES.has(recipes.get(j.id) ?? "")) continue;
    const [axis] = kinematicJoints([def], instances[def.node]?.[0] ? { [def.node]: instances[def.node]![0]! } : {}, {});
    const [A, B] = [j.a.node, j.b.node].map((id) => posedEnvelope(graph, id, instances[id]?.[0] ?? IDENTITY));
    if (!axis || !A?.length || !B?.length) continue;
    const o = axis.origin as Vec3;
    const d = axis.direction as Vec3;
    // Only b's round parts on the axis (a hub, a drum, a knuckle): a box lid
    // whose envelope runs along the hinge line claims the axis by its corner,
    // and so does the box (real-magnet-hinged-box: "150mm" of the hinge).
    const hubs = B.filter((b) => b.round && Math.abs(Math.abs(dot(b.axes[2], d)) - 1) < 1e-3 && Math.hypot(...cross(sub(b.c, o), d)) < PLAN_OVERLAP_TOL_MM);
    if (!hubs.length) continue;
    const ts = hubs.flatMap((b) => corners(b).map((p) => dot(sub(p, o), d)));
    const deep = (prims: Obb[], p: Vec3) => prims.some((x) => contains(x, p, -PLAN_OVERLAP_TOL_MM));
    let run = 0;
    let worst = { run: 0, at: o };
    for (let t = Math.min(...ts); t <= Math.max(...ts); t += 0.25) {
      const p = [0, 1, 2].map((i) => o[i]! + t * d[i]!) as Vec3;
      run = deep(A, p) && deep(hubs, p) ? run + 0.25 : 0;
      if (run > worst.run) worst = { run, at: p };
    }
    if (worst.run > PLAN_OVERLAP_TOL_MM) {
      problems.push(
        `${j.b.node} and ${j.a.node} both claim ${(worst.run + 2 * PLAN_OVERLAP_TOL_MM).toFixed(1)}mm of joint ${j.id}'s axis, ending near [${worst.at.map((v) => v.toFixed(1)).join(", ")}]: ${j.b.node} rides the joint's ${recipes.get(j.id) === "pin" ? "pin" : "shaft"} past ${j.a.node}.${j.a.port} (its retaining collar or clip sits between them), so it runs into ${j.a.node} further along the axis. Shorten ${j.b.node} along the axis by that much, or give ${j.a.node} room there.`,
      );
    }
  }
  return problems;
}

const CHANNEL_PORTS = new Set(["SLOT", "GROOVE"]);
const BORE_PORTS = new Set(["CLEARANCE_HOLE", "BORE", "SCREW_SEAT"]);

/** A SLOT/GROOVE posed on its floor: material just in front of the origin,
 *  open space params.depth further along +z, either outside the envelope or
 *  inside one of the node's own bores (a keyway opens into its bore). The
 *  keyway of t3-004 was posed on its floor 8mm from the axis, z-out toward
 *  the bore, and the generator cut on past it to meet the probe. Null when
 *  the port declares no depth or the origin is a mouth. */
function slotMouth(
  graph: GraphDoc,
  payload: CadContractPayload,
  port: CadContractPayload["ports"][number],
  o: Vec3,
  z: Vec3,
  inside: (p: Vec3) => boolean,
): { depth: number; open: string } | null {
  let depth: number;
  try {
    depth = resolveDim(graph, (port.params as Record<string, unknown>).depth as string | number);
  } catch {
    return null;
  }
  if (!(depth > 0)) return null;
  const bores: { name: string; o: Vec3; z: Vec3; r: number }[] = [];
  for (const b of payload.ports) {
    if (!BORE_PORTS.has(b.type)) continue;
    try {
      const pose = resolvePose(graph, b.pose);
      const len = Math.hypot(...pose.zAxis);
      bores.push({ name: b.name, o: pose.origin, z: pose.zAxis.map((c) => c / len) as Vec3, r: resolveDim(graph, (b.params as Record<string, unknown>).diameter as string | number) / 2 });
    } catch {
      // unresolvable or undeclared diameter: other lints say so
    }
  }
  // Open: outside the envelope, or in a bore (behind its mouth, which faces +z).
  const open = (p: Vec3): string | null => {
    if (!inside(p)) return "outside the envelope";
    for (const b of bores) {
      const d = sub(p, b.o);
      const w = dot(d, b.z);
      const radial = Math.hypot(d[0] - w * b.z[0], d[1] - w * b.z[1], d[2] - w * b.z[2]);
      if (w <= PORT_STEP_MM && radial < b.r) return `inside bore "${b.name}"`;
    }
    return null;
  };
  const len = Math.hypot(...z);
  const at = (s: number): Vec3 => [0, 1, 2].map((i) => o[i]! + (s * z[i]!) / len) as Vec3;
  if (open(at(PORT_STEP_MM)) !== null) return null;
  const far = open(at(depth + PORT_STEP_MM));
  return far === null ? null : { depth, open: far };
}

export const cadPlanGeometryLint = {
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    const payloadOf = (id: string) => graph.nodes[id]!.contract.payload as CadContractPayload | undefined;

    // Inward ports, in the node's own frame: no assembly needed.
    for (const n of Object.values(graph.nodes)) {
      if (REGISTRY_HARDWARE.has(n.kind)) continue; // fixed geometry, seat poses linted elsewhere
      const payload = payloadOf(n.id);
      let prims: Obb[];
      try {
        prims = (payload?.envelope?.volumes ?? []).map((v) => obb(graph, IDENTITY, v));
      } catch {
        continue; // unresolvable expression — not this lint's business
      }
      if (prims.length === 0) continue;
      const inside = (p: Vec3) => prims.some((b) => contains(b, p));
      for (const port of payload?.ports ?? []) {
        if (!isFacePort(port.type)) continue;
        let o: Vec3, z: Vec3;
        try {
          ({ origin: o, zAxis: z } = resolvePose(graph, port.pose));
        } catch {
          continue;
        }
        const len = Math.hypot(...z);
        if (len < 1e-9) continue;
        const step = (s: number): Vec3 => [0, 1, 2].map((i) => o[i]! + (s * PORT_STEP_MM * z[i]!) / len) as Vec3;
        if (inside(step(1)) && !inside(step(-1))) {
          problems.push(
            `${n.id}: port "${port.name}" (${port.type}) points INTO its own envelope — ${PORT_STEP_MM}mm along its +z [${z.join(", ")}] is inside the envelope and ${PORT_STEP_MM}mm behind it is outside. +z must point OUT of the mating face, away from the material: flip the zAxis, or the part mates on the wrong side of its partner.`,
          );
        }
        const floor = CHANNEL_PORTS.has(port.type) ? slotMouth(graph, payload!, port, o, z, inside) : null;
        if (floor) {
          problems.push(
            `${n.id}: ${port.type} port "${port.name}" sits on its channel's FLOOR, not its mouth — just in front of the origin along +z [${z.join(", ")}] is material, and ${floor.depth}mm further is open (${floor.open}). A ${port.type} origin is on the face the channel opens through, +z out of it, with params.depth running from there INTO the material along -z: move the origin ${floor.depth}mm along +z, onto the mouth. A keyway's mouth is the bore wall.`,
          );
        }
      }
    }

    const { instances, problems: solver } = solvePlan(graph);
    problems.push(...solver.map((p) => `plan assembly: ${p}`));

    // Posed envelopes of every placed copy. Fastening hardware is left out: a
    // screw passes through holes in parts it is not mated to by design, and so
    // does a joint's shaft. Their envelopes are only where-abouts; G5 clashes
    // the real solids.
    const posed: { key: string; id: string; boxes: Obb[] }[] = [];
    for (const n of Object.values(graph.nodes)) {
      if (FASTENING_HARDWARE.has(n.kind) || isJointHardware(graph, n.id)) continue;
      const volumes = payloadOf(n.id)?.envelope?.volumes ?? [];
      (instances[n.id] ?? []).forEach((w, i) => {
        try {
          posed.push({ key: i === 0 ? n.id : `${n.id}#${i}`, id: n.id, boxes: volumes.map((v) => obb(graph, w, v)) });
        } catch {
          // unresolvable expression — not this lint's business
        }
      });
    }
    const mated = new Set(
      [...graph.edges.map((e) => [e.from, e.to]), ...(graph.joints ?? []).map((j) => [j.a.node, j.b.node])].flatMap(([p, q]) => [`${p}|${q}`, `${q}|${p}`]),
    );
    for (let i = 0; i < posed.length; i++) {
      for (let j = i + 1; j < posed.length; j++) {
        const a = posed[i]!;
        const b = posed[j]!;
        if (mated.has(`${a.id}|${b.id}`)) {
          const problem = matedOverlap(graph, instances, a, b);
          if (problem) problems.push(problem);
          continue;
        }
        let worst = 0;
        for (const pa of a.boxes) {
          for (const pb of b.boxes) {
            if (within(pa, pb) || within(pb, pa)) continue;
            const depth = penetration(pa, pb);
            if (depth > PLAN_OVERLAP_TOL_MM && (pa.round || pb.round) && !deepPointShared(pa, pb)) continue;
            worst = Math.max(worst, depth);
          }
        }
        if (worst > PLAN_OVERLAP_TOL_MM) {
          problems.push(
            `${a.key} and ${b.key} are not mated to each other, but once the plan's mates place them their envelopes overlap by up to ${worst.toFixed(1)}mm (${b.key}'s envelope is centred at [${b.boxes[0]!.c.map((v) => v.toFixed(1)).join(", ")}]). One part would be built inside the other: fix the port pose on a mate that places one of them, or the envelope.`,
          );
        }
      }
    }
    problems.push(...axisClaims(graph, instances));
    // Revolute travel the parts' envelopes cannot make: a rotor that cannot
    // spin a full turn, or stated limits past the stops.
    for (const def of jointAxes(graph)) {
      const j = graph.joints?.find((x) => x.id === def.id) as { motion?: string; duty?: string; limits?: [number, number]; limitsSource?: string; travel?: number } | undefined;
      if (def.type !== "revolute" || !j) continue;
      const [lo, hi] = reachableTravel(graph, def);
      const full = lo <= -180 && hi >= 180;
      const span = j.travel ?? statedTravel(graph.brief?.goal ?? "");
      const [jl, jh] = j.limits ?? [lo, hi];
      if (span !== undefined && j.duty !== "continuous" && jh - jl < span - 1e-9) {
        const stated = j.limits && j.limitsSource !== "derived";
        problems.push(`joint ${def.id}: ${j.travel ? `travel is ${span}°` : `the brief states ${span}° of travel`}, but its limits [${jl}, ${jh}]° cover ${jh - jl}°${stated ? "" : ` (from rest the parts reach [${lo}, ${hi}]° before they meet)`}. ${stated ? `Limits are degrees about a.port's +z (${def.node}'s joint port), right-handed, 0 being the pose the mates place. Write travel: ${span} instead and expansion picks the direction, or w` : "Model b at the closed (rest) pose and w"}rite travel: ${span}, and give ${def.moving[0]} room to turn that far.`);
      }
      if (j.duty === "continuous" && !full) {
        problems.push(`joint ${def.id} is continuous, so ${def.moving.join(", ")} must turn a full circle, but its envelope meets a part that holds still past ${lo}°..${hi}° of travel. Give it room to spin (move or shrink what it sweeps into), or make the joint occasional with limits.`);
      } else if (j.limits && j.limitsSource !== "derived" && (j.limits[0] < lo || j.limits[1] > hi)) {
        const mirror = [-j.limits[1], -j.limits[0]];
        const flip = mirror[0]! >= lo && mirror[1]! <= hi ? ` [${mirror.join(", ")}] is clear: travel is right-handed about the port's +z, so the sign may be flipped.` : "";
        problems.push(`joint ${def.id} states limits [${j.limits.join(", ")}]°, but the parts' envelopes only reach [${lo}, ${hi}]° before they meet. Limits are degrees about a.port's +z (${def.node}'s joint port), right-handed, 0 being the pose the mates place.${flip} Write travel: <degrees> instead (expansion picks the direction), state limits within that range, or leave both out and expansion derives them.`);
      }
    }
    return problems;
  },
};
