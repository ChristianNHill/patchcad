import type { NodeRecord } from "@patchcad/shared";
import { importedNodeCode } from "./segment-joints.js";
import { fitOffset } from "./grounding.js";
import { isMachined, sourcingOf } from "./sourcing.js";
import {
  CATALOG,
  canonicalKey,
  dim,
  familiesOfKind,
  familyDims,
  parseSku,
  skuFor,
  standardLengths,
  threadSpec,
  type Sku,
} from "./catalog.js";

/**
 * Deterministic part registry. Two roles:
 *  - Hardware is REGISTRY-ONLY: exact interface dims from the catalog
 *    (catalog/hardware.json), codegen'd — an LLM never invents a screw, a
 *    bearing, or a motor. Every part class moved in here is one that can no
 *    longer fail generation, costs no tokens, and is standards-exact.
 *  - Parametric factories (plate) give the architect known-good
 *    exemplars and give tests deterministic geometry.
 * Registry output is ordinary node code (`def build(p)`), so it flows through
 * the exact same execute/verify gates as generated code.
 *
 * FRAMES. Anything that seats on a face puts that face at z = 0 with the part
 * running +z (or, for a screw, the head +z and the shank -z), so its seat port
 * is SEAT_POSE in grounding.ts. The exceptions say so where they are built.
 */

export interface MetricThread {
  /** ISO 273 normal-fit clearance hole Ø */
  clearance: number;
  /** coarse thread pitch (mm) — ISO 261 */
  pitch: number;
  /** tap drill Ø (coarse pitch) */
  tap: number;
  /** socket head cap screw: head Ø / head height */
  shcsHeadD: number;
  shcsHeadH: number;
  /** heat-set insert: install hole Ø / length */
  insertD: number;
  insertL: number;
  /** hex nut: across-flats / height */
  nutAf: number;
  nutH: number;
}

/** The pre-catalog per-thread table, now a view over the catalog so existing
 *  readers keep working. Threads lacking any of the four families are left out. */
export const METRIC: Record<string, MetricThread> = Object.fromEntries(
  Object.entries(CATALOG.threads).flatMap(([t, spec]) => {
    const shcs = familyDims("shcs", t);
    const insert = familyDims("heatset_std", t);
    const nut = familyDims("hex_nut", t);
    if (!shcs || !insert || !nut) return [];
    return [
      [
        t,
        {
          clearance: spec.clearance,
          pitch: spec.pitch,
          tap: spec.tapDrill,
          shcsHeadD: dim(shcs, "headD"),
          shcsHeadH: dim(shcs, "headH"),
          insertD: dim(insert, "holeD"),
          insertL: dim(insert, "length"),
          nutAf: dim(nut, "af"),
          nutH: dim(nut, "height"),
        },
      ],
    ];
  }),
);

const major = (thread: string) => Number(thread.slice(1));
const tap = (thread: string) => threadSpec(thread)!.tapDrill;

const module = (body: string) => `from build123d import *
import math

def build(p):
${body}`;

/** A cut-to-length part's default length, baked into its code: the SKU's,
 *  else the shortest stocked one. The live `length` param overrides it at
 *  build time (`p.get("length", …)`). */
function lengthOf(family: string, key: string, sku?: Sku): number {
  return sku?.length ?? standardLengths(family, key)[0] ?? 0;
}

/** Hex socket recess cut down from z = top. */
const socket = (af: number, top: number, depth: number) =>
  `Pos(0, 0, ${top - depth}) * extrude(RegularPolygon(${af} / math.sqrt(3), 6), ${depth + 0.01})`;

/**
 * Screws. SHCS and button heads sit head-down at the origin: head on
 * z ∈ [0, headH], shank hanging -z for `length`. A countersunk head has no
 * flat seat, so its frame is the FLUSH plane: head top at z = 0, cone and
 * shank running -z, and ISO 10642 length is measured from that plane.
 */
export function screwCode(family: string, thread: string, defaultLength = 12): string {
  const r = familyDims(family, thread)!;
  const d = major(thread);
  const [headD, headH, af] = [dim(r, "headD"), dim(r, "headH"), dim(r, "socketAf")];
  if (family === "csk") {
    return module(`    L = p.get("length", ${defaultLength})
    head = Pos(0, 0, ${-headH / 2}) * Cone(${d / 2}, ${headD / 2}, ${headH})
    shank = Pos(0, 0, -L / 2) * Cylinder(${d / 2}, L)
    return head + shank - ${socket(af, 0, headH * 0.6)}
`);
  }
  // A button head is a domed cylinder: round its top edge.
  const head =
    family === "button"
      ? `fillet(head.edges().group_by(Axis.Z)[-1], ${(headH * 0.8).toFixed(2)})`
      : "head";
  return module(`    L = p.get("length", ${defaultLength})
    head = Pos(0, 0, ${headH / 2}) * Cylinder(${headD / 2}, ${headH})
    head = ${head}
    shank = Pos(0, 0, -L / 2) * Cylinder(${d / 2}, L)
    return head + shank - ${socket(af, headH, headH * 0.6)}
`);
}

/**
 * Hex nut, seating face on z = 0 and body running +z — the same datum the
 * screw head uses, so a nut mates onto a surface the same way.
 *
 * RegularPolygon takes the circumradius, while nuts are specified across the
 * flats, hence AF/√3. Verified against the kernel: an M4 nut measures 7.00
 * across the flats and 8.08 across the corners.
 */
export function nutCode(thread: string): string {
  const r = familyDims("hex_nut", thread)!;
  const [af, h] = [dim(r, "af"), dim(r, "height")];
  return module(`    body = extrude(RegularPolygon(${af} / math.sqrt(3), 6), ${h})
    bore = Pos(0, 0, ${h} / 2) * Cylinder(${tap(thread)} / 2, ${h} * 2)
    return body - bore
`);
}

/**
 * Heat-set insert, modelled as the volume it occupies once installed: the OD
 * is the install-hole Ø from the table, so a part can subtract this shape to
 * get a correct boss. Flange face on z = 0, body running +z into the material.
 */
export function insertCode(thread: string, family = "heatset_std"): string {
  const r = familyDims(family, thread)!;
  const [d, l] = [dim(r, "holeD"), dim(r, "length")];
  return module(`    body = Pos(0, 0, ${l} / 2) * Cylinder(${d} / 2, ${l})
    bore = Pos(0, 0, ${l} / 2) * Cylinder(${tap(thread)} / 2, ${l} * 2)
    return body - bore
`);
}

