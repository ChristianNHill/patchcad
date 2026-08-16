import type { NodeRecord } from "@patchcad/shared";

/**
 * Deterministic part registry. Two roles:
 *  - Hardware is REGISTRY-ONLY: exact interface dims from the metric table,
 *    codegen'd — an LLM never invents a screw, a nut, or an insert. Every part
 *    class moved in here is one that can no longer fail generation, costs no
 *    tokens, and is standards-exact.
 *  - Parametric factories (plate, L-bracket) give the architect known-good
 *    exemplars and give tests deterministic geometry.
 * Registry output is ordinary node code (`def build(p)`), so it flows through
 * the exact same execute/verify gates as generated code.
 */

export interface MetricThread {
  /** ISO 273 normal-fit clearance hole Ø */
  clearance: number;
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

export const METRIC: Record<string, MetricThread> = {
  M3: { clearance: 3.4, tap: 2.5, shcsHeadD: 5.5, shcsHeadH: 3.0, insertD: 4.0, insertL: 5.8, nutAf: 5.5, nutH: 2.4 },
  M4: { clearance: 4.5, tap: 3.3, shcsHeadD: 7.0, shcsHeadH: 4.0, insertD: 5.6, insertL: 8.1, nutAf: 7.0, nutH: 3.2 },
  M5: { clearance: 5.5, tap: 4.2, shcsHeadD: 8.5, shcsHeadH: 5.0, insertD: 6.4, insertL: 9.5, nutAf: 8.0, nutH: 4.7 },
};

/** SHCS modeled head-down at origin: head sits on z ∈ [0, headH], shank hangs -z. */
export function shcsCode(thread: keyof typeof METRIC): string {
  const t = METRIC[thread]!;
  const shankD = Number(thread.slice(1));
  return `from build123d import *

def build(p):
    head = Pos(0, 0, ${t.shcsHeadH} / 2) * Cylinder(${t.shcsHeadD} / 2, ${t.shcsHeadH})
    shank = Pos(0, 0, -p.length / 2) * Cylinder(${shankD} / 2, p.length)
    return head + shank
`;
}

/**
 * Hex nut, seating face on z = 0 and body running +z — the same datum the
 * screw head uses, so a nut mates onto a surface the same way.
 *
 * RegularPolygon takes the circumradius, while nuts are specified across the
 * flats, hence AF/√3. Verified against the kernel: an M4 nut measures 7.00
 * across the flats and 8.08 across the corners.
 */
export function nutCode(thread: keyof typeof METRIC): string {
  const t = METRIC[thread]!;
  return `from build123d import *
import math

def build(p):
    body = extrude(RegularPolygon(${t.nutAf} / math.sqrt(3), 6), ${t.nutH})
    bore = Pos(0, 0, ${t.nutH} / 2) * Cylinder(${t.tap} / 2, ${t.nutH} * 2)
    return body - bore
`;
}

/**
 * Heat-set insert, modelled as the volume it occupies once installed: the OD
 * is the install-hole Ø from the table, so a part can subtract this shape to
 * get a correct boss. Flange face on z = 0, body running +z into the material.
 */
export function insertCode(thread: keyof typeof METRIC): string {
  const t = METRIC[thread]!;
  return `from build123d import *

def build(p):
    body = Pos(0, 0, ${t.insertL} / 2) * Cylinder(${t.insertD} / 2, ${t.insertL})
    bore = Pos(0, 0, ${t.insertL} / 2) * Cylinder(${t.tap} / 2, ${t.insertL} * 2)
    return body - bore
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

/** L-bracket: base leg in XY (top at z=thickness), upright leg at +Y face. */
export function lBracketCode(): string {
  return `from build123d import *

def build(p):
    t = p.thickness
    base = Pos(0, 0, t / 2) * Box(p.width, p.depth, t)
    wall = Pos(0, p.depth / 2 - t / 2, p.height / 2) * Box(p.width, t, p.height)
    bracket = base + wall
    base_hole = Pos(0, -p.depth / 2 + p.hole_inset, t / 2) * Cylinder(p.hole_diameter / 2, t)
    wall_hole = Pos(0, p.depth / 2 - t / 2, p.height - p.hole_inset) * \\
        Rot(90, 0, 0) * Cylinder(p.hole_diameter / 2, t)
    return bracket - base_hole - wall_hole
`;
}

/**
 * Metric hardware: kind → codegen. Everything here is fully determined by its
 * thread, is exact by construction, and declares no geometric ports — so these
 * kinds skip G4 envelope grading and the port-consistency lint (see
 * REGISTRY_HARDWARE below). Adding a class is a table entry plus a factory.
 */
const HARDWARE: Record<string, (thread: keyof typeof METRIC) => string> = {
  fastener: shcsCode,
  nut: nutCode,
  insert: insertCode,
};

/** Kinds resolved from HARDWARE. Exported because the gates and lints need to
 *  know which kinds are exact-by-construction rather than architect guesses. */
export const REGISTRY_HARDWARE = new Set(Object.keys(HARDWARE));

/**
 * The cook-time hook: hardware nodes resolve here, deterministically, before
 * any library or LLM step. The thread spec comes from contract params
 * (`thread` enum) — never from generated code.
 */
export function resolveHardware(node: NodeRecord): string | null {
  const factory = HARDWARE[node.kind];
  if (!factory) return null;
  const thread = String(
    node.params.thread ??
      node.contract.params.find((p) => p.name === "thread")?.default ??
      "",
  ).toUpperCase();
  if (!(thread in METRIC)) return null;
  return factory(thread as keyof typeof METRIC);
}

/** Imported pieces (STL/STEP/3MF segments) load their mesh deterministically —
 * UNLESS the user has reprompted them: a non-empty thread routes to the
 * generator, which starts from load_import() and edits the mesh with build123d
 * booleans. Hardware stays registry-only always. Files: imports/<nodeId>.ply. */
export function resolveDeterministic(node: NodeRecord): string | null {
  if (node.kind === "imported") {
    if (node.thread.length > 0) return null;
    return `def build(p):\n    return load_import("${node.id}.ply", scale=p.scale)\n`;
  }
  return resolveHardware(node);
}
