import type { ArchitectOutput } from "@patchcad/engine";
import type { GraphDoc, JointDecl, NodeRecord, ParamValue } from "@patchcad/shared";
import type { CadContractPayload, Pose } from "./index.js";
import { CATALOG, dim, familyDims, skuFor } from "./catalog.js";
import {
  CadJoint, FDM_MIN_WALL_MM, gt2PitchD, honours, idlerScrews, statedName, jointEscapes, pulleyHeight, railHoles, railScrews, rimMid, selectJoint,
  type HardwarePick, type JointDecision, type JointInput, type Lin, type JointProcess,
} from "./joints.js";
import { gt2TipD } from "./registry.js";
import { resolveBinding, resolveDim, resolvePose, type NumericPose } from "./bindings.js";
import type { AssemblyMate, JointAxisDef, KinematicJoint, Mat4 } from "./assembly.js";
import { reachableTravel, solvePlan, statedTravel } from "./plan-geometry.js";
import { FDM_SLIP_FIT_MM, SEAT_POSE } from "./grounding.js";
import { isMachined, sourcingOf } from "./sourcing.js";
import { HARDWARE_PORT_TYPES } from "./index.js";

/**
 * Plan-time joint expansion (the engine's `planning.expandPlan`). Each
 * declared joint goes through selectJoint, and the decision becomes ordinary
 * graph: catalog hardware nodes with deterministic ids (`j1_screw`,
 * `j1_bearing_a`), host ports on the two parts at the joint's port pose, and
 * the edges that mate them. Host port params are T1 bindings to the hardware's
 * SKU, so the generator for each part sees exact catalog numbers in its own
 * contract and nothing else. Hermeticity holds because this runs before the
 * first cook and writes contracts only.
 *
 * Idempotent: everything a joint minted is stripped and re-minted, so the same
 * plan always expands to the same graph, and a re-expansion after an edit
 * replaces rather than accumulates.
 *
 * HARDWARE PORTS ARE MATE FRAMES. A part that sits ON a face (a screw head, a
 * washer, a collar) mates through SEAT_POSE. A part that sits IN a host
 * feature (an insert, a bearing, a nut in a trap) mates through INSET_POSE,
 * whose +z runs along its body, so the mate's flip sends the body into the
 * host. The registry builds these parts exactly, so their mate frames are not
 * probed (joint-owned hardware sends G3 no ports); cadJointRuleLint re-derives
 * every one of them instead.
 */

type OutNode = ArchitectOutput["nodes"][number];
type OutEdge = ArchitectOutput["edges"][number];
type D = number | string;
type Vec = [number, number, number];
type CadPortT = CadContractPayload["ports"][number];

export const INSET_POSE = { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] } as const;

/** Roles that turn with b; everything else a joint mints holds still with a,
 *  or turns with a drive's motor (jointAxes `coupled`). */
export const MOVING_ROLES = new Set(["hub_bearing_a", "hub_bearing_b", "shaft", "collar", "eclip", "linear_bearing", "carriage", "spacer", "driven_pulley", "driven_gear", "lead_nut"]);

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const strip = (d: string) => (d.startsWith("expr:") ? d.slice(5).trim() : d);

/** Sum of numbers and expressions, folded to a number when it can be. */
function sum(...terms: D[]): D {
  let k = 0;
  const parts: string[] = [];
  for (const t of terms) {
    if (typeof t === "number") k += t;
    else parts.push(`(${strip(t)})`);
  }
  k = round(k);
  if (parts.length === 0) return k;
  if (k === 0) return parts.join(" + ");
  return `${parts.join(" + ")} ${k < 0 ? "-" : "+"} ${Math.abs(k)}`;
}

function times(c: number, d: D): D {
  if (typeof d === "number") return round(c * d);
  if (Math.abs(c) < 1e-12) return 0;
  if (c === 1) return d;
  if (c === -1) return `-(${strip(d)})`;
  return `${round(c)} * (${strip(d)})`;
}

const linExpr = (l: Lin, wallA: D, wallB: D) => sum(times(l[0], wallA), times(l[1], wallB), l[2]);

interface Frame {
  o: [D, D, D];
  x: Vec;
  y: Vec;
  z: Vec;
}

function frameOf(pose: Pose): Frame {
  const num = (v: readonly D[]) => v.map((c) => (typeof c === "number" ? c : Number(c))) as Vec;
  const z = num(pose.zAxis);
  const x = num(pose.xAxis);
  if ([...z, ...x].some((c) => !Number.isFinite(c))) throw new Error("a joint port's axes must be numbers, not expressions");
  const nz = Math.hypot(...z);
  const zu = z.map((c) => c / nz) as Vec;
  const dot = x[0] * zu[0] + x[1] * zu[1] + x[2] * zu[2];
  const xo = x.map((c, i) => c - dot * zu[i]!) as Vec;
  const nx = Math.hypot(...xo);
  const xu = xo.map((c) => c / nx) as Vec;
  const y: Vec = [zu[1] * xu[2] - zu[2] * xu[1], zu[2] * xu[0] - zu[0] * xu[2], zu[0] * xu[1] - zu[1] * xu[0]];
  return { o: [...pose.origin] as [D, D, D], x: xu, y, z: zu };
}

/** A pose in a port's frame: (u, v) across its face, w along its +z. */
function at(f: Frame, u: number, v: number, w: D, flipZ = false): Pose {
  const origin = [0, 1, 2].map((i) => sum(f.o[i]!, round(u * f.x[i]! + v * f.y[i]!), times(f.z[i]!, w))) as [D, D, D];
  const z = f.z.map((c) => round(flipZ ? -c : c) || 0) as Vec;
  return { origin, zAxis: z, xAxis: f.x.map((c) => round(c) || 0) as Vec };
}

/** Pattern positions for `count` features at spacing `p`, centred. */
export function patternOffsets(count: number, p: number): [number, number][] {
  if (count === 1) return [[0, 0]];
  if (count === 2) return [[-p / 2, 0], [p / 2, 0]];
  if (count === 4) return [[-p / 2, -p / 2], [p / 2, -p / 2], [-p / 2, p / 2], [p / 2, p / 2]];
  const r = p / (2 * Math.sin(Math.PI / count));
  return Array.from({ length: count }, (_, k) => {
    const a = Math.PI / 2 + (2 * Math.PI * k) / count;
    return [round(r * Math.cos(a)), round(r * Math.sin(a))] as [number, number];
  });
}

const payloadOf = (n: { contract: { payload?: unknown } }) => n.contract.payload as CadContractPayload;
/** Joint id → the prefix of everything it mints on a part (ports, params). */
export const jointVar = (id: string) => id.replace(/[^a-z0-9]+/gi, "_");
export const hardwareId = (joint: string, role: string) => `${joint}_${role}`;

/** The joint that minted a node, if one did: ids with `_` never come out of
 *  the architect's slugger, so they are expansion's alone. */
export function jointOwner(graph: Pick<GraphDoc, "joints">, nodeId: string): string | undefined {
  return (graph.joints ?? []).find((j) => nodeId.startsWith(`${j.id}_`))?.id;
}

/** The graph's edges as solver mates. A joint's hardware into its b's
 *  HUB_BORE on a revolute joint carries that joint as `axis`, so a second
 *  joint on the same axis checks the line, not the pose (AssemblyMate.axis). */
export function graphMates(graph: Pick<GraphDoc, "nodes" | "edges" | "joints">): AssemblyMate[] {
  return graph.edges.map((e) => {
    const mate: AssemblyMate = { fromNode: e.from, fromPort: e.fromPort, toNode: e.to, toPort: e.toPort };
    const hub = graph.nodes[e.to] && payloadOf(graph.nodes[e.to]!).ports?.find((p) => p.name === e.toPort)?.type === "HUB_BORE";
    const owner = jointOwner(graph, e.from);
    // A rod's far end: the far block's turn about the rod is set by the other rod.
    if (owner && e.fromPort === "far") return { ...mate, clockFree: true };
    // A lead nut rides its screw: where it sits along it is the slide's
    // travel, so a b another slide already places (the guide rod's) only has
    // to put the nut on the screw's line, not at the recipe's rest height.
    const nutOwner = graph.nodes[e.to]?.kind === "lead_nut" ? jointOwner(graph, e.to) : undefined;
    if (nutOwner) return { ...mate, axis: nutOwner };
    if (!hub || !owner) return mate;
    const revolute = (graph.joints ?? []).filter((j) => j.motion === "revolute" && j.b.node === e.to);
    const axis = revolute.find((j) => (j as { minted?: string[] }).minted?.includes(e.toPort))?.id ?? revolute.find((j) => j.id === owner)?.id;
    return axis ? { ...mate, axis } : mate;
  });
}

function processOf(node: Pick<NodeRecord, "kind" | "contract">): { process: JointProcess; material?: string } {
  const s = sourcingOf(node);
  return { process: isMachined(s.process) ? "CNC" : "FDM", material: s.material };
}

type Live = Record<string, Record<string, ParamValue>>;

/** A minimal graph for T1 resolution over an emission: contracts, plus the
 *  live param values when expanding a graph someone has been editing. */
function asGraph(out: ArchitectOutput, live: Live = {}): GraphDoc {
  return {
    nodes: Object.fromEntries(out.nodes.map((n) => [n.id, { id: n.id, kind: n.kind, params: { ...live[n.id] }, contract: n.contract }])),
  } as unknown as GraphDoc;
}

/** selectJoint's input for a declared joint, walls resolved. */
export function jointInput(graph: GraphDoc, j: CadJoint, joints: readonly unknown[] = graph.joints ?? []): JointInput | { error: string } {
  const a = graph.nodes[j.a.node];
  const b = graph.nodes[j.b.node];
  if (!a || !b) return { error: `${j.id}: joins ${!a ? j.a.node : j.b.node}, which is not a node` };
  let wallA: number, wallB: number, lateral: number | undefined, wallMotor: number | undefined;
  try {
    wallA = resolveDim(graph, j.wallA);
    wallB = resolveDim(graph, j.wallB);
    lateral = j.lateral === undefined ? undefined : resolveDim(graph, j.lateral);
    wallMotor = j.wallMotor === undefined ? undefined : resolveDim(graph, j.wallMotor);
  } catch (err) {
    return { error: `${j.id}: ${(err as Error).message}` };
  }
  const pa = processOf(a);
  const pb = processOf(b);
  const boreA = coaxialBore(graph, a, j.a.port);
  // Ahead of a.port only a's own material counts, not a printed pin a joint minted there.
  const minted = new Set((joints as { minted?: string[] }[]).flatMap((o) => o.minted ?? []));
  const { depthA, roomA, aheadA } = materialAt(graph, a, j.a.port, minted);
  return {
    id: j.id, intent: j.intent, motion: j.motion, duty: j.duty, driven: j.driven, speedClass: j.speedClass,
    torqueClass: j.torqueClass, precise: j.precise, load: j.load, access: j.access, wallA, wallB, lateral,
    processA: pa.process, processB: pb.process, materialA: pa.material, materialB: pb.material,
    minWall: partMinWall(b), minWallA: partMinWall(a),
    flush: j.flush, count: j.count, threadHint: j.threadHint, shaftHint: j.shaftHint, strokeMm: j.strokeMm,
    ratio: j.ratio, centerMm: j.centerMm, wallMotor, allowPrinted: j.allowPrinted, prefer: j.prefer, boreA, depthA, roomA,
    pairedB: j.motion === "revolute" && (joints as CadJoint[]).some((o) => o.id !== j.id && o.motion === "revolute" && o.b.node === j.b.node && facingApart(graph, b, j.b.port, o.b.port)),
    trappedB: aheadA !== undefined && aheadA > wallB + 1, printInPlace: j.printInPlace,
    guided: j.motion === "prismatic" && guidedElsewhere(graph, j, joints as CadJoint[]),
  };
}

/** Whether a slide's moving body (b, and the parts fixed joints and part
 *  edges hold to it, never through a) already rides a guide of its own:
 *  another slide's carriage or rod, or rolling wheels on axles it carries
 *  (the linear actuator's V-wheels, on the gantry or a spacer under it). */
function guidedElsewhere(graph: GraphDoc, j: CadJoint, joints: CadJoint[]): boolean {
  const links = [
    ...joints.filter((o) => (o.motion ?? "fixed") === "fixed").map((o) => [o.a.node, o.b.node]),
    ...(graph.edges ?? []).filter((e) => graph.nodes[e.from]?.kind === "part" && graph.nodes[e.to]?.kind === "part").map((e) => [e.from, e.to]),
  ];
  const body = new Set([j.b.node]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, q] of links) for (const [x, y] of [[p, q], [q, p]]) if (body.has(x!) && !body.has(y!) && y !== j.a.node) grew = !!body.add(y!);
  }
  return joints.some((o) => o.id !== j.id && ((o.motion === "prismatic" && !o.driven && body.has(o.b.node)) ||
    (o.motion === "revolute" && o.duty === "continuous" && !o.driven && body.has(o.a.node))));
}

/** Whether two ports of one node lie on one line and face apart: the two
 *  ends of a cradle that turns between two supports. */
function facingApart(graph: GraphDoc, node: NodeRecord, p: string, q: string): boolean {
  const ports = payloadOf(node).ports ?? [];
  const [pp, pq] = [ports.find((x) => x.name === p), ports.find((x) => x.name === q)];
  if (!pp || !pq || p === q) return false;
  try {
    const [a, b] = [resolvePose(graph, pp.pose), resolvePose(graph, pq.pose)];
    const z = unit(a.zAxis);
    if (dot3(z, unit(b.zAxis)) > -0.9999) return false;
    const d = sub3(b.origin, a.origin);
    return Math.hypot(...sub3(d, z.map((c) => c * dot3(d, z)))) < 0.01;
  } catch {
    return false;
  }
}

/** The wall a joint must leave in a part: FDM's minimum, or more when the
 *  part's process or a min_wall assertion on it says so (the kernel measures
 *  that assertion on every wall, the joint's seats included). */
function partMinWall(node: NodeRecord): number {
  const payload = payloadOf(node);
  const asserted = (payload?.assertions ?? []).flatMap((x) => (x.kind === "min_wall" ? [x.mm] : []));
  return Math.max(FDM_MIN_WALL_MM, payload?.process?.minWall ?? FDM_MIN_WALL_MM, ...asserted);
}

/** What a's envelope holds around the axis of its `port`, in its own frame:
 *  how deep it runs behind the port along -z, and the largest Ø it holds
 *  around the axis there. The best of the envelope volumes that contain the
 *  port origin with an edge along the axis; undefined when none does. */
function materialAt(graph: GraphDoc, node: NodeRecord, port: string, minted = new Set<string>()): { depthA?: number; roomA?: number; aheadA?: number } {
  const payload = node.contract.payload as CadContractPayload | undefined;
  const at = payload?.ports?.find((p) => p.name === port);
  if (!at) return {};
  const dot = (u: number[], v: number[]) => u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
  const unit = (v: number[]) => v.map((c) => c / Math.hypot(...v));
  let depthA: number | undefined, roomA: number | undefined, aheadA: number | undefined;
  try {
    const { origin: o, zAxis } = resolvePose(graph, at.pose);
    const z = unit(zAxis);
    for (const v of payload?.envelope?.volumes ?? []) {
      const q = resolvePose(graph, v.pose);
      const zx = unit(q.zAxis), xx = unit(q.xAxis);
      const yx = [zx[1]! * xx[2]! - zx[2]! * xx[1]!, zx[2]! * xx[0]! - zx[0]! * xx[2]!, zx[0]! * xx[1]! - zx[1]! * xx[0]!];
      const axes = [xx, yx, zx];
      const d = [0, 1, 2].map((k) => o[k]! - q.origin[k]!);
      const local = axes.map((ax) => dot(d, ax));
      const along = axes.map((ax) => dot(z, ax));
      const k = along.findIndex((c) => Math.abs(Math.abs(c) - 1) < 1e-3);
      if (k < 0) continue;
      const half = v.kind === "box" ? v.dims.map((x) => resolveDim(graph, x) / 2) : [resolveDim(graph, v.d) / 2, resolveDim(graph, v.d) / 2, resolveDim(graph, v.h) / 2];
      if (v.kind === "cylinder" && k !== 2) continue;
      const others = [0, 1, 2].filter((i) => i !== k);
      const room = v.kind === "cylinder" ? 2 * (half[0]! - Math.hypot(local[0]!, local[1]!)) : 2 * Math.min(...others.map((i) => half[i]! - Math.abs(local[i]!)));
      if (room <= 0 || Math.abs(local[k]!) > half[k]! + JOINT_FACE_TOL_MM) continue;
      const depth = half[k]! + Math.sign(along[k]!) * local[k]!;
      depthA = Math.max(depthA ?? 0, depth);
      roomA = Math.max(roomA ?? 0, room);
      if (!minted.has(`envelope:${JSON.stringify(v)}`)) aheadA = Math.max(aheadA ?? 0, 2 * half[k]! - depth);
    }
  } catch {
    // an unresolvable pose or size: nothing known about the material
  }
  return { depthA, roomA, aheadA };
}

