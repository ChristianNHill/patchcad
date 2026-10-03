import type { ArchitectOutput } from "@patchcad/engine";
import type { GraphDoc, JointDecl, NodeRecord, ParamValue } from "@patchcad/shared";
import type { CadContractPayload, Pose } from "./index.js";
import { CATALOG, dim, familyDims, skuFor } from "./catalog.js";
import { CadJoint, FDM_MIN_WALL_MM, selectJoint, type HardwarePick, type JointDecision, type JointInput, type Lin, type JointProcess } from "./joints.js";
import { resolveBinding, resolveDim, resolvePose, type NumericPose } from "./bindings.js";
import type { JointAxisDef } from "./assembly.js";
import { SEAT_POSE } from "./grounding.js";
import { sourcingOf } from "./sourcing.js";

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

/** Roles that turn with b; everything else a joint mints holds still with a. */
export const MOVING_ROLES = new Set(["shaft", "collar", "eclip", "linear_bearing", "carriage"]);

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

function processOf(node: Pick<NodeRecord, "kind" | "contract">): { process: JointProcess; material?: string } {
  const s = sourcingOf(node);
  const metal = s.process === "cnc" || s.process === "sheet_metal" || s.process === "laser_cut";
  return { process: metal ? "CNC" : "FDM", material: s.material };
}

type Live = Record<string, Record<string, ParamValue>>;

/** A minimal graph for T1 resolution over an emission: contracts, plus the
 *  live param values when expanding a graph someone has been editing. */
function asGraph(out: ArchitectOutput, live: Live = {}): GraphDoc {
  return {
    nodes: Object.fromEntries(out.nodes.map((n) => [n.id, { id: n.id, params: { ...live[n.id] }, contract: n.contract }])),
  } as unknown as GraphDoc;
}

/** selectJoint's input for a declared joint, walls resolved. */
export function jointInput(graph: GraphDoc, j: CadJoint): JointInput | { error: string } {
  const a = graph.nodes[j.a.node];
  const b = graph.nodes[j.b.node];
  if (!a || !b) return { error: `${j.id}: joins ${!a ? j.a.node : j.b.node}, which is not a node` };
  let wallA: number, wallB: number, lateral: number | undefined;
  try {
    wallA = resolveDim(graph, j.wallA);
    wallB = resolveDim(graph, j.wallB);
    lateral = j.lateral === undefined ? undefined : resolveDim(graph, j.lateral);
  } catch (err) {
    return { error: `${j.id}: ${(err as Error).message}` };
  }
  const pa = processOf(a);
  const pb = processOf(b);
  return {
    id: j.id, intent: j.intent, motion: j.motion, duty: j.duty, driven: j.driven, speedClass: j.speedClass,
    torqueClass: j.torqueClass, precise: j.precise, load: j.load, access: j.access, wallA, wallB, lateral,
    processA: pa.process, processB: pb.process, materialB: pb.material,
    minWall: (payloadOf(b).process?.minWall as number | undefined) ?? FDM_MIN_WALL_MM,
    flush: j.flush, count: j.count, threadHint: j.threadHint, shaftHint: j.shaftHint, strokeMm: j.strokeMm,
    allowPrinted: j.allowPrinted,
  };
}

/** What a decision fixes, lengths aside: when this changes, the joint is
 *  re-expanded; when only a length moves, T1 already followed it. */
