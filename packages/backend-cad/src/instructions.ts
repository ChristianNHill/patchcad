import type { GraphDoc, NodeRecord } from "@patchcad/shared";
import { mergedParams, type CadContractPayload } from "./index.js";
import { mul, poseToMat, transformPoint, type KinematicJoint, type Mat4 } from "./assembly.js";
import { resolveDim, resolvePose, type NumericPose } from "./bindings.js";
import { buildBom } from "./bom.js";
import { CATALOG, familyDims, type Sku } from "./catalog.js";
import { jointOwner } from "./expand.js";
import { hardwareAllowances, threadAllowances } from "./g5.js";
import type { KernelClient } from "./kernel.js";
import { skuOf } from "./registry.js";
import { sourcingOf } from "./sourcing.js";

/**
 * Assembly instructions, IKEA-style, from the graph alone — zero LLM calls.
 *
 * The order grows from a base part along the mates. Hardware joins the step
 * whose joint it fastens; heat-set inserts go in first, on the loose part;
 * bearings before the shaft through them, collars and anything else riding
 * the shaft after it; a belt after both its pulleys. A branch that only
 * touches the rest through one mate is built on its own and attached as one
 * (a sub-assembly). The kernel then sweeps each step's new parts in along
 * their approach (G5's prismatic sweep) and a blocked step is re-ordered or
 * reported, never printed as if it worked.
 *
 * Approach: a part is placed by mating one of its ports to a port on a part
 * already there, and ports point OUT of their mating face, so the part
 * travels along its own port's +z to get there.
 */

type Vec3 = [number, number, number];

export type StepAction = "press" | "insert" | "screw" | "slide" | "place" | "snap" | "attach";

export interface StepHardware {
  sku: string;
  description: string;
  qty: number;
  tool?: string;
  nodes: string[];
}

export interface AssemblyStep {
  n: number;
  title: string;
  action: StepAction;
  /** Made (printed or fabricated) parts this step places. */
  parts: { nodeId: string; qty: number }[];
  /** Bought parts this step places, by BOM sku. */
  hardware: StepHardware[];
  /** The sub-assembly this step builds, or attaches when action is "attach". */
  subassembly?: string;
  /** The node a sub-assembly's first step starts from (placed by that step). */
  holds?: string;
  /** The way the new parts travel to their pose. */
  direction: Vec3;
  notes: string[];
  /** Placed copies drawn as already there (`node`, `node#i`). */
  context: string[];
  /** Copies new in this step, each with the way it travels; stage 1 (the
   *  screws of a part placed in the same step) goes in after stage 0.
   *  `clearMm`: how far it rides a shaft already in place before it is free
   *  to move sideways. */
  moving: { key: string; direction: Vec3; stage?: number; clearMm?: number; held?: boolean }[];
}

export interface Subassembly {
  id: string;
  title: string;
  root: string;
  nodes: string[];
}

export interface AssemblySequence {
  base: string;
  steps: AssemblyStep[];
  subassemblies: Subassembly[];
  sequenceProblems: string[];
}

export interface SequenceOptions {
  /** [x, y]: x goes in before y (a sweep found y blocking x's way in). */
  before?: [string, string][];
  /** Sub-assembly roots to build in place instead (their attach was blocked). */
  dissolve?: string[];
  /** Parts that ride a shaft but cannot come in along it (a drum between two
   *  frame walls): held in place first, and the shaft goes through them. */
  held?: string[];
}

interface SceneLike {
  instances: Record<string, Mat4[]>;
  joints?: KinematicJoint[];
}

interface Copy {
  key: string;
  node: string;
  matrix: Mat4;
}

interface Link {
  self: Copy;
  port: string;
  other: Copy;
  otherPort: string;
}

const BEARINGS = new Set(["bearing", "bushing", "linear_bearing"]);
const FASTENERS = new Set(["fastener", "nut", "washer"]);
/** Pressed into one loose part before any parts meet. */
const PREINSTALLED = new Set(["insert", "magnet"]);
const ON_SHAFT = new Set(["collar", "eclip", "washer", "pulley", "gear"]);
const PORT_TOL_MM = 0.05;

/** ISO 4026 set screws: hex key across flats per thread. */
const SET_SCREW_KEY: Record<string, number> = { M2: 0.9, "M2.5": 1.3, M3: 1.5, M4: 2, M5: 2.5, M6: 3, M8: 4 };

const NOUN: Record<string, string> = {
  shcs: "socket head screw", button: "button head screw", csk: "countersunk screw", hex_nut: "hex nut",
  heatset_std: "heat-set insert", heatset_short: "short heat-set insert", washer: "washer", dowel: "dowel pin",
  threaded_rod: "threaded rod", bearing: "ball bearing", bearing_flanged: "flanged ball bearing", bushing: "bushing",
  shaft: "shaft", d_shaft: "D-shaft", collar: "shaft collar", eclip: "e-clip", lm_uu: "linear bearing",
  mgn_rail: "linear rail", mgn_carriage: "rail carriage", gt2_pulley: "GT2 pulley", gt2_idler: "GT2 idler",
  gt2_belt: "GT2 belt", gt2_loop: "GT2 closed belt", spur_gear: "spur gear", coupler: "shaft coupler",
  lead_screw: "lead screw", lead_nut: "lead screw nut", nema17: "stepper motor", brushless: "brushless motor",
  n20: "gear motor", sg90: "servo", disc_magnet: "disc magnet", oring: "O-ring", standoff: "standoff",
};

/** "the M3 insert", "4× M3 inserts". */
function counted(qty: number, label: string, one = "1×"): string {
  return qty > 1 ? `${qty}× ${/[a-z]$/i.test(label) && !/s$/.test(label) ? `${label}s` : label}` : `${one} ${label}`;
}

const unit = (v: number[]): Vec3 => {
  const n = Math.hypot(...v) || 1;
  return v.map((c) => Math.round((c / n) * 1e6) / 1e6) as Vec3;
};

function lengthOf(node: NodeRecord): number | undefined {
  const len = Number(mergedParams(node).length);
  return Number.isFinite(len) && len > 0 ? len : undefined;
}