/** How far a joint face may sit off its envelope's surface. */
const JOINT_FACE_TOL_MM = 0.5;

/** Ø of a BORE or CLEARANCE_HOLE `node` declares on the axis of its `port`
 *  (the port's z through its origin), in the node's own frame. */
function coaxialBore(graph: GraphDoc, node: NodeRecord, port: string): number | undefined {
  const ports = (node.contract.payload as CadContractPayload | undefined)?.ports ?? [];
  const at = ports.find((p) => p.name === port);
  if (!at) return undefined;
  try {
    const unit = (v: number[]) => v.map((c) => c / Math.hypot(...v));
    const dot = (u: number[], v: number[]) => u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
    const { origin: o, zAxis } = resolvePose(graph, at.pose);
    const z = unit(zAxis);
    for (const p of ports) {
      if (p.type !== "BORE" && p.type !== "CLEARANCE_HOLE") continue;
      const q = resolvePose(graph, p.pose);
      const dz = [0, 1, 2].map((k) => q.origin[k]! - o[k]!);
      const along = dot(dz, z);
      const parallel = Math.abs(Math.abs(dot(unit(q.zAxis), z)) - 1) < 1e-3;
      if (parallel && Math.hypot(...dz.map((v, k) => v - along * z[k]!)) < 0.5) return resolveDim(graph, p.params.diameter as number | string);
    }
  } catch {
    // an unresolvable pose or size: no bore to reuse
  }
  return undefined;
}

/** What a decision fixes, lengths aside: when this changes, the joint is
 *  re-expanded; when only a length moves, T1 already followed it. */
export function decisionKey(d: JointDecision): string {
  return [d.rule, ...d.parts.map((p) => `${p.role}=${p.family}:${p.key}`), ...(d.dims.slipA ? ["slipA"] : [])].join("|");
}

// ---------- Minting ----------

class Expansion {
  readonly graph: GraphDoc;
  constructor(readonly out: ArchitectOutput, live?: Live) {
    this.graph = asGraph(out, live);
  }

  node(id: string): OutNode {
    const n = this.out.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  }

  port(node: OutNode, name: string): CadPortT {
    const p = payloadOf(node).ports.find((x) => x.name === name);
    if (!p) throw new Error(`${node.id} has no port "${name}"`);
    return p;
  }

  /** Port and param names the current joint has added to its parts, kept on
   *  the joint (`minted`) so the next expansion strips exactly those. */
  minted: string[] = [];

  addPort(node: OutNode, side: "provides" | "requires", port: CadPortT, declType: string = port.type, description = "") {
    this.minted.push(port.name);
    // Several joints may seat the same port of an instanced part: one feature.
    if (payloadOf(node).ports.some((p) => p.name === port.name)) return;
    this.putPort(node, side, port, declType, description);
  }

  /** A minted hardware node's own port: stripped with the node, not by name. */
  putPort(node: OutNode, side: "provides" | "requires", port: CadPortT, declType: string = port.type, description = "") {
    payloadOf(node).ports.push(port);
    node.contract[side].push({ key: port.name, type: declType, description });
  }

  /** A host param, bound by T1 to the hardware it hosts. Its default is
   *  resolved here, so the first cook already sees the catalog number. */
  bindings: { node: OutNode; name: string; binding: string }[] = [];
  /** An envelope volume for a feature the joint grows on a part (a pin, a
   *  boss), minted as `envelope:<json>` so unmint can find it again. */
  addVolume(node: OutNode, volume: CadContractPayload["envelope"]["volumes"][number]) {
    this.minted.push(`envelope:${JSON.stringify(volume)}`);
    payloadOf(node).envelope.volumes.push(volume);
  }

  addParam(node: OutNode, name: string, description: string, binding: string) {
    this.minted.push(name);
    if (node.contract.params.some((p) => p.name === name)) return;
    node.contract.params.push({ type: "number", name, description, default: 0 });
    payloadOf(node).paramBindings = { ...(payloadOf(node).paramBindings ?? {}), [name]: binding };
    this.bindings.push({ node, name, binding });
  }

  addEdge(from: string, fromPort: string, to: string, toPort: string) {
    if (!this.out.edges.some((e) => e.from === from && e.fromPort === fromPort && e.to === to && e.toPort === toPort)) {
      this.out.edges.push({ from, fromPort, to, toPort });
    }
  }

  /** A catalog part: sku param (+ length where it is cut or stocked to one),
   *  its mate ports, and an envelope that only says roughly where it is. */
  mint(joint: string, pick: HardwarePick, summary: string, ports: { side: "provides" | "requires"; port: CadPortT; decl: string }[], length?: D) {
    const family = CATALOG.families[pick.family]!;
    const sku = skuFor(pick.family, pick.key)!;
    const id = hardwareId(joint, pick.role);
    // A length given as an expression still sizes the envelope: a shaft
    // whose length was a string got a 2mm-tall stub (two-link-arm).
    const lengthDefault = typeof length === "number" ? length : typeof length === "string" && !length.startsWith("screwLengthIn:") ? resolvedOr(this.graph, length, pick.length) : pick.length;
    const params: OutNode["contract"]["params"] = [
      { type: "string", name: "sku", description: "catalog part", default: sku.id },
      ...(length !== undefined || lengthDefault !== undefined
        ? [{ type: "number" as const, name: "length", description: "length, mm", default: lengthDefault ?? 0 }]
        : []),
    ];
    const node: OutNode = {
      id,
      kind: family.kind,
      title: `${joint} ${pick.role.replace(/_/g, " ")}`,
      spec: `${summary}. Catalog ${family.standard ?? "part"} ${pick.key}, built by the registry, never generated.`,
      contract: {
        name: id,
        summary: `${sku.id}${lengthDefault !== undefined ? ` × ${lengthDefault}` : ""}`,
        params,
        provides: [],
        requires: [],
        payload: {
          units: "mm",
          process: { kind: "FDM", minWall: FDM_MIN_WALL_MM, nozzle: 0.4 },
          ports: [],
          envelope: { volumes: [hardwareEnvelope(pick, lengthDefault)], clearance: 0.4 },
          paramBindings: {},
        } satisfies CadContractPayload,
      },
    };
    this.out.nodes.push(node);
    this.graph.nodes[id] = { id, params: {}, contract: node.contract } as unknown as NodeRecord;
    for (const p of ports) this.putPort(node, p.side, p.port, p.decl);
    if (typeof length === "string") {
      payloadOf(node).paramBindings = { length: length.startsWith("screwLengthIn:") ? length : `expr: ${strip(length)}` };
      this.bindings.push({ node, name: "length", binding: payloadOf(node).paramBindings.length! });
    }
    return node;
  }

  /** Resolve every binding against the expanded plan and write the defaults.
   *  Repeated because one binding can read another's result. */
  settle(): string[] {
    const problems: string[] = [];
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      problems.length = 0;
      for (const { node, name, binding } of this.bindings) {
        const r = resolveBinding(this.graph, binding);
        if ("error" in r) {
          problems.push(`${node.id}.${name}: ${r.error}`);
          continue;
        }
        const p = node.contract.params.find((x) => x.name === name)!;
        if (p.default !== r.value) {
          (p as { default: unknown }).default = r.value;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return problems;
  }
}

function hardwareEnvelope(pick: HardwarePick, length?: number) {
  const row = familyDims(pick.family, pick.key) ?? {};
  const nums = (keys: string[]) => keys.map((k) => row[k]).filter((v): v is number => typeof v === "number");
  const d = Math.max(4, ...nums(["od", "headD", "d", "af", "face", "bellD", "baseD", "flangeD", "width", "tabL", "bodyL"]));
  const h = Math.max(1, length ?? 0, ...nums(["width", "height", "length", "thickness", "bodyH", "bellH", "headH"]));
  return { kind: "cylinder" as const, pose: pose([0, 0, 0]), d: round(d * 1.2), h: round(h * 2) };
}

const pose = (origin: D[], z: Vec = [0, 0, 1]): Pose => ({ origin: origin as [D, D, D], zAxis: z, xAxis: [1, 0, 0] });

// ---------- Strip ----------

/** The names a joint's last expansion put on its parts: its `minted` list,
 *  or for a joint expanded before that list existed, its prefix. A joint never
 *  expanded owns nothing, so an architect's `bracket_face` survives a joint
 *  called `bracket`. */
export function mintedNames(joint: JointDecl): (name: string) => boolean {
  const j = joint as JointDecl & { minted?: string[]; expanded?: string };
  if (j.minted) {
    const names = new Set(j.minted);
    return (name) => names.has(name);
  }
  const v = jointVar(j.id);
  return j.expanded ? (name) => name.startsWith(`${v}_`) : () => false;
}

/** Remove everything a joint minted, so expansion can run again. Hardware
 *  ids carry `_`, which the architect's slugger never emits. */
function unmint(out: ArchitectOutput, joint: JointDecl) {
  const minted = (id: string) => id.startsWith(`${joint.id}_`);
  out.nodes = out.nodes.filter((n) => !minted(n.id));
  const mine = mintedNames(joint);
  for (const n of out.nodes) {
    if (n.id !== joint.a.node && n.id !== joint.b.node) continue;
    const p = payloadOf(n);
    p.ports = p.ports.filter((x) => !mine(x.name));
    n.contract.provides = n.contract.provides.filter((x) => !mine(x.key));
    n.contract.requires = n.contract.requires.filter((x) => !mine(x.key));
    n.contract.params = n.contract.params.filter((x) => !mine(x.name));
    p.paramBindings = Object.fromEntries(Object.entries(p.paramBindings ?? {}).filter(([k]) => !mine(k)));
    p.envelope.volumes = p.envelope.volumes.filter((v) => !mine(`envelope:${JSON.stringify(v)}`));
  }
  out.edges = out.edges.filter((e) => !minted(e.from) && !minted(e.to) && !mine(e.fromPort) && !mine(e.toPort));
}

// ---------- Recipes ----------

interface Ctx {
  x: Expansion;
  j: CadJoint;
  i: JointInput;
  v: string;
  /** Prefix of what a spindle mints on b: the first joint's to seat this port
   *  of b, so an instanced b (one wheel, four joints) has one hub. */
  vb: string;
  d: JointDecision;
  A: OutNode;
  B: OutNode;
  fa: Frame;
  fb: Frame;
  /** The coaxial joint on a's far side whose b rides this joint's axle. */
  far?: { j: CadJoint; fa: Frame; span: D };
  /** This joint's b rides that joint's axle (axleEnd). */
  shares?: string;
}

/** An expression's value against the expansion graph, else `fallback`. */
function resolvedOr(graph: GraphDoc, expr: string, fallback: number | undefined): number | undefined {
  try {
    return round(resolveDim(graph, expr));
  } catch {
    return fallback;
  }
}

/** The face mate between a and b, for joints where b holds still on a. */
function faceMate(c: Ctx) {
  const { x, j, A, B } = c;
  const has = (n: OutNode, side: "provides" | "requires", key: string) => n.contract[side].some((p) => p.key === key);
  if (x.out.edges.some((e) => (e.from === A.id && e.fromPort === j.a.port && e.to === B.id && e.toPort === j.b.port) ||
      (e.from === B.id && e.fromPort === j.b.port && e.to === A.id && e.toPort === j.a.port))) return;
  if (!has(A, "provides", j.a.port) && has(B, "provides", j.b.port)) {
    if (!has(A, "requires", j.a.port)) A.contract.requires.push({ key: j.a.port, type: x.port(B, j.b.port).type, description: `joint ${j.id}` });
    x.addEdge(B.id, j.b.port, A.id, j.a.port);
    return;
  }
  if (!has(A, "provides", j.a.port)) A.contract.provides.push({ key: j.a.port, type: x.port(A, j.a.port).type, description: `joint ${j.id}` });
  if (!has(B, "requires", j.b.port)) B.contract.requires.push({ key: j.b.port, type: x.port(A, j.a.port).type, description: `joint ${j.id}` });
  x.addEdge(A.id, j.a.port, B.id, j.b.port);
}

/** Motion joints place b through the hardware, so a direct a↔b mate would
 *  over-constrain it: drop it, and the requires it fed. */
function unmate(c: Ctx) {
  const { x, j, A, B } = c;
  const direct = (e: OutEdge) =>
    (e.from === A.id && e.fromPort === j.a.port && e.to === B.id && e.toPort === j.b.port) ||
    (e.from === B.id && e.fromPort === j.b.port && e.to === A.id && e.toPort === j.a.port);
  x.out.edges = x.out.edges.filter((e) => !direct(e));
  for (const [n, port] of [[A, j.a.port], [B, j.b.port]] as const) {
    if (!x.out.edges.some((e) => e.to === n.id && e.toPort === port)) {
      n.contract.requires = n.contract.requires.filter((p) => p.key !== port);
    }
  }
}

/** The joint's face ports keep their place as frames, but a feature now sits
 *  on or around their centre, so their probe samples one ring outside it. The
 *  ring reads the same bound param the feature does, so a bigger bearing moves
 *  it by T1 and leaves the contract alone. */
function ringFace(c: Ctx, node: OutNode, port: string, diameter: D) {
  const p = c.x.port(node, port);
  if (p.type === "FLAT_FACE") p.params = { ...p.params, ring_diameter: typeof diameter === "number" ? round(diameter) : diameter };
}

/** The ring for a pattern of features of Ø `feature`, `rho` from the face's
 *  centre: outside them all where the face holds that, else inside them,
 *  clamped to the face. Outside only, two Ø4 dowels 48 apart asked a 40mm
 *  face for a Ø52 ring, which no part can pass. */
function patternRing(c: Ctx, node: OutNode, port: string, feature: D, rho: number) {
  const outer = sum(feature, 2 * rho + 1.2);
  c.x.settle(); // the feature's bound Ø, not its placeholder 0
  const room = faceRoom(c.x.graph, node.id, port);
  const f = resolveDim(c.x.graph, feature);
  const inner = 2 * rho - f - 1.2;
  if (rho === 0 || room === undefined || 2 * rho + f + 1.2 <= room - RING_EDGE_MM / 2 || inner < 2) return ringFace(c, node, port, outer);
  ringFace(c, node, port, `min(${strip(String(sum(times(-1, feature), 2 * rho - 1.2)))}, ${round(room - RING_EDGE_MM)})`);
}

/** How far inside the face's edge an inner pattern ring stays, Ø, clear of a
 *  small edge chamfer; an outer ring may come half as close. */
const RING_EDGE_MM = 2.4;

/** The largest Ø centred on a port that the node's envelope holds across
 *  it, or undefined when no volume says. */
function faceRoom(graph: GraphDoc, nodeId: string, port: string): number | undefined {
  const node = graph.nodes[nodeId];
  return node ? materialAt(graph, node, port).roomA : undefined;
}

const n = (pick: HardwarePick, field: string) => dim(familyDims(pick.family, pick.key)!, field);
const part = (d: JointDecision, role: string) => d.parts.find((p) => p.role === role);

function fastener(c: Ctx) {
  const { x, j, v, d, A, B, fa, fb } = c;
  const screw = part(d, "screw")!;
  const thread = d.thread!;
  const spec = CATALOG.threads[thread]!;
  const count = j.count ?? 1;
  const pitch = j.pitch ?? Math.max(4 * Number(thread.slice(1)), 10);
  const at_ = patternOffsets(count, pitch);
  const rho = Math.max(...at_.map(([u, w]) => Math.hypot(u, w)));
  const sid = hardwareId(j.id, "screw");
  const under = d.dims.under ?? 0;
  const standoff: Record<string, number> = under > 0 ? { standoff: under } : {};

  // a: the head end, on a's far face.
  x.addParam(A, `${v}_clear`, `${thread} clearance hole for ${j.id}`, `hw:clearance:param:${sid}.sku`);
  let headType: CadPortT["type"] = "CLEARANCE_HOLE";
  let headParams: CadPortT["params"] = { diameter: `param(${A.id}.${v}_clear)` };
  let headPose: Pose = { ...SEAT_POSE, origin: [0, 0, -under] } as Pose;
  if (d.head === "csk") {
    x.addParam(A, `${v}_csk_d`, `countersink Ø for ${j.id}`, `hw:cskD:param:${sid}.sku`);
    headType = "COUNTERSINK";
    headParams = { diameter: `param(${A.id}.${v}_csk_d)`, angle: 90, through_diameter: `param(${A.id}.${v}_clear)` };
    headPose = SEAT_POSE as unknown as Pose;
  } else if ((d.dims.recess ?? 0) > 0) {
    x.addParam(A, `${v}_cbore_d`, `counterbore Ø for ${j.id}`, `hw:cboreD:param:${sid}.sku`);
    x.addParam(A, `${v}_cbore_depth`, `counterbore depth for ${j.id}`, `hw:cboreDepth:param:${sid}.sku`);
    headType = "COUNTERBORE";
    headParams = { diameter: `param(${A.id}.${v}_cbore_d)`, depth: `param(${A.id}.${v}_cbore_depth)`, through_diameter: `param(${A.id}.${v}_clear)` };
    // The head bears on the counterbore floor, d.dims.recess under the face.
    headPose = { origin: [0, 0, d.dims.recess!], zAxis: [0, 0, -1], xAxis: [1, 0, 0] };
  }
  const length = `screwLengthIn: ${screw.family}, ${thread}, min=${strip(String(linExpr(d.window!.min, j.wallA, j.wallB)))}, max=${strip(String(linExpr(d.window!.max, j.wallA, j.wallB)))}`;
  x.mint(j.id, screw, d.summary, [{ side: "requires", port: { name: "head", type: "FLAT_FACE", pose: headPose, params: { ring_diameter: spec.clearance + 1, ...standoff } }, decl: headType }], length);
  at_.forEach(([u, w], k) => {
    const name = `${v}_head${count > 1 ? `_${k + 1}` : ""}`;
    x.addPort(A, "provides", { name, type: headType, pose: at(fa, u, w, times(-1, j.wallA), true), params: headParams }, headType, `${screw.family} ${thread} head for ${j.id}`);
    x.addEdge(A.id, name, sid, "head");
  });

  // b: what the screw threads into.
  const bAt = (k: number, w: D, flip = false) => at(fb, at_[k]![0], -at_[k]![1], w, flip);
  const name = (base: string, k: number) => `${v}_${base}${count > 1 ? `_${k + 1}` : ""}`;
  const depthBinding = `expr: param(${sid}.length) - (${strip(String(j.wallA))}) - (${d.dims.offset}) + 0.5`;
  let faceFeature: D = `param(${B.id}.${v}_clear)`;
  if (d.recipe === "tapped") {
    x.addParam(B, `${v}_tap_depth`, `tapped depth for ${j.id}`, depthBinding);
    at_.forEach((_, k) =>
      x.addPort(B, "provides", { name: name("tap", k), type: "THREADED_HOLE", pose: bAt(k, 0), params: { thread, depth: `param(${B.id}.${v}_tap_depth)` } }),
    );
    faceFeature = spec.tapDrill;
  } else if (d.recipe === "insert") {
    const ins = part(d, "insert")!;
    const iid = hardwareId(j.id, "insert");
    x.addParam(B, `${v}_insert_d`, `heat-set insert hole Ø for ${j.id}`, `hw:insertHoleD:param:${iid}.sku`);
    x.addParam(B, `${v}_pocket`, `insert pocket depth (the screw's reach) for ${j.id}`, depthBinding);
    x.mint(j.id, ins, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: INSET_POSE as unknown as Pose, params: { ring_diameter: n(ins, "holeD") } }, decl: "INSERT_POCKET" }]);
    at_.forEach((_, k) => {
      x.addPort(B, "provides", { name: name("pocket", k), type: "INSERT_POCKET", pose: bAt(k, 0), params: { diameter: `param(${B.id}.${v}_insert_d)`, depth: `param(${B.id}.${v}_pocket)` } });
      x.addEdge(B.id, name("pocket", k), iid, "seat");
    });
    faceFeature = `param(${B.id}.${v}_insert_d)`;
  } else if (d.recipe === "nut_trap" || d.recipe === "side_nut_trap") {
    const nut = part(d, "nut")!;
    const nid = hardwareId(j.id, "nut");
    const side = d.recipe === "side_nut_trap";
    x.addParam(B, `${v}_clear`, `${thread} clearance hole for ${j.id}`, `hw:clearance:param:${sid}.sku`);
    x.addParam(B, `${v}_nut_af`, `nut across-flats for ${j.id}`, `hw:nutTrapAf:param:${nid}.sku`);
    x.addParam(B, `${v}_nut_h`, `nut height for ${j.id}`, `hw:nutTrapDepth:param:${nid}.sku`);
    x.mint(j.id, nut, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: INSET_POSE as unknown as Pose, params: { ring_diameter: spec.clearance + 1 } }, decl: "NUT_TRAP" }]);
    at_.forEach((_, k) => {
      x.addPort(B, "provides", {
        name: name("bolt", k), type: side ? "BORE" : "CLEARANCE_HOLE", pose: bAt(k, 0), params: { diameter: `param(${B.id}.${v}_clear)` },
      });
      // Axial: the trap opens on b's far face. Side: it sits mid-wall, its
      // top `embed` under the face, and opens toward +x.
      const trapPose = side ? bAt(k, times(-1, d.dims.embed!)) : bAt(k, times(-1, j.wallB), true);
      x.addPort(B, "provides", {
        name: name("trap", k), type: "NUT_TRAP", pose: trapPose,
        params: { af: `param(${B.id}.${v}_nut_af)`, depth: `param(${B.id}.${v}_nut_h)`, entry: side ? "side" : "axial" },
      });
      x.addEdge(B.id, name("trap", k), nid, "seat");
    });
  } else if (d.recipe === "through_bolt") {
    const t = d.dims.washer!;
    x.addParam(B, `${v}_clear`, `${thread} clearance hole for ${j.id}`, `hw:clearance:param:${sid}.sku`);
    const ring = { ring_diameter: spec.clearance + 1 };
    const nid = hardwareId(j.id, "nut");
    x.mint(j.id, part(d, "nut")!, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: { ...SEAT_POSE, origin: [0, 0, -t] } as Pose, params: { ...ring, standoff: t } }, decl: "CLEARANCE_HOLE" }]);
    x.mint(j.id, part(d, "washer_b")!, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: ring }, decl: "CLEARANCE_HOLE" }]);
    const wa = part(d, "washer_a");
    if (wa) x.mint(j.id, wa, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: ring }, decl: headType }]);
    at_.forEach((_, k) => {
      x.addPort(B, "provides", { name: name("back", k), type: "CLEARANCE_HOLE", pose: bAt(k, times(-1, j.wallB), true), params: { diameter: `param(${B.id}.${v}_clear)` } });
      x.addEdge(B.id, name("back", k), nid, "seat");
      x.addEdge(B.id, name("back", k), hardwareId(j.id, "washer_b"), "seat");
      if (wa) x.addEdge(A.id, `${v}_head${count > 1 ? `_${k + 1}` : ""}`, hardwareId(j.id, "washer_a"), "seat");
    });
  }
  faceMate(c);
  patternRing(c, A, j.a.port, `param(${A.id}.${v}_clear)`, rho);
  patternRing(c, B, j.b.port, faceFeature, rho);
}

