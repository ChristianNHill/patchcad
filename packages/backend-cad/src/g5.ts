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
import { METRIC, REGISTRY_HARDWARE, skuOf } from "./registry.js";
import { familyDims } from "./catalog.js";
import { isMachined, sourcingOf } from "./sourcing.js";
import { resolveDim } from "./bindings.js";
import { copyOwner, jointOwner, mintedNames } from "./expand.js";
import { invertRigid, transformPoint, type Mat4 } from "./assembly.js";
import { contains, posedEnvelope } from "./plan-geometry.js";
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
  const ends = [portOf(graph.nodes[e.from]!, e.fromPort), portOf(graph.nodes[e.to]!, e.toPort)];
  const types = ends.map((p) => p?.type);
  if (types.every((t) => t === "FLAT_FACE")) return CONTACT_GAP_TOL_MM;
  // A shaft through a bore that declares no fit is a pass-through (a rod
  // through a shelf's Ø18 hole): its radial clearance is the design's.
  const bore = ends.find((p) => p?.type === "BORE");
  const shaft = ends.find((p) => p?.type === "SHAFT");
  if (bore && shaft && !bore.params.fit) {
    const [b, sh] = [num(graph, bore.params.diameter ?? bore.params.d), num(graph, shaft.params.diameter ?? shaft.params.d)];
    if (Number.isFinite(b) && Number.isFinite(sh) && b > sh) return CONTACT_GAP_TOL_MM + (b - sh) / 2;
  }
  return CONTACT_GAP_TOL_MM + FDM_SLIP_FIT_MM / 2;
}

/** Smallest ball around a mate point the contact check looks inside. */
const CONTACT_RADIUS_MM = 5;

/** How far past a feature's nominal radius its wall can stand and still be
 *  in contact: the widest fit cut plus the loosest contact tolerance. A ball
 *  of the nominal radius never reached a slip-cut wall, so a horn in a
 *  Ø19.95 hub cut Ø20.1 read as a 10.05mm gap (robot arm, both servos). */