/** "M3×10 button head screw", "625 ball bearing", "158 mm GT2 closed belt". */
export function hardwareLabel(node: NodeRecord, sku: Sku | null = skuOf(node)): string {
  if (!sku) return node.title;
  const noun = NOUN[sku.family] ?? sku.family;
  const len = sku.length ?? lengthOf(node);
  const pulley = /^(\d+)T-(\d+(?:\.\d+)?)$/.exec(sku.key);
  if (pulley) return `${noun} (${pulley[1]} teeth, ${pulley[2]} mm bore)`;
  if (sku.family === "gt2_loop" || sku.family === "gt2_belt") return `${noun} (${len ? `${len} mm long, ` : ""}${sku.key} mm wide)`;
  const size = /^\d+(\.\d+)?$/.test(sku.key) && !BEARINGS.has(CATALOG.families[sku.family]!.kind) ? `Ø${sku.key}` : sku.key;
  return `${size}${len && CATALOG.families[sku.family]!.lengths ? `×${len}` : ""} ${noun}`;
}

/** What you need in your hand to fit this part, from its catalog row. */
export function toolFor(node: NodeRecord, sku: Sku | null = skuOf(node)): string | undefined {
  if (!sku) return undefined;
  const row = familyDims(sku.family, sku.key) ?? {};
  const n = (k: string) => (typeof row[k] === "number" ? (row[k] as number) : undefined);
  if (sku.family.startsWith("heatset")) return "soldering iron with a heat-set tip";
  if (n("socketAf")) return `${n("socketAf")} mm hex key`;
  if (sku.family === "hex_nut" || sku.family === "standoff") return n("af") ? `${n("af")} mm spanner` : undefined;
  const set = typeof row.setScrew === "string" ? SET_SCREW_KEY[row.setScrew] : undefined;
  return set ? `${set} mm hex key (set screw)` : undefined;
}

function portsOf(graph: GraphDoc, node: NodeRecord): Record<string, NumericPose> {
  const out: Record<string, NumericPose> = {};
  for (const p of (node.contract.payload as CadContractPayload | undefined)?.ports ?? []) {
    try {
      out[p.name] = resolvePose(graph, p.pose);
    } catch {
      // unresolvable: the solver already reports it
    }
  }
  return out;
}

function volumeOf(graph: GraphDoc, node: NodeRecord): number {
  const measured = (node.measurements?.data as { volume_mm3?: unknown } | undefined)?.volume_mm3;
  if (typeof measured === "number") return measured;
  let v = 0;
  for (const vol of (node.contract.payload as CadContractPayload | undefined)?.envelope?.volumes ?? []) {
    try {
      v += vol.kind === "box"
        ? vol.dims.reduce<number>((a, d) => a * resolveDim(graph, d), 1)
        : Math.PI * (resolveDim(graph, vol.d) / 2) ** 2 * resolveDim(graph, vol.h);
    } catch {
      // an unresolvable envelope counts for nothing
    }
  }
  return v;
}

/** Every placed copy, and which copy's port meets which: the mates at copy level. */
function copyLinks(graph: GraphDoc, scene: SceneLike) {
  const copies = new Map<string, Copy[]>();
  for (const id of Object.keys(graph.nodes)) {
    const placed = scene.instances[id]?.length ? scene.instances[id]! : [];
    copies.set(id, placed.map((matrix, i) => ({ key: i === 0 ? id : `${id}#${i}`, node: id, matrix })));
  }
  const ports = new Map(Object.values(graph.nodes).map((n) => [n.id, portsOf(graph, n)]));
  const links: Link[] = [];
  for (const e of graph.edges) {
    const pa = ports.get(e.from)?.[e.fromPort];
    const pb = ports.get(e.to)?.[e.toPort];
    if (!pa || !pb) continue;
    for (const a of copies.get(e.from) ?? []) {
      const at = transformPoint(a.matrix, pa.origin);
      for (const b of copies.get(e.to) ?? []) {
        if (Math.hypot(...transformPoint(b.matrix, pb.origin).map((c, i) => c - at[i]!)) > PORT_TOL_MM) continue;
        links.push({ self: a, port: e.fromPort, other: b, otherPort: e.toPort });
        links.push({ self: b, port: e.toPort, other: a, otherPort: e.fromPort });
      }
    }
  }
  /** The way a copy travels when this link places it: along its own port's +z. */
  const approach = (l: Link): Vec3 => {
    const m = mul(l.self.matrix, poseToMat(ports.get(l.self.node)![l.port]!));
    return unit([m[8]!, m[9]!, m[10]!]);
  };
  const portAt = (l: Link) => transformPoint(l.self.matrix, ports.get(l.self.node)![l.port]!.origin);
  return { copies, links, approach, portAt };
}

/** The order, from the mates; no geometry is consulted (see feasibleSequence). */
export function buildSequence(graph: GraphDoc, scene: SceneLike, opts: SequenceOptions = {}): AssemblySequence {
  return plan(graph, scene, opts).seq;
}