function dowels(c: Ctx) {
  const { x, j, v, d, A, B, fa, fb } = c;
  const count = j.count ?? 1;
  const at_ = patternOffsets(count, j.pitch ?? Math.max(5 * d.dims.d!, 10));
  const rho = Math.max(...at_.map(([u, w]) => Math.hypot(u, w)));
  const name = (side: string, k: number) => `${v}_${side}${count > 1 ? `_${k + 1}` : ""}`;
  if (d.recipe === "dowel") {
    const pin = part(d, "dowel")!;
    const id = hardwareId(j.id, "dowel");
    x.addParam(A, `${v}_dowel_d`, `dowel Ø for ${j.id}`, `hw:dowelHole:param:${id}.sku`);
    x.addParam(B, `${v}_dowel_d`, `dowel Ø for ${j.id}`, `hw:dowelHole:param:${id}.sku`);
    // Centred on the joint plane, half in each part, unless R1 set `press`
    // deep into a (a thin b takes less).
    const shift = d.dims.press === undefined ? 0 : round(d.dims.length! / 2 - d.dims.press);
    x.mint(j.id, pin, d.summary, [{ side: "requires", port: { name: "center", type: "FLAT_FACE", pose: pose([0, 0, shift]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "DOWEL_HOLE" }]);
    at_.forEach(([u, w], k) => {
      x.addPort(A, "provides", { name: name("dowel_a", k), type: "DOWEL_HOLE", pose: at(fa, u, w, 0), params: { diameter: `param(${A.id}.${v}_dowel_d)`, depth: d.dims.depthA ?? d.dims.depth!, fit: "press" } });
      x.addPort(B, "provides", { name: name("dowel_b", k), type: "DOWEL_HOLE", pose: at(fb, u, -w, 0), params: { diameter: `param(${B.id}.${v}_dowel_d)`, depth: d.dims.depthB ?? d.dims.depth!, fit: "slip" } });
      x.addEdge(A.id, name("dowel_a", k), id, "center");
    });
  } else {
    at_.forEach(([u, w], k) => {
      x.addPort(A, "provides", { name: name("peg", k), type: "SHAFT", pose: at(fa, u, w, 0), params: { diameter: d.dims.peg!, length: d.dims.length! } });
      // depth: how far the peg goes in, so a deterministic cut stops there.
      x.addPort(B, "provides", { name: name("socket", k), type: "BORE", pose: at(fb, u, -w, 0), params: { diameter: d.dims.d!, depth: round(d.dims.length! + 0.5) } });
    });
  }
  faceMate(c);
  const dowelD = (n: OutNode) => (d.recipe === "dowel" ? `param(${n.id}.${v}_dowel_d)` : d.dims.d!);
  patternRing(c, A, j.a.port, dowelD(A), rho);
  patternRing(c, B, j.b.port, dowelD(B), rho);
}

/** A stud half in each part: a dowel screw in a pilot BORE each side, or a
 *  threaded rod in a THREADED_HOLE each side. The dowel screw is centred on
 *  its origin, the rod starts at it, so the rod's centre mark sits L/2 up. */
function stud(c: Ctx) {
  const { x, j, v, d, A, B, fa, fb } = c;
  const p = part(d, "stud")!;
  const rod = p.family === "threaded_rod";
  const count = j.count ?? 1;
  const at_ = patternOffsets(count, j.pitch ?? Math.max(5 * d.dims.d!, 10));
  const rho = Math.max(...at_.map(([u, w]) => Math.hypot(u, w)));
  const id = hardwareId(j.id, "stud");
  x.mint(j.id, p, d.summary, [{
    side: "requires", port: { name: "center", type: "FLAT_FACE", pose: pose([0, 0, rod ? d.dims.length! / 2 : 0]), params: { ring_diameter: d.dims.d! / 2 } }, decl: rod ? "THREADED_HOLE" : "BORE",
  }]);
  const hole: { type: "THREADED_HOLE" | "BORE"; params: CadPortT["params"] } = rod
    ? { type: "THREADED_HOLE", params: { thread: d.thread!, depth: d.dims.depth! } }
    : { type: "BORE", params: { diameter: d.dims.pilot!, depth: d.dims.depth! } };
  const name = (side: string, k: number) => `${v}_stud_${side}${count > 1 ? `_${k + 1}` : ""}`;
  at_.forEach(([u, w], k) => {
    x.addPort(A, "provides", { name: name("a", k), type: hole.type, pose: at(fa, u, w, 0), params: hole.params });
    x.addPort(B, "provides", { name: name("b", k), type: hole.type, pose: at(fb, u, -w, 0), params: hole.params });
    x.addEdge(A.id, name("a", k), id, "center");
  });
  faceMate(c);
  patternRing(c, A, j.a.port, d.dims.pilot ?? d.dims.d!, rho);
  patternRing(c, B, j.b.port, d.dims.pilot ?? d.dims.d!, rho);
}

/** Two seats in a (one per face), a shaft through them fixed in b's hub, and
 *  the retention outside each seat. b is placed through the shaft. */
function spindle(c: Ctx) {
  const { x, j, v, d, A, B, fa, fb } = c;
  const bushing = d.recipe === "bushings";
  const [ra, rb] = bushing ? ["bushing_a", "bushing_b"] : ["bearing_a", "bearing_b"];
  const seatType = bushing ? "BUSHING_BORE" : "BEARING_SEAT";
  const shaft = part(d, "shaft")!;
  const keep = part(d, "collar") ?? part(d, "eclip")!;
  const kw = keep.family === "collar" ? n(keep, "width") : n(keep, "thickness");
  // A flanged bearing sits on its face like a screw head, its inner race fw proud.
  const fw = part(d, ra)!.family === "bearing_flanged" ? n(part(d, ra)!, "flangeW") : 0;
  const [ida, idb, sid, kid] = [hardwareId(j.id, ra), hardwareId(j.id, rb), hardwareId(j.id, shaft.role), hardwareId(j.id, keep.role)];
  unmate(c);

  x.addParam(A, `${v}_seat_od`, `${seatType === "BEARING_SEAT" ? "bearing" : "bushing"} OD for ${j.id}`, `hw:bearingSeatD:param:${ida}.sku`);
  x.addParam(A, `${v}_seat_w`, `seat depth for ${j.id}`, bushing ? `param:${ida}.length` : `hw:bearingWidth:param:${ida}.sku`);
  const seatParams: CadPortT["params"] = bushing
    ? { od: `param(${A.id}.${v}_seat_od)`, length: `param(${A.id}.${v}_seat_w)` }
    : { od: `param(${A.id}.${v}_seat_od)`, width: `param(${A.id}.${v}_seat_w)`, fit: "press" };
  x.addPort(A, "provides", { name: `${v}_seat_a`, type: seatType, pose: at(fa, 0, 0, 0), params: seatParams });
  // The second seat is in a's far face, or in the far joint's face when the
  // two share an axle (one seat each side of a body, not two in each wall).
  const far = c.far;
  // M1p: one bearing in this support, its partner in b's other support; the
  // outer collar sits on a's far face instead of a second bearing.
  const one = !part(d, rb);
  const outer = one ? `${v}_keep` : `${v}_seat_b`;
  if (one) x.addPort(A, "provides", { name: outer, type: "FLAT_FACE", pose: at(fa, 0, 0, times(-1, j.wallA), true), params: { ring_diameter: d.dims.d! + 2.4 } }, "FLAT_FACE", `the outer collar's face for ${j.id}`);
  else x.addPort(A, "provides", { name: outer, type: seatType, pose: far ? at(far.fa, 0, 0, 0) : at(fa, 0, 0, times(-1, j.wallA), true), params: seatParams });
  // The shaft through the web the seats leave in a: a slip bore the generator
  // cuts first time and G3 checks (two-link-arm's 2mm web clashed, 23mm³).
  const web = c.i.wallA - (one ? 1 : 2) * d.dims.width! - fw;
  if (!far && web > 0.2) {
    x.addPort(A, "provides", { name: `${v}_shaft_bore`, type: "BORE", pose: at(fa, 0, 0, times(-1, `param(${A.id}.${v}_seat_w)`)), params: { diameter: round(d.dims.d! + FDM_SLIP_FIT_MM), depth: round(web) } }, "BORE", `the shaft's way through the wall between the seats for ${j.id}`);
  }

  const seatPorts = (role: HardwarePick) => [
    { side: "requires" as const, port: { name: "seat", type: "FLAT_FACE" as const, pose: (fw ? SEAT_POSE : INSET_POSE) as unknown as Pose, params: { ring_diameter: n(role, "od") - 1 } }, decl: seatType },
    { side: "provides" as const, port: { name: "bore", type: "FLAT_FACE" as const, pose: fw ? pose([0, 0, fw]) : SEAT_POSE as unknown as Pose, params: { ring_diameter: d.dims.d! + 1 } }, decl: "FLAT_FACE" },
  ];
  x.mint(j.id, part(d, ra)!, d.summary, seatPorts(part(d, ra)!));
  x.addEdge(A.id, `${v}_seat_a`, ida, "seat");
  if (!one) {
    x.mint(j.id, part(d, rb)!, d.summary, seatPorts(part(d, rb)!));
    x.addEdge(A.id, `${v}_seat_b`, idb, "seat");
  }
  const [outerNode, outerPort] = one ? [A.id, outer] : [idb, "bore"];

  // A collar outside each seat: one node, two placements. A drive's driven
  // wheel takes the upper one's place, on a spacer washer.
  const drive = d.recipe === "belt_drive" || d.recipe === "gear_drive";
  x.mint(j.id, keep, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: d.dims.d! + 1 } }, decl: "FLAT_FACE" }]);
  if (!drive) x.addEdge(ida, "bore", kid, "seat");
  x.addEdge(outerNode, outerPort, kid, "seat");
  if (drive) {
    x.mint(j.id, part(d, "spacer")!, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: d.dims.d! + 1 } }, decl: "FLAT_FACE" }]);
    x.addEdge(ida, "bore", hardwareId(j.id, "spacer"), "seat");
  }

  // The shaft starts kw below a's far face (under the outer collar) and ends
  // flush with b's far face, through b's hub: on the upper collar, or above a
  // drive's driven wheel. A shared axle starts at the far b's outer face, and
  // carries that b on a second hub port facing back along it.
  const start = far ? sum(kw, far.j.wallB) : kw + fw;
  const hubAt = drive ? sum(kw + fw, j.wallA, d.dims.zB!) : far ? sum(start, far.span, kw) : sum(2 * (kw + fw), j.wallA);
  x.mint(j.id, shaft, d.summary, [
    { side: "requires", port: { name: "end", type: "FLAT_FACE", pose: pose([0, 0, start]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "FLAT_FACE" },
    { side: "provides", port: { name: "hub", type: "FLAT_FACE", pose: pose([0, 0, hubAt]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "HUB_BORE" },
    ...(drive
      ? [{ side: "provides" as const, port: { name: "drive", type: "FLAT_FACE" as const, pose: pose([0, 0, sum(kw + fw, j.wallA, d.dims.zDriven!)]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "HUB_BORE" }]
      : []),
    ...(far
      ? [{ side: "provides" as const, port: { name: "hub_b", type: "FLAT_FACE" as const, pose: pose([0, 0, far.j.wallB], [0, 0, -1]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "HUB_BORE" }]
      : []),
  ], sum(hubAt, j.wallB));
  x.addEdge(outerNode, outerPort, sid, "end");
  hubOn(c, shaft, sid, "hub");
  ringFace(c, A, j.a.port, sum(`param(${A.id}.${v}_seat_od)`, 2.4));
}

/** M1h: the spindle turned inside out. Two seats in b (its face and wallB
 *  behind it), an axle pressed into a's face and out through them, b 1mm off
 *  a's face, a collar on the axle past b's far face. b is placed by the axle. */
function hubBearings(c: Ctx) {
  const { x, j, v, vb, d, A, B, fa, fb } = c;
  const axle = part(d, "axle_shaft") ?? part(d, "axle_d_shaft")!;
  const keep = part(d, "axle_collar") ?? part(d, "axle_eclip")!;
  const kw = keep.family === "collar" ? n(keep, "width") : n(keep, "thickness");
  const [ida, idb, aid, kid] = [hardwareId(j.id, "hub_bearing_a"), hardwareId(j.id, "hub_bearing_b"), hardwareId(j.id, axle.role), hardwareId(j.id, keep.role)];
  unmate(c);
  x.addParam(B, `${vb}_seat_od`, `bearing OD for ${j.id}`, `hw:bearingSeatD:param:${ida}.sku`);
  x.addParam(B, `${vb}_seat_w`, `seat depth for ${j.id}`, `hw:bearingWidth:param:${ida}.sku`);
  const seat: CadPortT["params"] = { od: `param(${B.id}.${vb}_seat_od)`, width: `param(${B.id}.${vb}_seat_w)`, fit: "press" };
  x.addPort(B, "provides", { name: `${vb}_seat_a`, type: "BEARING_SEAT", pose: at(fb, 0, 0, 0), params: seat });
  x.addPort(B, "provides", { name: `${vb}_seat_b`, type: "BEARING_SEAT", pose: at(fb, 0, 0, times(-1, j.wallB), true), params: seat });
  for (const [id, role] of [[ida, "hub_bearing_a"], [idb, "hub_bearing_b"]] as const) {
    const p = part(d, role)!;
    x.mint(j.id, p, d.summary, [
      { side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: INSET_POSE as unknown as Pose, params: { ring_diameter: n(p, "od") - 1 } }, decl: "BEARING_SEAT" },
      { side: "provides", port: { name: "bore", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: d.dims.d! + 1 } }, decl: "FLAT_FACE" },
    ]);
  }
  x.addEdge(B.id, `${vb}_seat_a`, ida, "seat");
  x.addEdge(B.id, `${vb}_seat_b`, idb, "seat");
  x.mint(j.id, keep, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: d.dims.d! + 1 } }, decl: "FLAT_FACE" }]);
  x.addEdge(idb, "bore", kid, "seat");
  // The axle: socketed wallA deep in a, b's face 1mm past a's.
  x.addParam(A, `${v}_axle_d`, `axle Ø for ${j.id}`, `hw:shaftD:param:${aid}.sku`);
  x.addPort(A, "provides", { name: `${v}_axle`, type: "HUB_BORE", pose: at(fa, 0, 0, 0), params: { diameter: `param(${A.id}.${v}_axle_d)`, fit: "press", depth: j.wallA } });
  x.mint(j.id, axle, d.summary, [
    { side: "requires", port: { name: "end", type: "FLAT_FACE", pose: pose([0, 0, j.wallA], [0, 0, -1]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "HUB_BORE" },
    { side: "provides", port: { name: "hub", type: "FLAT_FACE", pose: pose([0, 0, sum(j.wallA, 1)]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "FLAT_FACE" },
  ], sum(j.wallA, 1, j.wallB, kw));
  x.addEdge(A.id, `${v}_axle`, aid, "end");
  // b is placed through its face port, which the plan may have declared provided.
  if (!B.contract.requires.some((p) => p.key === j.b.port)) B.contract.requires.push({ key: j.b.port, type: x.port(B, j.b.port).type, description: `joint ${j.id}` });
  x.addEdge(aid, "hub", B.id, j.b.port);
  ringFace(c, A, j.a.port, sum(`param(${A.id}.${v}_axle_d)`, 2.4));
  ringFace(c, B, j.b.port, sum(`param(${B.id}.${vb}_seat_od)`, 2.4));
}

/** M1f: one flanged bearing in a's face, its flange on the face; a washer on
 *  its inner race; a shaft from the bearing's foot (w − fw under a's face)
 *  through b's hub, b's face on the washer. b is placed by the shaft, and its
 *  coaxial joint on the far support holds it the other way. */
function flangedBearing(c: Ctx) {
  const { x, j, v, d, A, fa } = c;
  const [brg, shaft, spacer] = [part(d, "bearing")!, part(d, "shaft")!, part(d, "spacer")!];
  const [bid, sid, wid] = [hardwareId(j.id, "bearing"), hardwareId(j.id, shaft.role), hardwareId(j.id, "spacer")];
  const [w, fw, t] = [d.dims.width!, d.dims.flange!, d.dims.gap!];
  unmate(c);
  x.addParam(A, `${v}_seat_od`, `flanged bearing OD for ${j.id}`, `hw:bearingSeatD:param:${bid}.sku`);
  x.addParam(A, `${v}_seat_w`, `seat depth for ${j.id}`, `hw:bearingWidth:param:${bid}.sku`);
  x.addPort(A, "provides", { name: `${v}_seat_a`, type: "BEARING_SEAT", pose: at(fa, 0, 0, 0), params: { od: `param(${A.id}.${v}_seat_od)`, width: `param(${A.id}.${v}_seat_w)`, fit: "press" } });
  x.mint(j.id, brg, d.summary, [
    { side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: n(brg, "od") - 1 } }, decl: "BEARING_SEAT" },
    { side: "provides", port: { name: "bore", type: "FLAT_FACE", pose: pose([0, 0, fw]), params: { ring_diameter: d.dims.d! + 1 } }, decl: "FLAT_FACE" },
  ]);
  x.addEdge(A.id, `${v}_seat_a`, bid, "seat");
  x.mint(j.id, spacer, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: d.dims.d! + 1 } }, decl: "FLAT_FACE" }]);
  x.addEdge(bid, "bore", wid, "seat");
  x.mint(j.id, shaft, d.summary, [
    { side: "requires", port: { name: "end", type: "FLAT_FACE", pose: pose([0, 0, w], [0, 0, -1]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "FLAT_FACE" },
    { side: "provides", port: { name: "hub", type: "FLAT_FACE", pose: pose([0, 0, round(w + t)]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "HUB_BORE" },
  ], sum(round(w + t), j.wallB));
  x.addEdge(bid, "bore", sid, "end");
  hubOn(c, shaft, sid, "hub");
  ringFace(c, A, j.a.port, sum(`param(${A.id}.${v}_seat_od)`, 2.4));
}

/** b's hub on a joint's shaft, Ø (and D-flat) bound to the shaft's sku, at
 *  the joint's hubFit: a slip bore turned by the flat, or b pressed on. */
function hubOn(c: Ctx, shaft: HardwarePick, sid: string, from: string) {
  const { x, j, vb, B, fb } = c;
  x.addParam(B, `${vb}_shaft_d`, `shaft Ø for ${j.id}`, `hw:shaftD:param:${sid}.sku`);
  const hub: CadPortT["params"] = { diameter: `param(${B.id}.${vb}_shaft_d)` };
  if (shaft.family === "d_shaft") {
    x.addParam(B, `${vb}_flat`, `D-flat distance from the axis for ${j.id}`, `hw:hubFlat:param:${sid}.sku`);
    hub.flat = `param(${B.id}.${vb}_flat)`;
  }
  if (j.hubFit === "press") Object.assign(hub, { fit: "press", depth: j.wallB });
  x.addPort(B, "requires", { name: `${vb}_hub`, type: "HUB_BORE", pose: at(fb, 0, 0, 0), params: hub });
  x.addEdge(sid, from, B.id, `${vb}_hub`);
  ringFace(c, B, j.b.port, sum(`param(${B.id}.${vb}_shaft_d)`, 2.4));
}

/** The far joint of a shared axle: seats, shaft and collar are the near
 *  joint's (spindle), so this one only puts b on the shaft's far end. */
function axleEnd(c: Ctx) {
  const { j, d, A } = c;
  unmate(c);
  hubOn(c, part(d, "shaft")!, hardwareId(c.shares!, part(d, "shaft")!.role), "hub_b");
  ringFace(c, A, j.a.port, sum(`param(${A.id}.${jointVar(c.shares!)}_seat_od)`, 2.4));
}

/** A pin printed on a, through b, its e-clip in a CLIP_GROOVE just past b's
 *  far face: the clip's face on b, the groove a clip-width wide around it. */
function printedPin(c: Ctx) {
  const { x, j, v, d, A, B, fa, fb } = c;
  const gw = d.dims.grooveWidth!;
  x.addPort(A, "provides", { name: `${v}_pin`, type: "SHAFT", pose: at(fa, 0, 0, 0), params: { diameter: d.dims.d!, length: d.dims.length! } });
  // Print in place: captive in b's knuckle, no clip.
  if (part(d, "pin_clip")) {
    x.addPort(A, "provides", {
      name: `${v}_clip_groove`, type: "CLIP_GROOVE", pose: at(fa, 0, 0, sum(j.wallB, gw / 2)),
      params: { diameter: d.dims.groove!, width: gw, shaft_diameter: d.dims.d! },
    });
    x.mint(j.id, part(d, "pin_clip")!, d.summary, [{
      side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: pose([0, 0, round(gw / 2)], [0, 0, -1]), params: { ring_diameter: d.dims.groove! } }, decl: "CLIP_GROOVE",
    }]);
    x.addEdge(A.id, `${v}_clip_groove`, hardwareId(j.id, "pin_clip"), "seat");
  }
  x.addVolume(A, { kind: "cylinder", pose: at(fa, 0, 0, round(d.dims.length! / 2 - 0.5)), d: round(d.dims.d! + 1), h: round(d.dims.length! + 1) });
  x.addPort(B, "provides", { name: `${v}_pin_bore`, type: "BORE", pose: at(fb, 0, 0, 0), params: { diameter: d.dims.bore! } });
  faceMate(c);
  ringFace(c, A, j.a.port, d.dims.d! + 2.4);
  ringFace(c, B, j.b.port, d.dims.bore! + 2.4);
}

/** A catalog pin pressed `press` deep into a (or loose there, `slipA`) and
 *  turning `run` deep in b: both DOWEL_HOLEs at the pin's nominal Ø, the fit
 *  in each port's `fit`. A
 *  hole that would leave less than a minimum wall under it goes through. */
function pin(c: Ctx) {
  const { x, j, i, v, d, A, B, fa, fb } = c;
  const id = hardwareId(j.id, "pin");
  const deep = (got: number, wall: number, mw = FDM_MIN_WALL_MM) => (wall - got < mw ? wall : got);
  x.addParam(A, `${v}_pin_d`, `pin Ø for ${j.id}`, `hw:dowelHole:param:${id}.sku`);
  x.addParam(B, `${v}_pin_d`, `pin Ø for ${j.id}`, `hw:dowelHole:param:${id}.sku`);
  // The registry centres a dowel on its origin: L/2 − press out of a's face.
  x.mint(j.id, part(d, "pin")!, d.summary, [{
    side: "requires", port: { name: "center", type: "FLAT_FACE", pose: pose([0, 0, round(d.dims.length! / 2 - d.dims.press!)]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "DOWEL_HOLE",
  }]);
  // b between a's knuckles: the pin goes in through a once b is there.
  x.addPort(A, "provides", { name: `${v}_pin_a`, type: "DOWEL_HOLE", pose: at(fa, 0, 0, 0), params: { diameter: `param(${A.id}.${v}_pin_d)`, depth: i.trappedB ? i.wallA : deep(d.dims.press!, i.wallA, i.minWallA ?? i.minWall), fit: d.dims.slipA ? "slip" : "press" } });
  x.addPort(B, "provides", { name: `${v}_pin_b`, type: "DOWEL_HOLE", pose: at(fb, 0, 0, 0), params: { diameter: `param(${B.id}.${v}_pin_d)`, depth: deep(d.dims.run!, i.wallB, i.minWall), fit: "slip" } });
  x.addEdge(A.id, `${v}_pin_a`, id, "center");
  faceMate(c);
  ringFace(c, A, j.a.port, sum(`param(${A.id}.${v}_pin_d)`, 2.4));
  ringFace(c, B, j.b.port, sum(`param(${B.id}.${v}_pin_d)`, 2.4));
}

/** An LM-UU's pocket in b, pressed, standing on a lip. */
const lmSeat = (c: Ctx): CadPortT["params"] => ({ od: `param(${c.B.id}.${c.v}_lm_od)`, length: c.d.dims.length!, fit: "press", retention: "lip" });

function rodSlide(c: Ctx) {
  const { x, j, v, d, A, B, fa, fb } = c;
  const rod = part(d, "rod")!;
  const lm = part(d, "linear_bearing")!;
  const [rid, lid] = [hardwareId(j.id, "rod"), hardwareId(j.id, "linear_bearing")];
  unmate(c);
  const socket = sum(j.wallA, -FDM_MIN_WALL_MM);
  const F = j.far && j.far.node !== A.id ? x.node(j.far.node) : undefined;
  const farAt = sum(socket, 1, d.dims.stroke!, j.wallB);
  x.addParam(A, `${v}_rod_d`, `rod Ø for ${j.id}`, `hw:shaftD:param:${rid}.sku`);
  x.addPort(A, "provides", { name: `${v}_rod`, type: "BORE", pose: at(fa, 0, 0, 0), params: { diameter: `param(${A.id}.${v}_rod_d)`, depth: socket } });
  // Socketed in a, out along a's +z through b, long enough for the stroke.
  x.mint(j.id, rod, d.summary, [
    { side: "requires", port: { name: "end", type: "FLAT_FACE", pose: pose([0, 0, socket], [0, 0, -1]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "BORE" },
    { side: "provides", port: { name: "slide", type: "FLAT_FACE", pose: pose([0, 0, sum(socket, 1)]), params: { ring_diameter: d.dims.d! + 1 } }, decl: "FLAT_FACE" },
    // The far end block's face, the rod running on into a socket there.
    ...(F ? [{ side: "provides" as const, port: { name: "far", type: "FLAT_FACE" as const, pose: pose([0, 0, farAt]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "BORE" }] : []),
  ], F ? sum(farAt, socket) : farAt);
  x.addEdge(A.id, `${v}_rod`, rid, "end");
  if (F) {
    x.addParam(F, `${v}_rod_d`, `rod Ø for ${j.id}`, `hw:shaftD:param:${rid}.sku`);
    x.addPort(F, "requires", { name: `${v}_rod_far`, type: "BORE", pose: at(frameOf(x.port(F, j.far!.port).pose), 0, 0, 0), params: { diameter: `param(${F.id}.${v}_rod_d)`, depth: socket } });
    x.addEdge(rid, "far", F.id, `${v}_rod_far`);
    ringFace(c, F, j.far!.port, sum(`param(${F.id}.${v}_rod_d)`, 2.4));
  }
  x.addParam(B, `${v}_lm_od`, `linear bearing OD for ${j.id}`, `hw:bearingSeatD:param:${lid}.sku`);
  x.addPort(B, "provides", { name: `${v}_lm_seat`, type: "LINEAR_BEARING_SEAT", pose: at(fb, 0, 0, 0), params: lmSeat(c) });
  x.mint(j.id, lm, d.summary, [
    { side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: INSET_POSE as unknown as Pose, params: { ring_diameter: d.dims.od! - 1 } }, decl: "LINEAR_BEARING_SEAT" },
    { side: "requires", port: { name: "bore", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: d.dims.d! + 1 } }, decl: "FLAT_FACE" },
  ]);
  x.addEdge(B.id, `${v}_lm_seat`, lid, "seat");
  x.addEdge(rid, "slide", lid, "bore");
  ringFace(c, A, j.a.port, sum(`param(${A.id}.${v}_rod_d)`, 2.4));
  ringFace(c, B, j.b.port, sum(`param(${B.id}.${v}_lm_od)`, 2.4));
}

function rail(c: Ctx) {
  const { x, j, v, d, A, B, fb } = c;
  const r = part(d, "rail")!;
  const car = part(d, "carriage")!;
  const row = familyDims(car.family, car.key)!;
  unmate(c);
  const [rid, cid] = [hardwareId(j.id, "rail"), hardwareId(j.id, "carriage")];
  // The carriage is modelled in its rail's frame, so both mate on a's face.
  x.mint(j.id, r, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { size: dim(familyDims(r.family, r.key)!, "width") } }, decl: "FLAT_FACE" }]);
  x.mint(j.id, car, d.summary, [
    { side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { size: dim(row, "width") } }, decl: "FLAT_FACE" },
    { side: "provides", port: { name: "top", type: "FLAT_FACE", pose: pose([0, 0, dim(row, "height")]), params: { size: dim(row, "width") } }, decl: "FLAT_FACE" },
  ]);
  if (!B.contract.requires.some((p) => p.key === j.b.port)) B.contract.requires.push({ key: j.b.port, type: "FLAT_FACE", description: `joint ${j.id} carriage` });
  x.addEdge(cid, "top", B.id, j.b.port);
  const thread = String(row.mountThread);
  x.addParam(B, `${v}_clear`, `${thread} clearance for the carriage screws of ${j.id}`, `clearance:${thread}`);
  const [mx, my] = [dim(row, "mountX"), dim(row, "mountY")];
  x.addPort(B, "provides", {
    name: `${v}_carriage_holes`, type: "HOLE_PATTERN", pose: at(fb, 0, 0, 0),
    params: { diameter: `param(${B.id}.${v}_clear)`, nx: 2, ny: 2, pitch_x: mx, pitch_y: my },
  });
  ringFace(c, B, j.b.port, Math.hypot(mx, my) + CATALOG.threads[thread]!.clearance + 1.2);
  // The rail's own screws, one node at every hole, heads on the counterbore
  // floors, and the land they and the rail sit on: a RAIL_MOUNT on a's face.
  const rr = familyDims(r.family, r.key)!;
  const holes = railHoles(r.key, r.length!);
  const screws = hostScrews(c, "rail", railScrews(c.i, r.key) as JointDecision, holes.map((u) => [u, 0]), 0, dim(rr, "height") - dim(rr, "cboreDepth"), j.wallA);
  x.addPort(A, "provides", {
    name: `${v}_rail_mount`, type: "RAIL_MOUNT", pose: at(c.fa, 0, 0, 0),
    params: { width: dim(rr, "width"), length: r.length!, pitch: dim(rr, "pitch"), count: holes.length, hole_diameter: screws.hole, depth: screws.depth },
  }, "RAIL_MOUNT", `the ${r.key} rail's land`);
  x.addEdge(A.id, `${v}_rail_mount`, rid, "seat");
  x.addEdge(A.id, `${v}_rail_mount`, cid, "seat");
  // A ring of Ø10 passes between the holes whatever the pitch (≥ 20).
  ringFace(c, A, j.a.port, 10);
}

function directDrive(c: Ctx) {
  const { x, j, v, d, A, B, fa, fb } = c;
  const motor = part(d, "motor")!;
  const row = familyDims(motor.family, motor.key)!;
  const g = (k: string) => dim(row, k);
  const mid = hardwareId(j.id, "motor");
  unmate(c);
  let mountType: CadPortT["type"] = "MOTOR_MOUNT";
  let mountPose: Pose;
  let mountParams: CadPortT["params"];
  const motorMount = SEAT_POSE as unknown as Pose;
  let out: Pose;
  const clear = (t: string) => CATALOG.threads[t]!.clearance;
  const stepper = motor.family === "nema17" || motor.family === "nema14";
  if (stepper || motor.family === "n20") {
    // Under a, shaft up through it into b, 1mm clear of a's face.
    mountPose = at(fa, 0, 0, times(-1, j.wallA), true);
    mountParams =
      stepper
        ? { pilot_diameter: `param(${A.id}.${v}_pilot)`, hole_diameter: clear(String(row.holeThread)), pitch_x: g("holePitch"), pitch_y: g("holePitch") }
        : { pilot_diameter: round(g("shaftD") + 1), hole_diameter: round(g("holeD") + 0.2), pcd: g("pcd"), count: 2 };
    if (stepper) x.addParam(A, `${v}_pilot`, `motor pilot Ø for ${j.id}`, `hw:motorPilot:param:${mid}.sku`);
    out = pose([0, 0, times(-1, sum(j.wallA, 1))], [0, 0, -1]);
  } else if (motor.family === "brushless") {
    mountPose = at(fa, 0, 0, 0);
    x.addParam(A, `${v}_pcd`, `motor bolt circle for ${j.id}`, `hw:motorPcd:param:${mid}.sku`);
    mountParams = { pilot_diameter: round(g("shaftD") + 3), hole_diameter: clear(String(row.holeThread)), pcd: `param(${A.id}.${v}_pcd)`, count: g("holeCount"), start_angle: 45 };
    out = pose([0, 0, round(g("baseH") + g("bellH") + 0.5)]);
  } else {
    // Servo: tabs on a's face, case through a cut-out (or, tabZ 0, the case
    // standing on the face), output on the axis.
    const sx = round(g("bodyL") / 2 - g("bossD") / 2);
    mountType = "HOLE_PATTERN";
    mountPose = at(fa, -sx, 0, 0);
    const rows = typeof row.holeRowPitch === "number" ? row.holeRowPitch : 0;
    mountParams = { diameter: round(g("holeD") + 0.2), nx: 2, ny: rows ? 2 : 1, pitch_x: g("holePitch"), pitch_y: rows || 1 };
    const top = g("bodyH") - g("tabZ") + g("bossH") + g("splineH");
    out = pose([sx, 0, round(top - d.dims.engage!)]);
  }
  x.mint(j.id, motor, d.summary, [
    { side: "requires", port: { name: "mount", type: "FLAT_FACE", pose: motorMount, params: { ring_diameter: d.dims.d! + 2 } }, decl: mountType },
    { side: "provides", port: { name: "shaft", type: "FLAT_FACE", pose: out, params: { ring_diameter: d.dims.d! / 2 } }, decl: "HUB_BORE" },
  ]);
  x.addPort(A, "provides", { name: `${v}_motor_mount`, type: mountType, pose: mountPose, params: mountParams },
    mountType, typeof row.tabZ === "number" && row.tabZ > 0 ? `servo tab screws; cut a ${g("bodyL") + 0.6}×${g("bodyW") + 0.6} opening for the case, centred here` : "");
  x.addEdge(A.id, `${v}_motor_mount`, mid, "mount");
  const hub: CadPortT["params"] = { diameter: d.dims.d! };
  if (stepper || motor.family === "n20") hub.flat = round(g("shaftD") / 2 - g("flatDepth"));
  x.addPort(B, "requires", { name: `${v}_hub`, type: "HUB_BORE", pose: at(fb, 0, 0, 0), params: hub });
  x.addEdge(mid, "shaft", B.id, `${v}_hub`);
  ringFace(c, A, j.a.port, motor.family === "brushless" ? g("baseD") + 2.4 : d.dims.d! + 4);
  ringFace(c, B, j.b.port, d.dims.d! + 2.4);
}

/** Number params on a minted catalog node beside its sku: a gear's teeth, a
 *  belt's wrap. */
function setParams(node: OutNode, values: Record<string, number>) {
  for (const [name, value] of Object.entries(values)) node.contract.params.push({ type: "number", name, description: "", default: round(value) });
}

/**
 * Screws through catalog hardware into a, as the fixed-joint decision `sub`
 * picked them (joints.ts hardwareScrews): one screw node placed at every
 * position, each into a tapped hole or a heat-set insert in a, `w` up a's
 * joint normal. The screw's `host` port sits `clamp` down its shank, so the
 * head lands on the hardware. Returns the host ports, which the hardware the
 * screws hold can mate to as well, and the params they share.
 */
function hostScrews(c: Ctx, prefix: string, sub: JointDecision, at_: [number, number][], w: D, clamp: number, wallHost: D, note = "") {
  const { x, j, v, A, fa } = c;
  const screw = part(sub, "screw")!;
  const thread = sub.thread!;
  const sid = hardwareId(j.id, `${prefix}_screw`);
  const iid = hardwareId(j.id, `${prefix}_insert`);
  const tapped = sub.recipe === "tapped";
  const type = tapped ? "THREADED_HOLE" : "INSERT_POCKET";
  const bound = (l: Lin) => strip(String(linExpr(l, clamp, wallHost)));
  x.mint(j.id, { ...screw, role: `${prefix}_screw` }, sub.summary, [
    { side: "requires", port: { name: "host", type: "FLAT_FACE", pose: pose([0, 0, -round(clamp)], [0, 0, -1]), params: { ring_diameter: CATALOG.threads[thread]!.clearance + 1 } }, decl: type },
  ], `screwLengthIn: ${screw.family}, ${thread}, min=${bound(sub.window!.min)}, max=${bound(sub.window!.max)}`);
  const depth = `expr: param(${sid}.length) - ${round(clamp)} + 0.5`;
  let params: CadPortT["params"];
  if (tapped) {
    x.addParam(A, `${v}_${prefix}_tap_depth`, `tapped depth for ${j.id}'s ${prefix} screws`, depth);
    params = { thread, depth: `param(${A.id}.${v}_${prefix}_tap_depth)` };
  } else {
    const ins = part(sub, "insert")!;
    x.addParam(A, `${v}_${prefix}_insert_d`, `heat-set insert hole Ø for ${j.id}'s ${prefix} screws`, `hw:insertHoleD:param:${iid}.sku`);
    x.addParam(A, `${v}_${prefix}_pocket`, `insert pocket depth for ${j.id}'s ${prefix} screws`, depth);
    x.mint(j.id, { ...ins, role: `${prefix}_insert` }, sub.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: INSET_POSE as unknown as Pose, params: { ring_diameter: n(ins, "holeD") } }, decl: "INSERT_POCKET" }]);
    params = { diameter: `param(${A.id}.${v}_${prefix}_insert_d)`, depth: `param(${A.id}.${v}_${prefix}_pocket)` };
  }
  const ports = at_.map(([u, vv], k) => {
    const name = `${v}_${prefix}_${tapped ? "tap" : "pocket"}${at_.length > 1 ? `_${k + 1}` : ""}`;
    x.addPort(A, "provides", { name, type, pose: at(fa, u, vv, w), params }, type, note);
    if (!tapped) x.addEdge(A.id, name, iid, "seat");
    x.addEdge(A.id, name, sid, "host");
    return name;
  });
  return { ports, hole: tapped ? CATALOG.threads[thread]!.tapDrill : params.diameter!, depth: params.depth! };
}

