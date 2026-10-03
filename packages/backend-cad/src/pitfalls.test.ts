import { describe, expect, it } from "vitest";
import { PITFALLS, matchPitfalls } from "./pitfalls.js";

/**
 * One realistic report per seed, worded the way the kernel actually words it
 * (gates.py / pool.py, joined as `error\nhint: ...` by failureReport). A seed
 * that no real report can reach is dead weight in the table.
 */
const SAMPLES: Record<string, [stage: string, report: string]> = {
  "build-timeout": ["TIMEOUT", "execution exceeded 20s and was killed\nhint: the code likely loops forever or models something explosive — simplify"],
  "kernel-crash": ["KERNEL_CRASH", "the geometry kernel crashed running this code (exit -11)"],
  "empty-selector": ["G1", "build(p) raised IndexError: list index out of range"],
  "fillet-too-large": ["G1", "build(p) raised ValueError: Failed creating a fillet with radius of 3.0, try a smaller value"],
  "chamfer-failed": ["G1", "build(p) raised ValueError: Failed creating a chamfer, try a smaller length value(s)"],
  "occt-not-done": ["G1", "build(p) raised StdFail_NotDone: BRep_API: command not done"],
  "returned-builder": ["G1", "build(p) raised RuntimeError: BuildPart context requires a with block"],
  "returned-none": ["G1", "build(p) returned None\nhint: return the final Part from build(p)"],
  "missing-build": ["G0", "no top-level `def build(p)` function\nhint: the node must define exactly `def build(p):` returning a build123d Part"],
  "disallowed-import": ["G0", "import of 'cadquery' is not allowed\nhint: only these imports are permitted: ['build123d', 'math']"],
  "unknown-name": ["G1", "build(p) raised NameError: name 'Workplane' is not defined"],
  "align-argument": ["G1", "build(p) raised TypeError: Box.__init__() got an unexpected keyword argument 'centered'\nhint: omit align arguments — primitives are centered at the origin"],
  "operand-order": ["G1", "build(p) raised TypeError: unsupported operand type(s) for *: 'Part' and 'Pos'"],
  "not-a-method": ["G1", "build(p) raised AttributeError: 'Part' object has no attribute 'translate'"],
  "wire-not-closed": ["G1", "build(p) raised ValueError: Cannot make a face from a wire that is not closed"],
  "loft-sections": ["G1", "build(p) raised ValueError: loft requires at least two sections"],
  "sweep-path": ["G1", "build(p) raised ValueError: sweep path must be a Wire or Edge"],
  "revolve-profile": ["G1", "build(p) raised ValueError: revolve profile intersects the axis"],
  "offset-shell": ["G1", "build(p) raised RuntimeError: BRepOffset_MakeOffset failed: offset not done"],
  "invalid-topology": ["G2", "BRep validity check failed\nhint: a boolean or fillet produced corrupt topology — simplify or reorder the failing feature"],
  "no-solids": ["G2", "result contains no solids\nhint: the expression must produce solid geometry"],
  "empty-volume": ["G2", "non-positive volume (0.000 mm³)\nhint: booleans likely subtracted everything"],
  "unit-mistake": ["G2", "bounding box [4000.0, 60.0, 5.0] mm exceeds 1000 mm\nhint: dimensions look like a unit mistake"],
  "disjoint-solids": ["G2", "result has 3 disjoint solids"],
  "nut-trap-rotated": ["G3", 'port "trap" (NUT_TRAP): across the flats measured 6.58..6.58 along the flat normals, expected 5.5..5.9'],
  "nut-trap-side-entry": ["G3", 'port "trap" (NUT_TRAP): side entry is closed, material along +x at 1.2mm depth'],
  "bearing-no-shoulder": ["G3", 'port "seat" (BEARING_SEAT): no shoulder under the seat (0/8 points 0.5mm inside the wall meet material below it)'],
  "threaded-hole-tap": ["G3", 'port "tap" (THREADED_HOLE): expected Ø2.40..2.60, measured Ø3.40'],
  "fit-band": ["G3", 'port "pin" (DOWEL_HOLE): expected Ø4.05..4.25, measured Ø3.95'],
  "insert-pocket-wall": ["G3", 'port "insert" (INSERT_POCKET): wall under 1.2mm around the pocket (0/8 points in material on a Ø6.4 ring at 0.6mm depth)'],
  "hardware-depth": ["G3", 'port "insert" (INSERT_POCKET): needs 6.1mm of depth, measured 5.80'],
  "countersink-cone": ["G3", 'port "csk" (COUNTERSINK): expected a 90° cone, measured 71.4°'],
  "d-flat": ["G3", 'port "hub" (HUB_BORE): the flat at 2.00mm along +xAxis, expected it 1.5mm from the axis'],
  "radius-not-diameter": ["G3", 'port "mount_hole" (BORE): expected Ø4.5, measured Ø9.00'],
  "hole-not-through": ["G3", 'port "bolt" (CLEARANCE_HOLE): bottoms out at 2.80mm instead of passing through'],
  "channel-open": ["G3", 'port "rail" (SLOT): no wall within 6.0mm at 1.0mm depth — the channel is open, not a 6mm gap'],
  "feature-depth": ["G3", 'port "rail" (SLOT): expected width 6, narrowest measured 7.20 (at 2mm depth)'],
  "boss-missing": ["G3", 'port "boss" (SCREW_BOSS): boss wall missing (Ø8 ring 3/16 in material)'],
  "envelope-escape": ["G4", "412 mesh vertices escape the declared envelope (worst 3.20 mm past the 0.5 mm tolerance, near [30.0, 0.0, 2.5])"],
  "pattern-member": ["G3", 'port "bolts #4/4" (HOLE_PATTERN): no hole found at the declared origin (member 4 of 4, at u=20.00 v=20.00 in the port frame)'],
  "assert-bbox": ["G4b", 'assertion "bbox_axis x": expected at least 80 mm along x, measured 74.5'],
  "assert-volume": ["G4b", 'assertion "volume_range": expected 20000..26000 mm³, measured 41210.3'],
  "assert-holes": ["G4b", 'assertion "hole_count": expected 4 holes, measured 3'],
  "assert-symmetry": ["G4b", 'assertion "symmetry yz": expected mirror mismatch ≤ 0.02, measured 0.134'],
  "assert-solids": ["G4b", 'assertion "solids": expected 1 solid(s), measured 2'],
  "assert-min-wall": ["G4b", 'assertion "min_wall": expected walls of at least 1.2 mm, measured 0.412'],
  "cnc-internal-corner": ["G4c", 'process cnc "internal_corner": 4 internal vertical corner(s) tighter than the Ø3 end mill can cut; tightest radius 0.00 mm at [-10.0, -6.0, 3.0]'],
  "cnc-undercut": ["G4c", 'process cnc "undercut": 128.7 mm² of surface cannot be reached by a tool from +Z or -Z (e.g. at [-13.33, 0.0, 2.0])'],
  "cnc-pocket-depth": ["G4c", 'process cnc "pocket_depth": pocket at [-4.37, 0.67, -8.01] is 20.0 mm deep and 4.0 mm wide (5.0x; limit 4x)'],
  "sheet-thickness": ["G4c", 'process sheet_metal "constant_thickness": 2 face(s) are not 2.00 mm sheet; worst measures 8.00 mm at [21.0, 0.0, 3.0]'],
  "sheet-bend-radius": ["G4c", 'process sheet_metal "bend_radius": 1 bend(s) with inner radius below the 2.00 mm thickness; tightest 0.50 mm at [2.48, -3.33, 2.0]'],
  "sheet-hole-edge": ["G4c", 'process sheet_metal "hole_edge": 1 hole(s) closer than 4.00 mm (2x thickness) to an edge or bend; closest 1.50 mm, hole at [36.0, 0.0, 1.33]'],
  "laser-profile": ["G4c", 'process laser_cut "planar_profile": 5 face(s) are neither parallel nor perpendicular to the sheet (first: a plane at [-29.73, -4.73, 2.47])'],
  "process-wall": ["G4c", 'process sls "min_wall": thinnest wall 0.30 mm, the process needs 0.8 mm'],
  "resin-void": ["G4c", 'process resin "enclosed_void": 1 fully enclosed void(s): uncured resin is trapped inside and the part cracks'],
};