function plan(graph: GraphDoc, scene: SceneLike, opts: SequenceOptions) {
  const nodes = Object.values(graph.nodes);
  const byId = graph.nodes;
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const { copies, links, approach, portAt } = copyLinks(graph, scene);
  const problems: string[] = [];
  const bom = buildBom(graph);
  const skuId = (n: NodeRecord) => bom.buy.find((r) => r.nodes.includes(n.id))?.sku ?? skuOf(n)?.id ?? n.kind;
  const isBuy = (n: NodeRecord) => sourcingOf(n).class === "buy";
  const partners = (id: string) => [...new Set(links.filter((l) => l.self.node === id).map((l) => l.other.node))];

  // Every shaft copy's axis (registry shafts run 0..L along their own +z), and
  // where on it a node's mating ports sit: what rides a shaft is found by
  // geometry, so a gear an architect hung on a frame port still waits for it.
  const axes = nodes.filter((n) => n.kind === "shaft").flatMap((n) =>
    (copies.get(n.id) ?? []).map((c) => ({ node: n.id, key: c.key, o: transformPoint(c.matrix, [0, 0, 0]), z: unit([c.matrix[8]!, c.matrix[9]!, c.matrix[10]!]), len: lengthOf(n) ?? 0 })),
  );
  const along = (p: number[], a: (typeof axes)[number]) => {
    const rel = p.map((v, i) => v - a.o[i]!);
    const t = rel.reduce((sum, v, i) => sum + v * a.z[i]!, 0);
    const radial = Math.hypot(...rel.map((v, i) => v - t * a.z[i]!));
    return radial < 0.6 && t >= -1 && t <= a.len + 1 ? t : null;
  };
  const onShaft = (key: string) =>
    axes.flatMap((a) => (a.key.split("#")[0] === key.split("#")[0] ? [] : links.filter((l) => l.self.key === key).map((l) => along(portAt(l), a)).filter((t): t is number => t !== null).slice(0, 1).map((t) => ({ a, t }))));
  const shaftBorne = (n: NodeRecord) => (copies.get(n.id) ?? []).some((c) => onShaft(c.key).length > 0);
  const role = (n: NodeRecord): "insert" | "fastener" | "item" =>
    PREINSTALLED.has(n.kind) ? "insert" : FASTENERS.has(n.kind) && !(n.kind === "washer" && shaftBorne(n)) ? "fastener" : "item";
  const items = nodes.filter((n) => role(n) === "item");
  const fasteners = nodes.filter((n) => role(n) === "fastener");
  const inserts = nodes.filter((n) => role(n) === "insert");

  // Item-level neighbours.
  const nbrs = new Map<string, Set<string>>(items.map((n) => [n.id, new Set<string>()]));
  const join = (a: string, b: string) => {
    if (a !== b && nbrs.has(a) && nbrs.has(b)) {
      nbrs.get(a)!.add(b);
      nbrs.get(b)!.add(a);
    }
  };
  // Mates only: a joint's two parts may meet through a shaft, never directly.
  for (const l of links) join(l.self.node, l.other.node);

  // The base: a made part that holds still (nothing moving on a joint), the
  // one the most others hang off, then the biggest.
  const turning = new Set((scene.joints ?? []).flatMap((j) => [...j.moving, ...(j.coupled ?? []).flatMap((c) => c.moving)]).map((k) => k.split("#")[0]!));
  const made = items.filter((n) => !isBuy(n));
  const candidates = made.filter((n) => !turning.has(n.id)).length ? made.filter((n) => !turning.has(n.id)) : made;
  const score = (n: NodeRecord) => [nbrs.get(n.id)!.size, volumeOf(graph, n), n.id === graph.assembly.entryNodeId ? 1 : 0];
  const base = (candidates.length ? candidates : items).reduce<NodeRecord | undefined>((best, n) => {
    if (!best) return n;
    const [a, b] = [score(n), score(best)];
    const k = a.findIndex((v, i) => v !== b[i]);
    return k >= 0 && a[k]! > b[k]! ? n : best;
  }, undefined)?.id ?? graph.assembly.entryNodeId;

  const dist = new Map<string, number>([[base, 0]]);
  const queue = [base];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of [...(nbrs.get(cur) ?? [])].sort((a, b) => order.get(a)! - order.get(b)!)) {
      if (dist.has(nb)) continue;
      dist.set(nb, dist.get(cur)! + 1);
      queue.push(nb);
    }
  }
  const d = (id: string) => dist.get(id) ?? Infinity;

  const deps = new Map<string, Set<string>>(items.map((n) => [n.id, new Set([...nbrs.get(n.id)!].filter((nb) => d(nb) < d(n.id)))]));
  const dependsOn = (x: string, y: string) => {
    const seen = new Set<string>();
    const stack = [x];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === y) return true;
      if (!seen.has(cur)) (seen.add(cur), stack.push(...(deps.get(cur) ?? [])));
    }
    return false;
  };
  /** y goes in before x, unless y already waits on x: rules never make a cycle. */
  const addDep = (x: string, y: string) => {
    if (x !== y && deps.has(x) && deps.has(y) && !dependsOn(y, x)) deps.get(x)!.add(y);
  };
  // A bearing on the axis goes in before the shaft through it (a linear
  // bearing that rides the rod already waits on the rod, so it is left be);
  // a collar, spacer, pulley or gear on the axis goes on after the shaft.
  for (const n of items) {
    for (const { a } of (copies.get(n.id) ?? []).flatMap((c) => onShaft(c.key))) {
      if (BEARINGS.has(n.kind)) addDep(a.node, n.id);
      else if (ON_SHAFT.has(n.kind)) addDep(n.id, a.node);
    }
  }
  for (const j of graph.joints ?? []) {
    const members = nodes.filter((n) => jointOwner(graph, n.id) === j.id);
    const ofKind = (kinds: Set<string> | string) => members.filter((m) => (typeof kinds === "string" ? m.kind === kinds : kinds.has(m.kind))).map((m) => m.id);
    for (const m of members) {
      if (m.kind === "shaft") ofKind(BEARINGS).forEach((b) => addDep(m.id, b));
      if (m.kind === "collar" || m.kind === "eclip") ofKind("shaft").forEach((sh) => addDep(m.id, sh));
      if (m.kind === "belt") ofKind("pulley").forEach((p) => addDep(m.id, p));
      if (m.kind === "dowel") {
        const far = [j.a.node, j.b.node].find((end) => !partners(m.id).includes(end));
        if (far) addDep(far, m.id);
      }
    }
  }
  for (const x of opts.held ?? []) {
    const shafts = [...(deps.get(x) ?? [])].filter((id) => byId[id]!.kind === "shaft");
    for (const sh of shafts) {
      deps.get(x)!.delete(sh);
      for (const dep of deps.get(sh)!) addDep(x, dep);
      addDep(sh, x);
    }
  }
  for (const [x, y] of opts.before ?? []) deps.get(y)?.add(x);
  const fastenerDeps = new Map(
    fasteners.map((f) => {
      const owner = (graph.joints ?? []).find((j) => j.id === jointOwner(graph, f.id));
      return [f.id, new Set([...partners(f.id), ...(owner ? [owner.a.node, owner.b.node] : [])].filter((id) => byId[id] && role(byId[id]!) !== "fastener"))];
    }),
  );

  // Sub-assemblies: a branch whose parts depend only on each other, joined to
  // the rest by its root's one mate. A shaft is never a root: it passes
  // through what it joins.
  const parent = new Map<string, string>();
  for (const n of items) {
    const up = [...nbrs.get(n.id)!].filter((nb) => d(nb) === d(n.id) - 1).sort((a, b) => order.get(a)! - order.get(b)!)[0];
    if (up) parent.set(n.id, up);
  }
  const subtree = (root: string): Set<string> => {
    const out = new Set([root]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [child, p] of parent) if (out.has(p) && !out.has(child)) (out.add(child), (grew = true));
    }
    return out;
  };
  const subs: Subassembly[] = [];
  const inSub = new Map<string, Subassembly>();
  for (const r of [...items].sort((a, b) => d(a.id) - d(b.id) || order.get(a.id)! - order.get(b.id)!)) {
    if (r.id === base || r.kind === "shaft" || inSub.has(r.id) || opts.dissolve?.includes(r.id) || !Number.isFinite(d(r.id))) continue;
    if (deps.get(r.id)!.size !== 1) continue;
    const s = subtree(r.id);
    for (let pruned = true; pruned; ) {
      pruned = false;
      for (const y of s) {
        if (y === r.id || [...deps.get(y)!].every((dep) => s.has(dep))) continue;
        for (const z of subtree(y)) s.delete(z);
        pruned = true;
        break;
      }
    }
    if (s.size < 2 || s.size >= items.length - 1) continue;
    const sub: Subassembly = { id: String.fromCharCode(65 + subs.length), title: "", root: r.id, nodes: [...s] };
    sub.title = `Sub-assembly ${sub.id}: ${isBuy(r) ? hardwareLabel(r) : r.title}`;
    subs.push(sub);
    for (const y of s) inSub.set(y, sub);
  }

  // ---- scheduling
  const placed = new Set<string>();
  const placedKeys = new Set<string>();
  const steps: AssemblyStep[] = [];
  const hostOf = (c: Copy) => links.find((l) => l.self.key === c.key && role(byId[l.other.node]!) !== "insert")?.other;
  const label = (n: NodeRecord) => (isBuy(n) ? hardwareLabel(n) : n.title);
  const hostPhrase = (ids: string[]) => {
    const tally = new Map<string, number>();
    for (const id of new Set(ids)) {
      const name = isBuy(byId[id]!) ? hardwareLabel(byId[id]!) : byId[id]!.title;
      tally.set(name, (tally.get(name) ?? 0) + count(id));
    }
    const names = [...tally].map(([name, k]) => counted(k, name, "the"));
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  };
  const moves = (ids: string[], within: Set<string>) =>
    ids.flatMap((id) =>
      (copies.get(id) ?? []).map((c) => {
        const l = links.find((x) => x.self.key === c.key && within.has(x.other.node)) ?? links.find((x) => x.self.key === c.key);
        return { key: c.key, direction: l ? approach(l) : ([0, 0, -1] as Vec3), host: l?.other.node };
      }),
    );
  const hwEntries = (ids: string[], qtyOf: (id: string) => number): StepHardware[] => {
    const out = new Map<string, StepHardware>();
    for (const id of ids) {
      const n = byId[id]!;
      const sku = skuId(n);
      const prev = out.get(sku);
      if (prev) (prev.qty += qtyOf(id), prev.nodes.push(id));
      else out.set(sku, { sku, description: hardwareLabel(n), qty: qtyOf(id), ...(toolFor(n) ? { tool: toolFor(n) } : {}), nodes: [id] });
    }
    return [...out.values()];
  };
  const count = (id: string) => Math.max(1, copies.get(id)?.length ?? 1);
  const movingKeys = (ids: string[], within: Set<string>) => {
    const m = moves(ids, within);
    // A part carries the inserts already pressed into it.
    for (const ins of inserts) for (const c of copies.get(ins.id) ?? []) {
      const host = hostOf(c);
      const carrier = host && m.find((x) => x.key === host.key);
      if (carrier && !m.some((x) => x.key === c.key)) m.push({ key: c.key, direction: carrier.direction, host: carrier.host });
    }
    return m;
  };
  const visible = () =>
    [...placedKeys].filter((k) => {
      const node = k.split("#")[0]!;
      if (!PREINSTALLED.has(byId[node]!.kind)) return true;
      const host = hostOf((copies.get(node) ?? []).find((c) => c.key === k)!);
      return !host || placedKeys.has(host.key);
    });
  const push = (s: Omit<AssemblyStep, "n" | "direction">) => {
    steps.push({ ...s, n: steps.length + 1, direction: s.moving[0]?.direction ?? [0, 0, -1] });
    for (const m of s.moving) placedKeys.add(m.key);
  };

  // 1. Inserts first, each host on its own: heat them in before the parts meet.
  const byHost = new Map<string, { ids: Set<string>; keys: { key: string; direction: Vec3 }[] }>();
  for (const ins of inserts)
    for (const c of copies.get(ins.id) ?? []) {
      const l = links.find((x) => x.self.key === c.key);
      const host = l?.other.node ?? "";
      const g = byHost.get(host) ?? { ids: new Set(), keys: [] };
      g.ids.add(ins.id);
      g.keys.push({ key: c.key, direction: l ? approach(l) : [0, 0, -1] });
      byHost.set(host, g);
    }
  for (const [host, g] of [...byHost].sort(([a], [b]) => d(a) - d(b))) {
    const qty = g.keys.length;
    const hw = hwEntries([...g.ids], (id) => g.keys.filter((k) => k.key.split("#")[0] === id).length);
    push({
      title: `Press ${counted(qty, hw[0]!.description)} into ${hostPhrase([host])}`,
      action: "press",
      parts: [],
      hardware: hw,
      notes: [...g.ids].some((id) => byId[id]!.kind === "magnet")
        ? ["Press each magnet in flush. Check its pole against its partner first, so the pair attracts."]
        : ["Heat each insert with the soldering iron and press it straight down until it sits flush. Let it cool before you load it."],
      context: (copies.get(host) ?? []).map((c) => c.key),
      moving: g.keys,
    });
    for (const id of g.ids) placed.add(id);
  }

  const fastenersReady = () => fasteners.filter((f) => !placed.has(f.id) && [...fastenerDeps.get(f.id)!].every((x) => placed.has(x)));
  const actionFor = (n: NodeRecord, host: string | undefined): StepAction => {
    if (n.kind === "fastener" || n.kind === "standoff" || n.kind === "threaded_rod") return "screw";
    if (host && byId[host]!.kind === "shaft") return "slide";
    if (BEARINGS.has(n.kind) || n.kind === "dowel" || n.kind === "magnet") return "press";
    if (n.kind === "shaft") return "insert";
    if (ON_SHAFT.has(n.kind) || (host && byId[host]!.kind === "shaft")) return "slide";
    return "place";
  };
  const VERB: Record<StepAction, [string, string]> = {
    press: ["Press", "into"], insert: ["Insert", "through"], screw: ["Screw", "into"], slide: ["Slide", "onto"],
    place: ["Place", "on"], snap: ["Snap", "onto"], attach: ["Attach", "to"],
  };
  const notesFor = (ns: NodeRecord[], fs: NodeRecord[]) => {
    const out: string[] = [];
    const kinds = new Set(ns.map((n) => n.kind));
    if (kinds.has("bearing")) out.push("Push each bearing in square until it stops against its seat. Press on the outer ring only.");
    if (kinds.has("shaft")) out.push(ns.some((n) => skuOf(n)?.family === "d_shaft") ? "Turn the shaft so its flat faces the set screws." : "Push it through until it stops.");
    if (kinds.has("collar")) out.push("Slide each collar against its bearing and tighten its set screw.");
    if (kinds.has("pulley")) out.push("Line the pulley up with its belt, then tighten its set screw on the shaft's flat.");
    if (kinds.has("belt")) out.push("Work the belt over each pulley's flange one side at a time, then seat it in the teeth of both.");
    if (fs.some((f) => f.kind === "fastener")) out.push("Tighten each screw until snug. Printed plastic strips if you overtighten.");
    if (fs.some((f) => f.kind === "nut")) out.push("Hold the nut with the spanner while you turn the screw.");
    for (const [x, y] of opts.before ?? [])
      if (ns.some((n) => n.id === x)) out.push(`Fit this before the ${label(byId[y]!)}: it would block the way afterwards.`);
    return [...new Set(out)];
  };
  const withPhrase = (hw: StepHardware[]) =>
    hw.length ? ` with ${hw.map((h) => counted(h.qty, h.description)).join(" and ")}` : "";

  /** Place `ids` (items) now, with every fastener that becomes ready. */
  const step = (ids: string[], sub?: Subassembly) => {
    const within = new Set([...placed]);
    for (const id of ids) placed.add(id);
    const fs = fastenersReady();
    for (const f of fs) placed.add(f.id);
    const ns = ids.map((id) => byId[id]!);
    const mv = movingKeys(ids, within);
    const mated = [...new Set(mv.map((m) => m.host).filter((h): h is string => !!h && within.has(h)))];
    const action = opts.held?.includes(ns[0]!.id) ? "place" : actionFor(ns[0]!, mated[0]);
    // Say what it goes on, not what its mate frame happens to touch: a collar
    // slides onto the shaft, a shaft goes through every bearing, a belt loops
    // over its pulleys.
    const ruled = (kinds: (k: string) => boolean) => ids.flatMap((id) => [...deps.get(id)!].filter((x) => within.has(x) && kinds(byId[x]!.kind)));
    const hosts = action === "slide" && ruled((k) => k === "shaft").length ? ruled((k) => k === "shaft")
      : action === "insert" && ruled((k) => BEARINGS.has(k)).length ? ruled((k) => BEARINGS.has(k))
      : ns[0]!.kind === "belt" ? ruled((k) => k === "pulley") : mated;
    const fasten = moves(fs.map((f) => f.id), new Set(placed));
    const madeIds = ids.filter((id) => !isBuy(byId[id]!));
    const hw = [...hwEntries(ids.filter((id) => isBuy(byId[id]!)), count), ...hwEntries(fs.map((f) => f.id), count)];
    const own = hw.filter((h) => h.nodes.some((id) => ids.includes(id)));
    const fastenHw = hw.filter((h) => !own.includes(h));
    const things = [...madeIds.map((id) => counted(count(id), byId[id]!.title, "the")), ...own.map((h) => counted(h.qty, h.description, "the"))];
    const [verb, prep] = ns[0]!.kind === "belt" ? ["Loop", "over"] : VERB[fastenHw.length && action === "place" ? "attach" : action];
    const held = ids.filter((id) => opts.held?.includes(id));
    const through = held.flatMap((id) => [...deps.entries()].filter(([sh, ds]) => byId[sh]!.kind === "shaft" && ds.has(id)).map(([sh]) => sh));
    push({
      title: held.length
        ? `Hold ${things.join(" and ")} in place: ${hostPhrase(through)} goes through ${held.length + own.length > 1 || count(held[0]!) > 1 ? "them" : "it"} next`
        : `${verb} ${things.join(" and ")}${hosts.length ? ` ${prep} ${hostPhrase(hosts)}` : ""}${withPhrase(fastenHw)}`,
      action: fastenHw.length && action === "place" ? "screw" : action,
      parts: madeIds.map((id) => ({ nodeId: id, qty: count(id) })),
      hardware: hw,
      ...(sub ? { subassembly: sub.title } : {}),
      notes: held.length ? ["Line its bore up with the bearings and keep it there while the shaft goes in.", ...notesFor(ns, fs)] : notesFor(ns, fs),
      context: visible(),
      moving: [
        ...mv.map(({ key, direction }) => ({ key, direction, ...(held.includes(key.split("#")[0]!) ? { held: true } : {}) })),
        ...fasten.map(({ key, direction }) => ({ key, direction, stage: 1 })),
      ],
    });
  };

  const signature = (n: NodeRecord) =>
    isBuy(n) ? `${skuId(n)}|${partners(n.id).filter((p) => placed.has(p)).sort().join(",")}` : `node:${n.id}`;
  const run = (scope: Set<string>, sub?: Subassembly) => {
    for (;;) {
      const open = items.filter((n) => scope.has(n.id) && !placed.has(n.id));
      if (!open.length) return;
      const isUnit = (n: NodeRecord) => (inSub.get(n.id) && inSub.get(n.id) !== sub ? inSub.get(n.id)!.root === n.id : true);
      let ready = open.filter((n) => isUnit(n) && [...deps.get(n.id)!].every((x) => placed.has(x)));
      if (!ready.length) {
        const forced = open.filter(isUnit).sort((a, b) => [...deps.get(a.id)!].filter((x) => !placed.has(x)).length - [...deps.get(b.id)!].filter((x) => !placed.has(x)).length)[0]!;
        problems.push(`${forced.id}: the mates leave its order undecided (it waits on ${[...deps.get(forced.id)!].filter((x) => !placed.has(x)).join(", ")}), so it goes in here.`);
        ready = [forced];
      }
      ready.sort((a, b) => d(a.id) - d(b.id) || order.get(a.id)! - order.get(b.id)!);
      const first = ready[0]!;
      const own = inSub.get(first.id);
      if (own && own !== sub) {
        // Build it on the bench from its root, then bring it over whole.
        placed.add(first.id);
        const rest = new Set(own.nodes.filter((id) => id !== first.id));
        const before = steps.length;
        const keep = new Set(placedKeys);
        placedKeys.clear();
        for (const c of copies.get(first.id) ?? []) placedKeys.add(c.key);
        for (const k of keep) if (PREINSTALLED.has(byId[k.split("#")[0]!]!.kind)) placedKeys.add(k);
        run(rest, own);
        const opening = steps[before];
        if (opening) {
          // The bench step starts from the root, which it places.
          opening.holds = first.id;
          opening.notes.unshift(`Start with the ${label(first)}.`);
          if (isBuy(first)) opening.hardware.unshift(...hwEntries([first.id], count));
          else opening.parts.unshift({ nodeId: first.id, qty: count(first.id) });
        } else problems.push(`${own.title} has nothing to build on its own.`);
        const subKeys = new Set(placedKeys);
        placedKeys.clear();
        for (const k of keep) placedKeys.add(k);
        const attachFrom = links.find((l) => l.self.node === first.id && deps.get(first.id)!.has(l.other.node));
        const within = new Set([...placed].filter((id) => !own.nodes.includes(id)));
        const fs = fastenersReady();
        for (const f of fs) placed.add(f.id);
        const dir = attachFrom ? approach(attachFrom) : ([0, 0, -1] as Vec3);
        const hw = hwEntries(fs.map((f) => f.id), count);
        push({
          title: `Attach ${own.title.replace(/^Sub-assembly (\w+):.*/, "sub-assembly $1")} to ${hostPhrase(attachFrom ? [attachFrom.other.node] : [...within].slice(0, 1))}${withPhrase(hw)}`,
          action: "attach",
          parts: [],
          hardware: hw,
          subassembly: own.title,
          notes: notesFor([], fs),
          context: visible(),
          moving: [...[...subKeys].map((key) => ({ key, direction: dir })), ...moves(fs.map((f) => f.id), new Set(placed)).map(({ key, direction }) => ({ key, direction, stage: 1 }))],
        });
        continue;
      }
      const sig = signature(first);
      const group = ready.filter((n) => n === first || (isBuy(n) && !inSub.has(n.id) && signature(n) === sig));
      step(group.map((n) => n.id), sub);
    }
  };

  placed.add(base);
  for (const c of copies.get(base) ?? []) placedKeys.add(c.key);
  // Hardware that only ever touches the base goes in at once.
  const early = fastenersReady();
  if (early.length) {
    for (const f of early) placed.add(f.id);
    const hw = hwEntries(early.map((f) => f.id), count);
    push({
      title: `${early.some((f) => f.kind === "fastener") ? "Screw" : "Place"} ${hw.map((h) => counted(h.qty, h.description, "the")).join(" and ")} into ${hostPhrase([base])}`,
      action: early.some((f) => f.kind === "fastener") ? "screw" : "place",
      parts: [],
      hardware: hw,
      notes: notesFor([], early),
      context: visible(),
      moving: moves(early.map((f) => f.id), new Set([base])).map(({ key, direction }) => ({ key, direction })),
    });
  }
  run(new Set(items.map((n) => n.id).filter((id) => id !== base && Number.isFinite(d(id)))));
  for (const n of items.filter((x) => !Number.isFinite(d(x.id)) && x.id !== base))
    problems.push(`${n.id} is not joined to the assembly by any mate, so no step places it.`);
  for (const f of fasteners.filter((x) => !placed.has(x.id)))
    problems.push(`${f.id} fastens nothing that gets placed, so no step uses it.`);
  for (const j of scene.joints ?? []) {
    const last = [...steps].reverse().find((s) => s.moving.some((m) => j.moving.includes(m.key)));
    const note = j.type === "revolute" ? "Turn it by hand: it should spin freely." : "Push it by hand: it should slide freely.";
    if (last && !last.notes.includes(note)) last.notes.push(note);
  }
  for (const s of steps)
    for (const m of s.moving) {
      // Out the way it came: to the end of any shaft already in place that it rides.
      const out = m.direction.map((v) => -v);
      const clear = onShaft(m.key)
        .filter(({ a }) => s.context.includes(a.key))
        .map(({ a, t }) => (out.reduce((sum, v, i) => sum + v * a.z[i]!, 0) > 0 ? a.len - t : t));
      if (clear.length) m.clearMm = Math.max(0, ...clear);
    }
  const start = steps.find((s) => s.context.includes(base));
  start?.notes.unshift(`Start with the ${label(byId[base]!)}.`);
  for (const s of steps) {
    const up = s.moving.filter((m) => m.direction[2] > 0.5).length;
    if (up * 2 > s.moving.length) s.notes.push("This goes in from underneath: turn the assembly over if that is easier.");
  }

  const seq: AssemblySequence = { base, steps, subassemblies: subs, sequenceProblems: problems };
  seq.sequenceProblems.push(...checkSequence(graph, seq, copies));
  return { seq, deps };
}