/** A NEMA 17 under a at (u, v) on a's joint face, its shaft up through a:
 *  the mount face wallMotor under a's face (a pocket in a's underside when
 *  that is thinner than wallA), the shaft's port `z` above a's face. */
function nemaUnder(c: Ctx, u: number, vv: number, z: number): string {
  const { x, j, v, d, A, fa } = c;
  const motor = part(d, "motor")!;
  const row = familyDims(motor.family, motor.key)!;
  const mid = hardwareId(j.id, "motor");
  const wm: D = j.wallMotor ?? j.wallA;
  x.addParam(A, `${v}_pilot`, `motor pilot Ø for ${j.id}`, `hw:motorPilot:param:${mid}.sku`);
  x.addPort(A, "provides", {
    name: `${v}_motor_mount`, type: "MOTOR_MOUNT", pose: at(fa, u, vv, times(-1, wm), true),
    params: { pilot_diameter: `param(${A.id}.${v}_pilot)`, hole_diameter: CATALOG.threads[String(row.holeThread)]!.clearance, pitch_x: dim(row, "holePitch"), pitch_y: dim(row, "holePitch") },
  }, "MOTOR_MOUNT", j.wallMotor === undefined ? "" : `the motor's face, under a: pocket a's underside around the ${dim(row, "face")} square body up to here`);
  x.mint(j.id, motor, d.summary, [
    { side: "requires", port: { name: "mount", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: dim(row, "shaftD") + 2 } }, decl: "MOTOR_MOUNT" },
    { side: "provides", port: { name: "shaft", type: "FLAT_FACE", pose: pose([0, 0, times(-1, sum(wm, z))], [0, 0, -1]), params: { ring_diameter: dim(row, "shaftD") / 2 } }, decl: "HUB_BORE" },
  ]);
  x.addEdge(A.id, `${v}_motor_mount`, mid, "mount");
  return mid;
}