const FIT_REACH_MM = Math.max(...Object.values(FDM_FIT_BANDS_MM).map(([, hi]) => hi)) / 2 + CONTACT_GAP_TOL_MM + FDM_SLIP_FIT_MM / 2;

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
  // A threaded rod is a screw to its nuts (real-planetary-gearbox: 1.7mm³
  // of M3 thread read as a clash at each of four tie rods).
  const screws = Object.values(graph.nodes).filter((n) => n.kind === "fastener" || n.kind === "threaded_rod");
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
      // A joint on a copied b.port threads into the first one's nut, having
      // none of its own (dropCopySide).
      const rides = !!owner && !!mOwner && copyOwner(graph, owner) === mOwner && !graph.nodes[`${owner}${m.id.slice(mOwner.length)}`];
      if ((owner || mOwner) && owner !== mOwner && !rides) continue;
      // A joint's screw into its own motor (a servo's case pilots) engages
      // over the screw's length: the case is catalog, so no port says how deep.
      const len = m.kind === "motor" ? (owner && owner === mOwner ? num(graph, param(screw, "length")) : null) : engagementLength(m.kind, thread, skuOf(m)?.family, num(graph, param(m, "length")));
      if (len != null && Number.isFinite(len)) out.push({ a: screw.id, b: m.id, volume_mm3: allow(len) });
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
    // A joint's screw is mated by its HEAD (R2: a's counterbore), so the tapped
    // hole it runs into in b has no edge to it. That hole is still the joint's
    // own minted port (step stool: 98.4mm³ = M6 tap-drill annulus × 11.4mm, on
    // all 11 connector screws).
    const joint = owner ? graph.joints?.find((j) => j.id === owner) : undefined;
    if (!joint) continue;
    const mine = mintedNames(joint);
    for (const hostId of new Set([joint.a.node, joint.b.node])) {
      const host = graph.nodes[hostId];
      if (!host || out.some((x) => x.a === screw.id && x.b === hostId)) continue;
      const depths = ((host.contract.payload as CadContractPayload | undefined)?.ports ?? [])
        .filter((p) => THREADED_PORTS.has(p.type) && mine(p.name))
        .map((p) => num(graph, p.params.depth ?? param(screw, "length")))
        .filter(Number.isFinite);
      if (depths.length) out.push({ a: screw.id, b: hostId, volume_mm3: allow(Math.max(...depths)) });
    }
  }
  // A made part's male thread (THREADED_STUD) shares material with what it
  // threads into, mated by its own edge: a tapped hole on another part, a
  // catalog nut or insert (the spaghetti shelf's foot in its rod: 132 mm³).
  for (const e of graph.edges) {
    const ends = [[e.from, e.fromPort], [e.to, e.toPort]] as const;
    const stud = ends.map(([id, port]) => ({ id, port: graph.nodes[id] && portOf(graph.nodes[id]!, port) })).find((x) => x.port?.type === "THREADED_STUD");
    if (!stud) continue;
    const [otherId, otherPort] = ends.find(([id]) => id !== stud.id) ?? [];
    const other = otherId ? graph.nodes[otherId] : undefined;
    const thread = String(stud.port!.params.thread ?? "");
    if (!other || !METRIC[thread] || out.some((x) => [x.a, x.b].includes(stud.id) && [x.a, x.b].includes(other.id))) continue;
    const hole = portOf(other, otherPort!);
    const len = [stud.port!.params.length, hole && THREADED_PORTS.has(hole.type) ? hole.params.depth : undefined, other.kind === "nut" || other.kind === "insert" ? engagementLength(other.kind, thread, skuOf(other)?.family, num(graph, param(other, "length"))) ?? undefined : undefined]
      .map((v) => (v === undefined || v === null ? NaN : num(graph, v as number | string)))
      .filter(Number.isFinite);
    if (!len.length || !(hole && THREADED_PORTS.has(hole.type)) && other.kind !== "nut" && other.kind !== "insert") continue;
    out.push({ a: stud.id, b: other.id, volume_mm3: threadEngagementVolume(thread, Math.min(...len)) * 1.5 });
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
      } else if (port.type === "BUSHING_BORE" && part.kind === "bushing") {
        // Always pressed: gates.py probes a bushing bore at the press band.
        push(hostId, partId, ring(p("od"), p("od") - PRESS_INTERFERENCE_MM, p("length")));
      } else if (port.type === "HUB_BORE" && press && part.kind === "shaft") {
        push(hostId, partId, ring(p("diameter"), p("diameter") - PRESS_INTERFERENCE_MM, p("depth")));
      } else if (port.type === "LINEAR_BEARING_SEAT" && press && part.kind === "linear_bearing") {
        push(hostId, partId, ring(p("od"), p("od") - PRESS_INTERFERENCE_MM, p("length")));
      } else if (port.type === "DOWEL_HOLE" && press && (part.kind === "dowel" || part.kind === "pin")) {
        // A filament or wire pin pressed in is a dowel too (magnet box: 1.35mm³,
        // the FDM press cut's 0.05 on Ø1.75 over 10mm, blocked the base).
        push(hostId, partId, ring(p("diameter"), p("diameter") - PRESS_INTERFERENCE_MM, p("depth")));
      } else if (port.type === "NUT_TRAP" && part.kind === "nut") {
        const af = p("af");
        push(hostId, partId, (Math.sqrt(3) / 2) * (af ** 2 - (af - PRESS_INTERFERENCE_MM) ** 2) * p("depth"));
      }
    }
  }
  // By KIND, like a nut on a screw: a shaft and the bearings or bushings it
  // runs in are often each mated to the housing, not to each other.
  const shafts = Object.values(graph.nodes).filter((n) => n.kind === "shaft");
  for (const bearing of Object.values(graph.nodes).filter((n) => n.kind === "bearing" || n.kind === "bushing")) {
    const bore = hwDim(bearing, "bore");
    const width = hwDim(bearing, bearing.kind === "bushing" ? "length" : "width");
    for (const shaft of shafts) push(shaft.id, bearing.id, ring(bore + PRESS_INTERFERENCE_MM, bore, width));
  }
  // A wheel D-bored onto a motor's D-shaft turns WITH the shaft, but the
  // sweep turns the wheel about a motor that holds still, so the bore's flat
  // passes through the shaft's round side: one D-segment along the wheel
  // (belt-turntable: Ø5 flat 2 × 9mm face = 9.2mm³, swept "clash").
  const motors = Object.values(graph.nodes).filter((n) => n.kind === "motor");
  for (const wheel of Object.values(graph.nodes).filter((n) => n.kind === "gear" || n.kind === "pulley")) {
    for (const motor of motors) {
      if (!graph.edges.some((e) => (e.from === wheel.id && e.to === motor.id) || (e.from === motor.id && e.to === wheel.id))) continue;
      const r = hwDim(motor, "shaftD") / 2;
      const f = r - hwDim(motor, "flatDepth");
      const thickness = hwDim(wheel, "thickness");
      const length = Number.isFinite(thickness) ? thickness : hwDim(wheel, "hubL") + 2 * hwDim(wheel, "flangeW") + hwDim(wheel, "toothWidth");
      push(wheel.id, motor.id, (r ** 2 * Math.acos(f / r) - f * Math.sqrt(r ** 2 - f ** 2)) * length);
    }
  }
  // A spur pair in mesh touches along its flanks by design. Two exact
  // involutes at m·(z1+z2)/2 share nothing; brought GEAR_MESH_BAND_MM closer
  // (a backlash band's worth) an m1 × 8 pair shares 0.14mm³, and 0.3mm closer
  // 1.7mm³, while a pair half a tooth out of phase shares 35mm³. So the pair
  // may share what the band makes and nothing like a wrong phase or centre.
  // Any two gears of one module, a drive's or the plan's own: a pair further
  // apart shares nothing, and a closer one more than this.
  const gears = Object.values(graph.nodes).filter((n) => n.kind === "gear");
  gears.forEach((a, k) => {
    for (const b of gears.slice(k + 1)) {
      if (hwDim(a, "module") === hwDim(b, "module")) push(a.id, b.id, 0.2 * GEAR_MESH_BAND_MM * hwDim(a, "module") * Math.min(hwDim(a, "thickness"), hwDim(b, "thickness")));
    }
  });
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
    // nowhere near its centre, if a hole sits there. And down to a recessed
    // feature's floor: a counterbore's port is its mouth, but the head bears
    // 5.4mm down, so a 5mm ball saw only the head's 0.5mm radial clearance
    // and called a seated M5 a gap (pipe-clamp).
    const dims = (key?: string) =>
      ends
        .flatMap((p) => Object.entries(p?.params ?? {}))
        .filter(([k]) => !key || k === key)
        .map(([, v]) => {
          try {
            return resolveDim(graph, v);
          } catch {
            return 0;
          }
        });
    const widest = Math.max(0, ...dims()) / 2;
    const depth = Math.max(0, ...dims("depth"));
    return [{ edge: e.id, a: e.from, b: e.to, at, radius: Math.max(CONTACT_RADIUS_MM, Math.hypot(widest + (widest ? FIT_REACH_MM : 0), depth)) }];
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
      // A declared fit, or a machined pair, takes its process's band (radial:
      // half the Ø band); a plain printed bore keeps the FDM slip allowance.
      const machined = isMachined(sourcingOf(bore.n).process) || isMachined(sourcingOf(shaft.n).process);
      // Machined with no declared fit is a pass-through too: only a declared
      // fit is graded on its band.
      const fit = bore.port!.params.fit === "press" ? "press" : bore.port!.params.fit === "slip" ? "slip" : undefined;
      if (fit) {
        const [lo, hi] = (machined ? MACHINED_FIT_BANDS_MM : FDM_FIT_BANDS_MM)[fit];
        [expected, tol] = [Math.round(((lo + hi) / 4) * 1e4) / 1e4, Math.round(((hi - lo) / 4) * 1e4) / 1e4 + 0.01];
        // A fitted bore declares the shaft's nominal Ø; unmeasured, it is
        // taken at the middle of its band, as a seat is.
        if (bore.port!.params.fit && !outer.measured) outer = { d: outer.d + 2 * expected, measured: false };
      } else {
        // No declared fit and not machined: a pass-through, judged only on
        // being wide enough for the shaft to go in.
        expected = FDM_SLIP_FIT_MM / 2;
        if ((outer.d - inner) / 2 > expected) continue;
      }
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
/** Clearance a relief leaves around the partner's envelope. */
const RELIEF_MM = 0.3;