describe("pitfalls", () => {
  it("has a realistic report for every seed, and no sample without a seed", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(PITFALLS.map((p) => p.id).sort());
  });

  for (const pitfall of PITFALLS) {
    it(`${pitfall.id} matches its report`, () => {
      const [stage, report] = SAMPLES[pitfall.id]!;
      expect(matchPitfalls(stage, report, PITFALLS.length).map((p) => p.id)).toContain(pitfall.id);
    });
  }

  it("ids are unique", () => {
    expect(new Set(PITFALLS.map((p) => p.id)).size).toBe(PITFALLS.length);
  });

  it("caps the matches at three by default", () => {
    // Reads as five different failures at once; only three fixes get through.
    const noisy = "fillet chamfer loft sweep revolve offset wire not closed align StdFail_NotDone";
    expect(matchPitfalls("G1", noisy, PITFALLS.length).length).toBeGreaterThan(3);
    expect(matchPitfalls("G1", noisy)).toHaveLength(3);
  });

  it("respects the stage, so a hint's wording cannot pull in a fix for another gate", () => {
    // The G2 hint mentions "fillet"; the G1 fillet advice is about an exception
    // that never happened.
    const ids = matchPitfalls(...SAMPLES["invalid-topology"]!).map((p) => p.id);
    expect(ids).toEqual(["invalid-topology"]);
  });

  // A combined report is staged by its earliest failure, so an assertion that
  // fails beside a port arrives under G3 and must still find its fix.
  it("finds an assertion fix inside a report staged G3", () => {
    const report = [
      "2 gate failures — fix all of them in this attempt:",
      '1. [G3] port "bolt" (BORE): expected Ø4.5, measured Ø9.00',
      '2. [G4b] assertion "hole_count": expected 4 holes, measured 3',
    ].join("\n");
    expect(matchPitfalls("G3", report).map((p) => p.id)).toEqual(["radius-not-diameter", "assert-holes"]);
  });

  it("returns nothing for a failure it has never seen", () => {
    expect(matchPitfalls("G3", "something entirely novel")).toEqual([]);
  });
});
