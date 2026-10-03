/**
 * G5 — the assembly gate's inputs and verdicts. Every other gate grades ONE
 * part against its own contract; this one grades the parts against each other,
 * so each verdict names the two nodes that produce it.
 *
 *  - clash: two parts occupy the same space beyond what they are designed to
 *    share. A screw and its nut share the thread, so that volume is allowed —
 *    by pair, computed here, enforced inside the kernel's clash.
 *  - gap: a mate's ports coincide (the solver guarantees that) but the parts
 *    do not touch there, because a port is posed off its own surface.
 *  - fit: a shaft in a bore, or a screw in a clearance hole, whose radial
 *    clearance is outside the band the process needs.
 */
import type { GraphDoc, NodeRecord } from "@patchcad/shared";
import type { CheckFinding } from "@patchcad/engine";
import type { CadContractPayload } from "./index.js";
import type { ClashResult } from "./kernel.js";
import { METRIC, skuOf } from "./registry.js";
import { familyDims } from "./catalog.js";
import { isMachined, sourcingOf } from "./sourcing.js";
import { resolveDim } from "./bindings.js";
import { jointOwner } from "./expand.js";
import {
  FDM_FIT_BANDS_MM,
  FDM_SLIP_FIT_MM,
  MACHINED_FIT_BANDS_MM,
  engagementLength,
  majorDiameter,
  threadEngagementVolume,
} from "./grounding.js";

/** Mated parts further apart than this at the mate point are not touching.
 *  Above the clash mesh's 0.1mm chord deviation only on curved approaches,
 *  and flat contact measures exactly 0. */
export const CONTACT_GAP_TOL_MM = 0.1;

/** How far a radial clearance may sit from the one expected. */
export const FIT_BAND_MM = 0.1;

/** A mate between two flat faces must touch. One that puts a feature INTO
 *  another (peg in socket, tongue in slot, lip in groove) is cut with the slip
 *  fit around it, and the nearest material at the mate point can be exactly
 *  that far: measured 0.15mm on five generated mates, which is FDM_SLIP_FIT_MM/2. */
function contactTolerance(graph: GraphDoc, e: GraphDoc["edges"][number] | undefined): number {
  if (!e) return CONTACT_GAP_TOL_MM;
  const types = [portOf(graph.nodes[e.from]!, e.fromPort)?.type, portOf(graph.nodes[e.to]!, e.toPort)?.type];
  return types.every((t) => t === "FLAT_FACE") ? CONTACT_GAP_TOL_MM : CONTACT_GAP_TOL_MM + FDM_SLIP_FIT_MM / 2;
}

/** Smallest ball around a mate point the contact check looks inside. */
const CONTACT_RADIUS_MM = 5;

/** Port types a screw threads INTO, so it shares material with by design. */
const THREADED_PORTS = new Set(["THREADED_HOLE", "SCREW_BOSS"]);

/** The kernel's diameter aliases (gates.py `_port_diameter`). */
export const DIAMETER_KEYS = ["diameter", "dia", "holeDia", "hole_diameter", "d", "boreDia"];

type Port = CadContractPayload["ports"][number];

function param(n: NodeRecord, name: string): unknown {
  return n.params[name] ?? n.contract.params.find((p) => p.name === name)?.default;
}

function portOf(n: NodeRecord, name: string): Port | undefined {
  return (n.contract.payload as CadContractPayload | undefined)?.ports?.find((p) => p.name === name);
}

const nodeOf = (key: string) => key.split("#")[0]!;

/** Measured by G3 when the last verify probed it, else as declared. */
function diameterOf(graph: GraphDoc, n: NodeRecord, port: Port): { d: number; measured: boolean } | null {
  const probes = (n.measurements?.data as { ports?: { key: string; measured_diameter?: number }[] } | undefined)?.ports;
  const probed = probes?.find((p) => p.key === port.name)?.measured_diameter;
  if (typeof probed === "number") return { d: probed, measured: true };
  const key = DIAMETER_KEYS.find((k) => k in port.params);
  if (!key) return null;
  try {
    return { d: resolveDim(graph, port.params[key]!), measured: false };
  } catch {
    return null;
  }
}