/**
 * Every placed copy goes in exactly once, and every BOM row is used by the
 * steps that place it, in total exactly its quantity.
 */
function checkSequence(graph: GraphDoc, seq: AssemblySequence, copies: Map<string, Copy[]>): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  // An attach step carries the whole sub-assembly but places only its root.
  const root = (s: AssemblyStep) => seq.subassemblies.find((sub) => sub.title === s.subassembly)?.root;
  const placedBy = (s: AssemblyStep) => s.moving.map((m) => m.key).filter((k) => s.action !== "attach" || k.split("#")[0] === root(s) || !seq.subassemblies.some((sub) => sub.nodes.includes(k.split("#")[0]!)));
  for (const k of [...(copies.get(seq.base) ?? []).map((c) => c.key), ...seq.steps.flatMap(placedBy)])
    seen.set(k, (seen.get(k) ?? 0) + 1);
  for (const [id, cs] of copies) {
    if (PREINSTALLED.has(graph.nodes[id]!.kind)) {
      // An insert rides along with its part, so it moves twice; it is placed once.
      const pressed = seq.steps.filter((s) => s.action === "press" && s.hardware.some((h) => h.nodes.includes(id)));
      if (pressed.length === 0 && cs.length) problems.push(`${id} is never pressed in.`);
      continue;
    }
    for (const c of cs) {
      const n = seen.get(c.key) ?? 0;
      if (n !== 1) problems.push(`${c.key} is placed ${n === 0 ? "by no step" : `${n} times`}.`);
    }
  }
  const bom = buildBom(graph);
  // Per node: the copies a step moves in, or all of them for the root a bench step holds.
  const placedIn = (s: AssemblyStep, id: string) =>
    s.holds === id ? Math.max(1, copies.get(id)?.length ?? 1) : s.moving.filter((m) => m.key.split("#")[0] === id).length;
  const listed = new Set(bom.buy.flatMap((r) => r.nodes));
  for (const row of bom.buy) {
    const used = seq.steps.reduce((sum, s) => sum + s.hardware.filter((h) => h.sku === row.sku).flatMap((h) => h.nodes.filter((id) => row.nodes.includes(id))).reduce((a, id) => a + placedIn(s, id), 0), 0);
    if (used !== row.qty) problems.push(`BOM ${row.sku}: ${row.qty} on the list, ${used} used by the steps.`);
  }
  for (const id of new Set(seq.steps.flatMap((s) => s.hardware.flatMap((h) => h.nodes)))) {
    if (!listed.has(id)) problems.push(`${id} is used by the steps but not on the BOM: it has no generated geometry yet.`);
  }
  const made = new Map<string, number>([[seq.base, Math.max(1, copies.get(seq.base)?.length ?? 1)]]);
  for (const s of seq.steps) for (const p of s.parts) made.set(p.nodeId, (made.get(p.nodeId) ?? 0) + p.qty);
  for (const row of [...bom.print, ...bom.fabricate]) {
    const q = made.get(row.nodeId) ?? 0;
    if (q !== row.qty) problems.push(`BOM ${row.nodeId}: ${row.qty} on the list, ${q} placed by the steps.`);
  }
  return problems;
}