/** A wheel on a shaft: its bore port at its hub face (a pulley) or, for a
 *  centred gear, half its thickness down. */
const wheelBore = (dz: number, d: number) => ({
  side: "requires" as const, port: { name: "bore", type: "FLAT_FACE" as const, pose: pose([0, 0, round(dz)], [0, 0, -1]), params: { ring_diameter: d + 1 } }, decl: "HUB_BORE",
});

/** A GT2 belt round the motor pulley and one more wheel `center` along its
 *  +x (or -x with `back`), resting on the motor pulley's `belt` port. Its
 *  inner Ø clears the tips by 0.1, a running clearance the envelope band
 *  needs so its tessellated arcs never cut the rims. */
function wrapBelt(c: Ctx, pulleyId: string, center: number, teeth: [number, number], back: boolean) {
  const { x, j, d } = c;
  const node = x.mint(j.id, part(d, "belt")!, d.summary, [{
    side: "requires",
    port: { name: "seat", type: "FLAT_FACE", pose: { origin: [0, 0, 0], zAxis: [0, 0, -1], xAxis: [back ? -1 : 1, 0, 0] }, params: { standoff: 0 } },
    decl: "FLAT_FACE",
  }]);
  setParams(node, { center, d1: gt2TipD(teeth[0]) + 0.2, d2: gt2TipD(teeth[1]) + 0.2 });
  x.addEdge(pulleyId, "belt", hardwareId(j.id, "belt"), "seat");
}

/** A belt or gear drive: b on the spindle, above the driven wheel; the
 *  motor `center` along a's x, its wheel at the height the rule set. */
function offsetDrive(c: Ctx) {
  spindle(c);
  const { x, j, d } = c;
  const mid = nemaUnder(c, d.dims.center!, 0, d.dims.zMotor!);
  const sid = hardwareId(j.id, part(d, "shaft")!.role);
  const motorShaft = familyDims("nema17", part(d, "motor")!.key)!;
  if (d.recipe === "belt_drive") {
    const [mp, dp] = [part(d, "motor_pulley")!, part(d, "driven_pulley")!];
    const width = dim(familyDims("gt2_loop", part(d, "belt")!.key)!, "width");
    x.mint(j.id, mp, d.summary, [
      wheelBore(0, n(mp, "bore")),
      { side: "provides", port: { name: "belt", type: "FLAT_FACE", pose: pose([0, 0, round(rimMid(familyDims(mp.family, mp.key)!) - width / 2)]), params: { standoff: 0 } }, decl: "FLAT_FACE" },
    ]);
    x.mint(j.id, dp, d.summary, [wheelBore(0, n(dp, "bore"))]);
    x.addEdge(mid, "shaft", hardwareId(j.id, mp.role), "bore");
    x.addEdge(sid, "drive", hardwareId(j.id, dp.role), "bore");
    // From the motor back along -x to the driven axis.
    wrapBelt(c, hardwareId(j.id, mp.role), d.dims.center!, [d.dims.teethMotor!, d.dims.teethDriven!], true);
    return;
  }
  const t = d.dims.thickness!;
  const shaft = part(d, "shaft")!;
  const gear = (role: string, teeth: number, bore: number, flat: number, phase: number) => {
    const node = x.mint(j.id, part(d, role)!, d.summary, [wheelBore(-t / 2, bore)]);
    setParams(node, { module: d.dims.module!, teeth, pressure_angle: 20, thickness: t, bore, flat, phase });
  };
  gear("motor_gear", d.dims.teethMotor!, dim(motorShaft, "shaftD"), dim(motorShaft, "shaftD") / 2 - dim(motorShaft, "flatDepth"), d.dims.phase!);
  gear("driven_gear", d.dims.teethDriven!, d.dims.d!, shaft.family === "d_shaft" ? d.dims.d! / 2 - n(shaft, "flatDepth") : 0, 0);
  x.addEdge(mid, "shaft", hardwareId(j.id, "motor_gear"), "bore");
  x.addEdge(sid, "drive", hardwareId(j.id, "driven_gear"), "bore");
}

/** A lead screw on a's normal: motor under a, coupler, screw, its nut in b
 *  (placing b), and the guide rod in a beside it through an LM8UU in b. The
 *  rod is not mated to the bearing, so b has one placement. */