/** A screw's thread: its own param, else its SKU's (joint-minted screws name a sku). */
function threadOf(screw: NodeRecord): string | undefined {
  const thread = param(screw, "thread") ?? skuOf(screw)?.key;
  return typeof thread === "string" && METRIC[thread] ? thread : undefined;
}

/** Overlap volume each pair of nodes is designed to share: the thread. */
export function threadAllowances(graph: GraphDoc): { a: string; b: string; volume_mm3: number }[] {
  const out: { a: string; b: string; volume_mm3: number }[] = [];
  const screws = Object.values(graph.nodes).filter((n) => n.kind === "fastener");
  for (const screw of screws) {
    const thread = threadOf(screw);
    if (!thread) continue;
    const owner = jointOwner(graph, screw.id);
    // 1.5x, because the engagement can be longer than the table's nominal when
    // a screw runs past a nut, and a thread is the only thing that overlaps at
    // all at this scale.
    const allow = (len: number) => threadEngagementVolume(thread, len) * 1.5;
    // A nut or insert is matched by KIND, not by edge: a through-bolt is
    // wired screw→plate-a and nut→plate-b, so the two never share a mate.
    // Joint-minted hardware is scoped to its own joint, so a screw against
    // another joint's nut is still clash-checked.
    for (const m of Object.values(graph.nodes)) {
      const mOwner = jointOwner(graph, m.id);
      if ((owner || mOwner) && owner !== mOwner) continue;
      const len = engagementLength(m.kind, thread, skuOf(m)?.family);
      if (len != null) out.push({ a: screw.id, b: m.id, volume_mm3: allow(len) });
    }
    // A tapped hole or a boss pilot is matched by the mate that seats the
    // screw in it, since the part around it is otherwise an ordinary part.
    for (const e of graph.edges) {
      if (e.from !== screw.id && e.to !== screw.id) continue;
      const [otherId, otherPort] = e.from === screw.id ? [e.to, e.toPort] : [e.from, e.fromPort];
      const other = graph.nodes[otherId];
      const port = other && portOf(other, otherPort);
      if (!port || !THREADED_PORTS.has(port.type)) continue;
      const depth = port.params.depth ?? param(screw, "length");
      const len = typeof depth === "number" || typeof depth === "string" ? resolveDim(graph, depth) : NaN;
      if (Number.isFinite(len)) out.push({ a: screw.id, b: otherId, volume_mm3: allow(len) });
    }
  }
  return out;
}

/** How far a gear pair's centre may sit inside m·(z1+z2)/2 and still be
 *  meshing, not clashing: measured, see hardwareAllowances. */
export const GEAR_MESH_BAND_MM = 0.1;

/** Diameter interference a press fit may carry: the gate's press band is
 *  up to 0.1 under the part (gates.py FIT_BANDS). */
const PRESS_INTERFERENCE_MM = 0.1;
/** A heat-set insert's knurl stands this far proud of its pocket wall when
 *  the catalog gives no outer diameter. */
const KNURL_MM = 0.3;

const num = (graph: GraphDoc, v: unknown): number => {
  if (typeof v !== "number" && typeof v !== "string") return NaN;
  try {
    return resolveDim(graph, v);
  } catch {
    return NaN;
  }
};
/** A catalog part's dimension: its own param when it carries one, else its SKU's row. */
function hwDim(n: NodeRecord, field: string): number {
  const own = param(n, field);
  if (typeof own === "number") return own;
  const sku = skuOf(n);
  const v = sku ? familyDims(sku.family, sku.key)?.[field] : undefined;
  return typeof v === "number" ? v : NaN;
}
const ring = (outer: number, inner: number, len: number) => (Math.PI / 4) * (outer ** 2 - inner ** 2) * len;