/** Hex-drive wood insert, framed like a heat-set one: its face on z = 0,
 *  body +z, modelled at the pilot's Ø (its knife thread cuts the wood). */
export function woodInsertCode(thread: string, defaultLength: number): string {
  const r = familyDims("wood_insert", thread)!;
  return module(`    L = p.get("length", ${defaultLength})
    body = Pos(0, 0, L / 2) * Cylinder(${dim(r, "holeD")} / 2, L)
    bore = Pos(0, 0, L / 2) * Cylinder(${tap(thread)} / 2, L * 2)
    return body - bore
`);
}

/** ISO 7089 plain washer, face on z = 0, body +z. */
export function washerCode(thread: string): string {
  const r = familyDims("washer", thread)!;
  const t = dim(r, "thickness");
  return module(`    ring = Cylinder(${dim(r, "od") / 2}, ${t}) - Cylinder(${dim(r, "id") / 2}, ${t * 2})
    return Pos(0, 0, ${t / 2}) * ring
`);
}

/**
 * ISO 2338 dowel pin, chamfered both ends. No seat: a dowel spans a joint, so
 * it is CENTRED on z = 0 along z and mates at the joint plane, half in each part.
 */
export function dowelCode(size: string, defaultLength: number, family = "dowel"): string {
  const r = familyDims(family, size)!;
  const [d, c] = [dim(r, "d"), dim(r, "chamfer")];
  return module(`    L = p.get("length", ${defaultLength})
    body = Cylinder(${d / 2}, L - ${2 * c})
    top = Pos(0, 0, L / 2 - ${c / 2}) * Cone(${d / 2}, ${d / 2 - c}, ${c})
    bottom = Pos(0, 0, -L / 2 + ${c / 2}) * Cone(${d / 2 - c}, ${d / 2}, ${c})
    return body + top + bottom
`);
}

/**
 * Threaded rod / stud as the gates see it: a plain cylinder at the ISO pitch
 * diameter, d - 0.6495·P, from z = 0 running +z like the nut and insert. One
 * solid, built in milliseconds, and as good as the thread for G5, which
 * exempts thread overlap anyway.
 */
export function threadedRodCode(thread: string, defaultLength = 50): string {
  const pitchD = Math.round((major(thread) - 0.6495 * threadSpec(thread)!.pitch) * 1000) / 1000;
  return module(`    L = p.get("length", ${defaultLength})
    return Pos(0, 0, L / 2) * Cylinder(${pitchD / 2}, L)
`);
}

/**
 * Furniture fasteners. Wood threads are modelled at their core Ø, which is
 * under the pilot hole, for the same reason threaded_rod is a pitch-Ø
 * cylinder: one fast solid, and nothing for G5 to count as overlap.
 *  - Confirmat: framed like a countersunk screw, the flush plane on z = 0,
 *    90° head, shoulder and thread running -z.
 *  - Cam housing: its face on z = 0 and the body +z into the panel, the bolt
 *    head's cavity open toward +x (the panel edge the bolt comes through).
 *  - Cam bolt: the collar's face on z = 0, thread -z into one panel, shank,
 *    neck and head +z, the head centred on the drilling distance.
 *  - Dowel screw: headless, centred on z = 0 along z, half in each part.
 */
export function confirmatCode(size: string, defaultLength: number): string {
  const r = familyDims("confirmat", size)!;
  const [d, headD, sl] = [dim(r, "d"), dim(r, "headD"), dim(r, "shoulderL")];
  const hh = (headD - d) / 2;
  return module(`    L = p.get("length", ${defaultLength})
    head = Pos(0, 0, ${-hh / 2}) * Cone(${d / 2}, ${headD / 2}, ${hh})
    shoulder = Pos(0, 0, ${-hh - sl / 2 + 0.01}) * Cylinder(${d / 2}, ${sl + 0.02})
    tl = L - ${hh + sl}
    thread = Pos(0, 0, ${-(hh + sl)} - tl / 2 + 0.01) * Cylinder(${dim(r, "core") / 2}, tl + 0.02)
    return head + shoulder + thread - ${socket(dim(r, "socketAf"), 0, 2.5)}
`);
}

/** Chipboard screw: a countersunk wood screw framed like csk, the flush plane
 *  on z = 0, a 90° head and the thread at its core Ø running -z. */
export function chipboardCode(size: string, defaultLength: number): string {
  const r = familyDims("chipboard", size)!;
  const [d, headD, core] = [dim(r, "d"), dim(r, "headD"), dim(r, "core")];
  const hh = (headD - d) / 2;
  return module(`    L = p.get("length", ${defaultLength})
    head = Pos(0, 0, ${-hh / 2}) * Cone(${d / 2}, ${headD / 2}, ${hh})
    thread = Pos(0, 0, ${-hh} - (L - ${hh}) / 2 + 0.01) * Cylinder(${core / 2}, L - ${hh} + 0.02)
    return head + thread - Pos(0, 0, -1) * Box(${(d * 0.7).toFixed(2)}, ${(d * 0.18).toFixed(2)}, 2.01) - Pos(0, 0, -1) * Box(${(d * 0.18).toFixed(2)}, ${(d * 0.7).toFixed(2)}, 2.01)
`);
}

/**
 * V-slot wheel kit as one solid: the wheel's V rim (two cones from hubD to
 * the od at vAngle) on a hub, and its two bearings' inner races standing
 * `proud` past each face round the bore. Seat on z = 0 (a race face), body +z.
 */
export function vWheelCode(size: string): string {
  const r = familyDims("v_wheel", size)!;
  const [od, w, hub, proud, race, bore] = [dim(r, "od"), dim(r, "width"), dim(r, "hubD"), dim(r, "proud"), dim(r, "raceD"), dim(r, "bore")];
  const rise = (od - hub) / 2;
  const flank = rise / Math.tan(((dim(r, "vAngle") / 2) * Math.PI) / 180);
  const mid = proud + w / 2;
  return module(`    body = Pos(0, 0, ${mid}) * Cylinder(${hub / 2}, ${w})
    body = body + Pos(0, 0, ${mid - flank / 2}) * Cone(${hub / 2}, ${od / 2}, ${flank})
    body = body + Pos(0, 0, ${mid + flank / 2}) * Cone(${od / 2}, ${hub / 2}, ${flank})
    body = body + Pos(0, 0, ${mid}) * Cylinder(${race / 2}, ${w + 2 * proud})
    return body - Pos(0, 0, ${mid}) * Cylinder(${bore / 2}, ${w + 2 * proud + 1})
`);
}

