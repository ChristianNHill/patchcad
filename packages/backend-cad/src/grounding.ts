/**
 * Engineering facts derived from the hardware catalog, in one place, so the
 * architect, the lints and the prompts all read the same numbers.
 *
 * WHY THIS EXISTS: every one of these numbers was already in the codebase, and
 * every one was in the wrong place. The seat band was arithmetic inline in a
 * lint; the seat POSE was a sign nobody wrote down, which cost two unrecoverable
 * fastener failures when the architect guessed it; the thread-engagement volume
 * was a comment explaining why G5 cried wolf; the FDM slip fit was a kernel
 * constant the planner could not see. A fact the model must satisfy and cannot
 * read is a coin flip with extra steps.
 *
 * SCOPE IS DELIBERATELY NARROW. Only facts with evidence behind them, measured
 * in this repo against the real probes, go here. No ISO fit-tolerance tables:
 * they would be numbers I cannot check, and a grounding table nobody verified
 * is worse than an honest gap because the model would trust it.
 */
import { dim, familyDims, threadSpec } from "./catalog.js";
import { METRIC } from "./registry.js";

/** Nominal major diameter, from the designation. M4 -> 4. */
export function majorDiameter(thread: string): number {
  const d = Number(thread.slice(1));
  if (!Number.isFinite(d)) throw new Error(`not a metric thread designation: "${thread}"`);
  return d;
}

/** Catalog dim for a kind's default family at a thread, if the row exists. */
const rowDim = (family: string, field: string) => (thread: string) => {
  const row = familyDims(family, thread);
  return row ? dim(row, field) : undefined;
};

/** The face a hardware kind bears on, by outer diameter. A screw bears on its
 *  head, a nut on its across-flats, a washer on its OD. An insert has no
 *  flange in the registry model: its end face is a ring at the install-hole Ø. */
export const BEARING_DIAMETER: Record<string, (thread: string) => number | undefined> = {
  fastener: rowDim("shcs", "headD"),
  nut: rowDim("hex_nut", "af"),
  insert: rowDim("heatset_std", "holeD"),
  washer: rowDim("washer", "od"),
};

/**
 * Where a seat port's annular probe ring may sit: strictly outside the shank,
 * at or inside the bearing edge.
 *
 * Measured against the real probe on cad-clamp's M4 screw: 4.5, 5.5, 6.5 and
 * 6.9 pass; 7.5 and 8.0 fail with "no material just below the declared face".
 * The top is INCLUSIVE because a passing run used exactly 7.0, and a rule that
 * rejects geometry which demonstrably works is worse than a loose one — but the
 * rim is where tessellation decides, so `recommended` is the midpoint.
 */
export function seatBand(kind: string, thread: string): { min: number; max: number; recommended: number } | null {
  const max = threadSpec(thread) && BEARING_DIAMETER[kind]?.(thread);
  if (!max) return null;
  const min = majorDiameter(thread);
  return { min, max, recommended: Math.round(((min + max) / 2) * 10) / 10 };
}

/**
 * A seat port faces OUT of its hardware, and every kind puts its bearing face
 * at the origin with the body running +z: an SHCS head-down with the head on
 * z ∈ [0, headH], a nut seating on z = 0, an insert's flange the same. So the
 * port's +z points down.
 *
 * This sign is the single most expensive fact in this file. Guidance told the
 * architect to declare a seat port without giving it a pose, so the sign was a
 * coin flip; it came up [0,0,1] on one run and both fasteners failed G3 with
 * "material found above the declared face", at zero model calls and with no
 * repair round.
 */
export const SEAT_POSE = { origin: [0, 0, 0], zAxis: [0, 0, -1], xAxis: [1, 0, 0] } as const;

/**
 * How much material a screw and its mating hardware are SUPPOSED to share.
 *
 * A solid screw carries its major diameter and a nut is bored to the tap
 * (minor) diameter, so the difference is the thread itself, and any solid model
 * of an engagement interpenetrates by exactly this much. Measured: G5 reported
 * 12.8 mm³ between an M4 screw and its nut, and this returns 12.8 for
 * (M4, nutH 3.2). Without knowing that, the clash gate reports a false positive
 * on every bolted design in the domain.
 */