/** The pair's host part when exactly one side is catalog hardware. Hardware is
 *  exact and gets no repair round, so a clash or gap on such a mate is the
 *  host's to fix and the host's alone to answer for (pipe-clamp blocked two
 *  registry screws; belt-turntable sent its registry shaft to the model). */
function hostOf(graph: GraphDoc, a: string, b: string): { host: string; hw: string } | null {
  const hw = [a, b].filter((id) => REGISTRY_HARDWARE.has(graph.nodes[id]?.kind ?? ""));
  return hw.length === 1 ? { hw: hw[0]!, host: hw[0] === a ? b : a } : null;
}

const fmt = (v: number[]) => `[${v.join(", ")}]`;

/** How far a node's port origin lies outside its built body (the bbox its
 *  last build measured, in its own frame), or null when it is on it. */
function offBody(graph: GraphDoc, n: NodeRecord, portName: string): { mm: number; at: number[]; min: number[]; max: number[] } | null {
  const bbox = (n.measurements?.data as { bbox?: { min: number[]; max: number[] } } | undefined)?.bbox;
  const port = (n.contract.payload as CadContractPayload | undefined)?.ports?.find((p) => p.name === portName);
  if (!bbox || !port) return null;
  let at: number[];
  try {
    at = port.pose.origin.map((c) => resolveDim(graph, c));
  } catch {
    return null;
  }
  const mm = Math.hypot(...at.map((c, i) => Math.max(bbox.min[i]! - c, 0, c - bbox.max[i]!)));
  const r = (v: number[]) => v.map((c) => Math.round(c * 100) / 100);
  return mm > 0.5 ? { mm, at: r(at), min: r(bbox.min), max: r(bbox.max) } : null;
}