export interface InsertionQuery {
  id: string;
  moving: string[];
  still: string[];
  direction: Vec3;
  /** How far the copies ride a placed shaft before they can move sideways. */
  clear_mm?: number;
}

/** Worked over the flanges of what they wrap by hand: those never block them. */
const FLEXIBLE = new Set(["belt", "oring"]);

/** One sweep per step and approach direction: the new copies in, past the context. */
export function insertionQueries(seq: AssemblySequence): InsertionQuery[] {
  return seq.steps.flatMap((s) => {
    const groups = new Map<string, InsertionQuery>();
    for (const m of s.moving) {
      if (m.held) continue;
      const k = m.direction.join(",");
      const g = groups.get(k) ?? { id: `${s.n}:${groups.size}`, moving: [], still: s.context, direction: m.direction };
      g.moving.push(m.key);
      if (m.clearMm !== undefined) g.clear_mm = Math.max(g.clear_mm ?? 0, m.clearMm);
      groups.set(k, g);
    }
    return [...groups.values()].filter((g) => g.still.length > 0);
  });
}

export type InsertionCheck = (queries: InsertionQuery[]) => Promise<{ id: string; blocked: { part: string; by: string }[] }[]>;

/**
 * The mate order, then a sweep of every step. A blocked part goes in before
 * whatever blocks it, when the mates allow that; a blocked sub-assembly is
 * built in place instead. What no order fixes is reported, never hidden.
 */