export function camLockCode(size: string): string {
  const r = familyDims("cam_lock", size)!;
  const [rad, h, w] = [dim(r, "d") / 2 - 0.1, dim(r, "height"), dim(r, "edgeHole")];
  return module(`    body = Pos(0, 0, ${h / 2}) * Cylinder(${rad}, ${h})
    cavity = Pos(0, 0, ${(h + 2) / 2}) * Cylinder(${w / 2}, ${h - 4})
    mouth = Pos(${rad / 2 + 0.5}, 0, ${(h + 2) / 2}) * Box(${rad + 1}, ${w}, ${h - 4})
    slot = Pos(0, 0, 1) * Box(${rad * 1.2}, 1.2, 2.01)
    return body - cavity - mouth - slot
`);
}

export function camBoltCode(size: string): string {
  const r = familyDims("cam_bolt", size)!;
  const n = (k: string) => dim(r, k);
  const [tl, ch, hh] = [n("threadL"), n("collarH"), n("headH")];
  const neckTop = n("drillDistance") - hh / 2;
  return module(`    thread = Pos(0, 0, ${-tl / 2 + 0.01}) * Cylinder(${n("core") / 2}, ${tl + 0.02})
    collar = Pos(0, 0, ${ch / 2}) * Cylinder(${n("collarD") / 2}, ${ch})
    shank = Pos(0, 0, ${(ch + neckTop - 2) / 2}) * Cylinder(${n("shankD") / 2}, ${neckTop - 2 - ch + 0.02})
    neck = Pos(0, 0, ${neckTop - 1}) * Cylinder(${n("core") / 2}, 2.02)
    head = Pos(0, 0, ${neckTop + hh / 2}) * Cylinder(${n("headD") / 2}, ${hh})
    return thread + collar + shank + neck + head
`);
}

export function dowelScrewCode(size: string, defaultLength: number): string {
  return module(`    L = p.get("length", ${defaultLength})
    return Cylinder(${dim(familyDims("dowel_screw", size)!, "core") / 2}, L)
`);
}

/** Small pins. Filament stock is centred on z = 0 like a dowel; a wire nail
 *  is framed like a screw, head on z ∈ [0, headH] and the pointed shank -z. */
export function pinCode(family: string, size: string, defaultLength: number): string {
  const r = familyDims(family, size)!;
  const d = dim(r, "d");
  if (family === "filament_pin") {
    return module(`    L = p.get("length", ${defaultLength})
    return Cylinder(${d / 2}, L)
`);
  }
  const hh = dim(r, "headH");
  return module(`    L = p.get("length", ${defaultLength})
    head = Pos(0, 0, ${hh / 2}) * Cylinder(${dim(r, "headD") / 2}, ${hh})
    shank = Pos(0, 0, -(L - ${d}) / 2 + 0.01) * Cylinder(${d / 2}, L - ${d} + 0.02)
    point = Pos(0, 0, -L + ${d / 2}) * Cone(0, ${d / 2}, ${d})
    return head + shank + point
`);
}

/**
 * Rolling bearing: outer ring, inner ring and the shield band between them,
 * recessed 0.2 at each face so the rings read as rings. The band stands in for
 * balls and cage: it fills the envelope a clash check must see, and fuses the
 * rings into the one solid G2 expects. Face on z = 0, body +z.
 *
 * Flanged (F6xx): the flange's underside is the seat at z = 0, flange +z, and
 * the body hangs -z into its bore like a screw shank.
 */
export function bearingCode(family: string, size: string, fit = 0): string {
  const r = familyDims(family, size)!;
  const [bore, od, w] = [dim(r, "bore") + fit, dim(r, "od"), dim(r, "width")];
  const ring = ((od - bore) / 2) * 0.3;
  const z0 = family === "bearing_flanged" ? dim(r, "flangeW") - w : 0;
  const flange =
    family === "bearing_flanged"
      ? `
    fw = ${dim(r, "flangeW")}
    brg = brg + Pos(0, 0, fw / 2) * (Cylinder(${dim(r, "flangeD") / 2}, fw) - Cylinder(${od / 2 - ring}, fw * 2))`
      : "";
  return module(`    def annulus(ro, ri, h, z):
        return Pos(0, 0, z + h / 2) * (Cylinder(ro, h) - Cylinder(ri, h * 2))
    outer = annulus(${od / 2}, ${od / 2 - ring}, ${w}, ${z0})
    inner = annulus(${bore / 2 + ring}, ${bore / 2}, ${w}, ${z0})
    band = annulus(${od / 2 - ring + 0.01}, ${bore / 2 + ring - 0.01}, ${w - 0.4}, ${z0 + 0.2})
    brg = outer + inner + band${flange}
    return brg
`);
}

/** Plain sleeve bushing, face on z = 0, body +z. */
export function bushingCode(size: string, defaultLength: number, fit = 0): string {
  const r = familyDims("bushing", size)!;
  return module(`    L = p.get("length", ${defaultLength})
    return Pos(0, 0, L / 2) * (Cylinder(${dim(r, "od") / 2}, L) - Cylinder(${(dim(r, "bore") + fit) / 2}, L * 2))
`);
}

/** Ground rod or D-shaft from its end face at z = 0, running +z. The D-flat
 *  faces +x over the full length, so a HUB_BORE's flat clocks by xAxis. */
export function shaftCode(family: string, size: string, defaultLength: number): string {
  const r = familyDims(family, size)!;
  const d = dim(r, "d");
  const flat =
    family === "d_shaft" ? ` - Pos(${d - dim(r, "flatDepth")}, 0, L / 2) * Box(${d}, ${d * 2}, L * 2)` : "";
  return module(`    L = p.get("length", ${defaultLength})
    return Pos(0, 0, L / 2) * Cylinder(${d / 2}, L)${flat}
`);
}

/** Set-screw shaft collar, face on z = 0, body +z, tapped radially along +x. */
export function collarCode(size: string, fit = 0): string {
  const r = familyDims("collar", size)!;
  const [bore, od, w] = [dim(r, "bore") + fit, dim(r, "od"), dim(r, "width")];
  const screw = String(r.setScrew);
  return module(`    ring = Pos(0, 0, ${w / 2}) * (Cylinder(${od / 2}, ${w}) - Cylinder(${bore / 2}, ${w * 2}))
    hole = Pos(${(od + bore) / 4}, 0, ${w / 2}) * Rot(0, 90, 0) * Cylinder(${tap(screw) / 2}, ${(od - bore) / 2 + 1})
    return ring - hole
`);
}