/**
 * Overlap volume each catalog part shares with what holds it, by design: an
 * insert's knurl in its pocket, a press-fit bearing or dowel, a nut in its
 * trap, a shaft through a bearing's bore. Each is the worst case the host's
 * own G3 band allows, times the 1.5 the thread allowance uses.
 */
export function hardwareAllowances(graph: GraphDoc): { a: string; b: string; volume_mm3: number }[] {
  const out: { a: string; b: string; volume_mm3: number }[] = [];
  const push = (a: string, b: string, v: number) => {
    if (Number.isFinite(v) && v > 0) out.push({ a, b, volume_mm3: v * 1.5 });
  };
  for (const e of graph.edges) {
    for (const [hostId, hostPort, partId] of [
      [e.from, e.fromPort, e.to],
      [e.to, e.toPort, e.from],
    ] as const) {
      const host = graph.nodes[hostId];
      const part = graph.nodes[partId];
      const port = host && portOf(host, hostPort);
      if (!port || !part) continue;
      const p = (k: string) => num(graph, port.params[k]);
      const press = port.params.fit === "press";
      if (port.type === "INSERT_POCKET" && part.kind === "insert") {
        const od = hwDim(part, "od");
        push(hostId, partId, ring(Number.isFinite(od) ? od : p("diameter") + 2 * KNURL_MM, p("diameter"), p("depth")));
      } else if (port.type === "BEARING_SEAT" && press && part.kind === "bearing") {
        push(hostId, partId, ring(p("od"), p("od") - PRESS_INTERFERENCE_MM, p("width")));
      } else if (port.type === "LINEAR_BEARING_SEAT" && press && part.kind === "linear_bearing") {
        push(hostId, partId, ring(p("od"), p("od") - PRESS_INTERFERENCE_MM, p("length")));
      } else if (port.type === "DOWEL_HOLE" && press && part.kind === "dowel") {
        push(hostId, partId, ring(p("diameter"), p("diameter") - PRESS_INTERFERENCE_MM, p("depth")));
      } else if (port.type === "NUT_TRAP" && part.kind === "nut") {
        const af = p("af");
        push(hostId, partId, (Math.sqrt(3) / 2) * (af ** 2 - (af - PRESS_INTERFERENCE_MM) ** 2) * p("depth"));
      }
    }
  }
  // By KIND, like a nut on a screw: a shaft and the bearings it runs in are
  // often each mated to the housing, not to each other.
  const shafts = Object.values(graph.nodes).filter((n) => n.kind === "shaft");
  for (const bearing of Object.values(graph.nodes).filter((n) => n.kind === "bearing")) {
    const bore = hwDim(bearing, "bore");
    const width = hwDim(bearing, "width");
    for (const shaft of shafts) push(shaft.id, bearing.id, ring(bore + PRESS_INTERFERENCE_MM, bore, width));
  }
  // A spur pair in mesh touches along its flanks by design. Two exact
  // involutes at m·(z1+z2)/2 share nothing; brought GEAR_MESH_BAND_MM closer
  // (a backlash band's worth) an m1 × 8 pair shares 0.14mm³, and 0.3mm closer
  // 1.7mm³, while a pair half a tooth out of phase shares 35mm³. So the pair
  // may share what the band makes and nothing like a wrong phase or centre.
  for (const j of graph.joints ?? []) {
    const [a, b] = [graph.nodes[`${j.id}_motor_gear`], graph.nodes[`${j.id}_driven_gear`]];
    if (a && b) push(a.id, b.id, 0.2 * GEAR_MESH_BAND_MM * hwDim(a, "module") * hwDim(a, "thickness"));
  }
  return out;
}

