import type { NodeRecord } from "@patchcad/shared";
import type { CadContractPayload } from "./index.js";
import type { KernelFailure, KernelProcess } from "./kernel.js";
import { isVendorProcess, sourcingOf, type Process } from "./sourcing.js";

/**
 * Process DFM for fabricate parts: what the generator is told up front, and
 * what the kernel's G4c (dfm_process.py) holds the result to. The two say the
 * same numbers on purpose: guidance the gate does not check is a suggestion,
 * and a gate the guidance never mentioned costs a repair round to discover.
 */

export const DEFAULT_TOOL_RADIUS_MM = 1.5;

/** Between G4b (4.75) and a pass (5): every contract gate already holds. */
export const G4C_SCORE = 4.9;

const GUIDANCE: Record<Exclude<Process, "fdm">, (toolRadius: number, allowUndercuts: boolean) => string[]> = {
  cnc: (r, undercuts) => [
    "CNC MILLED, 3-axis, the cutter along the part's Z. The gate checks:",
    `  - every inside corner parallel to Z has a radius of at least ${r} mm: round the`,
    `    CUTTER before subtracting it, pocket = fillet(Box(w, l, d).edges().filter_by(Axis.Z), ${r + 0.1})`,
    "  - a pocket is at most 4x as deep as it is wide",
    undercuts
      ? "  - (a second setup is planned, so features opening sideways are allowed)"
      : "  - every face is reachable from +Z or -Z: no side holes, lips over a pocket or closed cavities",
    "  Drilled holes are plain Cylinder cuts. Outside corners may stay sharp.",
  ],
  sheet_metal: () => [
    "SHEET METAL: one sheet of ONE thickness, cut flat and folded. The gate checks:",
    "  - constant thickness everywhere: no bosses, ribs, pockets, chamfers or steps",
    "  - every bend has an INNER radius of at least the thickness t: model a bend as",
    "    (Cylinder(ri + t, w) - Cylinder(ri, w)) & <quadrant Box>, joined to flat Box flanges",
    "  - every hole's rim is at least 2t from any edge, other hole or bend",
  ],
  laser_cut: () => [
    "LASER CUT from flat stock: ONE 2D profile extruded straight through. The gate checks:",
    "  - every face is the top, the bottom, or perpendicular to them: build it as",
    "    extrude(<sketch>, t) with holes cut through; no chamfers, countersinks or edge fillets on",
    "    the top/bottom edges (rounding outline corners parallel to the thickness is fine)",
    "  - exactly two levels: no steps, pockets or bosses",
  ],
  sls: () => ["SLS nylon (powder bed): walls of at least 0.8 mm. Overhangs need no support; give any closed cavity an escape hole for powder."],
  mjf: () => ["MJF nylon (powder bed): walls of at least 0.8 mm. Overhangs need no support; give any closed cavity an escape hole for powder."],
  resin: () => ["RESIN (SLA/DLP): walls of at least 0.6 mm and NO fully enclosed void — open every cavity with a drain hole of 2 mm or more."],
};

/** The generator's process lines, a block per process; FDM's mirrors the kernel's fdm G4c rules. */
export function processLines(node: Pick<NodeRecord, "kind" | "contract">): string {
  const payload = node.contract.payload as CadContractPayload;
  const s = sourcingOf(node);
  if (!isVendorProcess(s)) {
    const { minWall, nozzle } = payload.process;
    return [
      `Process: FDM, min wall ${minWall} mm.`,
      `  - make every wall at least ${Math.max(minWall, 2 * nozzle)} mm, two perimeters of the ${nozzle} mm nozzle; the gate fails one thinner than a single perimeter`,
      "  - where the part's own frame allows, give it a flat lowest-Z face wide enough to stand on the bed without tipping",
      "  - keep any flat roof over a hole, tunnel or cavity under 10 mm across; past that, close it with 45° sides",
    ].join("\n");
  }
  const guide = GUIDANCE[s.process as Exclude<Process, "fdm">](s.toolRadius ?? DEFAULT_TOOL_RADIUS_MM, !!s.allowUndercuts);
  return [
    `Process: FABRICATED by a vendor (${s.process}) in ${s.material ?? "the stated material"}${s.finish ? `, finish ${s.finish}` : ""}.`,
    "Model the part exactly as built: no FDM allowances (no slip-fit oversize, no first-layer chamfers, no teardrop holes).",
    "Cut each fitted port at the Ø given on its port line.",
    ...guide,
  ].join("\n");
}

/** G4c wire format: a vendor process, or "fdm" for a printed part (the
 *  kernel's FDM rules). Undefined for bought hardware. */
export function kernelProcess(node: Pick<NodeRecord, "kind" | "contract">): KernelProcess | undefined {
  const s = sourcingOf(node);
  if (s.class === "print" && s.process === "fdm") return { kind: "fdm" };
  if (!isVendorProcess(s)) return undefined;
  return {
    kind: s.process!,
    ...(s.process === "cnc" ? { tool_radius: s.toolRadius ?? DEFAULT_TOOL_RADIUS_MM } : {}),
    ...(s.allowUndercuts ? { allow_undercuts: true } : {}),
  };
}

export interface DfmIssue {
  process: string;
  rule: string;
  message: string;
  expected?: number;
  measured?: number;
  at?: number[];
  count?: number;
}

/** The G4c failures in a kernel report, structured for the BOM and inspector. */
export function dfmIssues(failures: KernelFailure[] | undefined): DfmIssue[] {
  return (failures ?? [])
    .filter((f) => f.stage === "G4c")
    .map((f) => ({
      process: /^process (\w+)/.exec(f.error)?.[1] ?? "?",
      rule: f.rule ?? /"(\w+)"/.exec(f.error)?.[1] ?? "?",
      message: f.error,
      ...(f.expected !== undefined ? { expected: f.expected } : {}),
      ...(f.measured !== undefined ? { measured: f.measured } : {}),
      ...(f.at ? { at: f.at } : {}),
      ...(f.count !== undefined ? { count: f.count } : {}),
    }));
}
