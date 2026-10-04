import type { GraphDoc } from "@patchcad/shared";
import type { CheckFinding } from "@patchcad/engine";
import { transformPoint, type Mat4 } from "./assembly.js";
import { resolveDim, resolvePose } from "./bindings.js";
import { standardLengths } from "./catalog.js";
import type { CadContractPayload } from "./index.js";
import type { AssemblySequence } from "./instructions.js";
import type { CadJoint } from "./joints.js";
import { contains, posedEnvelope, solvePlan } from "./plan-geometry.js";
import { REGISTRY_HARDWARE, skuOf } from "./registry.js";

/**
 * Assembly feasibility as a check: the sequencer's blocked insertions
 * (instructions.ts `feasibleSequence`, after every re-order it could try),
 * attributed like a G5 clash. Material outside its own part's envelope is
 * that part's code reaching into the other's path: a repair round. A pin
 * printed on one hinge half with the other half's closed knuckles around it
 * is the contract's: blocked, so T3 can renegotiate it, and so is any other
 * block inside the envelopes (on the assembly suite: magnet pockets whose
 * ports point into their parts, a gear seated past the end of its shaft).
 * Catalog hardware is exact, so a block between two catalog parts blames the
 * made parts that seat them. A print-in-place joint is assembled by printing,
 * so its pair is never swept.
 */

type Vec3 = [number, number, number];
const nodeOf = (key: string) => key.split("#")[0]!;
const fmt = (v: readonly number[]) => `[${v.map((c) => Math.round(c * 100) / 100).join(", ")}]`;

function jointBetween(graph: GraphDoc, x: string, y: string): (CadJoint & { expanded?: string }) | undefined {
  return (graph.joints as (CadJoint & { expanded?: string })[] | undefined)?.find((j) => (j.a.node === x && j.b.node === y) || (j.a.node === y && j.b.node === x));
}

export function assemblyFindings(graph: GraphDoc, seq: AssemblySequence, instances: Record<string, Mat4[]>): CheckFinding[] {
  const out: CheckFinding[] = [];
  const hardware = (id: string) => REGISTRY_HARDWARE.has(graph.nodes[id]?.kind ?? "");
  // One finding per blocked copy: what stops it, by the likeliest cause (an
  // integral pin, then the biggest made part in the way, then anything).
  const byPart = new Map<string, NonNullable<AssemblySequence["blocked"]>>();
  for (const x of seq.blocked ?? []) {
    if (jointBetween(graph, nodeOf(x.part), nodeOf(x.by))?.printInPlace) continue;
    byPart.set(`${x.step}|${x.part}`, [...(byPart.get(`${x.step}|${x.part}`) ?? []), x]);
  }
  for (const all of byPart.values()) {
    const integral = (y: (typeof all)[number]) => /^M2p\b/.test(jointBetween(graph, nodeOf(y.part), nodeOf(y.by))?.expanded ?? "");
    const x = all.find(integral) ?? [...all].sort((u, v) => Number(hardware(nodeOf(u.by))) - Number(hardware(nodeOf(v.by))) || v.volume_mm3 - u.volume_mm3)[0]!;
    const [p, q] = [nodeOf(x.part), nodeOf(x.by)];
    const j = jointBetween(graph, p, q);
    const head = `Assembly: step ${x.step} cannot be done: ${x.part} cannot reach its place travelling along ${fmt(x.direction)}; ${x.by}${all.length > 1 ? ` (and ${all.length - 1} more)` : ""} is in the way ${x.travel_mm.toFixed(1)}mm out (${x.volume_mm3.toFixed(1)} mm³ near ${fmt(x.at)}), and no order the mates allow gets it in first.`;
    const base = { nodeA: p, nodeB: q, kind: "assembly", measured: x.volume_mm3, expected: 0 };
    if (j && integral(x)) {
      out.push({
        ...base,
        message: `${head} Joint ${j.id}'s pin is printed as part of ${j.a.node}, so ${j.b.node}'s closed bore can only go on along the pin, and ${j.a.node}'s own material stands in the way. No code change fixes that: re-declare ${j.id} with a separate pin (a filament pin or a dowel, inserted after the halves close), or printInPlace: true when the two print together.`,
      });
      continue;
    }
    const repair = codeAtFault(graph, instances, x, p, q);
    if (!repair) {
      const seats = (id: string) => (hardware(id) ? graph.edges.flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : [])).filter((n) => !hardware(n)) : [id]);
      out.push({
        ...base,
        message: `${head} Both parts keep inside their envelopes, so the contracts leave no way in (a port pointing into its part, a closed bore, a part seated off its shaft): no code change fixes it.`,
        blame: [...new Set([...seats(p), ...seats(q)])],
      });
      continue;
    }
    out.push({
      ...base,
      message: `${head} The material in the way lies outside ${repair.nodeId}'s envelope, so ${repair.nodeId}'s code reaches into the path: it gets a repair round.`,
      repair,
      blame: [repair.nodeId],
    });
  }
  return out;
}