function leadScrew(c: Ctx) {
  const { x, j, v, d, A, B, fa, fb } = c;
  unmate(c);
  const [cp, nut] = [familyDims("coupler", part(d, "coupler")!.key)!, familyDims("lead_nut", part(d, "lead_nut")!.key)!];
  const [cid, sid, nid, rid, lid] = ["coupler", "lead_screw", "lead_nut", "rod", "linear_bearing"].map((r) => hardwareId(j.id, r)) as [string, string, string, string, string];
  const ft = dim(nut, "flangeT");
  // On the screw's axis the motor is under a.port, so a wallMotor thicker than wallA (an offset drive's) does not apply.
  const mid = nemaUnder(c.i.wallMotor !== undefined && c.i.wallMotor > c.i.wallA ? { ...c, j: { ...j, wallMotor: undefined } } : c, 0, 0, d.dims.gap!);
  x.mint(j.id, part(d, "coupler")!, d.summary, [
    wheelBore(0, dim(cp, "boreA")),
    { side: "provides", port: { name: "screw", type: "FLAT_FACE", pose: pose([0, 0, round(d.dims.screwStart! - d.dims.gap!)]), params: { ring_diameter: dim(cp, "boreB") + 1 } }, decl: "HUB_BORE" },
  ]);
  x.addEdge(mid, "shaft", cid, "bore");
  x.mint(j.id, part(d, "lead_screw")!, d.summary, [
    { side: "requires", port: { name: "end", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: 4 } }, decl: "HUB_BORE" },
    { side: "provides", port: { name: "nut", type: "FLAT_FACE", pose: pose([0, 0, round(d.dims.z0! - ft - d.dims.screwStart!)]), params: { ring_diameter: dim(nut, "bodyD") } }, decl: "FLAT_FACE" },
  ]);
  x.addEdge(cid, "screw", sid, "end");
  x.mint(j.id, part(d, "lead_nut")!, d.summary, [
    { side: "requires", port: { name: "screw", type: "FLAT_FACE", pose: pose([0, 0, ft]), params: { ring_diameter: dim(nut, "bodyD") } }, decl: "FLAT_FACE" },
    { side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: dim(nut, "flangeD") - 1 } }, decl: "BORE" },
  ]);
  x.addEdge(sid, "nut", nid, "screw");
  x.addPort(B, "provides", { name: `${v}_nut`, type: "BORE", pose: at(fb, 0, 0, 0), params: { diameter: dim(nut, "bodyD") } }, "BORE", "the lead nut's body, its flange against this face");
  x.addPort(B, "provides", {
    name: `${v}_nut_holes`, type: "HOLE_PATTERN", pose: at(fb, 0, 0, 0),
    params: { diameter: CATALOG.threads[String(nut.holeThread)]!.clearance, count: dim(nut, "holeCount"), pcd: dim(nut, "pcd") },
  });
  x.addEdge(B.id, `${v}_nut`, nid, "seat");
  ringFace(c, A, j.a.port, dim(cp, "od") + 2.4);
  ringFace(c, B, j.b.port, dim(nut, "pcd") + CATALOG.threads[String(nut.holeThread)]!.clearance + 2.4);
  if (!part(d, "rod")) return; // b rides its own guide

  const g = d.dims.guide!;
  // A wall too thin for the socket has a boss on its face that holds it.
  const boss = d.dims.boss ?? 0;
  const socket = sum(boss, j.wallA, -(c.i.minWallA ?? FDM_MIN_WALL_MM));
  x.addParam(A, `${v}_rod_d`, `guide rod Ø for ${j.id}`, `hw:shaftD:param:${rid}.sku`);
  x.addPort(A, "provides", { name: `${v}_rod`, type: "BORE", pose: at(fa, g, 0, boss), params: { diameter: `param(${A.id}.${v}_rod_d)`, depth: socket } }, "BORE",
    boss ? `the guide rod's socket, in a Ø${d.dims.bossD} boss standing ${boss} above the joint face` : "");
  if (boss) x.addVolume(A, { kind: "cylinder", pose: at(fa, g, 0, round(boss / 2 - 0.5)), d: d.dims.bossD! + 1, h: round(boss + 1) });
  x.mint(j.id, part(d, "rod")!, d.summary, [
    { side: "requires", port: { name: "end", type: "FLAT_FACE", pose: pose([0, 0, socket], [0, 0, -1]), params: { ring_diameter: 4 } }, decl: "BORE" },
  ], sum(socket, d.dims.z0!, d.dims.stroke!, j.wallB, -boss));
  x.addEdge(A.id, `${v}_rod`, rid, "end");
  x.addParam(B, `${v}_lm_od`, `linear bearing OD for ${j.id}`, `hw:bearingSeatD:param:${lid}.sku`);
  // A platform thinner than the bearing has a boss under it, toward a.
  const lmBoss = d.dims.lmBoss ?? 0;
  x.addPort(B, "provides", { name: `${v}_lm_seat`, type: "LINEAR_BEARING_SEAT", pose: at(fb, g, 0, lmBoss), params: lmSeat(c) }, "LINEAR_BEARING_SEAT",
    lmBoss ? `the LM8UU's seat, in a Ø${d.dims.lmBossD} boss standing ${lmBoss} out of this face toward a` : "");
  if (lmBoss) x.addVolume(B, { kind: "cylinder", pose: at(fb, g, 0, round(lmBoss / 2 - 0.5)), d: d.dims.lmBossD! + 1, h: round(lmBoss + 1) });
  x.mint(j.id, part(d, "linear_bearing")!, d.summary, [
    { side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: INSET_POSE as unknown as Pose, params: { ring_diameter: d.dims.od! - 1 } }, decl: "LINEAR_BEARING_SEAT" },
  ]);
  x.addEdge(B.id, `${v}_lm_seat`, lid, "seat");
}

/** The rail, a NEMA 17 past one end and an idler past the other, both
 *  `beltY` to a's +y, an open belt round them that b clamps in a slot over its
 *  near run. The idler stands on a boss of a, on a washer, on its screw. */
function beltCarriage(c: Ctx) {
  rail(c);
  const { x, j, v, d, A, B, fa, fb } = c;
  const [X, Y] = [d.dims.drive!, d.dims.beltY!];
  const mp = part(d, "motor_pulley")!;
  const [idl, wash] = [familyDims("gt2_idler", part(d, "idler")!.key)!, familyDims("washer", part(d, "idler_washer")!.key)!];
  const belt = familyDims("gt2_belt", part(d, "belt")!.key)!;
  const mid = nemaUnder(c, -X, Y, d.dims.gap!);
  x.mint(j.id, mp, d.summary, [
    wheelBore(0, n(mp, "bore")),
    { side: "provides", port: { name: "belt", type: "FLAT_FACE", pose: pose([0, 0, round(rimMid(familyDims(mp.family, mp.key)!) - dim(belt, "width") / 2)]), params: { standoff: 0 } }, decl: "FLAT_FACE" },
  ]);
  x.addEdge(mid, "shaft", hardwareId(j.id, mp.role), "bore");

  const boss = d.dims.boss!;
  const bossD = round(dim(wash, "od") + 2 * FDM_MIN_WALL_MM + 2);
  const tw = dim(wash, "thickness");
  const [host] = hostScrews(c, "idler", idlerScrews(c.i, boss) as JointDecision, [[X, Y]], boss, tw + pulleyHeight(idl), sum(boss, j.wallA),
    `on a Ø${bossD} boss standing ${boss} above the joint face, under the belt idler`).ports;
  x.addVolume(A, { kind: "cylinder", pose: at(fa, X, Y, round(boss / 2 - 0.5)), d: bossD + 1, h: round(boss + 1) });
  x.mint(j.id, part(d, "idler_washer")!, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: dim(wash, "id") + 1 } }, decl: "FLAT_FACE" }]);
  x.addEdge(A.id, host!, hardwareId(j.id, "idler_washer"), "seat");
  x.mint(j.id, part(d, "idler")!, d.summary, [{
    side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: pose([0, 0, -tw], [0, 0, -1]), params: { ring_diameter: dim(idl, "bore") + 1, standoff: tw } }, decl: "FLAT_FACE",
  }]);
  x.addEdge(A.id, host!, hardwareId(j.id, "idler"), "seat");
  wrapBelt(c, hardwareId(j.id, mp.role), 2 * X, [20, 20], false);

  // b's frame is a's turned about x, so a's +y is b's -y.
  const t = dim(belt, "thickness");
  x.addPort(B, "provides", {
    name: `${v}_belt_slot`, type: "SLOT", pose: at(fb, 0, -round(Y - gt2TipD(20) / 2 - 0.1 - t / 2), 0),
    params: { width: round(t + 1), depth: d.dims.slotDepth! },
  }, "SLOT", "the belt's near run passes along here: b clamps it in this slot");
}

/** Wood connectors sit in a row along the joint face's x, `pitch` apart:
 *  across it (y) is the panel's thickness. */
const rowOffsets = (count: number, pitch: number) => Array.from({ length: count }, (_, k) => round((k - (count - 1) / 2) * pitch));

/** W3: the confirmat's countersink on a's far face, its pilot in b's edge. */
function confirmat(c: Ctx) {
  const { x, j, v, d, A, B, fa, fb } = c;
  const count = j.count ?? 1;
  const us = rowOffsets(count, j.pitch ?? 100);
  const name = (base: string, k: number) => `${v}_${base}${count > 1 ? `_${k + 1}` : ""}`;
  const sid = hardwareId(j.id, "screw");
  x.mint(j.id, part(d, "screw")!, d.summary, [{ side: "requires", port: { name: "head", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: d.dims.headD! + 1 } }, decl: "COUNTERSINK" }]);
  us.forEach((u, k) => {
    x.addPort(A, "provides", { name: name("head", k), type: "COUNTERSINK", pose: at(fa, u, 0, times(-1, j.wallA), true), params: { diameter: d.dims.headD!, angle: 90, through_diameter: d.dims.drillA! } }, "COUNTERSINK", `confirmat head for ${j.id}`);
    x.addEdge(A.id, name("head", k), sid, "head");
    x.addPort(B, "provides", { name: name("pilot", k), type: "BORE", pose: at(fb, u, 0, 0), params: { diameter: d.dims.drillB!, depth: d.dims.pilotDepth! } });
  });
  faceMate(c);
  const rho = Math.max(...us.map(Math.abs));
  patternRing(c, A, j.a.port, d.dims.drillA!, rho);
  patternRing(c, B, j.b.port, d.dims.drillB!, rho);
}

/** W2: the cam bolt's pilot in a's face, the Ø8 hole in b's edge, the cam's
 *  pocket in b's face (toward b.port's +y, the bolt axis mid-panel), and a
 *  glued dowel either side of each bolt. */
function camLock(c: Ctx) {
  const { x, j, v, d, A, B, fa, fb } = c;
  const count = j.count ?? 1;
  const us = rowOffsets(count, j.pitch ?? 128);
  const name = (base: string, k: number) => `${v}_${base}${count > 1 ? `_${k + 1}` : ""}`;
  const [bid, cid] = [hardwareId(j.id, "cam_bolt"), hardwareId(j.id, "cam")];
  x.mint(j.id, part(d, "cam_bolt")!, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: d.dims.pilot! + 1 } }, decl: "BORE" }]);
  x.mint(j.id, part(d, "cam")!, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: INSET_POSE as unknown as Pose, params: { ring_diameter: d.dims.edgeHole! } }, decl: "BORE" }]);
  const dowel = part(d, "dowel");
  const did = hardwareId(j.id, "dowel");
  if (dowel) {
    x.addParam(A, `${v}_dowel_d`, `dowel Ø for ${j.id}`, `hw:dowelHole:param:${did}.sku`);
    x.addParam(B, `${v}_dowel_d`, `dowel Ø for ${j.id}`, `hw:dowelHole:param:${did}.sku`);
    x.mint(j.id, dowel, d.summary, [{ side: "requires", port: { name: "center", type: "FLAT_FACE", pose: INSET_POSE as unknown as Pose, params: { ring_diameter: Number(dowel.key) / 2 } }, decl: "DOWEL_HOLE" }]);
  }
  const axis = (vec: Vec) => vec.map((cc) => round(cc) || 0) as Vec;
  us.forEach((u, k) => {
    x.addPort(A, "provides", { name: name("bolt", k), type: "BORE", pose: at(fa, u, 0, 0), params: { diameter: d.dims.pilot!, depth: d.dims.pilotDepth! } });
    x.addEdge(A.id, name("bolt", k), bid, "seat");
    x.addPort(B, "provides", { name: name("edge", k), type: "BORE", pose: at(fb, u, 0, 0), params: { diameter: d.dims.edgeHole!, depth: d.dims.distance! } });
    const camAt: Pose = { origin: at(fb, u, round(d.dims.panel! / 2), -d.dims.distance!).origin, zAxis: axis(fb.y), xAxis: axis(fb.z) };
    x.addPort(B, "provides", { name: name("cam", k), type: "BORE", pose: camAt, params: { diameter: d.dims.camD!, depth: d.dims.camDepth! } });
    x.addEdge(B.id, name("cam", k), cid, "seat");
    if (!dowel) return;
    for (const [s, du] of [["l", -d.dims.dowelOffset!], ["r", d.dims.dowelOffset!]] as const) {
      x.addPort(A, "provides", { name: name(`dowel_a_${s}`, k), type: "DOWEL_HOLE", pose: at(fa, u + du, 0, 0), params: { diameter: `param(${A.id}.${v}_dowel_d)`, depth: d.dims.dowelDepth!, fit: "press" } });
      x.addPort(B, "provides", { name: name(`dowel_b_${s}`, k), type: "DOWEL_HOLE", pose: at(fb, u + du, 0, 0), params: { diameter: `param(${B.id}.${v}_dowel_d)`, depth: d.dims.dowelDepth!, fit: "press" } });
      x.addEdge(A.id, name(`dowel_a_${s}`, k), did, "center");
    }
  });
  faceMate(c);
  const rho = Math.max(...us.map(Math.abs));
  patternRing(c, A, j.a.port, d.dims.pilot!, rho);
  patternRing(c, B, j.b.port, d.dims.edgeHole!, rho);
}

const RECIPES: Record<JointDecision["recipe"], ((c: Ctx) => void) | undefined> = {
  flanged_bearing: flangedBearing,
  stud,
  tapped: fastener,
  through_bolt: fastener,
  insert: fastener,
  nut_trap: fastener,
  side_nut_trap: fastener,
  dowel: dowels,
  peg: dowels,
  bearings: spindle,
  bushings: spindle,
  hub_bearings: hubBearings,
  printed_pin: printedPin,
  pin,
  rod_slide: rodSlide,
  rail,
  direct_drive: directDrive,
  belt_drive: offsetDrive,
  gear_drive: offsetDrive,
  lead_screw: leadScrew,
  belt_carriage: beltCarriage,
  confirmat,
  cam_lock: camLock,
  snap: undefined,
};

/** The decision for every declared joint of a graph, or why there is none. */
export function jointDecisions(graph: GraphDoc): { joint: CadJoint; decision: JointDecision | { error: string } }[] {
  return (graph.joints ?? []).map((raw) => {
    const parsed = CadJoint.safeParse(raw);
    if (!parsed.success) return { joint: raw as unknown as CadJoint, decision: { error: `${raw.id}: ${parsed.error.issues[0]?.message ?? "invalid joint"}` } };
    const input = jointInput(graph, parsed.data);
    return { joint: parsed.data, decision: "error" in input ? input : selectJoint(input) };
  });
}

/**
 * The engine's expandPlan for CAD: strip what each joint minted, re-run its
 * rule, mint again. A joint whose rule has no answer mints nothing and keeps
 * the plan as declared; cadJointRuleLint reports the shortfall so the
 * architect's repair round can thicken the wall it names.
 */