/** DIN 6799 retaining washer: a flat C, open on +x, face on z = 0, body +z.
 *  The inner Ø is the groove Ø, which is what the shaft's groove must match. */
export function eclipCode(size: string): string {
  const r = familyDims("eclip", size)!;
  const [g, od, s] = [dim(r, "groove"), dim(r, "od"), dim(r, "thickness")];
  return module(`    ring = Pos(0, 0, ${s / 2}) * (Cylinder(${od / 2}, ${s}) - Cylinder(${g / 2}, ${s * 2}))
    return ring - Pos(${od / 2}, 0, ${s / 2}) * Box(${od}, ${(g * 0.8).toFixed(2)}, ${s * 2})
`);
}

/** LM-UU linear ball bushing with its two retaining-ring grooves. Face on
 *  z = 0, body +z. */
export function linearBearingCode(size: string, fit = 0): string {
  const r = familyDims("lm_uu", size)!;
  const [bore, od, L] = [dim(r, "bore") + fit, dim(r, "od"), dim(r, "length")];
  const [span, gw, gd] = [dim(r, "grooveSpan"), dim(r, "grooveWidth"), dim(r, "grooveD")];
  return module(`    body = Pos(0, 0, ${L / 2}) * (Cylinder(${od / 2}, ${L}) - Cylinder(${bore / 2}, ${L * 2}))
    for z in (${L / 2 - span / 2 + gw / 2}, ${L / 2 + span / 2 - gw / 2}):
        body = body - Pos(0, 0, z) * (Cylinder(${od / 2 + 1}, ${gw}) - Cylinder(${gd / 2}, ${gw * 2}))
    return body
`);
}

/**
 * Miniature profile rail, along x and centred on the origin, mounting face on
 * z = 0, body +z, with counterbored holes at pitch (centred, so the end
 * distances match) and the two ball tracks as side grooves.
 */
export function railCode(size: string, defaultLength: number): string {
  const r = familyDims("mgn_rail", size)!;
  const [w, h, pitch] = [dim(r, "width"), dim(r, "height"), dim(r, "pitch")];
  const [hd, cd, cdepth] = [dim(r, "holeD"), dim(r, "cboreD"), dim(r, "cboreDepth")];
  return module(`    L = p.get("length", ${defaultLength})
    rail = Pos(0, 0, ${h / 2}) * Box(L, ${w}, ${h})
    for y in (${-w / 2}, ${w / 2}):
        rail = rail - Pos(0, y, ${h * 0.6}) * Box(L * 2, 1.0, 1.2)
    n = max(1, int(L // ${pitch}))
    cutters = []
    for i in range(n):
        x = (i - (n - 1) / 2) * ${pitch}
        cutters.append(Pos(x, 0, ${h / 2}) * Cylinder(${hd / 2}, ${h * 2}))
        cutters.append(Pos(x, 0, ${h - cdepth / 2 + 0.5}) * Cylinder(${cd / 2}, ${cdepth + 1}))
    return rail.cut(*cutters)
`);
}

/**
 * Carriage block in its RAIL's frame (z = 0 is the rail's mounting face, x
 * along the rail), so it is placed by the same mate as the rail plus a stroke
 * offset in x. Body from the underside gap to the stated height, a channel
 * over the rail, four tapped mounting holes in the top.
 */
export function carriageCode(size: string): string {
  const r = familyDims("mgn_carriage", size)!;
  const rail = familyDims("mgn_rail", String(r.rail))!;
  const [w, l, h, gap] = [dim(r, "width"), dim(r, "length"), dim(r, "height"), dim(r, "gap")];
  const channelTop = dim(rail, "height") + 0.3;
  const depth = Math.min(3, (h - channelTop) * 0.8).toFixed(2);
  return module(`    body = Pos(0, 0, ${(gap + h) / 2}) * Box(${l}, ${w}, ${h - gap})
    body = body - Pos(0, 0, ${channelTop / 2}) * Box(${l * 2}, ${dim(rail, "width") + 0.4}, ${channelTop})
    for x in (${-dim(r, "mountX") / 2}, ${dim(r, "mountX") / 2}):
        for y in (${-dim(r, "mountY") / 2}, ${dim(r, "mountY") / 2}):
            body = body - Pos(x, y, ${h} - ${depth} / 2) * Cylinder(${tap(String(r.mountThread)) / 2}, ${depth} + 0.01)
    return body
`);
}

/** GT2 tip Ø: the pitch Ø (teeth × 2 / π) less twice the 0.254 pitch-line offset. */
export const gt2TipD = (teeth: number) => (teeth * 2) / Math.PI - 0.508;

/**
 * GT2 pulley, axis z, hub face on z = 0: hub, flange, toothed rim, flange,
 * bore through, one radial set screw in the hub. The teeth are the rim with a
 * belt-tooth groove cut per tooth at the pitch line — a toothed silhouette and
 * the right tip Ø, not a conjugate profile. An idler (gt2_idler) has no hub:
 * its first flange sits on z = 0.
 */
export function pulleyCode(size: string, family = "gt2_pulley", fit = 0): string {
  const r = familyDims(family, size)!;
  const teeth = dim(r, "teeth");
  const tip = gt2TipD(teeth);
  const [tw, fd, fw] = ["toothWidth", "flangeD", "flangeW"].map((k) => dim(r, k)) as [number, number, number];
  const bore = dim(r, "bore") + fit;
  const hl = typeof r.hubL === "number" ? r.hubL : 0;
  const total = hl + 2 * fw + tw;
  const hub = hl
    ? `
    body = body + disc(${dim(r, "hubD") / 2}, ${hl}, 0)
    body = body - Pos(0, 0, ${total / 2}) * Cylinder(${bore / 2}, ${total * 2})
    return body - Pos(${(dim(r, "hubD") + bore) / 4}, 0, ${hl / 2}) * Rot(0, 90, 0) * Cylinder(${tap(String(r.setScrew)) / 2}, ${(dim(r, "hubD") - bore) / 2 + 1})`
    : `
    return body - Pos(0, 0, ${total / 2}) * Cylinder(${bore / 2}, ${total * 2})`;
  return module(`    def disc(rad, h, z):
        return Pos(0, 0, z + h / 2) * Cylinder(rad, h)
    rim = disc(${tip / 2}, ${tw}, ${hl + fw})
    grooves = [
        Pos(${tip / 2 - 0.195} * math.cos(i * 2 * math.pi / ${teeth}), ${tip / 2 - 0.195} * math.sin(i * 2 * math.pi / ${teeth}), ${hl + fw + tw / 2}) * Cylinder(0.555, ${tw})
        for i in range(${teeth})
    ]
    body = disc(${fd / 2}, ${fw}, ${hl}) + rim.cut(*grooves) + disc(${fd / 2}, ${fw}, ${hl + fw + tw})${hub}
`);
}