export function decisionKey(d: JointDecision): string {
  return [d.rule, ...d.parts.map((p) => `${p.role}=${p.family}:${p.key}`)].join("|");
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

  addPort(node: OutNode, side: "provides" | "requires", port: CadPortT, declType: string = port.type, description = "") {
    payloadOf(node).ports.push(port);
    node.contract[side].push({ key: port.name, type: declType, description });
  }

  /** A host param, bound by T1 to the hardware it hosts. Its default is
   *  resolved here, so the first cook already sees the catalog number. */
  bindings: { node: OutNode; name: string; binding: string }[] = [];
  addParam(node: OutNode, name: string, description: string, binding: string) {
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
    const lengthDefault = typeof length === "number" ? length : pick.length;
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
    for (const p of ports) this.addPort(node, p.side, p.port, p.decl);
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

/** Remove everything a joint minted, so expansion can run again. */
function unmint(out: ArchitectOutput, joint: CadJoint) {
  const v = jointVar(joint.id);
  const minted = (id: string) => id.startsWith(`${joint.id}_`) || id.startsWith(`${joint.id}-`);
  out.nodes = out.nodes.filter((n) => !minted(n.id));
  const mine = (name: string) => name.startsWith(`${v}_`);
  for (const n of out.nodes) {
    if (n.id !== joint.a.node && n.id !== joint.b.node) continue;
    const p = payloadOf(n);
    p.ports = p.ports.filter((x) => !mine(x.name));
    n.contract.provides = n.contract.provides.filter((x) => !mine(x.key));
    n.contract.requires = n.contract.requires.filter((x) => !mine(x.key));
    n.contract.params = n.contract.params.filter((x) => !mine(x.name));
    p.paramBindings = Object.fromEntries(Object.entries(p.paramBindings ?? {}).filter(([k]) => !mine(k)));
  }
  out.edges = out.edges.filter((e) => !minted(e.from) && !minted(e.to) && !mine(e.fromPort) && !mine(e.toPort));
}

// ---------- Recipes ----------

interface Ctx {
  x: Expansion;
  j: CadJoint;
  v: string;
  d: JointDecision;
  A: OutNode;
  B: OutNode;
  fa: Frame;
  fb: Frame;
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
  ringFace(c, A, j.a.port, sum(`param(${A.id}.${v}_clear)`, 2 * rho + 1.2));
  ringFace(c, B, j.b.port, sum(faceFeature, 2 * rho + 1.2));
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
    // Centred on the joint plane, half in each part.
    x.mint(j.id, pin, d.summary, [{ side: "requires", port: { name: "center", type: "FLAT_FACE", pose: INSET_POSE as unknown as Pose, params: { ring_diameter: d.dims.d! / 2 } }, decl: "DOWEL_HOLE" }]);
    at_.forEach(([u, w], k) => {
      x.addPort(A, "provides", { name: name("dowel_a", k), type: "DOWEL_HOLE", pose: at(fa, u, w, 0), params: { diameter: `param(${A.id}.${v}_dowel_d)`, depth: d.dims.depth!, fit: "press" } });
      x.addPort(B, "provides", { name: name("dowel_b", k), type: "DOWEL_HOLE", pose: at(fb, u, -w, 0), params: { diameter: `param(${B.id}.${v}_dowel_d)`, depth: d.dims.depth!, fit: "slip" } });
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
  ringFace(c, A, j.a.port, sum(dowelD(A), 2 * rho + 1.2));
  ringFace(c, B, j.b.port, sum(dowelD(B), 2 * rho + 1.2));
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
  const [ida, idb, sid, kid] = [hardwareId(j.id, ra), hardwareId(j.id, rb), hardwareId(j.id, shaft.role), hardwareId(j.id, keep.role)];
  unmate(c);

  x.addParam(A, `${v}_seat_od`, `${seatType === "BEARING_SEAT" ? "bearing" : "bushing"} OD for ${j.id}`, `hw:bearingSeatD:param:${ida}.sku`);
  x.addParam(A, `${v}_seat_w`, `seat depth for ${j.id}`, bushing ? `param:${ida}.length` : `hw:bearingWidth:param:${ida}.sku`);
  const seatParams: CadPortT["params"] = bushing
    ? { od: `param(${A.id}.${v}_seat_od)`, length: `param(${A.id}.${v}_seat_w)` }
    : { od: `param(${A.id}.${v}_seat_od)`, width: `param(${A.id}.${v}_seat_w)`, fit: "press" };
  x.addPort(A, "provides", { name: `${v}_seat_a`, type: seatType, pose: at(fa, 0, 0, 0), params: seatParams });
  x.addPort(A, "provides", { name: `${v}_seat_b`, type: seatType, pose: at(fa, 0, 0, times(-1, j.wallA), true), params: seatParams });

  const seatPorts = (role: HardwarePick) => [
    { side: "requires" as const, port: { name: "seat", type: "FLAT_FACE" as const, pose: INSET_POSE as unknown as Pose, params: { ring_diameter: n(role, "od") - 1 } }, decl: seatType },
    { side: "provides" as const, port: { name: "bore", type: "FLAT_FACE" as const, pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: d.dims.d! + 1 } }, decl: "FLAT_FACE" },
  ];
  x.mint(j.id, part(d, ra)!, d.summary, seatPorts(part(d, ra)!));
  x.mint(j.id, part(d, rb)!, d.summary, seatPorts(part(d, rb)!));
  x.addEdge(A.id, `${v}_seat_a`, ida, "seat");
  x.addEdge(A.id, `${v}_seat_b`, idb, "seat");

  // A collar outside each seat: one node, two placements.
  x.mint(j.id, keep, d.summary, [{ side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: SEAT_POSE as unknown as Pose, params: { ring_diameter: d.dims.d! + 1 } }, decl: "FLAT_FACE" }]);
  x.addEdge(ida, "bore", kid, "seat");
  x.addEdge(idb, "bore", kid, "seat");

  // The shaft starts kw below a's far face (under the outer collar) and ends
  // flush with b's far face, through b's hub.
  const hubAt = sum(2 * kw, j.wallA);
  x.mint(j.id, shaft, d.summary, [
    { side: "requires", port: { name: "end", type: "FLAT_FACE", pose: pose([0, 0, kw]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "FLAT_FACE" },
    { side: "provides", port: { name: "hub", type: "FLAT_FACE", pose: pose([0, 0, hubAt]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "HUB_BORE" },
  ], sum(hubAt, j.wallB));
  x.addEdge(idb, "bore", sid, "end");

  x.addParam(B, `${v}_shaft_d`, `shaft Ø for ${j.id}`, `hw:shaftD:param:${sid}.sku`);
  const hub: CadPortT["params"] = { diameter: `param(${B.id}.${v}_shaft_d)` };
  if (shaft.family === "d_shaft") {
    x.addParam(B, `${v}_flat`, `D-flat distance from the axis for ${j.id}`, `hw:hubFlat:param:${sid}.sku`);
    hub.flat = `param(${B.id}.${v}_flat)`;
  }
  x.addPort(B, "requires", { name: `${v}_hub`, type: "HUB_BORE", pose: at(fb, 0, 0, 0), params: hub });
  x.addEdge(sid, "hub", B.id, `${v}_hub`);
  ringFace(c, A, j.a.port, sum(`param(${A.id}.${v}_seat_od)`, 2.4));
  ringFace(c, B, j.b.port, sum(`param(${B.id}.${v}_shaft_d)`, 2.4));
}

function printedPin(c: Ctx) {
  const { x, j, v, d, A, B, fa, fb } = c;
  x.addPort(A, "provides", { name: `${v}_pin`, type: "SHAFT", pose: at(fa, 0, 0, 0), params: { diameter: d.dims.d!, length: j.wallB } });
  x.addPort(B, "provides", { name: `${v}_pin_bore`, type: "BORE", pose: at(fb, 0, 0, 0), params: { diameter: d.dims.bore! } });
  faceMate(c);
  ringFace(c, A, j.a.port, d.dims.d! + 2.4);
  ringFace(c, B, j.b.port, d.dims.bore! + 2.4);
}

function rodSlide(c: Ctx) {
  const { x, j, v, d, A, B, fa, fb } = c;
  const rod = part(d, "rod")!;
  const lm = part(d, "linear_bearing")!;
  const [rid, lid] = [hardwareId(j.id, "rod"), hardwareId(j.id, "linear_bearing")];
  unmate(c);
  const socket = sum(j.wallA, -FDM_MIN_WALL_MM);
  x.addParam(A, `${v}_rod_d`, `rod Ø for ${j.id}`, `hw:shaftD:param:${rid}.sku`);
  x.addPort(A, "provides", { name: `${v}_rod`, type: "BORE", pose: at(fa, 0, 0, 0), params: { diameter: `param(${A.id}.${v}_rod_d)` } });
  // Socketed in a, out along a's +z through b, long enough for the stroke.
  x.mint(j.id, rod, d.summary, [
    { side: "requires", port: { name: "end", type: "FLAT_FACE", pose: pose([0, 0, socket], [0, 0, -1]), params: { ring_diameter: d.dims.d! / 2 } }, decl: "BORE" },
    { side: "provides", port: { name: "slide", type: "FLAT_FACE", pose: pose([0, 0, sum(socket, 1)]), params: { ring_diameter: d.dims.d! + 1 } }, decl: "FLAT_FACE" },
  ], sum(socket, 1, d.dims.stroke!, j.wallB));
  x.addEdge(A.id, `${v}_rod`, rid, "end");
  x.addParam(B, `${v}_lm_od`, `linear bearing OD for ${j.id}`, `hw:bearingSeatD:param:${lid}.sku`);
  x.addPort(B, "provides", { name: `${v}_lm_seat`, type: "BEARING_SEAT", pose: at(fb, 0, 0, 0), params: { od: `param(${B.id}.${v}_lm_od)`, width: d.dims.length!, fit: "press" } });
  x.mint(j.id, lm, d.summary, [
    { side: "requires", port: { name: "seat", type: "FLAT_FACE", pose: INSET_POSE as unknown as Pose, params: { ring_diameter: d.dims.od! - 1 } }, decl: "BEARING_SEAT" },
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
  if (!A.contract.provides.some((p) => p.key === j.a.port)) A.contract.provides.push({ key: j.a.port, type: "FLAT_FACE", description: `joint ${j.id} rail` });
  x.addEdge(A.id, j.a.port, rid, "seat");
  x.addEdge(A.id, j.a.port, cid, "seat");
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
  if (motor.family === "nema17" || motor.family === "n20") {
    // Under a, shaft up through it into b, 1mm clear of a's face.
    mountPose = at(fa, 0, 0, times(-1, j.wallA), true);
    mountParams =
      motor.family === "nema17"
        ? { pilot_diameter: `param(${A.id}.${v}_pilot)`, hole_diameter: clear(String(row.holeThread)), pitch_x: g("holePitch"), pitch_y: g("holePitch") }
        : { pilot_diameter: round(g("shaftD") + 1), hole_diameter: round(g("holeD") + 0.2), pcd: g("pcd"), count: 2 };
    if (motor.family === "nema17") x.addParam(A, `${v}_pilot`, `motor pilot Ø for ${j.id}`, `hw:motorPilot:param:${mid}.sku`);
    out = pose([0, 0, times(-1, sum(j.wallA, 1))], [0, 0, -1]);
  } else if (motor.family === "brushless") {
    mountPose = at(fa, 0, 0, 0);
    x.addParam(A, `${v}_pcd`, `motor bolt circle for ${j.id}`, `hw:motorPcd:param:${mid}.sku`);
    mountParams = { pilot_diameter: round(g("shaftD") + 3), hole_diameter: clear(String(row.holeThread)), pcd: `param(${A.id}.${v}_pcd)`, count: g("holeCount"), start_angle: 45 };
    out = pose([0, 0, round(g("baseH") + g("bellH") + 0.5)]);
  } else {
    // SG90: tabs on a's face, case through a cut-out, spline on the axis.
    const sx = round(g("bodyL") / 2 - g("bossD") / 2);
    mountType = "HOLE_PATTERN";
    mountPose = at(fa, -sx, 0, 0);
    mountParams = { diameter: round(g("holeD") + 0.2), nx: 2, ny: 1, pitch_x: g("holePitch"), pitch_y: 1 };
    const top = g("bodyH") - g("tabZ") + g("bossH") + g("splineH");
    out = pose([sx, 0, round(top - d.dims.engage!)]);
  }
  x.mint(j.id, motor, d.summary, [
    { side: "requires", port: { name: "mount", type: "FLAT_FACE", pose: motorMount, params: { ring_diameter: d.dims.d! + 2 } }, decl: mountType },
    { side: "provides", port: { name: "shaft", type: "FLAT_FACE", pose: out, params: { ring_diameter: d.dims.d! / 2 } }, decl: "HUB_BORE" },
  ]);
  x.addPort(A, "provides", { name: `${v}_motor_mount`, type: mountType, pose: mountPose, params: mountParams },
    mountType, motor.family === "sg90" ? `servo tab screws; cut a ${g("bodyL") + 0.6}×${g("bodyW") + 0.6} opening for the case, centred here` : "");
  x.addEdge(A.id, `${v}_motor_mount`, mid, "mount");
  const hub: CadPortT["params"] = { diameter: d.dims.d! };
  if (motor.family === "nema17" || motor.family === "n20") hub.flat = round(g("shaftD") / 2 - g("flatDepth"));
  x.addPort(B, "requires", { name: `${v}_hub`, type: "HUB_BORE", pose: at(fb, 0, 0, 0), params: hub });
  x.addEdge(mid, "shaft", B.id, `${v}_hub`);
  ringFace(c, A, j.a.port, motor.family === "brushless" ? g("baseD") + 2.4 : d.dims.d! + 4);
  ringFace(c, B, j.b.port, d.dims.d! + 2.4);
}

const RECIPES: Record<JointDecision["recipe"], ((c: Ctx) => void) | undefined> = {
  tapped: fastener,
  through_bolt: fastener,
  insert: fastener,
  nut_trap: fastener,
  side_nut_trap: fastener,
  dowel: dowels,
  peg: dowels,
  bearings: spindle,
  bushings: spindle,
  printed_pin: printedPin,
  rod_slide: rodSlide,
  rail,
  direct_drive: directDrive,
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
  for (const j of joints) if (j.success) unmint(out, j.data);
  const x = new Expansion(out, live);
  const kept: JointDecl[] = [];
  joints.forEach((parsed, i) => {
    const raw = out.joints![i]!;
    if (!parsed.success) return void kept.push(raw);
    const j = parsed.data;
    const A = out.nodes.find((nd) => nd.id === j.a.node);
    const B = out.nodes.find((nd) => nd.id === j.b.node);
    const inp = A && B ? jointInput(x.graph, j) : { error: "unknown node" };
    const decision = "error" in inp ? inp : selectJoint(inp);
    const recipe = "error" in decision ? undefined : RECIPES[decision.recipe];
    if ("error" in decision || !recipe || !A || !B) return void kept.push(j);
    try {
      if (!payloadOf(A).ports.some((p) => p.name === j.a.port) || !payloadOf(B).ports.some((p) => p.name === j.b.port)) {
        return void kept.push(j);
      }
      recipe({ x, j, v: jointVar(j.id), d: decision, A, B, fa: frameOf(x.port(A, j.a.port).pose), fb: frameOf(x.port(B, j.b.port).pose) });
      kept.push({ ...j, expanded: decisionKey(decision) } as JointDecl);
    } catch {
      kept.push(j);
    }
  });
  x.settle();
  for (const { node, name, binding } of x.bindings) {
    const was = cached.get(`${node.id}.${name}`);
    const p = node.contract.params.find((q) => q.name === name);
    if (p && was?.binding === binding && was.value !== undefined) (p as { default: unknown }).default = was.value;
  }
  // The plan's own edges first, then the minted ones, so a re-expansion lists
  // a face mate it added last time exactly where this one does.
  const minted = (e: OutEdge) => [e.from, e.to].some((id) => id.includes("_")) || [e.fromPort, e.toPort].some((p) => /_/.test(p) && kept.some((j) => p.startsWith(`${jointVar(j.id)}_`)));
  out.edges = [...out.edges.filter((e) => !minted(e)), ...out.edges.filter(minted)];
  out.joints = kept;
  return out;
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

// ---------- Kinematics ----------

/**
 * Every motion joint's axis, in a's frame at a's joint port, and the nodes
 * that move with b: b itself, the hardware that turns with it (shaft,
 * collars, carriage), and anything mated onward from those, never crossing
 * back into a or the hardware that holds still (bearings, rail, motor).
 */
export function jointAxes(graph: GraphDoc): JointAxisDef[] {
  const out: JointAxisDef[] = [];
  for (const { joint, decision } of jointDecisions(graph)) {
    if (joint.motion === "fixed" || "error" in decision) continue;
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
    const span = decision.recipe === "rail" ? (decision.dims.railLength! - decision.dims.carriage!) / 2 : 0;
    const limits: [number, number] =
      joint.motion === "revolute" ? (joint.limits ?? [-180, 180]) : decision.recipe === "rail" ? [-span, span] : [0, decision.dims.stroke ?? 0];
    out.push({ id: joint.id, type: joint.motion, node: joint.a.node, pose, axis: decision.recipe === "rail" ? "x" : "z", limits, moving: [...moving] });
  }
  return out;
}

// ---------- Lint ----------

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
    for (const { joint, decision } of jointDecisions(graph)) {
      if (ids.has(joint.id)) problems.push(`joint ${joint.id}: declared twice; joint ids must be unique`);
      ids.add(joint.id);
      if ("error" in decision) {
        problems.push(`joint ${decision.error}. Thicken the wall it names, change the joint's intent, load or access, or give a hint (threadHint, shaftHint).`);
        continue;
      }
      for (const end of [joint.a, joint.b]) {
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
        if (!missing) problems.push(`joint ${joint.id}: was never expanded into hardware${unframed.length ? ` — ${unframed.join("; ")}` : ""}.`);
        continue;
      }
      if (was !== decisionKey(decision)) {
        problems.push(`joint ${joint.id}: its hardware is not what rule ${decision.rule} picks today (${decision.summary}); re-expand the plan rather than editing joint hardware by hand.`);
        continue;
      }
      for (const p of decision.parts) {
        const id = hardwareId(joint.id, p.role);
        const nd = graph.nodes[id];
        if (!nd) problems.push(`joint ${joint.id}: ${id} is missing; the joint's hardware is minted, never declared.`);
        else if (nd.kind !== CATALOG.families[p.family]!.kind) problems.push(`joint ${joint.id}: ${id} is a ${nd.kind}, rule ${decision.rule} mints a ${CATALOG.families[p.family]!.kind}`);
      }
    }
    // Hardware outside every joint: fasteners answer to cadFastenerJustifiedLint,
    // the rest must at least sit in a host feature.
    const owned = new Set(jointDecisions(graph).flatMap(({ joint, decision }) =>
      "error" in decision ? [] : decision.parts.map((p) => hardwareId(joint.id, p.role))));
    const hosted = new Set(["THREADED_HOLE", "INSERT_POCKET", "NUT_TRAP", "COUNTERBORE", "COUNTERSINK", "DOWEL_HOLE", "BEARING_SEAT", "BUSHING_BORE", "MOTOR_MOUNT", "MAGNET_POCKET", "HUB_BORE", "SHAFT", "BORE"]);
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