export async function feasibleSequence(graph: GraphDoc, scene: SceneLike, check: InsertionCheck): Promise<AssemblySequence> {
  const opts: Required<SequenceOptions> = { before: [], dissolve: [], held: [] };
  const nodeOf = (key: string) => key.split("#")[0]!;
  for (let round = 0; ; round++) {
    const { seq, deps } = plan(graph, scene, opts);
    let results: Awaited<ReturnType<InsertionCheck>>;
    try {
      results = await check(insertionQueries(seq));
    } catch (err) {
      seq.sequenceProblems.push(`insertion check did not run: ${(err as Error).message}. The order follows the mates only; no step was checked for a clear path.`);
      return seq;
    }
    const wraps = (part: string, by: string) => FLEXIBLE.has(graph.nodes[part]?.kind ?? "") && !!deps.get(part)?.has(by);
    const blocked = results
      .map((r) => ({ ...r, blocked: r.blocked.filter((b) => !wraps(nodeOf(b.part), nodeOf(b.by))) }))
      .filter((r) => r.blocked.length > 0).map((r) => ({ ...r, step: seq.steps[Number(r.id.split(":")[0]) - 1]! }));
    const dependsOn = (x: string, y: string) => {
      const seen = new Set<string>();
      const stack = [x];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === y) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        stack.push(...(deps.get(cur) ?? []));
      }
      return false;
    };
    const fix = round < 12 && blocked.map((b) => {
      if (b.step.action === "attach") {
        const root = (seq.subassemblies.find((s) => s.title === b.step.subassembly))?.root;
        return root && !opts.dissolve.includes(root) ? () => opts.dissolve.push(root) : null;
      }
      const pair = b.blocked.map((x) => [nodeOf(x.part), nodeOf(x.by)] as [string, string])
        .find(([x, y]) => deps.has(x) && deps.has(y) && y !== seq.base && !dependsOn(x, y) && !opts.before.some(([a, c]) => a === x && c === y));
      if (pair) return () => opts.before.push(pair);
      // Riding a shaft it cannot slide along: hold it first, shaft through it.
      const rider = b.blocked.map((x) => nodeOf(x.part)).find((x) => !opts.held.includes(x) && [...(deps.get(x) ?? [])].some((id) => graph.nodes[id]?.kind === "shaft"));
      return rider ? () => opts.held.push(rider) : null;
    }).find((f) => f);
    if (fix) {
      fix();
      continue;
    }
    for (const b of blocked) {
      const by = [...new Set(b.blocked.map((x) => x.by))].join(", ");
      seq.sequenceProblems.push(`step ${b.step.n} cannot be done: on its way in, ${[...new Set(b.blocked.map((x) => x.part))].join(", ")} runs into ${by}, and no order the mates allow fits it in first.`);
    }
    return seq;
  }
}