/**
 * GT2 belt, its envelope with no teeth drawn. Open (no `center` param): a
 * strip along +x from the origin, back face on z = 0, teeth side +z. Wrapped
 * (`center` > 0): a closed band around two pulleys, the first on the origin
 * and the second `center` along +x, inner Ø `d1` / `d2` (the pulleys' tip Ø),
 * bottom edge on z = 0 and the width up +z.
 */
export function beltCode(size: string, defaultLength: number, family = "gt2_belt"): string {
  const r = familyDims(family, size)!;
  const [t, w] = [dim(r, "thickness"), dim(r, "width")];
  return module(`    L = p.get("length", ${defaultLength})
    c = p.get("center", 0)
    if c > 0:
        def hull(r1, r2):
            return Face(Wire.make_convex_hull([Edge.make_circle(r1), Pos(c, 0, 0) * Edge.make_circle(r2)]))
        r1, r2 = p.get("d1", 10) / 2, p.get("d2", 10) / 2
        return extrude(hull(r1 + ${t}, r2 + ${t}) - hull(r1, r2), ${w}, dir=(0, 0, 1))
    return Pos(L / 2, 0, ${t / 2}) * Box(L, ${w}, ${t})
`);
}

/** Flexible coupler, axis z, bore A from z = 0 to the middle, bore B above. */
export function couplerCode(size: string): string {
  const r = familyDims("coupler", size)!;
  const [a, b, od, L] = [dim(r, "boreA"), dim(r, "boreB"), dim(r, "od"), dim(r, "length")];
  return module(`    body = Pos(0, 0, ${L / 2}) * Cylinder(${od / 2}, ${L})
    body = body - Pos(0, 0, ${L / 4}) * Cylinder(${a / 2}, ${L / 2 + 0.02})
    return body - Pos(0, 0, ${(3 * L) / 4}) * Cylinder(${b / 2}, ${L / 2 + 0.02})
`);
}

/** Flanged lead-screw nut, framed like a screw head: the flange's bearing
 *  face on z = 0 with the flange +z, the body -z into the host, bored through,
 *  the flange's screw holes on their pcd. */
export function leadNutCode(size: string): string {
  const r = familyDims("lead_nut", size)!;
  const [ft, L] = [dim(r, "flangeT"), dim(r, "length")];
  return module(`    nut = Pos(0, 0, ${ft / 2}) * Cylinder(${dim(r, "flangeD") / 2}, ${ft}) + Pos(0, 0, ${-(L - ft) / 2 + 0.01}) * Cylinder(${dim(r, "bodyD") / 2}, ${L - ft + 0.02})
    nut = nut - Pos(0, 0, ${ft - L / 2}) * Cylinder(${dim(r, "bore") / 2}, ${L * 2})
    for i in range(${dim(r, "holeCount")}):
        a = i * 2 * math.pi / ${dim(r, "holeCount")}
        nut = nut - Pos(${dim(r, "pcd") / 2} * math.cos(a), ${dim(r, "pcd") / 2} * math.sin(a), ${ft / 2}) * Cylinder(${dim(r, "holeD") / 2}, ${ft * 2})
    return nut
`);
}

/**
 * Motors. Mount face on z = 0 with the body +z, so the seat is SEAT_POSE and
 * whatever goes THROUGH the host (NEMA pilot and shaft, N20 shaft) runs -z.
 *  - NEMA 17: square body with the corners turned off, 4 tapped holes, pilot
 *    boss, D-flat shaft on +x. `length` is the body length.
 *  - Brushless outrunner: base on z = 0, bell above, shaft up +z, M3 base holes.
 *  - N20: gearbox face on z = 0, shaft -z with its flat, two M1.6 holes.
 *  - SG90 / MG996R: the tab underside is the seat; the case hangs -z through
 *    a cutout and the output spline is on top, offset to one end as on the
 *    real part. MG996R has two holes per tab (holeRowPitch).
 *  - STS3215: no tabs, the case bottom is the seat (tabZ 0) with four
 *    self-tapping holes in it; the horn sits on the case over the output.
 */