/** One contact query per solved mate between two parts that both have geometry. */
export function contactQueries(
  graph: GraphDoc,
  mateOrigins: ([number, number, number] | null)[],
  posed: Set<string>,
): { edge: string; a: string; b: string; at: number[]; radius: number }[] {
  return graph.edges.flatMap((e, i) => {
    const at = mateOrigins[i];
    if (!at || !posed.has(e.from) || !posed.has(e.to)) return [];
    // A port declaring a standoff sits that far off its face on purpose: a
    // washer is between the nut and the part (expand.ts).
    const ends = [portOf(graph.nodes[e.from]!, e.fromPort), portOf(graph.nodes[e.to]!, e.toPort)];
    if (ends.some((p) => p?.params.standoff !== undefined)) return [];
    // Widen the ball to the mated features: a 40mm face may touch its partner
    // nowhere near its centre, if a hole sits there.
    const dims = [portOf(graph.nodes[e.from]!, e.fromPort), portOf(graph.nodes[e.to]!, e.toPort)]
      .flatMap((p) => Object.values(p?.params ?? {}))
      .map((v) => {
        try {
          return resolveDim(graph, v);
        } catch {
          return 0;
        }
      });
    return [{ edge: e.id, a: e.from, b: e.to, at, radius: Math.max(CONTACT_RADIUS_MM, ...dims.map((d) => d / 2)) }];
  });
}

/** Declared fits, checked as radial clearance against the process band. */
export function fitFindings(graph: GraphDoc): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const e of graph.edges) {
    const a = graph.nodes[e.from];
    const b = graph.nodes[e.to];
    if (!a?.artifact || !b?.artifact) continue;
    const ends = [
      { n: a, port: portOf(a, e.fromPort) },
      { n: b, port: portOf(b, e.toPort) },
    ];
    const typed = (t: string) => ends.find((x) => x.port?.type === t);
    const shaft = typed("SHAFT");
    const bore = typed("BORE");
    const hole = typed("CLEARANCE_HOLE");
    const screw = ends.find((x) => x.n.kind === "fastener");
    const seat = typed("BEARING_SEAT");
    const bearing = ends.find((x) => x.n.kind === "bearing");

    let inner: number, outer: { d: number; measured: boolean } | null, expected: number, what: string;
    let tol = FIT_BAND_MM;
    if (seat && bearing && seat !== bearing) {
      // The seat's own band (gates.py FIT_BANDS), as radial clearance.
      // Unmeasured, the seat is taken at the middle of its band, so what is
      // checked is the bearing's OD against the seat's declared one.
      inner = hwDim(bearing.n, "od");
      // Radial, so half the Ø band: centred on its midpoint, half its width.
      const bands = isMachined(sourcingOf(seat.n).process) ? MACHINED_FIT_BANDS_MM : FDM_FIT_BANDS_MM;
      const [lo, hi] = bands[seat.port!.params.fit === "press" ? "press" : "slip"];
      [expected, tol] = [Math.round(((lo + hi) / 4) * 1e4) / 1e4, Math.round(((hi - lo) / 4) * 1e4) / 1e4];
      outer = diameterOf(graph, seat.n, seat.port!) ?? { d: num(graph, seat.port!.params.od) + 2 * expected, measured: false };
      if (!Number.isFinite(inner) || !Number.isFinite(outer.d)) continue;
      what = `bearing ${bearing.n.id} OD${inner} in ${seat.n.id}.${seat.port!.name}`;
    } else if (shaft && bearing && shaft !== bearing) {
      // A bearing's bore takes its shaft at a transition fit: -0.05..+0.1 on Ø.
      const s = diameterOf(graph, shaft.n, shaft.port!);
      const b = hwDim(bearing.n, "bore");
      if (!s || !Number.isFinite(b)) continue;
      inner = s.d;
      outer = { d: b, measured: false };
      [expected, tol] = [0.0125, 0.0375];
      what = `${shaft.n.id}.${shaft.port!.name} Ø${inner.toFixed(2)} in bearing ${bearing.n.id}`;
    } else if (shaft && bore) {
      const s = diameterOf(graph, shaft.n, shaft.port!);
      outer = diameterOf(graph, bore.n, bore.port!);
      if (!s || !outer) continue;
      inner = s.d;
      expected = FDM_SLIP_FIT_MM / 2;
      what = `${shaft.n.id}.${shaft.port!.name} Ø${inner.toFixed(2)} in ${bore.n.id}.${bore.port!.name}`;
    } else if (screw && hole && screw !== hole) {
      const thread = threadOf(screw.n);
      if (!thread) continue;
      outer = diameterOf(graph, hole.n, hole.port!);
      if (!outer) continue;
      inner = majorDiameter(thread);
      expected = (METRIC[thread]!.clearance - inner) / 2;
      what = `${thread} ${screw.n.id} in ${hole.n.id}.${hole.port!.name}`;
    } else continue;

    const measured = (outer.d - inner) / 2;
    if (Math.abs(measured - expected) <= tol + 1e-9) continue;
    out.push({
      nodeA: e.from,
      nodeB: e.to,
      kind: "fit",
      measured: Math.round(measured * 1000) / 1000,
      expected,
      message: `G5 fit: ${what} Ø${outer.d.toFixed(2)}${outer.measured ? " (measured)" : " (declared)"} leaves ${measured.toFixed(2)}mm radial clearance, expected ${expected.toFixed(3)}±${tol}. ${measured < expected ? "Too tight to assemble" : "Loose enough to rattle"} — the hole or the shaft diameter in a contract is wrong.`,
    });
  }
  return out;
}

