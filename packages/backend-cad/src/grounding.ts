/**
 * Engineering facts derived from the METRIC table, in one place, so the
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
import { METRIC } from "./registry.js";

/** Nominal major diameter, from the designation. M4 -> 4. */
export function majorDiameter(thread: string): number {
  const d = Number(thread.slice(1));
  if (!Number.isFinite(d)) throw new Error(`not a metric thread designation: "${thread}"`);
  return d;
}

/** The face a hardware kind bears on, by outer diameter. A screw bears on its
 *  head, a nut on its across-flats, an insert on its flange. */
export const BEARING_DIAMETER: Record<string, (m: (typeof METRIC)[string]) => number> = {
  fastener: (m) => m.shcsHeadD,
  nut: (m) => m.nutAf,
  insert: (m) => m.insertD,
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
  const m = METRIC[thread];
  const outer = BEARING_DIAMETER[kind];
  if (!m || !outer) return null;
  const min = majorDiameter(thread);
  const max = outer(m);
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
  const m = METRIC[thread];
  if (!m) throw new Error(`unknown thread "${thread}"`);
  const major = majorDiameter(thread);
  return (Math.PI / 4) * (major ** 2 - m.tap ** 2) * engagementLength;
}

/** Engagement length for a screw into each mating kind, from the table. */
export function engagementLength(kind: string, thread: string): number | null {
  const m = METRIC[thread];
  if (!m) return null;
  if (kind === "nut") return m.nutH;
  if (kind === "insert") return m.insertL;
  return null;
}

/**
 * FDM slip fit: a peg is made SMALLER than the socket that receives it, by this
 * much on diameter. Mirrors the kernel's PEG_CLEARANCE, which is where the
 * import path grows peg joints, and it belongs here too so a planner can reason
 * about a fit it did not generate.
 *
 * The direction is the part people get backwards, so it is in the name: a peg
 * larger than its hole does not assemble.
 */
export const FDM_SLIP_FIT_MM = 0.3;

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