// ---------------------------------------------------------------------------
// The document

export interface InstructionsDocument {
  title: string;
  subtitle: string;
  summary: string;
  tools: string[];
  problems: string[];
  items: { id: string; label: string; qty: number; gauge_mm?: number; code?: string; params?: Record<string, unknown> }[];
  made: { label: string; qty: number }[];
  steps: (AssemblyStep & { callouts: { keys: string[]; label: string }[]; hardware: (StepHardware & { label: string; item: string })[] })[];
}

const GAUGED = new Set(["shcs", "button", "csk", "dowel", "threaded_rod", "standoff"]);

/** What the kernel draws: the posed copies and every page's content. */
export function instructionsDocument(graph: GraphDoc, scene: SceneLike, seq: AssemblySequence) {
  const bom = buildBom(graph);
  const parts = Object.values(graph.nodes)
    .filter((n) => n.artifact?.code)
    .flatMap((n) =>
      (scene.instances[n.id] ?? []).map((matrix, i) => ({ key: i === 0 ? n.id : `${n.id}#${i}`, code: n.artifact!.code, params: mergedParams(n) as Record<string, unknown>, matrix })),
    );
  const items = bom.buy.map((row) => {
    const node = graph.nodes[row.nodes[0]!]!;
    const sku = skuOf(node);
    const len = sku && GAUGED.has(sku.family) ? (sku.length ?? lengthOf(node)) : undefined;
    return {
      id: row.sku,
      label: hardwareLabel(node),
      qty: row.qty,
      ...(len ? { gauge_mm: len } : {}),
      ...(node.artifact?.code ? { code: node.artifact.code, params: mergedParams(node) as Record<string, unknown> } : {}),
    };
  });
  const tools = [...new Set(seq.steps.flatMap((s) => s.hardware.map((h) => h.tool).filter((t): t is string => !!t)))];
  const made = [...bom.print, ...bom.fabricate];
  const document: InstructionsDocument = {
    title: graph.brief.goal ? graph.brief.goal.charAt(0).toUpperCase() + graph.brief.goal.slice(1) : graph.id,
    subtitle: `${seq.steps.length} steps. Start with the ${graph.nodes[seq.base]?.title ?? seq.base}.`,
    summary: `${made.reduce((a, r) => a + r.qty, 0)} made parts, ${bom.buy.reduce((a, r) => a + r.qty, 0)} bought parts, ${seq.steps.length} steps.`,
    tools,
    problems: seq.sequenceProblems,
    items,
    made: made.map((r) => ({ label: `${r.title} (${r.process}${r.material ? `, ${r.material}` : ""})`, qty: r.qty })),
    steps: seq.steps.map((s) => ({
      ...s,
      hardware: s.hardware.map((h) => ({ ...h, label: h.description, item: h.sku })),
      callouts: s.hardware
        .filter((h) => h.qty > 1)
        // The raster font has no "×".
        .map((h) => ({ keys: s.moving.map((m) => m.key).filter((k) => h.nodes.includes(k.split("#")[0]!)), label: `${h.qty}x` }))
        .filter((c) => c.keys.length > 0),
    })),
  };
  return { parts, document };
}