export function expandJoints(input: ArchitectOutput, live?: Live): ArchitectOutput {
  const out = structuredClone(input) as ArchitectOutput;
  const joints = (out.joints ?? []).map((raw) => CadJoint.safeParse(raw));
  // A bound default is only a cache of its binding: T1 owns the live value.
  // Keeping the old one wherever the binding is unchanged means an untouched
  // joint re-expands to a byte-identical contract and dirties nothing.
  const cached = new Map<string, { binding: string; value: unknown }>();
  for (const n of out.nodes) {
    for (const [name, binding] of Object.entries(payloadOf(n).paramBindings ?? {})) {
      cached.set(`${n.id}.${name}`, { binding, value: n.contract.params.find((p) => p.name === name)?.default });
    }
  }
  joints.forEach((j, i) => j.success && unmint(out, out.joints![i]!));
  const x = new Expansion(out, live);
  const kept: JointDecl[] = [];
  const planned = joints.map((parsed) => {
    if (!parsed.success) return undefined;
    const j = parsed.data;
    const A = out.nodes.find((nd) => nd.id === j.a.node);
    const B = out.nodes.find((nd) => nd.id === j.b.node);
    const inp = A && B ? jointInput({ ...x.graph, edges: out.edges } as GraphDoc, j, out.joints) : { error: "unknown node" };
    const decision = "error" in inp ? inp : selectJoint(inp);
    if ("error" in decision || "error" in inp || !A || !B) return undefined;
    if (!payloadOf(A).ports.some((p) => p.name === j.a.port) || !payloadOf(B).ports.some((p) => p.name === j.b.port)) return undefined;
    return { j, inp, decision, A, B };
  });
  const axles = sharedAxles(x, planned);
  const firstOnB = new Map<string, string>();
  for (const p of planned) if (p && !firstOnB.has(`${p.j.b.node}|${p.j.b.port}`)) firstOnB.set(`${p.j.b.node}|${p.j.b.port}`, jointVar(p.j.id));
  const done = new Set<number>();
  joints.forEach((parsed, i) => {
    const raw = out.joints![i]!;
    if (!parsed.success) return void kept.push(raw);
    const p = planned[i];
    if (!p || !RECIPES[p.decision.recipe]) return void kept.push(parsed.data);
    const { j, inp, decision, A, B } = p;
    const near = axles.get(i);
    const shares = near !== undefined && done.has(near) ? planned[near]!.j.id : undefined;
    const farAt = [...axles].find(([, n]) => n === i)?.[0];
    const far = farAt === undefined ? undefined : planned[farAt]!.j;
    const recipe = shares ? axleEnd : RECIPES[decision.recipe]!;
    x.minted = [];
    try {
      const fa = frameOf(x.port(A, j.a.port).pose);
      recipe({
        x, j, i: inp, v: jointVar(j.id), vb: firstOnB.get(`${j.b.node}|${j.b.port}`)!, d: decision, A, B, fa, fb: frameOf(x.port(B, j.b.port).pose), shares,
        far: far && { j: far, fa: frameOf(x.port(A, far.a.port).pose), span: spanOf(fa, frameOf(x.port(A, far.a.port).pose)) },
      });
      kept.push({ ...j, expanded: decisionKey(decision), minted: [...new Set(x.minted)], ...(shares ? { shared: shares } : {}) } as JointDecl);
      done.add(i);
    } catch (err) {
      // Half a recipe is worse than none: strip what it got to, and say why.
      unmint(out, { ...j, minted: x.minted } as JointDecl);
      kept.push({ ...j, failed: `${decision.rule} could not be expanded: ${(err as Error).message}` } as JointDecl);
    }
  });
  phaseGears(out, x.graph);
  x.settle();
  for (const { node, name, binding } of x.bindings) {
    const was = cached.get(`${node.id}.${name}`);
    const p = node.contract.params.find((q) => q.name === name);
    if (p && was?.binding === binding && was.value !== undefined) (p as { default: unknown }).default = was.value;
  }
  // The plan's own edges first, then the minted ones, so a re-expansion lists
  // a face mate it added last time exactly where this one does.
  const names = new Set(kept.flatMap((j) => (j as { minted?: string[] }).minted ?? []));
  const minted = (e: OutEdge) => [e.from, e.to].some((id) => id.includes("_")) || names.has(e.fromPort) || names.has(e.toPort);
  out.edges = [...out.edges.filter((e) => !minted(e)), ...out.edges.filter(minted)];
  out.joints = kept;
  deriveTravel(out, live);
  return out;
}

/**
 * A revolute joint with no stated limits turns as far as its parts'
 * envelopes let it, not a full turn: two flat hinge leaves on one pin meet
 * folded well short of 180°, and the ±180° default sent G5's sweep straight
 * through the other leaf. Continuous duty keeps the full turn, which the
 * plan lint holds it to. Re-derived on every expansion, so a moved part
 * moves its stops.
 */
function deriveTravel(out: ArchitectOutput, live?: Live) {
  const graph = { ...asGraph(out, live), edges: out.edges, joints: out.joints, assembly: { entryNodeId: out.entryNodeId } } as unknown as GraphDoc;
  const axes = jointAxes(graph);
  out.joints = out.joints!.map((raw) => {
    const j = raw as CadJoint;
    if (j.motion !== "revolute" || j.duty === "continuous" || (j.limits && j.limitsSource !== "derived")) return raw;
    const def = axes.find((a) => a.id === j.id);
    if (!def) return raw;
    const [lo, hi] = reachableTravel(graph, def);
    // A stated travel turns whichever way reaches it, the open side first.
    const t = j.travel;
    const limits: [number, number] = t === undefined ? [lo, hi] : hi >= t ? [0, t] : -lo >= t ? [-t, 0] : [lo, hi];
    return { ...raw, limits, limitsSource: "derived" } as JointDecl;
  });
}

type Planned = { j: CadJoint; inp: JointInput; decision: JointDecision; A: OutNode; B: OutNode } | undefined;

const unit = (v: readonly number[]) => {
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
};
const dot3 = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub3 = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const cross3 = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];

/** a's thickness between two of its joint faces that face apart, along the
 *  first one's +z: an expression when their origins are. */
const spanOf = (near: Frame, far: Frame): D => sum(...[0, 1, 2].flatMap((k) => [times(near.z[k]!, near.o[k]!), times(-near.z[k]!, far.o[k]!)]));

/**
 * Bushing or bearing joints on one a whose axes are a single line, facing
 * apart: a wheel each side of a body. Each alone mints a full-width shaft, two
 * seats and a collar, and the left set lands in the right one. Together they
 * share one axle: the earlier joint mints it with a seat in each face, the
 * later only hangs its b on the far end. Later index → earlier index.
 */