/** The made part whose material leaves its own envelope at the blocking point:
 *  the still part at rest, the moving one shifted back by its travel. */
function codeAtFault(
  graph: GraphDoc,
  instances: Record<string, Mat4[]>,
  x: NonNullable<AssemblySequence["blocked"]>[number],
  p: string,
  q: string,
): CheckFinding["repair"] {
  const worldOf = (key: string) => instances[nodeOf(key)]?.[Number(key.split("#")[1] ?? 0)];
  const inside = (id: string, key: string, at: Vec3) => {
    const w = worldOf(key);
    return !w || posedEnvelope(graph, id, w).some((o) => contains(o, at, 0.3));
  };
  const at = x.at as Vec3;
  const back = at.map((c, i) => c + x.direction[i]! * x.travel_mm) as Vec3;
  const made = (id: string) => !REGISTRY_HARDWARE.has(graph.nodes[id]?.kind ?? "");
  const [outQ, outP] = [made(q) && !inside(q, x.by, at), made(p) && !inside(p, x.part, back)];
  if (outQ === outP) return undefined;
  const [id, other] = outQ ? [q, p] : [p, q];
  return {
    nodeId: id,
    report:
      `Assembly: ${p} cannot be put in place: travelling in along ${fmt(x.direction)} it runs into ${q} near ${fmt(at)} (world, ${x.travel_mm.toFixed(1)}mm before ${p} is home). ` +
      `That material of this part lies outside its envelope, in ${other}'s way. Keep inside the envelope there: a lead-in chamfer, a relief, or leave the feature off, and keep every port where it is.`,
  };
}

// ---------------------------------------------------------------------------
// Plan time: the two blocks the assembly suite's cooks found, caught before
// any generation from the posed plan alone.

/** Host features a catalog part sits IN, its body behind the host's face, by
 *  the kind that fills them (a screw INTO an insert pocket stands proud). */
const POCKETS: Record<string, string> = {
  MAGNET_POCKET: "magnet", INSERT_POCKET: "insert", NUT_TRAP: "nut", BEARING_SEAT: "bearing", LINEAR_BEARING_SEAT: "linear_bearing", BUSHING_BORE: "bushing",
};
/** Catalog parts that ride a shaft by their own bore. */
const RIDERS = new Set(["gear", "pulley", "collar"]);

const sub3 = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!] as Vec3;
const dot3 = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const round1 = (v: number) => Math.round(v * 10) / 10;

/** A port's origin and unit +z in the world, through one copy's pose. */
function worldPort(graph: GraphDoc, m: Mat4, pose: unknown): { o: Vec3; z: Vec3 } | undefined {
  try {
    const p = resolvePose(graph, pose as never);
    const o = transformPoint(m, p.origin);
    const z = sub3(transformPoint(m, p.origin.map((c, i) => c + p.zAxis[i]!)), o);
    const len = Math.hypot(...z);
    return len > 1e-9 ? { o, z: z.map((c) => c / len) as Vec3 } : undefined;
  } catch {
    return undefined;
  }
}