export function motorCode(family: string, size: string, defaultLength = 40): string {
  const r = familyDims(family, size)!;
  const n = (k: string) => dim(r, k);
  if (family === "nema17" || family === "nema14") {
    const [face, pitch, d] = [n("face"), n("holePitch"), n("shaftD")];
    return module(`    L = p.get("length", ${defaultLength})
    body = Pos(0, 0, L / 2) * Box(${face}, ${face}, L) & Pos(0, 0, L / 2) * Cylinder(${(face / 2) * 1.2}, L)
    for x in (${-pitch / 2}, ${pitch / 2}):
        for y in (${-pitch / 2}, ${pitch / 2}):
            body = body - Pos(x, y, ${n("holeDepth") / 2}) * Cylinder(${tap(String(r.holeThread)) / 2}, ${n("holeDepth")} + 0.01)
    pilot = Pos(0, 0, ${-n("pilotH") / 2}) * Cylinder(${n("pilotD") / 2}, ${n("pilotH") + 0.01})
    shaft = Pos(0, 0, ${-n("shaftL") / 2}) * Cylinder(${d / 2}, ${n("shaftL")})
    shaft = shaft - Pos(${d - n("flatDepth")}, 0, ${-n("shaftL") / 2 - n("pilotH") / 2}) * Box(${d}, ${d * 2}, ${n("shaftL") - n("pilotH")})
    return body + pilot + shaft
`);
  }
  if (family === "brushless") {
    const [bh, bellH, sl] = [n("baseH"), n("bellH"), n("shaftL")];
    return module(`    base = Pos(0, 0, ${bh / 2}) * Cylinder(${n("baseD") / 2}, ${bh})
    bell = Pos(0, 0, ${bh + bellH / 2 - 0.01}) * Cylinder(${n("bellD") / 2}, ${bellH})
    shaft = Pos(0, 0, ${bh + bellH + sl / 2 - 0.5}) * Cylinder(${n("shaftD") / 2}, ${sl + 0.5})
    motor = base + bell + shaft
    for i in range(${n("holeCount")}):
        a = math.pi / 4 + i * 2 * math.pi / ${n("holeCount")}
        motor = motor - Pos(${n("pcd") / 2} * math.cos(a), ${n("pcd") / 2} * math.sin(a), 1.5) * Cylinder(${tap(String(r.holeThread)) / 2}, 3.01)
    return motor
`);
  }
  if (family === "n20") {
    const [w, h, L, d, sl] = [n("width"), n("height"), n("gearboxL") + n("motorL"), n("shaftD"), n("shaftL")];
    return module(`    body = Pos(0, 0, ${L / 2}) * (Box(${w}, ${h}, ${L}) & Cylinder(${w / 2}, ${L}))
    for x in (${-n("pcd") / 2}, ${n("pcd") / 2}):
        body = body - Pos(x, 0, 1) * Cylinder(${n("holeD") * 0.4}, 2.01)
    shaft = Pos(0, 0, ${-sl / 2}) * Cylinder(${d / 2}, ${sl + 0.01})
    shaft = shaft - Pos(${d - n("flatDepth")}, 0, ${-sl / 2 - 0.5}) * Box(${d}, ${d * 2}, ${sl - 1})
    return body + shaft
`);
  }
  const [bl, bw, bh, tz] = [n("bodyL"), n("bodyW"), n("bodyH"), n("tabZ")];
  const top = bh - tz;
  const sx = bl / 2 - n("bossD") / 2;
  const rows = typeof r.holeRowPitch === "number" ? [-r.holeRowPitch / 2, r.holeRowPitch / 2] : [0];
  if (family === "sts3215") {
    const [hd, hh, pcd] = [n("splineD"), n("splineH"), n("hornPcd")];
    // The case pilots sit off-centre, toward the body from the axis (holeX).
    const hx = typeof r.holeX === "number" ? r.holeX : 0;
    return module(`    body = Pos(0, 0, ${bh / 2}) * Box(${bl}, ${bw}, ${bh})
    for x in (${hx - n("holePitch") / 2}, ${hx + n("holePitch") / 2}):
        for y in (${rows.join(", ")},):
            body = body - Pos(x, y, 2.5) * Cylinder(${n("holeD") / 2}, 5.01)
    horn = Pos(${sx}, 0, ${bh + hh / 2 - 0.01}) * Cylinder(${hd / 2}, ${hh})
    for i in range(4):
        a = i * math.pi / 2
        horn = horn - Pos(${sx} + ${pcd / 2} * math.cos(a), ${pcd / 2} * math.sin(a), ${bh + hh - 1.5}) * Cylinder(${tap(String(r.hornThread)) / 2}, 3.01)
    return body + horn
`);
  }
  return module(`    body = Pos(0, 0, ${bh / 2 - tz}) * Box(${bl}, ${bw}, ${bh})
    tabs = Pos(0, 0, ${n("tabT") / 2}) * Box(${n("tabL")}, ${bw}, ${n("tabT")})
    for x in (${-n("holePitch") / 2}, ${n("holePitch") / 2}):
        for y in (${rows.join(", ")},):
            tabs = tabs - Pos(x, y, ${n("tabT") / 2}) * Cylinder(${n("holeD") / 2}, ${n("tabT") * 2})
    boss = Pos(${sx}, 0, ${top + n("bossH") / 2 - 0.01}) * Cylinder(${n("bossD") / 2}, ${n("bossH")})
    spline = Pos(${sx}, 0, ${top + n("bossH") + n("splineH") / 2 - 0.01}) * Cylinder(${n("splineD") / 2}, ${n("splineH")})
    return body + tabs + boss + spline
`);
}

/** Disc magnet, face on z = 0, body +z. */
export function magnetCode(size: string): string {
  const r = familyDims("disc_magnet", size)!;
  const h = dim(r, "h");
  return module(`    return Pos(0, 0, ${h / 2}) * Cylinder(${dim(r, "d") / 2}, ${h})
`);
}

/** O-ring on its inner Ø (`id` param), centred on the origin in the xy plane.
 *  No seat: it lies in a gland. */
export function oringCode(size: string): string {
  const cs = dim(familyDims("oring", size)!, "cs");
  return module(`    return Torus((p.get("id", 10) + ${cs}) / 2, ${cs / 2})
`);
}

/** Hex female-female standoff, face on z = 0, body +z, tapped through. */
export function standoffCode(thread: string, defaultLength: number): string {
  const af = dim(familyDims("standoff", thread)!, "af");
  return module(`    L = p.get("length", ${defaultLength})
    body = extrude(RegularPolygon(${af} / math.sqrt(3), 6), L)
    return body - Pos(0, 0, L / 2) * Cylinder(${tap(thread)} / 2, L * 2)
`);
}

/**
 * Involute spur gear. This is the clearest case for the registry in the whole
 * taxonomy: a correct tooth profile is an involute curve, which a language
 * model will approximate with trapezoids every time, and no gate can tell a
 * plausible-looking wrong tooth from a right one.
 *
 * Unlike the thread-driven hardware this is param-driven, so the code text is
 * constant and a param change needs no re-codegen — it just re-executes.
 * involute_gear (kernel gear.py, injected like the other registry classes)
 * puts the axis on the origin, matching the part-local frame convention,
 * with a tooth on +x, and builds any tooth count (bd_warehouse refused z >= 42
 * at 20 degrees). `phase` turns the teeth (not the bore) by that many
 * degrees, so a meshing pair can put a gap opposite a tooth; `flat` makes the
 * bore a D, the flat that far from the axis along +x, like a D-shaft's, or
 * turned `clock` degrees about z to face the hub port's xAxis (the probe reads
 * the flat on +xAxis and fits the circle on the -x half, so a flat cut on +x
 * under an xAxis of -x read as Ø8.28 on a Ø7.95 press bore: hand-winch).
 * `fit` is added to the bore Ø (see boreFit).
 */