/** Kinds whose registry body is centred on z = 0 along z; the rest sit on
 *  z = 0 with the body +z (SEAT_POSE). */
const CENTRED_HARDWARE = new Set(["gear", "dowel", "dowel_screw", "oring"]);

/** A catalog part as the solid a host must clear: the cylinder its catalog
 *  dims (a gear: its tip circle) sweep along its own z, from where its frame
 *  convention starts it. Null when the row carries no Ø or length. */
function hardwareCylinder(graph: GraphDoc, n: NodeRecord): { d: number; z0: number; z1: number } | null {
  const d =
    n.kind === "gear"
      ? hwDim(n, "module") * (hwDim(n, "teeth") + 2)
      : Math.max(...["od", "d", "flangeD", "headD"].map((k) => hwDim(n, k)).filter(Number.isFinite));
  const len = [num(graph, param(n, "length")), ...["thickness", "width", "height", "length"].map((k) => hwDim(n, k))].find((v) => Number.isFinite(v) && v > 0);
  if (!Number.isFinite(d) || d <= 0 || len === undefined) return null;
  return CENTRED_HARDWARE.has(n.kind) ? { d, z0: -len / 2, z1: len / 2 } : { d, z0: 0, z1: len };
}

/**
 * Whose CODE a clash is. Against catalog hardware it is always the host's,
 * mated or not: the hardware cannot change, and a shaft run through a base's
 * web between its two bushing seats has no edge to the base at all
 * (two-link-arm: base error_contract with no repair round, twice). The hint
 * carries the hardware's own cylinder in the host's frame, from its catalog
 * dims, because its contract envelope is only rough.
 *
 * Between two MATED parts, when the shared material lies inside one part's
 * envelope and outside the other's, the other part's material has left its
 * own claim and entered its partner's (a hinge leaf's plate running into the
 * other leaf's knuckle). That part can be repaired against its partner's
 * envelope, which is contract data, so the repair stays hermetic. Inside both
 * or neither, the poses are what disagree.
 */
