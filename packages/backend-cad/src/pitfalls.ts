import { readFileSync, statSync } from "node:fs";
import { learnedPitfallFix, MIN_PITFALL_OCCURRENCES, type LearnedPitfall } from "@patchcad/engine";

/**
 * Error→fix retrieval for the repair loop. A gate report says WHAT broke; the
 * model still has to guess why, and the guesses repeat: the same IndexError
 * from an empty selector, the same radius-for-diameter slip, the same fillet
 * that timed out. Each entry pairs a recognisable report with the fix that
 * actually worked, seeded from the cheat-sheet rules (each earned by a burned
 * attempt budget) and from build123d/OCCT failure modes.
 *
 * Matches ride the repair USER turn only, never the system prompt, so the
 * system prefix stays byte-identical across a cook wave and prefix-cacheable.
 * Order matters: specific entries come before general ones, and the cap keeps
 * the first matches.
 */

export interface Pitfall {
  id: string;
  /** Gate stage this applies to; undefined matches any stage. */
  stage?: string;
  match: RegExp;
  fix: string;
}

export const PITFALLS: Pitfall[] = [
  {
    id: "build-timeout",
    stage: "TIMEOUT",
    match: /exceeded \d+s|timed out|was killed/i,
    fix: "The kernel kills a build at 20s and leaves nothing to measure. Usually a broad fillet: fillet(shape.edges(), r) on a lofted or booleaned body. Narrow the selector, round BEFORE cutting, keep loft sections in single digits, and leave cosmetic edges sharp.",
  },
  {
    id: "kernel-crash",
    stage: "KERNEL_CRASH",
    match: /crashed/,
    fix: "OpenCascade crashed outright, almost always on a fillet or boolean over complex topology. Reduce fillet radii, round fewer edges, fillet before cutting, and build tricky features as separate solids joined with +.",
  },
  {
    id: "empty-selector",
    stage: "G1",
    match: /IndexError: (?:list|tuple|ShapeList)? ?index out of range/,
    fix: "A selector came back empty: .group_by(...)[-1] or [0] on no edges raises IndexError. Leave that edge sharp, or select from a shape you know has those edges (the primitive before the booleans).",
  },
  {
    id: "fillet-too-large",
    stage: "G1",
    match: /fillet/i,
    fix: "The fillet radius is too large for an adjacent face, or the edge set includes edges that cannot be rounded. Use a radius under half the thinnest wall it touches, fillet the primitive BEFORE cutting into it, or drop the cosmetic fillet.",
  },
  {
    id: "chamfer-failed",
    stage: "G1",
    match: /chamfer/i,
    fix: "The chamfer length is larger than an adjacent face allows. Shrink it below half the thinnest adjacent wall, apply it before boolean cuts, or leave the edge sharp.",
  },
  {
    id: "occt-not-done",
    stage: "G1",
    match: /StdFail_NotDone|command not done|BRep_API|Standard_\w+Error/,
    fix: "OpenCascade refused an operation (fillet, boolean, loft or offset) without saying which. Find the most complex feature, make it simpler or build it as a separate solid and combine with +, and avoid rounding edges created by a cut.",
  },
  {
    id: "returned-builder",
    match: /BuildPart|BuildSketch|BuildLine|Builder/,
    fix: "Builder mode is not supported. Use algebra mode only: compose shapes with + - & and Pos/Rot, and return the shape itself from build(p), not a BuildPart context.",
  },
  {
    id: "returned-none",
    stage: "G1",
    match: /returned None/,
    fix: "build(p) must end with `return part`. Every branch must return the final shape.",
  },
  {
    id: "missing-build",
    match: /no top-level `def build\(p\)`|module level/,
    fix: "Define exactly one top-level `def build(p):` and put all geometry inside it. The module may only import and define.",
  },
  {
    id: "disallowed-import",
    stage: "G0",
    match: /import of .* is not allowed/,
    fix: "Only `from build123d import *` and `math` are allowed. Remove every other import and express the part with build123d alone.",
  },
  {
    id: "unknown-name",
    stage: "G1",
    match: /NameError: name '\w+' is not defined|does not exist in build123d/,
    fix: "That name is not in build123d (it may be a CadQuery-ism). Use only the calls in the cheat sheet, spelled exactly.",
  },
  {
    id: "align-argument",
    stage: "G1",
    match: /align/i,
    fix: "Drop align= arguments. Primitives are centered at the origin; place them with Pos(x, y, z) * shape.",
  },
  {
    id: "operand-order",
    stage: "G1",
    match: /unsupported operand type\(s\) for \*/,
    fix: "Placement goes on the LEFT: Pos(x, y, z) * shape and Rot(a, b, c) * shape. shape * Pos(...) is not defined.",
  },
  {
    id: "not-a-method",
    stage: "G1",
    match: /is not a shape method|has no attribute '(?!solids)\w+'/,
    fix: "That method does not exist on build123d shapes. Use the free functions (fillet(...), chamfer(...), extrude(...), loft([...])) and the + - & operators instead of method chains.",
  },
  {
    id: "wire-not-closed",
    stage: "G1",
    match: /not closed|make_face|MakeFace|wire/i,
    fix: "make_face needs a CLOSED wire: the last Line/Spline must end exactly at the first point. Prefer Polyline(..., close=True) or a closed sketch primitive (Rectangle, Circle) when you can.",
  },
  {
    id: "loft-sections",
    stage: "G1",
    match: /loft/i,
    fix: "loft takes a list of sketches on DISTINCT parallel planes, in order along the blend, e.g. [Plane.XY.offset(z) * Circle(r) for z, r in ...]. Two sections on the same plane, a section out of order, or a raw wire instead of a sketch all fail.",
  },
  {
    id: "sweep-path",
    stage: "G1",
    match: /sweep/i,
    fix: "sweep(section, path): the section must sit on a plane perpendicular to the path at its START point. Build the path first, then place the section with Plane(origin=path @ 0, z_dir=path % 0).",
  },
  {
    id: "revolve-profile",
    stage: "G1",
    match: /revolve/i,
    fix: "A revolve profile must lie in a plane that contains the axis and stay entirely on one side of it. A profile crossing the axis self-intersects.",
  },
  {
    id: "offset-shell",
    stage: "G1",
    match: /offset|shell|BRepOffset|thicken/i,
    fix: "offset/shell on curved or booleaned bodies is fragile. Hollow the part by subtracting a smaller copy built from the same primitives instead.",
  },
  {
    id: "invalid-topology",
    stage: "G2",
    match: /BRep validity check failed/,
    fix: "A boolean met coincident faces. Make every cutter overshoot the faces it cuts through by at least 0.5 mm, and offset touching unions by a hair so no two faces are exactly coplanar.",
  },
  {
    id: "no-solids",
    stage: "G2",
    match: /contains no solids/,
    fix: "The result is a sketch, face or wire, not a solid. extrude(), revolve() or loft() it before returning.",
  },
  {
    id: "empty-volume",
    stage: "G2",
    match: /non-positive volume|zero-size/,
    fix: "A subtraction removed everything, or a sketch was never extruded. Check each cutter's size against the body before cutting.",
  },
  {
    id: "unit-mistake",
    stage: "G2",
    match: /bounding box .* exceeds/,
    fix: "Dimensions are in millimetres. A value 1000× or 25.4× too large usually means metres or inches slipped in.",
  },
  {
    id: "disjoint-solids",
    match: /(?:\d+|multiple) (?:disjoint |separate )?solids|disconnected/i,
    fix: "The part is several separate solids. Every feature must overlap the body it joins by at least 0.5 mm before the union.",
  },
  {
    id: "nut-trap-rotated",
    stage: "G3",
    match: /\(NUT_TRAP\): across the (?:flats|corners)/,
    fix: "Align the hex with the port: a CORNER on xAxis and flats facing ±y, which is how `RegularPolygon((af + 0.2) / math.sqrt(3), 6)` comes out unrotated. Do not Rot it 30°, and do not cut a round pocket: the nut's corners need the hex.",
  },
  {
    id: "nut-trap-side-entry",
    stage: "G3",
    match: /side entry is closed|side-entry channel/,
    fix: "A side-entry trap opens toward +xAxis: subtract a Box as wide as the trap's flats and as tall as the trap, from the trap centre out through the part's edge along +x.",
  },
  {
    id: "bearing-no-shoulder",
    stage: "G3",
    match: /\((?:LINEAR_)?BEARING_SEAT\): no shoulder/,
    fix: "The bearing seat has no shoulder, so the bearing falls through. Cut the seat only `width` deep and leave a 1-2mm lip under it: the bore below the seat must be at most od - 2.",
  },
  {
    id: "threaded-hole-tap",
    stage: "G3",
    match: /\(THREADED_HOLE\): expected Ø/,
    fix: "A threaded hole is cut at the TAP DRILL (M3 2.5, M4 3.3, M5 4.2), not the clearance or the major diameter; the thread is cut into that later.",
  },
  {
    id: "fit-band",
    stage: "G3",
    match: /expected Ø[\d.]+\.\.[\d.]+, measured Ø/,
    fix: "This bore is a fit, so only a narrow band passes. Cut it at the middle of the band the report names, not at the part's nominal size: press is up to 0.1 UNDER the part, slip is 0.05-0.25 OVER it.",
  },
  {
    id: "insert-pocket-wall",
    stage: "G3",
    match: /\(INSERT_POCKET\): wall under/,
    fix: "A heat-set insert melts into its wall. Put the pocket in a boss at least pocket Ø + 2.4mm wide, or move it away from the edge, so 1.2mm of material surrounds it for its whole depth.",
  },
  {
    id: "hardware-depth",
    stage: "G3",
    match: /needs [\d.]+mm of depth|the seat is [\d.]+mm deep|\(NUT_TRAP\): [\d.]+mm deep|recess (?:steps at|runs through)/,
    fix: "The pocket depth is measured from the port face along -z. Position the cutter so its top is at the face and its length is the depth the report names; a centred Cylinder(r, h) at the face cuts only h/2 deep.",
  },
  {
    id: "countersink-cone",
    stage: "G3",
    match: /\(COUNTERSINK\): expected (?:a [\d.]+° cone|Ø[\d.]+ at the face)/,
    fix: "Cut the countersink as a Cone(through_d / 2, diameter / 2, h) with h = (diameter - through_d) / 2 / tan(angle / 2), its wide end exactly at the face.",
  },
  {
    id: "d-flat",
    stage: "G3",
    match: /\(HUB_BORE\): (?:no flat|the flat at)/,
    fix: "The D-flat sits `flat` mm from the bore axis, facing +xAxis. Intersect the bore cutter with a Box whose +x face is at x = flat, before subtracting it.",
  },
  {
    id: "radius-not-diameter",
    stage: "G3",
    match: /expected (?:pilot |outer )?Ø[\d.]+, measured Ø/,
    fix: "Cylinder takes a RADIUS: a hole of diameter d is Cylinder(d / 2, h). Read the diameter from the port params and cut exactly at the port origin along its z axis.",
  },
  {
    id: "hole-not-through",
    stage: "G3",
    match: /bottoms out|instead of passing through/,
    fix: "A through hole must pass the WHOLE thickness: make the cutter longer than the body (thickness + 2 mm) and centre it on the material, not on one face, since Cylinder is centered on its origin.",
  },
  {
    id: "channel-open",
    stage: "G3",
    match: /the channel is open/,
    fix: "A wall is missing at the channel mouth. Chamfer real edges with chamfer(); never fake a lead-in with a rotated Box, which spans leg*1.414 and cuts the wall away.",
  },
  {
    id: "feature-depth",
    stage: "G3",
    match: /expected (?:depth|width) [\d.]+, (?:narrowest )?measured/,
    fix: "Size the cutter to the declared number exactly. A centered Box/Cylinder of height h cut at a face reaches h/2 deep, so place it with Pos at depth - h/2 below the face.",
  },
  {
    id: "boss-missing",
    stage: "G3",
    match: /boss wall missing|pilot hole .* missing|no open channel/,
    fix: "The feature is not at the port. Build it at the port's origin, oriented so its +z axis points OUT of the material, then cut any pilot along -z.",
  },
  {
    id: "envelope-escape",
    stage: "G4",
    match: /escape the declared envelope/,
    fix: "Primitives are centered, so Box(a, b, c) spans ±a/2, ±b/2, ±c/2 from its Pos. Check the reported worst point, find the feature there, and shrink or move it inside the envelope.",
  },
  // G4b entries carry no stage: a combined contract report is staged by its
  // EARLIEST failure (usually G3), so a stage filter would hide them exactly
  // when an assertion fails beside a port. The assertion text is specific.
  {
    id: "pattern-member",
    stage: "G3",
    match: /\(member \d+ of \d+, at u=/,
    fix: "A pattern member is missing or the wrong size. Generate the positions from the port params in a loop (polar: pcd/2 * cos/sin of start_angle + 360°·k/count; grid: (i - (nx-1)/2) * pitch_x, (j - (ny-1)/2) * pitch_y) in the port frame, instead of hand-typing coordinates.",
  },
  {
    id: "assert-bbox",
    match: /assertion "bbox_axis/,
    fix: "The overall size along that axis is wrong. A centred Box(a, b, c) spans exactly a × b × c, so add up the stack along the axis (body + bosses + lips) and size the main body to the stated number. Features sticking past the body count too.",
  },
  {
    id: "assert-volume",
    match: /assertion "volume_range"/,
    fix: "The material volume is off. Too much usually means a hollow or cut that never happened (a cutter that misses the body). Too little usually means a Cylinder given a diameter where it takes a RADIUS, or walls thinner than the contract states.",
  },
  {
    id: "assert-holes",
    match: /assertion "hole_count"/,
    fix: "Holes are counted as closed round bores. Cut each with `part - Pos(x, y, z) * Cylinder(d / 2, h)`, keep it clear of the edge so its wall goes all the way round, and do not merge two holes into a slot. A counterbore and its pilot count as ONE hole, and so does a D-bore or a keyed bore. Count the holes the spec asks for; never add a hole the spec does not name just to reach the number.",
  },
  {
    id: "assert-symmetry",
    match: /assertion "symmetry/,
    fix: "The part must mirror onto itself about that plane through its bounding-box centre. Build one half and `mirror(half, about=Plane.YZ)` (or XZ/XY), or place every off-centre feature as a ± pair. A one-sided lug, tab or hole breaks it.",
  },
  {
    id: "assert-solids",
    match: /assertion "solids"/,
    fix: "The solid count is wrong. Features meant to be one body must overlap it by at least 0.5 mm before the +; bodies meant to be separate must not touch.",
  },
  {
    id: "assert-min-wall",
    match: /assertion "min_wall"/,
    fix: "A wall is thinner than the contract allows. Shrink the cutter (a hollowing cut of size outer - 2·wall), or move neighbouring cuts apart so the material between them reaches the stated thickness.",
  },
  // G4c process DFM, stageless for the same reason as G4b: a combined
  // contract report is staged by its earliest failure.
  {
    id: "cnc-internal-corner",
    match: /process cnc "internal_corner"/,
    fix: "Round the CUTTER, not the pocket afterwards: pocket = fillet(Box(w, l, d).edges().filter_by(Axis.Z), r) with r at least the tool radius, then part - Pos(...) * pocket. An L-shaped outline needs its inside corner rounded the same way. Filleting the finished part's edges usually selects the wrong ones or times out.",
  },
  {
    id: "cnc-undercut",
    match: /process cnc "undercut"/,
    fix: "Something can only be reached from the side. Turn side holes into slots open to +Z or -Z, cut lips and overhangs back to vertical walls, and split a closed cavity into an open pocket. If the part truly needs a second setup, that is a contract change (sourcing.allowUndercuts), not a code change.",
  },
  {
    id: "cnc-pocket-depth",
    match: /process cnc "pocket_depth"/,
    fix: "A narrow pocket is too deep for a stiff cutter. Widen it toward depth / 4, make it shallower, or open one end of it to the outside so it becomes a step.",
  },
  {
    id: "sheet-thickness",
    match: /process sheet_metal "constant_thickness"/,
    fix: "Sheet metal is one gauge. Remove bosses, ribs, pockets and chamfers; model the part as flat Box flanges of thickness t joined by annular bend sections, and attach nothing to the sheet faces.",
  },
  {
    id: "sheet-bend-radius",
    match: /process sheet_metal "bend_radius"/,
    fix: "Every fold needs an inner radius of at least the thickness. Join flanges with (Cylinder(ri + t, w) - Cylinder(ri, w)) & <quadrant Box> with ri >= t, and shorten each flange by ri + t so it meets the bend; never butt two plates at a sharp corner.",
  },
  {
    id: "sheet-hole-edge",
    match: /process sheet_metal "hole_edge"/,
    fix: "Move each hole so its rim is at least 2x the thickness from every edge, bend and other hole, or lengthen the flange to make room. Keep the declared port positions; grow the flange around them.",
  },
  {
    id: "laser-profile",
    match: /process laser_cut "(?:planar_profile|single_thickness)"/,
    fix: "A laser part is extrude(<sketch>, t) and nothing else: one 2D outline with holes cut through. Drop chamfers, countersinks, top-edge fillets, steps and pockets; round outline corners only with edges parallel to the thickness.",
  },
  {
    id: "process-wall",
    match: /process (?:sls|mjf|resin) "min_wall"/,
    fix: "The vendor process cannot form walls this thin. Thicken the wall (shrink the hollowing cutter) or move neighbouring cuts apart.",
  },
  {
    id: "resin-void",
    match: /process resin "enclosed_void"/,
    fix: "A sealed cavity traps uncured resin. Make the part solid, or cut a drain hole of at least 2 mm from the cavity to the outside.",
  },
];

/** Pitfalls mined from this install's own repairs (engine `minePitfalls`,
 *  written by the server library). Off until the server names the file, so
 *  tests and scripts see the seeded table only. */
let learnedFile: string | undefined;
let learnedCache: { mtimeMs: number; list: Pitfall[] } | undefined;

export function useLearnedPitfalls(file: string | undefined): void {
  learnedFile = file;
  learnedCache = undefined;
}

/** Re-read only when the file changes. A missing or corrupt file is no
 *  learned pitfalls, never a failed repair. */
function learnedPitfalls(): Pitfall[] {
  if (!learnedFile) return [];
  try {
    const { mtimeMs } = statSync(learnedFile);
    if (learnedCache?.mtimeMs !== mtimeMs) {
      const seeded = new Set(PITFALLS.map((p) => p.id));
      const raw = JSON.parse(readFileSync(learnedFile, "utf8")) as LearnedPitfall[];
      const list = raw
        .filter((p) => p.occurrences >= MIN_PITFALL_OCCURRENCES && !seeded.has(p.id))
        // The stored `fix` is never read: files mined before fixes went
        // code-free carry another node's repair diff in it.
        .map((p) => ({ id: p.id, stage: p.stage, match: new RegExp(p.pattern), fix: learnedPitfallFix(p.stage, p.occurrences) }));
      learnedCache = { mtimeMs, list };
    }
    return learnedCache.list;
  } catch {
    return [];
  }
}

/** The fixes worth showing for this failure, most specific first. Seeded
 *  entries always come before learned ones, so a learned fix only fills a
 *  slot no seed claimed. */
export function matchPitfalls(stage: string, report: string, limit = 3): Pitfall[] {
  return [...PITFALLS, ...learnedPitfalls()]
    .filter((p) => (p.stage === undefined || p.stage === stage) && p.match.test(report))
    .slice(0, limit);
}