/** Each defect with the part at fault and the one it is measured against. */
export function assemblyPlanDefects(graph: GraphDoc): { node: string; other: string; message: string }[] {
  const problems: { node: string; other: string; message: string }[] = [];
  let instances: Record<string, Mat4[]>;
  try {
    ({ instances } = solvePlan(graph));
  } catch {
    return problems; // the plan geometry lint reports an unsolvable plan
  }
  const ports = (id: string) => (graph.nodes[id]?.contract.payload as CadContractPayload | undefined)?.ports ?? [];
  const hardware = (id: string) => REGISTRY_HARDWARE.has(graph.nodes[id]?.kind ?? "");

  // A catalog part mated to a pocket must sit in it: a magnet posed ON the
  // pocket's face stands in the partner's pocket (asm-magnetic-lid: each
  // lid magnet passed through a box magnet on the way down).
  for (const e of graph.edges) {
    const [host, hostPort, hw, hwPort] = hardware(e.to) ? [e.from, e.fromPort, e.to, e.toPort] : [e.to, e.toPort, e.from, e.fromPort];
    const port = ports(host).find((p) => p.name === hostPort);
    const seat = ports(hw).find((p) => p.name === hwPort);
    if (!port || !seat || POCKETS[port.type] !== graph.nodes[hw]?.kind || hardware(host)) continue;
    for (const m of instances[host] ?? []) {
      const at = worldPort(graph, m, port.pose);
      // The copy this pocket placed: its seat on the pocket, facing it.
      const copy = at && (instances[hw] ?? []).find((w) => {
        const s = worldPort(graph, w, seat.pose);
        return s && Math.hypot(...sub3(s.o, at.o)) < 0.05 && dot3(s.z, at.z) < -0.99;
      });
      const prims = copy ? posedEnvelope(graph, hw, copy) : [];
      if (!at || prims.length === 0) continue;
      const c = prims[0]!.c;
      const proud = dot3(sub3(c, at.o), at.z);
      if (proud > 0.1) {
        problems.push({ node: hw, other: host, message: `${hw}: mated to ${host}'s ${port.type} "${hostPort}" but posed ON its face, not in it: its body's centre stands ${round1(proud)}mm out of ${host} along the pocket's +z, where the partner part goes. Pose ${hw}'s seat port zAxis [0, 0, 1] so its body sinks into the pocket from the mouth.` });
        break;
      }
    }
  }

  // A part on a shaft's axis must lie along the shaft: a gear past its end
  // is carried by nothing (asm-hand-winch: the 45T gear 13mm past the drum
  // shaft, seated on the frame, could not turn with the drum).
  const shafts = Object.values(graph.nodes).flatMap((n) => {
    const sku = n.kind === "shaft" ? skuOf(n) : null;
    let L: number | undefined;
    try {
      L = sku ? resolveDim(graph, `param(${n.id}.length)`) : undefined;
    } catch {
      L = sku ? (sku.length ?? standardLengths(sku.family, sku.key)[0]) : undefined;
    }
    return L ? (instances[n.id] ?? []).map((m) => ({ id: n.id, o: transformPoint(m, [0, 0, 0]), z: sub3(transformPoint(m, [0, 0, 1]), transformPoint(m, [0, 0, 0])), L })) : [];
  });
  if (shafts.length === 0) return problems;
  for (const n of Object.values(graph.nodes)) {
    if (n.kind === "shaft") continue;
    const payload = n.contract.payload as CadContractPayload | undefined;
    for (const m of instances[n.id] ?? []) {
      // Each axis the part turns on, with how far it runs along it.
      const axes: { o: Vec3; z: Vec3; span: [number, number] }[] = [];
      for (const p of payload?.ports ?? []) {
        if (p.type !== "HUB_BORE") continue;
        const at = worldPort(graph, m, p.pose);
        let depth = 1;
        try {
          depth = resolveDim(graph, (p.params as Record<string, unknown> | undefined)?.depth as never) || 1;
        } catch {
          // no depth: the bore's mouth alone
        }
        if (at) axes.push({ ...at, span: [-depth, 0] });
      }
      if (RIDERS.has(n.kind)) {
        for (const v of payload?.envelope?.volumes ?? []) {
          if (v.kind !== "cylinder") continue;
          const at = worldPort(graph, m, v.pose);
          try {
            const h = resolveDim(graph, v.h);
            if (at) axes.push({ ...at, span: [-h / 2, h / 2] });
          } catch {
            // an unresolved height: no axis known
          }
        }
      }
      for (const ax of axes) {
        const on = shafts.filter((s) => Math.abs(dot3(s.z, ax.z)) > 0.999 && Math.hypot(...sub3(sub3(ax.o, s.o), s.z.map((c) => c * dot3(sub3(ax.o, s.o), s.z)))) < 0.5);
        if (on.length === 0) continue;
        const gaps = on.map((s) => {
          const t = ax.span.map((k) => dot3(sub3(ax.o.map((c, i) => c + k * ax.z[i]!), s.o), s.z));
          const [lo, hi] = [Math.min(...t), Math.max(...t)];
          return { s, gap: lo > s.L ? lo - s.L : hi < 0 ? -hi : 0 };
        });
        const near = gaps.reduce((a, b) => (b.gap < a.gap ? b : a));
        if (near.gap > 0.5) {
          problems.push({ node: n.id, other: near.s.id, message: `${n.id}: sits ${round1(near.gap)}mm past the end of ${near.s.id} (${near.s.L}mm long), on its axis but off it: nothing carries it, so it cannot turn with the shaft. Mate it onto the shaft (a HUB_BORE within the shaft's length, a longer shaft), or move it along the axis onto it.` });
        }
      }
    }
  }
  return problems.filter((p, i) => problems.findIndex((q) => q.message === p.message) === i);
}

export const cadAssemblyPlanLint = {
  run: (graph: GraphDoc): string[] => assemblyPlanDefects(graph).map((d) => d.message),
};