function clashRepair(graph: GraphDoc, instances: Record<string, Mat4[]>, c: { a: string; b: string; at: number[]; volume_mm3: number }) {
  const [a, b] = [nodeOf(c.a), nodeOf(c.b)];
  const worldOf = (key: string) => instances[nodeOf(key)]?.[Number(key.split("#")[1] ?? 0)];
  const [wa, wb] = [worldOf(c.a), worldOf(c.b)];
  if (!wa || !wb) return undefined;
  const p = c.at as [number, number, number];
  const localTo = (w: Mat4) => (q: readonly number[]) => transformPoint(invertRigid(w), q).map((v) => Math.round(v * 100) / 100);
  const pair = hostOf(graph, a, b);
  if (pair) {
    const hw = graph.nodes[pair.hw]!;
    const [wHost, wHw] = pair.host === a ? [wa, wb] : [wb, wa];
    const local = localTo(wHost);
    const cyl = hardwareCylinder(graph, hw);
    const toHost = (z: number) => local(transformPoint(wHw, [0, 0, z]));
    const solid = cyl
      ? ` The ${hw.kind} is a Ø${cyl.d.toFixed(1)} cylinder on its axis from ${fmt(toHost(cyl.z0))} to ${fmt(toHost(cyl.z1))} (this part's frame). ` +
        `Keep ≥${RELIEF_MM}mm clear of it wherever it passes this part: a Ø${(cyl.d + 2 * RELIEF_MM).toFixed(1)} hole through any web or wall it runs through, or this part's material kept outside that Ø where it sits beside it.`
      : "";
    return {
      nodeId: pair.host,
      report:
        `G5 clash with ${pair.hw}: ${c.volume_mm3.toFixed(1)} mm³ of this part sits inside the catalog ${hw.kind} ${pair.hw} near ${fmt(local(p))} (this part's frame).${solid} ` +
        `${pair.hw} is exact and never changes, so this part makes room for it: cut the seat, bore or pocket it sits in to its full diameter and depth, and keep every port where it is.`,
    };
  }
  if (!graph.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))) return undefined;
  const holding = (id: string, w: Mat4) => posedEnvelope(graph, id, w).find((o) => contains(o, p));
  const [inA, inB] = [holding(a, wa), holding(b, wb)];
  if (!inA === !inB) return undefined;
  const [x, wx, y, prim] = inA ? [b, wb, a, inA] : [a, wa, b, inB!];
  const local = localTo(wx);
  const c0 = local(prim.c);
  const axis = (k: 0 | 1 | 2) => local(prim.c.map((v, i) => v + prim.axes[k][i]!)).map((v, i) => Math.round((v - c0[i]!) * 1000) / 1000);
  const shape = prim.round
    ? `a cylinder Ø${(2 * prim.half[0]).toFixed(1)} × ${(2 * prim.half[2]).toFixed(1)} centred at ${fmt(c0)}, axis ${fmt(axis(2))}`
    : `a box ${prim.half.map((h) => (2 * h).toFixed(1)).join(" × ")} centred at ${fmt(c0)}, its axes ${fmt(axis(0))}, ${fmt(axis(1))}, ${fmt(axis(2))}`;
  return {
    nodeId: x,
    report:
      `G5 clash with ${y}: ${c.volume_mm3.toFixed(1)} mm³ of this part sits inside ${y}'s envelope near ${fmt(local(p))} (this part's frame). ` +
      `${y} claims ${shape} there. Leave ≥${RELIEF_MM}mm clearance around it: cut a relief in this part where ${y} sits, ` +
      `and keep every port where it is.`,
  };
}