export function gearCode(fit = 0, flat = `p.get("flat", 0)`, nominal = "p.bore", clock = 0): string {
  const bore = fit ? `(nominal ${fit < 0 ? "-" : "+"} ${Math.abs(fit)})` : "nominal";
  const turn = clock ? `Rot(0, 0, ${clock}) * ` : "";
  return `from build123d import *

def build(p):
    gear = involute_gear(p.module, int(p.teeth), p.pressure_angle, p.thickness, p.get("phase", 0))
    flat = ${flat}
    nominal = ${nominal}
    if nominal > 0:
        hole = Cylinder(${bore} / 2, p.thickness * 2)
        if flat > 0:
            hole = hole - ${turn}Pos(flat + nominal / 2, 0, 0) * Box(nominal, nominal * 2, p.thickness * 4)
        gear = gear - hole
    return gear
`;
}

/** Rectangular plate with a symmetric corner hole pattern, top face at z = t/2. */
export function plateCode(): string {
  return `from build123d import *

def build(p):
    plate = Box(p.width, p.depth, p.thickness)
    inset = p.hole_inset
    for sx in (-1, 1):
        for sy in (-1, 1):
            hole = Pos(sx * (p.width / 2 - inset), sy * (p.depth / 2 - inset), 0) * \\
                Cylinder(p.hole_diameter / 2, p.thickness)
            plate = plate - hole
    return plate
`;
}

/** Family → codegen. Each takes the canonical key, the resolved SKU and the
 *  bore's fit offset (boreFit), which only the bored families use. */
const CODEGEN: Record<string, (key: string, sku: Sku, fit: number) => string> = {
  shcs: (k, s) => screwCode("shcs", k, lengthOf("shcs", k, s)),
  button: (k, s) => screwCode("button", k, lengthOf("button", k, s)),
  csk: (k, s) => screwCode("csk", k, lengthOf("csk", k, s)),
  hex_nut: (k) => nutCode(k),
  heatset_std: (k) => insertCode(k, "heatset_std"),
  heatset_short: (k) => insertCode(k, "heatset_short"),
  wood_insert: (k, s) => woodInsertCode(k, lengthOf("wood_insert", k, s)),
  washer: (k) => washerCode(k),
  dowel: (k, s) => dowelCode(k, lengthOf("dowel", k, s)),
  threaded_rod: (k, s) => threadedRodCode(k, lengthOf("threaded_rod", k, s)),
  bearing: (k, _s, f) => bearingCode("bearing", k, f),
  bearing_flanged: (k, _s, f) => bearingCode("bearing_flanged", k, f),
  bushing: (k, s, f) => bushingCode(k, lengthOf("bushing", k, s), f),
  shaft: (k, s) => shaftCode("shaft", k, lengthOf("shaft", k, s)),
  d_shaft: (k, s) => shaftCode("d_shaft", k, lengthOf("d_shaft", k, s)),
  collar: (k, _s, f) => collarCode(k, f),
  eclip: (k) => eclipCode(k),
  lm_uu: (k, _s, f) => linearBearingCode(k, f),
  mgn_rail: (k, s) => railCode(k, lengthOf("mgn_rail", k, s)),
  mgn_carriage: (k) => carriageCode(k),
  gt2_pulley: (k, _s, f) => pulleyCode(k, "gt2_pulley", f),
  gt2_idler: (k, _s, f) => pulleyCode(k, "gt2_idler", f),
  gt2_belt: (k, s) => beltCode(k, lengthOf("gt2_belt", k, s)),
  gt2_loop: (k, s) => beltCode(k, lengthOf("gt2_loop", k, s), "gt2_loop"),
  spur_gear: (_k, _s, f) => gearCode(f),
  coupler: (k) => couplerCode(k),
  lead_screw: (k, s) => shaftCode("lead_screw", k, lengthOf("lead_screw", k, s)),
  lead_nut: (k) => leadNutCode(k),
  nema17: (k, s) => motorCode("nema17", k, lengthOf("nema17", k, s)),
  brushless: (k) => motorCode("brushless", k),
  n20: (k) => motorCode("n20", k),
  sg90: (k) => motorCode("sg90", k),
  mg996r: (k) => motorCode("mg996r", k),
  sts3215: (k) => motorCode("sts3215", k),
  nema14: (k, s) => motorCode("nema14", k, lengthOf("nema14", k, s)),
  wood_dowel: (k, s) => dowelCode(k, lengthOf("wood_dowel", k, s), "wood_dowel"),
  confirmat: (k, s) => confirmatCode(k, lengthOf("confirmat", k, s)),
  chipboard: (k, s) => chipboardCode(k, lengthOf("chipboard", k, s)),
  v_wheel: (k) => vWheelCode(k),
  cam_lock: (k) => camLockCode(k),
  cam_bolt: (k) => camBoltCode(k),
  dowel_screw: (k, s) => dowelScrewCode(k, lengthOf("dowel_screw", k, s)),
  filament_pin: (k, s) => pinCode("filament_pin", k, lengthOf("filament_pin", k, s)),
  wire_nail: (k, s) => pinCode("wire_nail", k, lengthOf("wire_nail", k, s)),
  disc_magnet: (k) => magnetCode(k),
  oring: (k) => oringCode(k),
  standoff: (k, s) => standoffCode(k, lengthOf("standoff", k, s)),
};

/** Live value first, contract default second, never from generated code. */
function paramOf(node: NodeRecord, name: string): string {
  return String(node.params[name] ?? node.contract.params.find((p) => p.name === name)?.default ?? "");
}

/**
 * A bought part's bore is exact, but a HUB_BORE the node declares on itself is
 * probed against a fit band, and registry parts get no repair round: a gear
 * bored at the nominal Ø5.00 fails a slip band of 5.05..5.25 for good. So the
 * bore is cut at the band's middle for the process that makes the part, from
 * the same table the generator's cut annotation reads (grounding.ts).
 */
function boreFit(node: NodeRecord): number {
  const ports = (node.contract.payload as { ports?: { type: string; params: Record<string, number | string> }[] } | undefined)?.ports;
  const hub = ports?.find((p) => p.type === "HUB_BORE");
  return hub ? fitOffset(hub, isMachined(sourcingOf(node).process)) : 0;
}

/**
 * The D-flat a gear's own HUB_BORE declares, as Python. A joint mints it as
 * `param(<gear>.<joint>_flat)`, not as the gear's `flat`, and hand-winch's
 * gears were cut round and failed G3 ("the flat at 3.98mm, expected 3").
 */
function hubFlat(node: NodeRecord): string | undefined {
  return hubParam(node, "flat", "0");
}

/** Degrees about z from the gear's +x to its own HUB_BORE's xAxis: the side
 *  the probe (and the D-shaft's flat, mated through that port) expects. */
