/**
 * Plan-time geometric lint: solve the PLAN's assembly from its declared ports
 * and pose each node's envelope, before a single part is generated. Three
 * defects are visible from the contracts alone, and each used to cost a full
 * cook to discover:
 *
 *  - two parts that are not mated to each other but whose envelopes
 *    interpenetrate once the mates have placed them;
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
import type { CadContractPayload } from "./index.js";
import { IDENTITY, mul, poseToMat, solveAssembly, type Mat4 } from "./assembly.js";
import { resolveDim, resolvePose } from "./bindings.js";
import { FASTENING_HARDWARE, REGISTRY_HARDWARE } from "./registry.js";
import { isJointHardware } from "./expand.js";

/** Envelopes carry slack around the part; touching neighbours may overlap by it. */
export const PLAN_OVERLAP_TOL_MM = 1.0;

/** How far either side of a port origin the inward test steps. */
const PORT_STEP_MM = 0.5;

/** Ports whose material lies behind the face, on -z. A SHAFT or a boss
 *  stands OUT along +z, so its own material is legitimately in front. */
const FACE_PORTS = new Set([
  "FLAT_FACE", "CLEARANCE_HOLE", "BORE", "SCREW_SEAT", "HOLE_PATTERN", "GROOVE", "SLOT",
  // Hardware host features are cut into the part from the port's face.
  "THREADED_HOLE", "INSERT_POCKET", "NUT_TRAP", "COUNTERBORE", "COUNTERSINK", "DOWEL_HOLE",
  "BEARING_SEAT", "BUSHING_BORE", "MOTOR_MOUNT", "MAGNET_POCKET", "HUB_BORE",
]);

type Vec3 = [number, number, number];
type Prim = CadContractPayload["envelope"]["volumes"][number];

/** A posed primitive: centre, unit axes, half-extents along them. A cylinder
 *  is its bounding box here, except where `round` says to test it radially. */
interface Obb {
  c: Vec3;
  axes: [Vec3, Vec3, Vec3];
  half: Vec3;
  round: boolean;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function obb(graph: GraphDoc, world: Mat4, prim: Prim): Obb {
  const m = mul(world, poseToMat(resolvePose(graph, prim.pose)));
  const col = (i: number): Vec3 => [m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!];
  const half: Vec3 =
    prim.kind === "box"
      ? (prim.dims.map((d) => resolveDim(graph, d) / 2) as Vec3)
      : [resolveDim(graph, prim.d) / 2, resolveDim(graph, prim.d) / 2, resolveDim(graph, prim.h) / 2];
  return { c: col(3), axes: [col(0), col(1), col(2)], half, round: prim.kind === "cylinder" };
}

function contains(b: Obb, p: Vec3, margin = 0): boolean {
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

/** Solve the plan the same way the cook will (CadBackend.solveScene). */
function solvePlan(graph: GraphDoc) {
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
  const mates = graph.edges.map((e) => ({ fromNode: e.from, fromPort: e.fromPort, toNode: e.to, toPort: e.toPort }));
  return solveAssembly(nodes, mates, graph.assembly.entryNodeId);
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
        if (!FACE_PORTS.has(port.type)) continue;
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
    const mated = new Set(graph.edges.flatMap((e) => [`${e.from}|${e.to}`, `${e.to}|${e.from}`]));
    for (let i = 0; i < posed.length; i++) {
      for (let j = i + 1; j < posed.length; j++) {
        const a = posed[i]!;
        const b = posed[j]!;
        if (mated.has(`${a.id}|${b.id}`)) continue;
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
    return problems;
  },
};