export interface AssemblyInstructions {
  sequence: AssemblySequence;
  /** Kernel paths: one SVG per page, the PDF, the HTML. */
  pages: string[];
  pdf: string | null;
  html: string | null;
  error?: string;
}

/** Sequence, sweep, draw. The kernel being down still yields the sequence. */
export async function assemblyInstructions(
  graph: GraphDoc,
  scene: SceneLike,
  kernel: KernelClient,
  opts: { importDir?: string; render?: boolean } = {},
): Promise<AssemblyInstructions> {
  const parts = Object.values(graph.nodes)
    .filter((n) => n.artifact?.code)
    .flatMap((n) => (scene.instances[n.id] ?? []).map((matrix, i) => ({ key: i === 0 ? n.id : `${n.id}#${i}`, code: n.artifact!.code, params: mergedParams(n) as Record<string, unknown>, matrix })));
  const allow = [...threadAllowances(graph), ...hardwareAllowances(graph)];
  const sequence = await feasibleSequence(graph, scene, async (queries) => {
    if (!queries.length) return [];
    const res = await kernel.insertions(parts, queries, { importDir: opts.importDir, allow });
    if (!res.ok || !res.insertions) throw new Error(res.error ?? "the kernel returned no insertion report");
    if (res.insertions.errors.length) throw new Error(res.insertions.errors.join("; "));
    return res.insertions.checks;
  });
  if (opts.render === false) return { sequence, pages: [], pdf: null, html: null };
  const doc = instructionsDocument(graph, scene, sequence);
  const res = await kernel.instructions(doc.parts, doc.document, { importDir: opts.importDir });
  if (!res.ok) return { sequence, pages: [], pdf: null, html: null, error: res.error ?? "the kernel drew no pages" };
  return { sequence, pages: res.pages ?? [], pdf: res.pdf ?? null, html: res.html ?? null };
}