function hubClock(node: NodeRecord): number {
  const ports = (node.contract.payload as { ports?: { type: string; pose?: { xAxis?: unknown[] } }[] } | undefined)?.ports;
  const x = ports?.find((p) => p.type === "HUB_BORE")?.pose?.xAxis;
  if (!x || typeof x[0] !== "number" || typeof x[1] !== "number" || Math.hypot(x[0], x[1]) < 1e-6) return 0;
  return Math.round((Math.atan2(x[1], x[0]) * 180) / Math.PI * 1e4) / 1e4;
}

/** A param of a gear's own HUB_BORE, as Python. Its Ø is the joint's shaft
 *  and wins over the gear's `bore` (hand-winch: bore 8.3 on a Ø8 press hub
 *  measured 8.28 at G3). */
function hubParam(node: NodeRecord, name: string, fallback: string): string | undefined {
  const ports = (node.contract.payload as { ports?: { type: string; params: Record<string, number | string> }[] } | undefined)?.ports;
  const v = ports?.find((p) => p.type === "HUB_BORE")?.params[name];
  if (typeof v === "number") return String(v);
  const ref = typeof v === "string" ? /^\s*param\(([^.()]+)\.(\w+)\)\s*$/.exec(v) : null;
  return ref && ref[1] === node.id ? `p.get(${JSON.stringify(ref[2])}, ${fallback})` : undefined;
}

/**
 * Which catalog row a hardware node is. `sku` wins; without one, the kind's
 * default family keyed by `thread` (thread-keyed families) or `size`. A SKU
 * of another kind's family is declined, not reinterpreted.
 */
export function skuOf(node: NodeRecord): Sku | null {
  const families = familiesOfKind(node.kind);
  const id = paramOf(node, "sku");
  if (id) {
    const sku = parseSku(id);
    return sku && families.includes(sku.family) ? sku : null;
  }
  const family = families[0];
  if (!family) return null;
  const key = canonicalKey(family, paramOf(node, CATALOG.families[family]!.keyedBy));
  return key ? skuFor(family, key)! : null;
}

/**
 * Catalog-driven factory. These re-codegen when the SKU changes: an M5 nut is
 * different code, not an M4 with new params. A SKU carrying a vendor STEP
 * loads it (through the project's imports, like an imported mesh) and falls
 * back to the parametric model only when the file is not there: a STEP that
 * is present but will not load fails the build rather than hiding behind the
 * fallback.
 */
function bySku(node: NodeRecord): string | null {
  const sku = skuOf(node);
  if (!sku) return null;
  const code = CODEGEN[sku.family]!(sku.key, sku, boreFit(node));
  if (!sku.stepFile) return code;
  return code.replace(
    "def build(p):\n",
    `def build(p):\n    try:\n        return load_import(${JSON.stringify(sku.stepFile)})\n    except FileNotFoundError:\n        pass\n`,
  );
}

/**
 * Registry parts: kind → codegen. Everything here is exact by construction and
 * declares no geometric ports, so these kinds skip G4 envelope grading and the
 * port-consistency lint. Adding a class is a catalog family plus a factory.
 */
const REGISTRY: Record<string, (node: NodeRecord) => string | null> = {
  ...Object.fromEntries(Object.values(CATALOG.families).map((f) => [f.kind, bySku])),
  // Param-driven: the code text is constant, see gearCode.
  gear: (node) => gearCode(boreFit(node), hubFlat(node), hubParam(node, "diameter", "p.bore"), hubClock(node)),
};

/** Kinds resolved from REGISTRY. Exported because the gates and lints need to
 *  know which kinds are exact-by-construction rather than architect guesses. */
export const REGISTRY_HARDWARE = new Set(Object.keys(REGISTRY));

/**
 * Solid count per registry kind where it is not 1, for G2 (kernelRequest).
 * Every catalog part is built as one fused solid on purpose (a bearing's
 * shield band fuses its rings, the threaded rod is a pitch-Ø cylinder), so
 * this is empty; null would mean "not countable, skip the check".
 */
export const REGISTRY_SOLIDS: Record<string, number | null> = {};

/**
 * The subset that exists to join parts together, and so must be justified by a
 * hole port somewhere (cadFastenerJustifiedLint). A gear meshes with another
 * gear rather than bolting to anything, and a bearing or motor is the thing
 * being held, so they are deliberately not in here.
 */
export const FASTENING_HARDWARE = new Set(["fastener", "nut", "insert", "threaded_rod", "washer", "dowel", "standoff", "cam_lock", "cam_bolt", "dowel_screw", "pin"]);

/**
 * Why a registry node names no catalog part, or null when it resolves (or is
 * not registry hardware). cadHardwareResolvesLint runs it at plan time.
 */
export function unresolvedHardware(node: NodeRecord): string | null {
  const build = REGISTRY[node.kind];
  if (!build || build(node) !== null) return null;
  const family = familiesOfKind(node.kind)[0];
  const sku = paramOf(node, "sku");
  const keyedBy = family ? CATALOG.families[family]!.keyedBy : "size";
  const named = sku ? `sku "${sku}"` : `${keyedBy} "${paramOf(node, keyedBy)}"`;
  const known = family ? Object.keys(CATALOG.families[family]!.dims).join(", ") : "";
  return `${node.id}: ${node.kind} ${named} names no ${node.kind} in the hardware catalog${known ? ` (${family} has ${known})` : ""}. Hardware is built only from the catalog, never generated, so name a listed size.`;
}

/**
 * The cook-time hook: registry nodes resolve here, deterministically, before
 * any library or LLM step. A registry kind that names no catalog part still
 * resolves, to code that fails G1 with the reason, so the cook lands in
 * error_code: returning null would hand a screw to the LLM generator.
 */
export function resolveHardware(node: NodeRecord): string | null {
  const build = REGISTRY[node.kind];
  if (!build) return null;
  return build(node) ?? module(`    raise ValueError(${JSON.stringify(unresolvedHardware(node))})\n`);
}

/** Imported pieces (STL/STEP/3MF segments) load their mesh deterministically,
 * with their joints' host features cut in (segment-joints.ts) —
 * UNLESS the user has reprompted them: a non-empty thread routes to the
 * generator, which starts from that same expression and edits the mesh with
 * build123d booleans. Hardware stays registry-only always. Files: imports/<nodeId>.ply. */
export function resolveDeterministic(node: NodeRecord): string | null {
  if (node.kind === "imported") {
    if (node.thread.length > 0) return null;
    return importedNodeCode(node);
  }
  return resolveHardware(node);
}