function sharedAxles(x: Expansion, planned: Planned[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const used = new Set<number>();
  const axis = (j: CadJoint) => {
    try {
      return resolvePose(x.graph, x.port(x.node(j.a.node), j.a.port).pose);
    } catch {
      return undefined;
    }
  };
  planned.forEach((p, n) => {
    planned.forEach((s, f) => {
      if (f <= n || !p || !s || used.has(n) || used.has(f)) return;
      if (p.j.a.node !== s.j.a.node || !["bushings", "bearings"].includes(p.decision.recipe) || decisionKey(p.decision) !== decisionKey(s.decision)) return;
      if ((p.j.count ?? 1) > 1 || (s.j.count ?? 1) > 1) return;
      const [ap, as] = [axis(p.j), axis(s.j)];
      if (!ap || !as) return;
      const z = unit(ap.zAxis);
      if (dot3(z, unit(as.zAxis)) > -0.9999) return;
      const d = ap.origin.map((c, k) => c - as.origin[k]!);
      const along = dot3(d, z);
      if (along <= 0 || Math.hypot(...d.map((c, k) => c - along * z[k]!)) > 0.01) return;
      pairs.set(f, n);
      used.add(n).add(f);
    });
  });
  return pairs;
}

// ---------- Gears without a joint ----------

type GraphLike = Pick<GraphDoc, "nodes" | "edges" | "joints"> & { assembly: { entryNodeId: string } };

/** What a gear node is built from: its live param, else its contract default. */
function gearParam(n: Pick<NodeRecord, "params" | "contract">, name: string): number {
  const v = n.params?.[name] ?? n.contract.params.find((p) => p.name === name)?.default;
  return typeof v === "number" ? v : Number(v);
}

export interface GearMesh {
  a: string;
  b: string;
  /** b's phase, degrees, that puts a gap of b where a's tooth is. */
  phase: number;
  /** b's turn per degree of a's, about each gear's own +z. */
  ratio: number;
}

/**
 * Gear pairs the plan meshes without a drive joint: two gear nodes, not a
 * joint's, whose posed axes are parallel at m·(z1+z2)/2 with their faces
 * overlapping. The registry builds each with a tooth on +x, so left alone the
 * pair meets tooth to tooth. A tooth of a sits a fraction fa of a pitch behind
 * the line of centres, b's fb; rolling keeps fa + fb (opposed axes fb − fa)
 * fixed, and a tooth in a gap is that sum at one half.
 */
export function gearMeshes(graph: GraphLike, world: Record<string, Mat4>): GearMesh[] {
  const gears = Object.values(graph.nodes).filter((n) => n.kind === "gear" && world[n.id] && !jointOwner(graph, n.id));
  const out: GearMesh[] = [];
  const phase = new Map(gears.map((g) => [g.id, gearParam(g, "phase") || 0]));
  const fixed = new Set<string>();
  const col = (m: Mat4, c: number) => [m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!];
  const angle = (u: number[], m: Mat4) => {
    const [x, z] = [col(m, 0), col(m, 2)];
    const y = [z[1]! * x[2]! - z[2]! * x[1]!, z[2]! * x[0]! - z[0]! * x[2]!, z[0]! * x[1]! - z[1]! * x[0]!];
    return (Math.atan2(dot3(u, y), dot3(u, x)) * 180) / Math.PI;
  };
  const frac = (f: number) => f - Math.floor(f);
  gears.forEach((ga, n) => {
    gears.slice(n + 1).forEach((gb) => {
      const [wa, wb] = [world[ga.id]!, world[gb.id]!];
      const [m, za, zb] = [gearParam(ga, "module"), gearParam(ga, "teeth"), gearParam(gb, "teeth")];
      if (!(m > 0 && za > 0 && zb > 0) || Math.abs(gearParam(gb, "module") - m) > 1e-9) return;
      const [aa, ab] = [col(wa, 2), col(wb, 2)];
      const same = dot3(aa, ab);
      if (Math.abs(same) < 0.9999) return;
      const c = [0, 1, 2].map((k) => wb[12 + k]! - wa[12 + k]!);
      const axial = dot3(c, aa);
      const r = c.map((v, k) => v - axial * aa[k]!);
      const dist = Math.hypot(...r);
      if (Math.abs(dist - (m * (za + zb)) / 2) > GEAR_CENTRE_TOL_MM || Math.abs(axial) >= (gearParam(ga, "thickness") + gearParam(gb, "thickness")) / 2) return;
      const u = r.map((v) => v / dist);
      const [pa, pb] = [360 / za, 360 / zb];
      const fa = frac((angle(u, wa) - phase.get(ga.id)!) / pa);
      const fb = same > 0 ? frac(0.5 - fa) : frac(fa + 0.5);
      const want = round(frac((angle(u.map((v) => -v), wb) - fb * pb) / pb) * pb);
      if (!fixed.has(gb.id)) phase.set(gb.id, want);
      fixed.add(ga.id).add(gb.id);
      out.push({ a: ga.id, b: gb.id, phase: phase.get(gb.id)!, ratio: round((same > 0 ? -1 : 1) * (za / zb)) });
    });
  });
  return out;
}

/** Each gear mesh as a joint G5 sweeps: a full turn of a about its own axis,
 *  b coupled at the mesh ratio, so the pair is checked tooth through tooth.
 *  A gear riding a revolute joint (on its shaft) turns with that joint's whole
 *  moving set, and each joint's own sweep turns the other gear's set coupled:
 *  the winch swept its drum gear into a frozen pinion, and each gear round a
 *  shaft that held still. Two such joints need no mesh joint of their own.
 *  Mutates `joints` (their `coupled`). */
export function gearMeshJoints(graph: GraphDoc, world: Record<string, Mat4>, joints: KinematicJoint[] = []): KinematicJoint[] {
  const axis = (id: string) => ({
    origin: [world[id]![12]!, world[id]![13]!, world[id]![14]!] as Vec,
    direction: [8, 9, 10].map((k) => Math.round(world[id]![k]! * 1e6) / 1e6) as Vec,
  });
  const carrier = (id: string) => {
    const g = axis(id);
    return joints.find((j) => j.type === "revolute" && j.moving.includes(id) && Math.abs(Math.abs(dot3(j.direction, g.direction)) - 1) < 1e-6 && Math.hypot(...cross3(sub3(g.origin, j.origin), j.direction)) < 0.01);
  };
  return gearMeshes(graph, world).flatMap((m): KinematicJoint[] => {
    const [ja, jb] = [carrier(m.a), carrier(m.b)];
    const [ma, mb] = [ja?.moving ?? [m.a], jb?.moving ?? [m.b]];
    if (ja) (ja.coupled ??= []).push({ ...axis(m.b), ratio: m.ratio, moving: mb });
    if (jb) (jb.coupled ??= []).push({ ...axis(m.a), ratio: round(1 / m.ratio), moving: ma });
    if (ja && jb && ja !== jb) return [];
    return [{ id: `mesh:${m.a}:${m.b}`, type: "revolute", ...axis(m.a), limits: [-180, 180], moving: ma, coupled: [{ ...axis(m.b), ratio: m.ratio, moving: mb }] }];
  });
}

/** How far off m·(z1+z2)/2 a gear pair's centres may sit and still be a pair
 *  the plan meant to mesh: a centre declared to a rounded figure. */
export const GEAR_CENTRE_TOL_MM = 0.5;

/** Give each meshing gear pair's second gear the phase gearMeshes asks for. */
function phaseGears(out: ArchitectOutput, base: GraphDoc) {
  const nodes = Object.fromEntries(out.nodes.map((n) => [n.id, { ...base.nodes[n.id]!, kind: n.kind, contract: n.contract }]));
  const graph = { nodes, edges: out.edges, joints: out.joints ?? [], assembly: { entryNodeId: out.entryNodeId } } as unknown as GraphDoc;
  if (!Object.values(nodes).some((n) => n.kind === "gear")) return;
  const { world } = solvePlan(graph);
  for (const mesh of gearMeshes(graph, world)) {
    const node = out.nodes.find((n) => n.id === mesh.b)!;
    const p = node.contract.params.find((q) => q.name === "phase");
    if (p) (p as { default: unknown }).default = mesh.phase;
    else node.contract.params.push({ type: "number", name: "phase", description: "tooth phase, degrees: set at expansion so the teeth mesh", default: mesh.phase });
  }
}

/** Joints whose rule now picks different hardware than was expanded (a wall
 *  or an intent moved). A length change alone is not one: T1 follows it. A
 *  joint no rule fits any more is not either; it keeps the hardware it has and
 *  answers to jointErrors. */
export function staleJoints(graph: GraphDoc): string[] {
  return jointDecisions(graph)
    .filter(({ joint, decision }) => {
      const was = (graph.joints.find((j) => j.id === joint.id) as { expanded?: string } | undefined)?.expanded;
      return !("error" in decision) && decisionKey(decision) !== was;
    })
    .map(({ joint }) => joint.id);
}

/** Why each joint with no fitting rule has none. */
export function jointErrors(graph: GraphDoc): string[] {
  return jointDecisions(graph).flatMap(({ decision }) => ("error" in decision ? [decision.error] : []));
}

/** Whether two joints' a.ports lie on one line of the same a, and if so
 *  whether they face the same way or apart. */
function coaxial(graph: GraphDoc, p: CadJoint, q: CadJoint): false | "same" | "apart" {
  if (p.a.node !== q.a.node) return false;
  try {
    const axis = (j: CadJoint) => resolvePose(graph, payloadOf(graph.nodes[j.a.node]!).ports.find((x) => x.name === j.a.port)!.pose);
    const [ap, aq] = [axis(p), axis(q)];
    const z = unit(ap.zAxis);
    const facing = dot3(z, unit(aq.zAxis));
    if (Math.abs(facing) < 0.9999) return false;
    const d = aq.origin.map((c, k) => c - ap.origin[k]!);
    const along = dot3(d, z);
    if (Math.hypot(...d.map((c, k) => c - along * z[k]!)) >= 0.01) return false;
    return facing > 0 ? "same" : "apart";
  } catch {
    return false;
  }
}

/** Slack past each joint's walls along its axis, for collars and clips. */
const SPAN_SLACK_MM = 10;

/** Whether two coaxial joints' hardware can meet along the axis: each runs
 *  wallA behind its a.port and wallB in front, plus slack. Two hinges at
 *  either end of a lid, each on its own pin, do not. */
function spansMeet(graph: GraphDoc, p: CadJoint, q: CadJoint): boolean {
  const span = (j: CadJoint, z: number[], o: number[]): [number, number] | undefined => {
    const inp = jointInput(graph, j);
    if ("error" in inp) return undefined;
    const pose = resolvePose(graph, payloadOf(graph.nodes[j.a.node]!).ports.find((x) => x.name === j.a.port)!.pose);
    const at = dot3(pose.origin.map((c, k) => c - o[k]!), z);
    const ends = [at - Math.sign(dot3(unit(pose.zAxis), z)) * inp.wallA, at + Math.sign(dot3(unit(pose.zAxis), z)) * inp.wallB];
    return [Math.min(...ends) - SPAN_SLACK_MM, Math.max(...ends) + SPAN_SLACK_MM];
  };
  try {
    const ap = resolvePose(graph, payloadOf(graph.nodes[p.a.node]!).ports.find((x) => x.name === p.a.port)!.pose);
    const z = unit(ap.zAxis);
    const [sp, sq] = [span(p, z, ap.origin), span(q, z, ap.origin)];
    return !sp || !sq || (sp[0] < sq[1] && sq[0] < sp[1]);
  } catch {
    return true;
  }
}

/** The joint whose axle this one rides, when it shares one (sharedAxles). */
const sharedOf = (graph: Pick<GraphDoc, "joints">, id: string) => (graph.joints.find((j) => j.id === id) as { shared?: string } | undefined)?.shared;

// ---------- Kinematics ----------

/** A pose moved (u, v) across its own face. */
function across(p: NumericPose, u: number, v: number): NumericPose {
  const [z, x] = [p.zAxis, p.xAxis];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { ...p, origin: p.origin.map((o, k) => round(o + u * x[k]! + v * y[k]!)) as NumericPose["origin"] };
}

/** What a drive's motor turns, by role, about axes parallel to the joint's
 *  port (in a's frame), in degrees per unit of the joint's travel: a belt's
 *  pulleys turn together, a gear pair against each other, a lead screw 360°
 *  per lead, the pulleys of a belt carriage 360° per pitch circumference. */
function drivenWith(d: JointDecision, pose: NumericPose): { pose: NumericPose; ratio: number; moving: string[] }[] {
  const r = (d.dims.teethDriven ?? 1) / (d.dims.teethMotor ?? 1);
  const perMm = 360 / (Math.PI * gt2PitchD(20));
  switch (d.recipe) {
    case "belt_drive":
      return [{ pose: across(pose, d.dims.center!, 0), ratio: round(r), moving: ["motor_pulley"] }];
    case "gear_drive":
      return [{ pose: across(pose, d.dims.center!, 0), ratio: round(-r), moving: ["motor_gear"] }];
    case "lead_screw":
      return [{ pose, ratio: round(360 / d.dims.lead!), moving: ["coupler", "lead_screw"] }];
    case "belt_carriage":
      return [
        { pose: across(pose, -d.dims.drive!, d.dims.beltY!), ratio: round(perMm), moving: ["motor_pulley"] },
        { pose: across(pose, d.dims.drive!, d.dims.beltY!), ratio: round(perMm), moving: ["idler"] },
      ];
    default:
      return [];
  }
}

/**
 * Every motion joint's axis, in a's frame at a's joint port, and the nodes
 * that move with b: b itself, the hardware that turns with it (shaft,
 * collars, carriage), and anything mated onward from those, never crossing
 * back into a or the hardware that holds still (bearings, rail, motor).
 */
export function jointAxes(graph: GraphDoc): JointAxisDef[] {
  const out: JointAxisDef[] = [];
  for (const { joint, decision } of jointDecisions(graph)) {
    // A joint riding another's axle turns with that joint's sweep.
    if (joint.motion === "fixed" || "error" in decision || sharedOf(graph, joint.id)) continue;
    const port = payloadOf(graph.nodes[joint.a.node] ?? { contract: {} }).ports?.find((p) => p.name === joint.a.port);
    if (!port) continue;
    let pose: NumericPose;
    try {
      pose = resolvePose(graph, port.pose);
    } catch {
      continue;
    }
    const hw = decision.parts.map((p) => ({ id: hardwareId(joint.id, p.role), role: p.role })).filter((h) => graph.nodes[h.id]);
    const blocked = new Set([joint.a.node, ...hw.filter((h) => !MOVING_ROLES.has(h.role)).map((h) => h.id)]);
    // An instanced b (one wheel node on two axles) links every axle through
    // it: the other axles' hardware turns with its own joint, not this one.
    const siblings = new Set(graph.joints.filter((o) => o.id !== joint.id && o.b.node === joint.b.node && (o as { shared?: string }).shared !== joint.id).map((o) => o.id));
    for (const id of Object.keys(graph.nodes)) if (siblings.has(jointOwner(graph, id) ?? "")) blocked.add(id);
    const moving = new Set([joint.b.node, ...hw.filter((h) => MOVING_ROLES.has(h.role)).map((h) => h.id)]);
    const queue = [...moving];
    while (queue.length) {
      const id = queue.shift()!;
      for (const e of graph.edges) {
        const next = e.from === id ? e.to : e.to === id ? e.from : undefined;
        if (next && !moving.has(next) && !blocked.has(next)) {
          moving.add(next);
          queue.push(next);
        }
      }
    }
    const railed = decision.recipe === "rail" || decision.recipe === "belt_carriage";
    const span = railed ? (decision.dims.railLength! - decision.dims.carriage!) / 2 : 0;
    const limits: [number, number] =
      joint.motion === "revolute" ? statedLimits(graph, joint) : railed ? [-span, span] : [0, decision.dims.stroke ?? 0];
    const coupled = drivenWith(decision, pose).map((c) => ({ ...c, moving: c.moving.map((r) => hardwareId(joint.id, r)).filter((id) => graph.nodes[id]) }));
    out.push({ id: joint.id, type: joint.motion, node: joint.a.node, pose, axis: railed ? "x" : "z", limits, moving: [...moving], ...(coupled.length ? { coupled } : {}) });
  }
  return out;
}

/** A revolute joint's travel. Derived limits run to where the envelopes
 *  meet, which near the axis can be past where the real parts do (the hinged
 *  box's lid hit the box at 145°, the brief asked 110). When the brief states
 *  a travel, the sweep is that span from rest, toward the side that reaches
 *  it; a reach short of it keeps the derived limits and the travel lint says so. */
function statedLimits(graph: GraphDoc, joint: CadJoint): [number, number] {
  const [lo, hi] = joint.limits ?? [-180, 180];
  const span = joint.limitsSource === "derived" && joint.duty !== "continuous" ? statedTravel(graph.brief?.goal ?? "") : undefined;
  if (span === undefined) return [lo, hi];
  if (hi >= span) return [0, span];
  if (-lo >= span) return [-span, 0];
  return [lo, hi];
}

// ---------- Lint ----------

/** Walls the brief or either part's spec states as a number ("4mm thick"):
 *  a repair round must not change those. */
function statedWalls(graph: GraphDoc, j: CadJoint, i: JointInput): string[] {
  const text = [graph.brief?.goal, graph.nodes[j.a.node]?.spec, graph.nodes[j.b.node]?.spec].join(" ");
  const said = (n: number) => new RegExp(`(^|[^\\d.])${String(Math.round(n * 100) / 100).replace(".", "\\.")}\\s*mm`).test(text);
  return ([["wallA", i.wallA], ["wallB", i.wallB]] as const).filter(([, n]) => said(n)).map(([w, n]) => `${w} ${mm1(n)}`);
}
const mm1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

/** What the architect can change to make a joint fit: a declaration that
 *  lets another rule fit first, and a thicker wall only when nothing in the
 *  brief pins it. */
function jointRepair(graph: GraphDoc, joint: CadJoint): string {
  const input = jointInput(graph, joint);
  if ("error" in input) return "Fix the joint's ends and walls.";
  const d = selectJoint(input);
  if ("error" in d && d.error.includes("no joint rule supports")) return "No rule can mint it yet: drop prefer and let the rules pick, or declare that part as its own hardware node mated to both parts.";
  const escapes = jointEscapes(input);
  // A wall longer than a's material is a mis-declared wall, never a stated one.
  const past = input.depthA !== undefined && input.wallA > input.depthA + JOINT_FACE_TOL_MM;
  const pinned = statedWalls(graph, joint, input).filter((w) => !(past && w.startsWith("wallA")));
  const keep =
    (joint.prefer?.recipe || joint.prefer?.family ? `Keep prefer (${statedName(joint.prefer)}): the brief named it, so make room for it. ` : "") +
    (past ? `wallA is a's material behind a.port along the axis (${mm1(input.depthA!)} here), or move a.port to the face that has the wall behind it. ` : "") +
    (pinned.length ? `The brief states ${pinned.join(" and ")}: keep ${pinned.length > 1 ? "them" : "it"}. ` : "");
  if (escapes.length) return `${keep}${escapes.map((e) => e[0]!.toUpperCase() + e.slice(1)).join("; or ")}${pinned.length ? "" : "; or thicken the wall it names"}.`;
  return `${keep}${pinned.length ? "Change" : "Thicken the wall it names, change"} the joint's intent, load or access, or give a hint (threadHint, shaftHint).`;
}

/**
 * Every joint has a rule that fits, every expansion is the one its rule
 * produces today, and every piece of non-fastening hardware belongs to a joint
 * or is wired to a host feature. Plan time, so a shortfall ("j3: R4 wallB 3.0
 * < insert 5.8 + 1.2") is an architect repair round, not a failed cook.
 */
export const cadJointRuleLint = {
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    const ids = new Set<string>();
    const decisions = jointDecisions(graph);
    const pairs = new Map<string, string>();
    for (const { joint, decision } of decisions) {
      if (ids.has(joint.id)) problems.push(`joint ${joint.id}: declared twice; joint ids must be unique`);
      ids.add(joint.id);
      const pair = `${joint.a.node}.${joint.a.port}|${joint.b.node}.${joint.b.port}`;
      const first = pairs.get(pair);
      if (first && sharedOf(graph, joint.id) !== first) {
        problems.push(`joints ${first} and ${joint.id} both join ${joint.a.node}.${joint.a.port} to ${joint.b.node}.${joint.b.port}, so each mints its own hardware on the same axis and they clash. Make them one joint with count and pitch (a screw or dowel pattern), or give each its own a.port and b.port (a joint per guide rod).`);
      }
      pairs.set(pair, first ?? joint.id);
      // Facing apart with one spindle decision, expansion shares the axle (sharedAxles).
      const axle = (o: (typeof decisions)[number]) =>
        !("error" in o.decision) && !("error" in decision) && ["bushings", "bearings"].includes(decision.recipe) && decisionKey(o.decision) === decisionKey(decision) && coaxial(graph, o.joint, joint) === "apart";
      // One bearing per support (M1p, M1f): two joints on one b by design.
      const pairOnB = (o: (typeof decisions)[number]) => o.joint.b.node === joint.b.node && !("error" in decision) && ["M1p", "M1f"].includes(decision.rule);
      const other = !first && joint.motion !== "fixed" ? decisions.find((o) => o.joint !== joint && o.joint.motion !== "fixed" && coaxial(graph, o.joint, joint) && !axle(o) && !pairOnB(o) && spansMeet(graph, o.joint, joint)) : undefined;
      const repeatedA = other && other.joint.a.port === joint.a.port && other.joint.b.node === joint.b.node;
      if (repeatedA && decisions.indexOf(other) < decisions.findIndex((o) => o.joint === joint)) {
        // real-linear-actuator: four V-wheel joints with the wheel as a.
        problems.push(`joints ${other.joint.id} and ${joint.id} both name ${joint.a.node}.${joint.a.port} as a: a part placed several times (four identical wheels) is b in each joint, naming the SAME b.port, and the part it sits on (${joint.b.node}) is a, at its own port per joint.`);
      } else if (other && decisions.indexOf(other) < decisions.findIndex((o) => o.joint === joint) && sharedOf(graph, joint.id) !== other.joint.id && sharedOf(graph, other.joint.id) !== joint.id) {
        problems.push(`joints ${other.joint.id} and ${joint.id} both turn about one axis of ${joint.a.node}, so each mints its own shaft and bearings there and they clash. One joint per axis: what else turns on it (a gear on the drum's shaft, the crank on the pinion's) mates to that joint's b, or to its shaft; two joints on opposite faces of ${joint.a.node} facing apart share one axle.`);
      }
      if ("error" in decision) {
        problems.push(`joint ${decision.error}. ${jointRepair(graph, joint)}`);
        continue;
      }
      if (joint.prefer && (joint.prefer.recipe || joint.prefer.family) && !honours(decision, joint.prefer)) {
        problems.push(`joint ${joint.id}: the brief states ${statedName(joint.prefer)}, but rule ${decision.rule} picks ${decision.summary}. Stated hardware is binding.`);
      }
      if (joint.far && (joint.far.node === joint.a.node || !graph.nodes[joint.far.node])) {
        problems.push(`joint ${joint.id}: far must name the far end block as its own node (${joint.far.node} ${graph.nodes[joint.far.node] ? `is a` : "does not exist"}). Two end blocks are two nodes: one is a, the other is far.`);
      }
      for (const end of [joint.a, joint.b, ...(joint.far ? [joint.far] : [])]) {
        const nd = graph.nodes[end.node];
        if (nd && !payloadOf(nd).ports?.some((p) => p.name === end.port)) {
          problems.push(`joint ${joint.id}: ${end.node} has no port "${end.port}". A joint end names the FLAT_FACE port on that part where the joint sits (+z toward the other part).`);
        }
      }
      const was = (graph.joints.find((j) => j.id === joint.id) as { expanded?: string } | undefined)?.expanded;
      if (was === undefined) {
        const unframed = [joint.a, joint.b].flatMap((end) => {
          const port = payloadOf(graph.nodes[end.node] ?? { contract: {} }).ports?.find((p) => p.name === end.port);
          try {
            if (port) frameOf(port.pose);
            return [];
          } catch (err) {
            return [`${end.node}.${end.port}: ${(err as Error).message}`];
          }
        });
        const missing = [joint.a, joint.b].some((end) => !payloadOf(graph.nodes[end.node] ?? { contract: {} }).ports?.some((p) => p.name === end.port));
        const failed = (graph.joints.find((j) => j.id === joint.id) as { failed?: string } | undefined)?.failed;
        const why = [...unframed, ...(failed ? [failed] : [])];
        if (!missing) problems.push(`joint ${joint.id}: was never expanded into hardware${why.length ? ` — ${why.join("; ")}` : ""}.`);
        continue;
      }
      if (was !== decisionKey(decision)) {
        problems.push(`joint ${joint.id}: its hardware is not what rule ${decision.rule} picks today (${decision.summary}); re-expand the plan rather than editing joint hardware by hand.`);
        continue;
      }
      for (const end of [joint.a, joint.b]) {
        const ring = payloadOf(graph.nodes[end.node]!).ports.find((p) => p.name === end.port && p.type === "FLAT_FACE")?.params.ring_diameter;
        const room = faceRoom(graph, end.node, end.port);
        let d: number | undefined;
        try {
          d = ring === undefined ? undefined : resolveDim(graph, ring as D);
        } catch {
          // an unresolvable ring is cadExpressionsResolveLint's to report
        }
        if (d !== undefined && room !== undefined && d > room + 0.01) {
          problems.push(`joint ${joint.id}: ${end.node}.${end.port}'s probe ring is Ø${mm1(d)}, but the face holds only Ø${mm1(room)} around its centre (its envelope), so G3 can never pass it. Make the face bigger, bring the pattern in (pitch), or use smaller hardware.`);
        }
      }
      const owner = sharedOf(graph, joint.id) ?? joint.id;
      for (const p of decision.parts) {
        const id = hardwareId(owner, p.role);
        const nd = graph.nodes[id];
        if (!nd) problems.push(`joint ${joint.id}: ${id} is missing; the joint's hardware is minted, never declared.`);
        else if (nd.kind !== CATALOG.families[p.family]!.kind) problems.push(`joint ${joint.id}: ${id} is a ${nd.kind}, rule ${decision.rule} mints a ${CATALOG.families[p.family]!.kind}`);
      }
    }
    // Hardware outside every joint: fasteners answer to cadFastenerJustifiedLint,
    // the rest must at least sit in a host feature.
    const owned = new Set(decisions.flatMap(({ joint, decision }) =>
      "error" in decision ? [] : decision.parts.map((p) => hardwareId(sharedOf(graph, joint.id) ?? joint.id, p.role))));
    const hosted = new Set([...HARDWARE_PORT_TYPES, "SHAFT", "BORE"]);
    const MOTION_KINDS = new Set(["bearing", "bushing", "shaft", "collar", "eclip", "linear_bearing", "rail", "carriage", "motor"]);
    for (const nd of Object.values(graph.nodes)) {
      if (!MOTION_KINDS.has(nd.kind) || owned.has(nd.id)) continue;
      const wired = graph.edges.some((e) => {
        const [other, port] = e.from === nd.id ? [e.to, e.toPort] : e.to === nd.id ? [e.from, e.fromPort] : [];
        const host = other ? graph.nodes[other] : undefined;
        return !!host && payloadOf(host).ports?.some((p) => p.name === port && hosted.has(p.type));
      });
      if (!wired) {
        problems.push(`${nd.id}: a ${nd.kind} that no joint owns and no host feature holds. Declare a joint with motion (revolute/prismatic) and intent between the two parts instead; the rules pick the ${nd.kind}.`);
      }
    }
    return problems;
  },
};

/** Ports of joint-owned hardware are mate frames, not features to probe. */
export function isJointHardware(graph: GraphDoc, nodeId: string): boolean {
  return nodeId.includes("_") && !!jointOwner(graph, nodeId);
}