export function threadEngagementVolume(thread: string, engagementLength: number): number {
  const spec = threadSpec(thread);
  if (!spec) throw new Error(`unknown thread "${thread}"`);
  const major = majorDiameter(thread);
  return (Math.PI / 4) * (major ** 2 - spec.tapDrill ** 2) * engagementLength;
}

/** Engagement length for a screw into each mating kind, from the catalog.
 *  `family` is the part's own (skuOf): a short heat-set insert engages less
 *  than a standard one. */
export function engagementLength(kind: string, thread: string, family?: string): number | null {
  if (kind === "nut") return rowDim(family ?? "hex_nut", "height")(thread) ?? null;
  if (kind === "insert") return rowDim(family ?? "heatset_std", "length")(thread) ?? null;
  return null;
}

/**
 * FDM printed-to-printed slip fit: a peg is made SMALLER than the socket that
 * receives it, by this much on diameter. Mirrors the kernel's PEG_CLEARANCE,
 * which is where the import path grows peg joints, and it belongs here too so
 * a planner can reason about a fit it did not generate.
 *
 * WIDER THAN THE SLIP BAND ON PURPOSE. FDM_FIT_BANDS_MM.slip [+0.05, +0.25]
 * is for a BOUGHT part, exact to a few hundredths, in a printed hole: one
 * print's error to absorb. A printed peg in a printed socket carries both
 * prints' error, so it needs more than the band's top. Nothing probes this
 * clearance at G3 (SHAFT and BORE are probed at their declared Ø); G5 checks
 * it as the expected radial clearance of a shaft in a bore.
 *
 * The direction is the part people get backwards, so it is in the name: a peg
 * larger than its hole does not assemble.
 */
export const FDM_SLIP_FIT_MM = 0.3;

type FitBands = Record<"press" | "slip" | "magnet" | "nutTrapAf", readonly [number, number]>;

/**
 * The G3 probes' diameter bands relative to the nominal part, as [lo, hi]:
 * gates.py FIT_BANDS, plus the nut trap's across-flats [af, af + 0.4]
 * (NUT_TRAP_SLOP_MM). Pinned to gates.py by grounding.test.ts.
 */
export const FDM_FIT_BANDS_MM: FitBands = { press: [-0.1, 0], slip: [0.05, 0.25], magnet: [0.05, 0.2], nutTrapAf: [0, 0.4] };

/** The same, for a machined part (cnc, sheet_metal, laser_cut: gates.py
 *  MACHINED_FIT_BANDS). SLS, MJF and resin print to the FDM bands. */
export const MACHINED_FIT_BANDS_MM: FitBands = { press: [-0.05, 0], slip: [0, 0.05], magnet: [0, 0.1], nutTrapAf: [0, 0.4] };

const midpoints = (b: FitBands) =>
  Object.fromEntries(Object.entries(b).map(([k, [lo, hi]]) => [k, Math.round(((lo + hi) / 2) * 1e4) / 1e4])) as Record<keyof FitBands, number>;

/**
 * What to CUT for a bought part's host feature, as an offset on the nominal
 * size the port declares. The port says the part (an 8 mm dowel); the G3
 * probe owns the tolerance band; these are the band midpoints, so a part that
 * lands a little off either way still passes. Never add these to a port
 * param: the probe would count the fit twice.
 */
export const FDM_FIT_CUT_MM = midpoints(FDM_FIT_BANDS_MM);
export const MACHINED_FIT_CUT_MM = midpoints(MACHINED_FIT_BANDS_MM);

/** Port type → the param that carries the nominal size, and which cut applies.
 *  DOWEL_HOLE and the bearing seats take theirs from the port's own `fit`. */
