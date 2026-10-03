import type { NodeRecord } from "@patchcad/shared";
import { importedNodeCode } from "./segment-joints.js";
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

/** A cut-to-length part's length: the live `length` param, else the SKU's,
 *  else the shortest stocked one. */
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
export function dowelCode(size: string, defaultLength: number): string {
  const r = familyDims("dowel", size)!;
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
 * The same rod with a real ISO profile (bd_warehouse IsoThread), for a picture
 * rather than a gate: it is a coreless ridge of one solid per turn segment (30
 * for M4x20), and fusing a core costs ~3s per 20mm, which a long rod turns
 * into a build timeout. Never on the gate path. `IsoThread` is injected into
 * the kernel exec namespace rather than imported (worker.py
 * _registry_namespace), so G0 stays closed to generated code.
 */
export function isoThreadedRodCode(thread: string, defaultLength = 50): string {
  const pitch = threadSpec(thread)!.pitch;
  return `from build123d import *

def build(p):
    return IsoThread(major_diameter=${major(thread)}, pitch=${pitch}, length=p.get("length", ${defaultLength}), external=True)
`;
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
export function bearingCode(family: string, size: string): string {
  const r = familyDims(family, size)!;
  const [bore, od, w] = [dim(r, "bore"), dim(r, "od"), dim(r, "width")];
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
export function bushingCode(size: string, defaultLength: number): string {
  const r = familyDims("bushing", size)!;
  return module(`    L = p.get("length", ${defaultLength})
    return Pos(0, 0, L / 2) * (Cylinder(${dim(r, "od") / 2}, L) - Cylinder(${dim(r, "bore") / 2}, L * 2))
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
export function collarCode(size: string): string {
  const r = familyDims("collar", size)!;
  const [bore, od, w] = [dim(r, "bore"), dim(r, "od"), dim(r, "width")];
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
export function linearBearingCode(size: string): string {
  const r = familyDims("lm_uu", size)!;
  const [bore, od, L] = [dim(r, "bore"), dim(r, "od"), dim(r, "length")];
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

/**
 * GT2 pulley, axis z, hub face on z = 0: hub, flange, toothed rim, flange,
 * bore through, one radial set screw in the hub. The teeth are the rim with a
 * belt-tooth groove cut per tooth at the pitch line — a toothed silhouette and
 * the right tip Ø, not a conjugate profile.
 */
export function pulleyCode(size: string): string {
  const r = familyDims("gt2_pulley", size)!;
  const teeth = dim(r, "teeth");
  const tip = (teeth * 2) / Math.PI - 0.508;
  const [bore, tw, fd, fw, hd, hl] = ["bore", "toothWidth", "flangeD", "flangeW", "hubD", "hubL"].map((k) => dim(r, k)) as [
    number, number, number, number, number, number,
  ];
  const total = hl + 2 * fw + tw;
  return module(`    def disc(rad, h, z):
        return Pos(0, 0, z + h / 2) * Cylinder(rad, h)
    rim = disc(${tip / 2}, ${tw}, ${hl + fw})
    grooves = [
        Pos(${tip / 2 - 0.195} * math.cos(i * 2 * math.pi / ${teeth}), ${tip / 2 - 0.195} * math.sin(i * 2 * math.pi / ${teeth}), ${hl + fw + tw / 2}) * Cylinder(0.555, ${tw})
        for i in range(${teeth})
    ]
    body = disc(${hd / 2}, ${hl}, 0) + disc(${fd / 2}, ${fw}, ${hl}) + rim.cut(*grooves) + disc(${fd / 2}, ${fw}, ${hl + fw + tw})
    body = body - Pos(0, 0, ${total / 2}) * Cylinder(${bore / 2}, ${total * 2})
    screw = Pos(${(hd + bore) / 4}, 0, ${hl / 2}) * Rot(0, 90, 0) * Cylinder(${tap(String(r.setScrew)) / 2}, ${(hd - bore) / 2 + 1})
    return body - screw
`);
}

/** Open GT2 belt, its envelope strip: along +x from the origin, back face on
 *  z = 0, teeth side +z. */
export function beltCode(size: string, defaultLength: number): string {
  const r = familyDims("gt2_belt", size)!;
  const t = dim(r, "thickness");
  return module(`    L = p.get("length", ${defaultLength})
    return Pos(L / 2, 0, ${t / 2}) * Box(L, ${dim(r, "width")}, ${t})
`);
}

/**
 * Motors. Mount face on z = 0 with the body +z, so the seat is SEAT_POSE and
 * whatever goes THROUGH the host (NEMA pilot and shaft, N20 shaft) runs -z.
 *  - NEMA 17: square body with the corners turned off, 4 tapped holes, pilot
 *    boss, D-flat shaft on +x. `length` is the body length.
 *  - Brushless outrunner: base on z = 0, bell above, shaft up +z, M3 base holes.
 *  - N20: gearbox face on z = 0, shaft -z with its flat, two M1.6 holes.
 *  - SG90: the tab underside is the seat; the case hangs -z through a cutout
 *    and the output spline is on top, offset to one end as on the real part.
 */
export function motorCode(family: string, size: string, defaultLength = 40): string {
  const r = familyDims(family, size)!;
  const n = (k: string) => dim(r, k);
  if (family === "nema17") {
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
  // sg90
  const [bl, bw, bh, tz] = [n("bodyL"), n("bodyW"), n("bodyH"), n("tabZ")];
  const top = bh - tz;
  const sx = bl / 2 - n("bossD") / 2;
  return module(`    body = Pos(0, 0, ${bh / 2 - tz}) * Box(${bl}, ${bw}, ${bh})
    tabs = Pos(0, 0, ${n("tabT") / 2}) * Box(${n("tabL")}, ${bw}, ${n("tabT")})
    for x in (${-n("holePitch") / 2}, ${n("holePitch") / 2}):
        tabs = tabs - Pos(x, 0, ${n("tabT") / 2}) * Cylinder(${n("holeD") / 2}, ${n("tabT") * 2})
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
 * SpurGear centers on the origin, matching the part-local frame convention.
 */
export function gearCode(): string {
  return `from build123d import *

def build(p):
    gear = SpurGear(
        module=p.module,
        tooth_count=int(p.teeth),
        pressure_angle=p.pressure_angle,
        thickness=p.thickness,
    )
    if p.bore > 0:
        gear = gear - Cylinder(p.bore / 2, p.thickness * 2)
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

/** Family → codegen. Each takes the canonical key and the resolved SKU. */
const CODEGEN: Record<string, (key: string, sku: Sku) => string> = {
  shcs: (k, s) => screwCode("shcs", k, lengthOf("shcs", k, s)),
  button: (k, s) => screwCode("button", k, lengthOf("button", k, s)),
  csk: (k, s) => screwCode("csk", k, lengthOf("csk", k, s)),
  hex_nut: (k) => nutCode(k),
  heatset_std: (k) => insertCode(k, "heatset_std"),
  heatset_short: (k) => insertCode(k, "heatset_short"),
  washer: (k) => washerCode(k),
  dowel: (k, s) => dowelCode(k, lengthOf("dowel", k, s)),
  threaded_rod: (k, s) => threadedRodCode(k, lengthOf("threaded_rod", k, s)),
  bearing: (k) => bearingCode("bearing", k),
  bearing_flanged: (k) => bearingCode("bearing_flanged", k),
  bushing: (k, s) => bushingCode(k, lengthOf("bushing", k, s)),
  shaft: (k, s) => shaftCode("shaft", k, lengthOf("shaft", k, s)),
  d_shaft: (k, s) => shaftCode("d_shaft", k, lengthOf("d_shaft", k, s)),
  collar: (k) => collarCode(k),
  eclip: (k) => eclipCode(k),
  lm_uu: (k) => linearBearingCode(k),
  mgn_rail: (k, s) => railCode(k, lengthOf("mgn_rail", k, s)),
  mgn_carriage: (k) => carriageCode(k),
  gt2_pulley: (k) => pulleyCode(k),
  gt2_belt: (k, s) => beltCode(k, lengthOf("gt2_belt", k, s)),
  spur_gear: () => gearCode(),
  nema17: (k, s) => motorCode("nema17", k, lengthOf("nema17", k, s)),
  brushless: (k) => motorCode("brushless", k),
  n20: (k) => motorCode("n20", k),
  sg90: (k) => motorCode("sg90", k),
  disc_magnet: (k) => magnetCode(k),
  oring: (k) => oringCode(k),
  standoff: (k, s) => standoffCode(k, lengthOf("standoff", k, s)),
};

/** Live value first, contract default second, never from generated code. */
function paramOf(node: NodeRecord, name: string): string {
  return String(node.params[name] ?? node.contract.params.find((p) => p.name === name)?.default ?? "");
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
 * back to the parametric model when the file is not there.
 */
function bySku(node: NodeRecord): string | null {
  const sku = skuOf(node);
  if (!sku) return null;
  const code = CODEGEN[sku.family]!(sku.key, sku);
  if (!sku.stepFile) return code;
  return code.replace(
    "def build(p):\n",
    `def build(p):\n    try:\n        return load_import(${JSON.stringify(sku.stepFile)})\n    except Exception:\n        pass\n`,
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
  gear: () => gearCode(),
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
export const FASTENING_HARDWARE = new Set(["fastener", "nut", "insert", "threaded_rod", "washer", "dowel", "standoff"]);

/**
 * The cook-time hook: registry nodes resolve here, deterministically, before
 * any library or LLM step.
 */
export function resolveHardware(node: NodeRecord): string | null {
  return REGISTRY[node.kind]?.(node) ?? null;
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