/** The kernel's clash and contact report, attributed to node pairs. */
export function clashFindings(graph: GraphDoc, report: NonNullable<ClashResult["clash"]>): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const c of report.clashes) {
    out.push({
      nodeA: nodeOf(c.a),
      nodeB: nodeOf(c.b),
      kind: "clash",
      measured: c.volume_mm3,
      expected: 0,
      message: `G5 clash: ${c.a} and ${c.b} occupy the same space: ${c.volume_mm3.toFixed(1)} mm³ of shared material near [${c.at.join(", ")}]. Both parts pass their own gates, so the fault is in a mate offset or a port pose, not in either part's code.`,
    });
  }
  // A moving part at some pose of its joint, not at rest: the joint is the
  // thing to fix (its axis, its limits, or the parts' clearance around it).
  // A pair already clashing at rest is reported once, above.
  const still = new Set(report.clashes.map((c) => [nodeOf(c.a), nodeOf(c.b)].sort().join("|")));
  for (const c of report.swept ?? []) {
    if (still.has([nodeOf(c.a), nodeOf(c.b)].sort().join("|"))) continue;
    const joint = graph.joints?.find((j) => j.id === c.joint);
    const unit = (joint as { motion?: string } | undefined)?.motion === "prismatic" ? "mm" : "°";
    out.push({
      nodeA: nodeOf(c.a),
      nodeB: nodeOf(c.b),
      kind: "swept",
      measured: c.volume_mm3,
      expected: 0,
      message: `G5 swept: joint ${c.joint} carries ${c.a} into ${c.b} at ${c.travel}${unit} of its travel: ${c.volume_mm3.toFixed(1)} mm³ shared near [${c.at.join(", ")}]. Both parts clear at rest; give ${c.a} room to ${unit === "°" ? "turn" : "slide"} (shorter blades, a taller shaft, or ${c.b} moved out of its path), or limit the joint.`,
    });
  }
  for (const g of report.contacts ?? []) {
    const e = graph.edges.find((x) => x.id === g.edge);
    if (g.gap_mm <= contactTolerance(graph, e)) continue;
    const ports = e ? ` (${e.from}.${e.fromPort} → ${e.to}.${e.toPort})` : "";
    out.push({
      nodeA: g.a,
      nodeB: g.b,
      kind: "gap",
      measured: g.gap_mm,
      expected: 0,
      message: `G5 gap: ${g.a} and ${g.b} are mated${ports} but ${g.gap_mm.toFixed(2)}mm apart at [${g.at.join(", ")}], where their ports meet. One of the two ports is posed off its part's surface, so the part floats.`,
    });
  }
  return out;
}