export function clashFindings(graph: GraphDoc, report: NonNullable<ClashResult["clash"]>, instances: Record<string, Mat4[]> = {}): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const c of report.clashes) {
    const repair = clashRepair(graph, instances, c);
    const pair = hostOf(graph, nodeOf(c.a), nodeOf(c.b));
    const shared = `G5 clash: ${c.a} and ${c.b} occupy the same space: ${c.volume_mm3.toFixed(1)} mm³ of shared material near [${c.at.join(", ")}].`;
    out.push({
      nodeA: nodeOf(c.a),
      nodeB: nodeOf(c.b),
      kind: "clash",
      measured: c.volume_mm3,
      expected: 0,
      message: pair
        ? `${shared} ${pair.hw} is catalog hardware, exact by construction, so ${pair.host} must make room for it${repair ? ": it gets a repair round" : ""}.`
        : repair
          ? `${shared} It lies in ${repair.nodeId === nodeOf(c.a) ? nodeOf(c.b) : nodeOf(c.a)}'s envelope and outside ${repair.nodeId}'s, so ${repair.nodeId}'s code reaches into its partner: it gets a repair round to cut a relief.`
          : `${shared} Both parts pass their own gates, so the fault is in a mate offset or a port pose, not in either part's code.`,
      ...(repair ? { repair } : {}),
      ...(pair ? { blame: [pair.host] } : {}),
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
    const pair = hostOf(graph, nodeOf(c.a), nodeOf(c.b));
    out.push({
      ...(pair ? { blame: [pair.host] } : {}),
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
    const message = `G5 gap: ${g.a} and ${g.b} are mated${ports} but ${g.gap_mm.toFixed(2)}mm apart at [${g.at.join(", ")}], where their ports meet.`;
    const pair = hostOf(graph, g.a, g.b);
    // A port the architect posed on catalog hardware by hand can itself be
    // off the part: real-planetary-gearbox posed its M3 rods' ports at
    // -L/2 + 6, for a rod centred on its origin, and a catalog rod runs
    // 0..L. No repair of the host moves that; the plan has to.
    const hwPort = pair && e ? (pair.hw === e.from ? e.fromPort : e.toPort) : undefined;
    const off = pair && hwPort && !jointOwner(graph, pair.hw) ? offBody(graph, graph.nodes[pair.hw]!, hwPort) : null;
    if (pair && off && off.mm >= g.gap_mm - 0.5) {
      out.push({
        nodeA: g.a,
        nodeB: g.b,
        kind: "gap",
        measured: g.gap_mm,
        expected: 0,
        message: `${message} ${pair.hw}'s own port "${hwPort}" is posed at [${off.at.join(", ")}] in its frame, ${off.mm.toFixed(2)}mm off its body (the catalog ${graph.nodes[pair.hw]!.kind} spans [${off.min.join(", ")}]..[${off.max.join(", ")}]). The plan posed it for a different frame: re-pose ${pair.hw}.${hwPort} onto the part, or let a joint place the hardware.`,
        blame: [pair.hw],
      });
      continue;
    }
    if (pair && e) {
      // The hardware's frame is exact, so the host's feature is what is off.
      const port = pair.host === e.from ? e.fromPort : e.toPort;
      const type = portOf(graph.nodes[pair.host]!, port)?.type ?? "port";
      const kind = graph.nodes[pair.hw]!.kind;
      out.push({
        nodeA: g.a,
        nodeB: g.b,
        kind: "gap",
        measured: g.gap_mm,
        expected: 0,
        message: `${message} ${pair.hw} is catalog hardware, exact by construction, so ${pair.host}'s ${port} is what is off: it gets a repair round.`,
        blame: [pair.host],
        repair: {
          nodeId: pair.host,
          report:
            `G5 gap with ${pair.hw}: the catalog ${kind} mated at this part's ${type} port "${port}" sits ${g.gap_mm.toFixed(2)}mm off this part's material. ` +
            `The ${kind} is exact and placed at the port, so the ${type}'s seat face must lie on it: cut the ${type} to exactly the depth and diameter its params declare, measured from the port origin along the port's axis, so the ${kind} sits flush on its seat. Keep every port where it is.`,
        },
      });
      continue;
    }
    out.push({
      nodeA: g.a,
      nodeB: g.b,
      kind: "gap",
      measured: g.gap_mm,
      expected: 0,
      message: `${message} One of the two ports is posed off its part's surface, so the part floats.`,
    });
  }
  return out;
}