const FITTED_PORTS: Record<string, { param: string; cut: keyof typeof FDM_FIT_CUT_MM | "fit" }> = {
  DOWEL_HOLE: { param: "diameter", cut: "fit" },
  BEARING_SEAT: { param: "od", cut: "fit" },
  LINEAR_BEARING_SEAT: { param: "od", cut: "fit" },
  BUSHING_BORE: { param: "od", cut: "press" },
  HUB_BORE: { param: "diameter", cut: "slip" },
  MOTOR_MOUNT: { param: "pilot_diameter", cut: "slip" },
  MAGNET_POCKET: { param: "diameter", cut: "magnet" },
  NUT_TRAP: { param: "af", cut: "nutTrapAf" },
};

/**
 * The generator's annotation for one of its own ports: the size to cut on FDM,
 * worked out from the nominal the port declares, plus the shape rules the
 * probes enforce beyond Ø. `num` resolves a port param (it may be a T1
 * expression); an unresolvable one gets the rule instead. null = no fit.
 */
export function fitCut(
  port: { type: string; params: Record<string, number | string> },
  num: (v: number | string) => number | undefined,
  machined = false,
): string | null {
  if (port.type === "INSERT_POCKET") return "cut at the declared diameter, at least depth + 0.3 deep, 1.2 mm wall around it";
  if (port.type === "THREADED_HOLE") {
    const tapDrill = threadSpec(String(port.params.thread ?? ""))?.tapDrill;
    return tapDrill === undefined ? null : `cut Ø ${tapDrill} (tap drill for ${port.params.thread})`;
  }
  const spec = FITTED_PORTS[port.type];
  if (!spec) return null;
  const cut = spec.cut === "fit" ? (port.params.fit === "slip" ? "slip" : "press") : spec.cut;
  const offset = (machined ? MACHINED_FIT_CUT_MM : FDM_FIT_CUT_MM)[cut];
  const raw = port.params[spec.param];
  const nominal = raw === undefined ? undefined : num(raw);
  const sign = offset < 0 ? "−" : "+";
  const size =
    nominal === undefined
      ? `${spec.param} ${sign} ${Math.abs(offset)}`
      : `${Math.round((nominal + offset) * 1000) / 1000} (${spec.param} ${nominal} ${sign} ${Math.abs(offset)}, ${cut})`;
  const what = port.type === "NUT_TRAP" ? "across the flats" : "Ø";
  const shoulder =
    port.type === "BEARING_SEAT" || (port.type === "LINEAR_BEARING_SEAT" && port.params.retention !== "clip")
      ? `; pocket ≥ ${port.type === "BEARING_SEAT" ? "width" : "length"} deep on a shoulder lip ≥ 1 mm (bore below ≤ od − 2)`
      : "";
  return `cut ${what} ${size}${shoulder}`;
}

/** Rendered for the architect, because a number it cannot read is a number it
 *  will guess. Kept to the facts above, in the units the contract uses. */
export function groundingLines(): string[] {
  const rows = Object.keys(METRIC).map((t) => {
    const m = METRIC[t]!;
    const screw = seatBand("fastener", t)!;
    return `  ${t}: clearance hole Ø${m.clearance}, tapped-in-plastic Ø${m.tap}, heat-set insert hole Ø${m.insertD}, screw-head seat ring Ø${screw.min}..${screw.max} (use ${screw.recommended}), nut seat ring Ø${majorDiameter(t)}..${m.nutAf} (use ${seatBand("nut", t)!.recommended})`;
  });
  return [
    "METRIC FACTS, so you do not have to guess them. All Ø in mm.",
    ...rows,
    `A hardware seat port is ALWAYS posed origin [0,0,0] zAxis [0,0,-1]: the bearing face is at the origin and the body runs +z, so the port faces out of the material. The opposite sign fails G3 and hardware has no repair round.`,
    `A peg is ${FDM_SLIP_FIT_MM}mm SMALLER on diameter than the socket it enters. A peg larger than its hole does not assemble.`,
    `A screw and its nut or insert SHARE material by design, the thread itself, so an overlap there is not a clash.`,
  ];
}
