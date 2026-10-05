import { z } from "zod";
import { CATALOG, canonicalKey, dim, familyDims, pickLength, standardLengths, threadSpec, type DimsRow } from "./catalog.js";
import { FDM_SLIP_FIT_MM, majorDiameter } from "./grounding.js";
import { gt2TipD } from "./registry.js";

/**
 * Joint rules: the architect says what a joint must DO (hold, come apart,
 * align, spin, slide) and a pure function picks the hardware. The model states
 * intent and never names a screw, because "harden rules, not prompts": a
 * plausible but wrong fastener costs a cook, and a rule costs nothing to run
 * again.
 *
 * `selectJoint` walks JOINT_RULES in order and the first rule that FITS wins.
 * A rule that applies but does not fit (a wall too thin for an insert) records
 * why, and if nothing fits the error names every shortfall, so the architect's
 * repair round knows which wall to thicken.
 */

/** Snap fits stay off until a probe can verify one. */
export const SNAP_ENABLED = false;

/** FDM's minimum wall, the process default in CadContractPayload. */
export const FDM_MIN_WALL_MM = 1.2;

/** A print-in-place pin's diametral clearance in its knuckle. */
export const PRINT_IN_PLACE_GAP_MM = 0.6;

const Dim = z.union([z.number(), z.string()]);
const Level = z.enum(["low", "medium", "high"]);
const End = z.object({ node: z.string(), port: z.string() });

/** What the architect declares per joint: intent, never hardware. Walls are
 *  numbers or T1 expressions ("param(base.thickness)"), so a joint tracks the
 *  parts it joins. */
export const CadJoint = z.object({
  id: z.string(),
  a: End.describe("the part that stays put (housing, frame, base): a FLAT_FACE port where the joint is, +z toward b"),
  b: End.describe("the part joined to it, which moves for motion joints: a FLAT_FACE port facing a. One node placed several times (four identical wheels) names the SAME port in each of its joints"),
  intent: z.enum(["permanent", "removable", "serviceable", "alignment"]),
  motion: z.enum(["fixed", "revolute", "prismatic"]).default("fixed"),
  duty: z.enum(["occasional", "continuous"]).default("occasional"),
  driven: z.boolean().optional(),
  speedClass: Level.optional(),
  torqueClass: Level.optional(),
  precise: z.boolean().optional(),
  load: z.enum(["none", "light", "medium", "heavy"]).default("light"),
  access: z.enum(["one_side", "both_sides"]).default("both_sides"),
  count: z.number().int().min(1).max(12).default(1),
  /** Spacing of a `count` pattern, mm. Defaults from the hardware. */
  pitch: z.number().positive().optional(),
  /** Thickness of a / b at the joint, along the joint axis. */
  wallA: Dim,
  wallB: Dim,
  /** Room around the joint axis in b, for a side-entry nut trap. */
  lateral: Dim.optional(),
  flush: z.boolean().optional(),
  threadHint: z.string().optional(),
  shaftHint: z.number().positive().optional(),
  strokeMm: z.number().positive().optional(),
  /** Prismatic on a rod held at both ends: the part holding its far end. */
  far: End.optional().describe("prismatic on a rod held at both ends: the far end block (its own node, not a again), a FLAT_FACE port facing back along the rod; the rod runs into a socket there too"),
  /** Driven revolute: motor turns per output turn (2 = a 2:1 reduction).
   *  Asking for one, or for an offset motor, means a belt or a gear pair. */
  ratio: z.number().positive().optional(),
  /** Driven revolute: motor axis to driven axis, mm. A belt takes it as a
   *  minimum, a gear pair as a target. */
  centerMm: z.number().positive().optional(),
  /** Thickness of a where a driven joint's motor mounts under it, when that
   *  is thinner than wallA (a pocket in a's underside). Defaults to wallA. */
  wallMotor: Dim.optional(),
  allowPrinted: z.boolean().optional(),
  /** Fixed onto a rod: the part is clamped and moved by hand (a thumb screw). */
  toolFree: z.boolean().optional().describe("fixed, b's BORE onto a's SHAFT station: clamped and moved by hand, no tools (a thumb screw, not a set screw)"),
  /** Revolute, printed: a and b print as one piece, the pin captive in its
   *  knuckles with clearance, so nothing is assembled (or swept going in). */
  printInPlace: z.boolean().optional().describe("revolute: a and b print together as one piece, the hinge pin captive with clearance (a print-in-place hinge or fidget). Only when both are FDM, the pin is integral, and the brief says it prints assembled or it can never come apart; never with hardware"),
  /** Hardware the brief names. Binding: only rules that use it are tried, and
   *  when it cannot fit the joint errors instead of substituting. */
  prefer: z.object({
    recipe: z.string().optional().describe("a rule id (R3) or recipe (through_bolt)"),
    family: z.string().optional().describe("a catalog family: dowel, bearing, gt2_pulley, spur_gear, hex_nut, heatset_std, lm_uu, ..."),
    key: z.string().optional().describe("that family's size: 4 (a Ø4 dowel), 608, M5, LM8UU"),
  }).optional().describe("hardware the brief names, by type and size: it is used or the joint errors"),
  /** How b's hub takes a revolute joint's shaft: slip (a D-flat turns it) or
   *  press (b is pressed onto the shaft, a wheel onto its axle). */
  hubFit: z.enum(["slip", "press"]).optional().describe("revolute: press when b is pressed onto the shaft (a wheel onto an axle), else slip"),
  /** Revolute travel in degrees; continuous joints sweep the full turn. */
  limits: z.tuple([z.number(), z.number()]).optional(),
  /** Revolute: how far it turns from rest, degrees, with no direction:
   *  expansion turns it whichever way the parts allow and writes `limits`. */
  travel: z.number().positive().max(360).optional().describe("revolute: degrees it turns from the pose the mates place, either way; expansion picks the direction and writes limits. Prefer it to limits"),
  /** "derived": plan expansion swept the parts' envelopes for `limits`
   *  because none were stated, and re-derives them on every expansion. */
  limitsSource: z.enum(["derived"]).optional().describe("set by plan expansion; never write it"),
  /** Why the joint is what it is, when that is not what was asked for (an
   *  import's fastener that did not fit and became an alignment dowel). */
  note: z.string().optional(),
});
export type CadJoint = z.infer<typeof CadJoint>;

export type JointProcess = "FDM" | "CNC";

/** selectJoint's input: a joint with its walls resolved to numbers. */
export interface JointInput {
  id?: string;
  intent: CadJoint["intent"];
  motion?: CadJoint["motion"];
  duty?: CadJoint["duty"];
  driven?: boolean;
  speedClass?: z.infer<typeof Level>;
  torqueClass?: z.infer<typeof Level>;
  precise?: boolean;
  load: CadJoint["load"];
  access: CadJoint["access"];
  wallA: number;
  wallB: number;
  processA: JointProcess;
  processB: JointProcess;
  /** Material b is machined from, for engagement length: steel | aluminum. */
  materialB?: string;
  materialA?: string;
  /** b's minimum wall, and a's when it differs: the largest of FDM's 1.2,
   *  the part's process minWall and its own min_wall assertion. */
  minWall?: number;
  minWallA?: number;
  flush?: boolean;
  count?: number;
  threadHint?: string;
  shaftHint?: number;
  strokeMm?: number;
  ratio?: number;
  centerMm?: number;
  wallMotor?: number;
  allowPrinted?: boolean;
  prefer?: CadJoint["prefer"];
  lateral?: number;
  /** a is a catalog part (a rail, an idler), so no counterbore can be cut in it. */
  noRecess?: boolean;
  /** Ø of a bore a already declares on the joint's axis (a brief's "3.2mm knuckle bores"). */
  boreA?: number;
  /** a's envelope behind a.port along the axis, and the largest Ø it holds
   *  around the axis there (expand.ts materialAt). Unknown when undefined. */
  depthA?: number;
  roomA?: number;
  /** b also turns on a coaxial revolute joint from its far side (a cradle
   *  between two supports). */
  pairedB?: boolean;
  /** How far apart b's two faces are along that axis. */
  pairSpan?: number;
  /** A slide whose moving body already rides a guide of its own (wheels on
   *  a rail, another slide's carriage): no guide rod of its own. */
  guided?: boolean;
  /** a's envelope holds the axis ahead of a.port past b's wall: b sits
   *  between a's knuckles, so nothing fixed to a can enter b along the axis. */
  trappedB?: boolean;
  printInPlace?: boolean;
  toolFree?: boolean;
  /** b is a catalog wheel with its bearings built in (an OpenBuilds V-wheel
   *  kit): its bore Ø. Only the axle and its keeper are minted. */
  bBuiltIn?: number;
  /** a.port is a SHAFT station and b.port a BORE: the rod's Ø (expand.ts). */
  onRod?: number;
}

/** One catalog part a joint needs. `role` becomes the node id suffix. */
export interface HardwarePick {
  role: string;
  family: string;
  key: string;
  length?: number;
}

export type Recipe =
  | "hub_bearings"
  | "flanged_bearing"
  | "dowel"
  | "peg"
  | "tapped"
  | "through_bolt"
  | "insert"
  | "nut_trap"
  | "side_nut_trap"
  | "snap"
  | "bearings"
  | "bushings"
  | "printed_pin"
  | "pin"
  | "rod_slide"
  | "rail"
  | "direct_drive"
  | "belt_drive"
  | "gear_drive"
  | "lead_screw"
  | "belt_carriage"
  | "confirmat"
  | "cam_lock"
  | "stud"
  | "rod_clamp";

/** ca·wallA + cb·wallB + k, mm: a length bound the expansion re-derives as a
 *  T1 binding, so a wall edit re-picks the screw length with no LLM call. */
export type Lin = [number, number, number];
export const linAt = (l: Lin, wallA: number, wallB: number) => l[0] * wallA + l[1] * wallB + l[2];

export interface JointDecision {
  rule: string;
  recipe: Recipe;
  summary: string;
  /** Why, in order: each choice the rule made and what forced it. */
  reasons: string[];
  thread?: string;
  head?: "shcs" | "button" | "csk";
  parts: HardwarePick[];
  /** The numbers the expansion cuts host features from, mm. */
  dims: Record<string, number>;
  /** The screw's stocked-length window, when there is a screw. */
  window?: { min: Lin; max: Lin };
}

export interface JointRule {
  id: string;
  /** Whether the rule speaks to this joint at all. */
  when: (i: JointInput) => boolean;
  /** Whether the rule may serve a joint whose hardware the brief states:
   *  `when` without the preferences that pick between rules. Default `when`. */
  can?: (i: JointInput) => boolean;
  /** Catalog families its decisions may hold, so a stated family tries only
   *  the rules that can use it. */
  uses: string[];
  /** A decision, or the shortfall that stopped it ("wallB 3.0 < insert 5.8 + 1.2"). */
  fit: (i: JointInput) => JointDecision | string;
}

const LOADS = ["none", "light", "medium", "heavy"] as const;
const atLeast = (load: JointInput["load"], floor: JointInput["load"]) => LOADS.indexOf(load) >= LOADS.indexOf(floor);
const mm = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const r2 = (n: number) => Math.round(n * 100) / 100;
const minWallOf = (i: JointInput) => i.minWall ?? FDM_MIN_WALL_MM;
const minWallA = (i: JointInput) => i.minWallA ?? minWallOf(i);
const minWallBoth = (i: JointInput) => Math.max(minWallOf(i), minWallA(i));
const n = (family: string, key: string, field: string) => dim(familyDims(family, key)!, field);
const SCREWS = ["shcs", "button", "csk"];
const SPINDLE = ["bearing", "d_shaft", "shaft", "collar", "eclip"];

/** "A 4mm steel pin" is any of these at Ø4: the rules decide which. */
const PINS = ["shaft", "d_shaft", "dowel"];
const sameFamily = (stated: string, family: string) => stated === family || (PINS.includes(stated) && PINS.includes(family));

/** The size the brief states for `family`, when it names that family. */
const statedKey = (i: JointInput, family: string) =>
  i.prefer?.family && i.prefer.key && sameFamily(i.prefer.family, family) ? canonicalKey(family, i.prefer.key) : undefined;

// ---------- Fasteners ----------

/** threadHint wins; else light M3, medium M4, heavy M5, stepping up to M6 or
 *  M8 under a heavy load only when both walls are at least 3·d. */
export function pickThread(i: JointInput): { thread: string; reason: string } {
  const said = i.threadHint ?? i.prefer?.key;
  const hint = said && Object.keys(CATALOG.threads).find((t) => t.toUpperCase() === said.toUpperCase());
  if (hint) return { thread: hint, reason: `thread ${hint} as ${i.threadHint ? "hinted" : "stated"}` };
  if (i.load === "heavy") {
    for (const t of ["M8", "M6"]) {
      const need = 3 * majorDiameter(t);
      if (i.wallA >= need && i.wallB >= need) return { thread: t, reason: `heavy load and both walls ≥ 3·d = ${need}: ${t}` };
    }
  }
  const thread = { none: "M3", light: "M3", medium: "M4", heavy: "M5" }[i.load];
  return { thread, reason: `${i.load} load: ${thread}` };
}

interface Head {
  head: "shcs" | "button" | "csk";
  /** Head recess cut into a: counterbore or countersink depth, else 0. */
  recess: number;
  /** Clamp length minus wallA: how far the screw's length datum sits below
   *  a's back face (a counterbore floor), negative, or 0. */
  offset: number;
  clamp: number;
  reason: string;
}

/** flush → countersunk; room for a counterbore → SHCS in one; else button. */
function pickHead(i: JointInput, thread: string, opts: { recessed: boolean }): Head | string {
  const mw = minWallA(i);
  if (i.flush) {
    const h = n("csk", thread, "headH");
    if (i.wallA < h + mw) return `wallA ${mm(i.wallA)} < countersunk ${thread} head ${mm(h)} + ${mw}`;
    return { head: "csk", recess: h, offset: 0, clamp: i.wallA, reason: "flush: countersunk head" };
  }
  const cboreDepth = n("shcs", thread, "headH") + 0.4;
  if (opts.recessed && !i.noRecess && i.wallA >= cboreDepth + Math.max(2 * mw, majorDiameter(thread))) {
    return { head: "shcs", recess: cboreDepth, offset: -cboreDepth, clamp: i.wallA - cboreDepth, reason: `wallA ${mm(i.wallA)} has room for a ${mm(cboreDepth)} counterbore: SHCS` };
  }
  return { head: "button", recess: 0, offset: 0, clamp: i.wallA, reason: "no room to recess the head: button head on the face" };
}

const headFamily = (h: Head) => (h.head === "csk" ? "csk" : h.head === "button" ? "button" : "shcs");

function screwLength(i: JointInput, thread: string, h: Head, window: { min: Lin; max: Lin }): number | string {
  const [min, max] = [linAt(window.min, i.wallA, i.wallB), linAt(window.max, i.wallA, i.wallB)];
  const L = pickLength(headFamily(h), thread, { min, max });
  if (L !== undefined) return L;
  return `no stocked ${headFamily(h)} ${thread} length in ${mm(min)}..${mm(max)} (stocked: ${standardLengths(headFamily(h), thread).join(", ")})`;
}

const screwPart = (thread: string, h: Head, length: number): HardwarePick => ({ role: "screw", family: headFamily(h), key: thread, length });

function decision(rule: string, recipe: Recipe, summary: string, reasons: string[], rest: Partial<JointDecision> = {}): JointDecision {
  return { rule, recipe, summary, reasons, parts: [], dims: {}, ...rest };
}

const fixed = (i: JointInput) => (i.motion ?? "fixed") === "fixed";
const fastens = (i: JointInput) => fixed(i) && i.intent !== "alignment";

/** C1: b slides onto a's rod and is clamped there by one radial screw in
 *  its wall: a DIN 464 thumb screw when it moves by hand (toolFree), else an
 *  ISO 4026 set screw, flush. Under a medium load or more a DIN 705 collar
 *  under b holds it up as well, so the screw only locates. The spaghetti
 *  shelf's brackets had no rule at all: its thumb screws were hand-wired and
 *  the plan checks deleted them. wallB is b's radial wall at the clamp; the
 *  screw is the longest stocked one that ends at the bore wall. */
const C1: JointRule = {
  id: "C1",
  when: (i) => fixed(i) && i.onRod !== undefined,
  uses: ["thumb_screw", "set_screw", "collar"],
  fit: (i) => {
    const d = i.onRod!;
    const family = i.toolFree ? "thumb_screw" : "set_screw";
    const want = i.threadHint ?? (d <= 8 ? "M4" : d <= 14 ? "M5" : "M6");
    const order = ["M8", "M6", "M5", "M4", "M3"].filter((t) => !i.threadHint || t === i.threadHint);
    const shortfalls: string[] = [];
    for (const thread of [want, ...order.filter((t) => t !== want && Number(t.slice(1)) < Number(want.slice(1)))]) {
      const lengths = standardLengths(family, thread);
      if (!lengths.length) continue;
      // The tip stops at the bore wall (the bore's slip leaves it clear of the
      // rod), no more than 2mm short of it so it still bears when tightened.
      const L = [...lengths].reverse().find((l) => l <= i.wallB + 0.01 && l >= i.wallB - 2);
      if (L === undefined) {
        shortfalls.push(`${thread}: no stocked ${family === "thumb_screw" ? "thumb" : "set"} screw ${mm(i.wallB - 2)}..${mm(i.wallB)} long (${lengths.join(", ")})`);
        continue;
      }
      const collar = atLeast(i.load, "medium") ? familyDims("collar", String(d)) : undefined;
      if (atLeast(i.load, "medium") && !collar) shortfalls.push(`no stocked collar for a Ø${d} rod to carry the load`);
      return decision("C1", "rod_clamp", `${family === "thumb_screw" ? "DIN 464" : "ISO 4026"} ${thread}×${L} ${family === "thumb_screw" ? "thumb" : "set"} screw clamping b on the Ø${d} rod${collar ? ", on a DIN 705 collar" : ""}`, [
        `fixed, b on a's rod: one radial screw clamps it`,
        i.toolFree ? "moved by hand: a knurled thumb screw" : "set with a hex key: a flush set screw",
        `${thread}${thread === want ? ` for a Ø${d} rod` : `, the largest that fits wallB ${mm(i.wallB)}`}; ${L}mm ends at the bore wall`,
        ...(collar ? [`${i.load} load: a collar under b carries it`] : []),
      ], {
        thread,
        parts: [{ role: "screw", family, key: thread, length: L }, ...(collar ? [{ role: "collar", family: "collar", key: String(d) }] : [])],
        dims: { d, wall: i.wallB },
      });
    }
    return `C1: ${shortfalls.join("; ") || `wallB ${mm(i.wallB)} holds no clamp screw`}`;
  },
};

/** R1: ISO 2338 dowel, press in a, slip in b. Common practice engages a
 *  dowel at least 1·d in each part (1.5·d preferred, so a 3·d pin first): a
 *  blind hole e + 0.5 deep with the minimum wall behind it, or, in a part too
 *  thin for that, a through hole with the pin 0.5 shy of the far face (the
 *  organiser's Ø5 pin in an 8mm top). Old rule: both walls ≥ 1.5·d + 1.7,
 *  9.2 for a Ø5, which refused that top. */
const R1: JointRule = {
  id: "R1",
  when: (i) => fixed(i) && i.intent === "alignment",
  uses: ["dowel"],
  fit: (i) => {
    const mw = minWallBoth(i);
    // How far a pin may go into a wall: blind with mw behind, else through.
    const cap = (wall: number, d: number) => (wall - mw - 0.5 >= d ? wall - mw - 0.5 : wall - 0.5 >= d ? wall - 0.5 : -1);
    const stated = statedKey(i, "dowel") ?? (i.shaftHint !== undefined ? canonicalKey("dowel", String(i.shaftHint)) : undefined);
    const preferred = stated ? Number(stated) : { none: 3, light: 3, medium: 4, heavy: 5 }[i.load];
    const sizes = stated ? [preferred] : Object.keys(CATALOG.families.dowel!.dims).map(Number).filter((d) => d <= preferred).sort((a, b) => b - a);
    for (const d of sizes) {
      const [ca, cb] = [cap(i.wallA, d), cap(i.wallB, d)];
      // Through one part at most: through both, nothing holds the pin's ends.
      if (ca < 0 || cb < 0 || (ca > i.wallA - mw - 0.5 && cb > i.wallB - mw - 0.5)) continue;
      const key = canonicalKey("dowel", String(d))!;
      const L = pickLength("dowel", key, { min: 3 * d, max: ca + cb }) ?? pickLength("dowel", key, { min: 2 * d, max: ca + cb });
      if (L === undefined) continue;
      const eb = r2(Math.min(cb, Math.max(L / 2, L - ca)));
      const ea = r2(L - eb);
      const depth = (e: number, wall: number) => r2(Math.min(e + 0.5, wall));
      const through = (wall: number, e: number) => e + 0.5 > wall - mw;
      return decision("R1", "dowel", `Ø${d}×${L} dowel, press in a, slip in b`, [
        `alignment: ISO 2338 dowel`,
        stated ? `Ø${d} as stated` : `Ø${d}: the largest at or under the ${i.load}-load Ø${preferred} engaging 1·d or more in both`,
        `${mm(ea)} in a, ${mm(eb)} in b${through(i.wallB, eb) ? ", through b (too thin for a blind hole)" : ""}${through(i.wallA, ea) ? ", through a" : ""}`,
      ], {
        parts: [{ role: "dowel", family: "dowel", key, length: L }],
        dims: { d, length: L, depth: depth(Math.max(ea, eb), Math.max(i.wallA, i.wallB)), depthA: through(i.wallA, ea) ? i.wallA : depth(ea, i.wallA), depthB: through(i.wallB, eb) ? i.wallB : depth(eb, i.wallB), press: ea },
      });
    }
    const need = (d: number) => mm(d + 0.5);
    if (stated) return `walls ${mm(i.wallA)}/${mm(i.wallB)}: a Ø${preferred} dowel needs 1·d in both, a wall of at least ${need(preferred)} each (through), on a stocked length`;
    return `walls ${mm(i.wallA)}/${mm(i.wallB)}: no dowel Ø${preferred} or smaller engages 1·d in both on a stocked length`;
  },
};

/** R1b: the printed peg alignment falls back to when walls are too thin. */
const R1b: JointRule = {
  id: "R1b",
  when: (i) => fixed(i) && i.intent === "alignment" && i.allowPrinted !== false,
  uses: [],
  fit: (i) => {
    const length = i.wallB - minWallOf(i);
    if (length < 1) return `wallB ${mm(i.wallB)} < printed peg 1.0 + ${minWallOf(i)}`;
    const d = 3;
    return decision("R1b", "peg", `printed Ø${d - FDM_SLIP_FIT_MM} peg`, ["alignment, walls too thin for a dowel: printed peg"], {
      dims: { d, peg: d - FDM_SLIP_FIT_MM, length: r2(Math.min(length, 2 * d)) },
    });
  },
};

/** R2: b is machined, so tap it, with the thread engaged at least the
 *  material's engagementMin and 1mm of wall left under the hole. */
const R2: JointRule = {
  id: "R2",
  // Never into wood, whatever a is: the step stool's beech rails got M6 tapped holes.
  when: (i) => fastens(i) && i.processB === "CNC" && classB(i) !== "wood",
  uses: SCREWS,
  fit: (i) => {
    const { thread, reason } = pickThread(i);
    const material = (i.materialB ?? "aluminum").toLowerCase().includes("steel") ? "steel" : "aluminum";
    const engage = threadSpec(thread)!.engagementMin[material]!;
    if (i.wallB < engage + 1) return `wallB ${mm(i.wallB)} < ${thread} engagement in ${material} ${mm(engage)} + 1`;
    const h = pickHead(i, thread, { recessed: true });
    if (typeof h === "string") return h;
    const window = { min: [1, 0, h.offset + engage] as Lin, max: [1, 1, h.offset - 1] as Lin };
    const L = screwLength(i, thread, h, window);
    if (typeof L === "string") return L;
    return decision("R2", "tapped", `${thread}×${L} ${h.head} into a tapped hole`, [`b is machined: tap it`, reason, h.reason], {
      thread, head: h.head, parts: [screwPart(thread, h, L)], window,
      dims: { recess: h.recess, offset: h.offset, tapDepth: r2(L - h.clamp + 0.5) },
    });
  },
};

/** R3: reachable from both sides and heavy, or b is metal too thin to tap
 *  (R2 tried it first): through-bolt, nut, two washers. Last of all it is the
 *  fallback for a printed b too thin for an insert or a nut trap (R3f). */
const R3: JointRule = {
  id: "R3",
  when: (i) => fastens(i) && i.access === "both_sides" && (i.load === "heavy" || i.processB === "CNC"),
  can: (i) => fastens(i) && i.access === "both_sides",
  uses: [...SCREWS, "hex_nut", "washer"],
  fit: (i) => {
    const { thread, reason } = pickThread(i);
    const h: Head | string = i.flush
      ? pickHead(i, thread, { recessed: false })
      : { head: "shcs", recess: 0, offset: 0, clamp: i.wallA, reason: "washer under the head" };
    if (typeof h === "string") return h;
    const t = n("washer", thread, "thickness");
    const nutH = n("hex_nut", thread, "height");
    const pitch = threadSpec(thread)!.pitch;
    const under = h.head === "csk" ? 0 : t;
    const k = h.offset + under + t + nutH + 2 * pitch;
    const window = { min: [1, 1, k] as Lin, max: [1, 1, k + 6] as Lin };
    const L = screwLength(i, thread, h, window);
    if (typeof L === "string") return L;
    const washers: HardwarePick[] = [
      ...(under ? [{ role: "washer_a", family: "washer", key: thread }] : []),
      { role: "washer_b", family: "washer", key: thread },
    ];
    const why = i.load === "heavy" ? "heavy load" : i.processB === "CNC" ? "metal b too thin to tap" : "printed b too thin for an insert or a nut trap";
    return decision("R3", "through_bolt", `${thread}×${L} through-bolt, nut and washers`, [`${why}, both sides reachable: through-bolt`, reason], {
      thread, head: h.head, parts: [screwPart(thread, h, L), { role: "nut", family: "hex_nut", key: thread }, ...washers], window,
      dims: { recess: h.recess, offset: h.offset, washer: t, under },
    });
  },
};

/** R4: printed and meant to come apart: heat-set insert in b. The pocket is
 *  cut as deep as the screw reaches, and the screw engages the whole insert. */
const R4: JointRule = {
  id: "R4",
  when: (i) => fastens(i) && i.processB === "FDM" && (i.intent === "removable" || i.intent === "serviceable"),
  can: (i) => fastens(i) && i.processB === "FDM",
  uses: [...SCREWS, "heatset_std", "heatset_short"],
  fit: (i) => {
    const { thread, reason } = pickThread(i);
    const mw = minWallOf(i);
    const shortfalls: string[] = [];
    for (const family of ["heatset_std", "heatset_short"]) {
      const row = familyDims(family, thread);
      if (!row) continue;
      const insL = dim(row, "length");
      if (i.wallB < insL + mw) {
        shortfalls.push(`wallB ${mm(i.wallB)} < ${family === "heatset_std" ? "insert" : "short insert"} ${mm(insL)} + ${mw}`);
        continue;
      }
      const h = pickHead(i, thread, { recessed: true });
      if (typeof h === "string") return h;
      const window = { min: [1, 0, h.offset + insL - 0.5] as Lin, max: [1, 1, h.offset - mw - 0.8] as Lin };
      const L = screwLength(i, thread, h, window);
      if (typeof L === "string") {
        shortfalls.push(L);
        continue;
      }
      return decision("R4", "insert", `${thread}×${L} ${h.head} into a heat-set insert`, [
        `printed and ${i.intent}: heat-set insert, never self-tapped plastic`, reason, h.reason,
        ...(family === "heatset_short" ? [`wallB ${mm(i.wallB)} too thin for a standard insert: short insert`] : []),
      ], {
        thread, head: h.head,
        parts: [screwPart(thread, h, L), { role: "insert", family, key: thread }], window,
        dims: { recess: h.recess, offset: h.offset, insertLength: insL, pocketDepth: r2(L - h.clamp + 0.5) },
      });
    }
    return shortfalls.join("; ");
  },
};

/** R5: printed, both sides reachable: a nut in an axial trap on b's far face. */
const R5: JointRule = {
  id: "R5",
  when: (i) => fastens(i) && (i.processB === "FDM" || classB(i) === "wood") && i.access === "both_sides",
  uses: [...SCREWS, "hex_nut"],
  fit: (i) => {
    const { thread, reason } = pickThread(i);
    const nutH = n("hex_nut", thread, "height");
    const mw = minWallOf(i);
    if (i.wallB < nutH + 2 * mw) return `wallB ${mm(i.wallB)} < nut ${mm(nutH)} + 2·${mw}`;
    const h = pickHead(i, thread, { recessed: true });
    if (typeof h === "string") return h;
    const pitch = threadSpec(thread)!.pitch;
    const window = { min: [1, 1, h.offset - 0.2 * nutH] as Lin, max: [1, 1, h.offset + 2 * pitch + 1.5] as Lin };
    const L = screwLength(i, thread, h, window);
    if (typeof L === "string") return L;
    return decision("R5", "nut_trap", `${thread}×${L} ${h.head} into a trapped nut`, [`printed, both sides reachable: axial nut trap`, reason, h.reason], {
      thread, head: h.head, parts: [screwPart(thread, h, L), { role: "nut", family: "hex_nut", key: thread }], window,
      dims: { recess: h.recess, offset: h.offset, nutDepth: nutH },
    });
  },
};

/** R6: printed, one side only: the nut slides in from the side, mid-wall. */
const R6: JointRule = {
  id: "R6",
  // In wood, the side-entry nut is the furniture cross-dowel (barrel nut) idiom.
  when: (i) => fastens(i) && (i.processB === "FDM" || classB(i) === "wood") && i.access === "one_side",
  uses: [...SCREWS, "hex_nut"],
  fit: (i) => {
    const { thread, reason } = pickThread(i);
    const af = n("hex_nut", thread, "af");
    const nutH = n("hex_nut", thread, "height");
    const mw = minWallOf(i);
    if (i.lateral === undefined) return `lateral room around the screw in b is not declared (side nut trap needs ${mm(af + 2 * mw)})`;
    if (i.lateral < af + 2 * mw) return `lateral ${mm(i.lateral)} < nut ${mm(af)} AF + 2·${mw}`;
    if (i.wallB < nutH + 2 * mw) return `wallB ${mm(i.wallB)} < nut ${mm(nutH)} + 2·${mw}`;
    const h = pickHead(i, thread, { recessed: true });
    if (typeof h === "string") return h;
    const embed = r2((i.wallB - nutH) / 2);
    const window = { min: [1, 0.5, h.offset + nutH / 2] as Lin, max: [1, 1, h.offset - mw] as Lin };
    const L = screwLength(i, thread, h, window);
    if (typeof L === "string") return L;
    return decision("R6", "side_nut_trap", `${thread}×${L} ${h.head} into a side-entry nut`, [`printed, one side reachable: side-entry nut trap`, reason, h.reason], {
      thread, head: h.head, parts: [screwPart(thread, h, L), { role: "nut", family: "hex_nut", key: thread }],
      window, dims: { recess: h.recess, offset: h.offset, nutDepth: nutH, embed },
    });
  },
};

/** R3 again, after R4 and R5: a thin printed plate reachable from both sides
 *  takes a through-bolt at any load, so the wall a brief pins can stay. */
const R3f: JointRule = {
  id: "R3",
  when: (i) => fastens(i) && i.access === "both_sides" && i.processB === "FDM" && i.load !== "heavy",
  can: (i) => fastens(i) && i.access === "both_sides",
  uses: [...SCREWS, "hex_nut", "washer"],
  fit: R3.fit,
};

/** R7: snap fit. Off until snap probes exist. */
const R7: JointRule = {
  id: "R7",
  when: (i) => fastens(i) && i.processB === "FDM" && i.intent === "permanent" && !atLeast(i.load, "medium"),
  uses: [],
  fit: () => (SNAP_ENABLED ? decision("R7", "snap", "snap fit", ["permanent, light, printed: snap"]) : "snap fits are disabled until a probe can verify one"),
};

// ---------- Wood ----------

/** Panel stock that takes wood screws, cam fittings and glued dowels, never a
 *  tapped hole or an insert: material names a wood or a wood board. */
const WOOD = /\b(wood|hardwood|softwood|timber|mdf|hdf|ply(wood)?|particle ?board|chipboard|osb|melamine|oak|beech|birch|pine|spruce|maple|walnut|ash|poplar|bamboo)\b/i;
export const isWood = (material?: string) => !!material && WOOD.test(material);
const METAL = /\b(alumin(i)?um|steel|stainless|brass|bronze|copper|titanium)\b/i;

/** What a part is made of, for the joint rules: wood takes wood screws,
 *  cam fittings, dowels and nuts, never a tapped thread; metal is tapped;
 *  plastic (FDM, SLS) takes inserts and nut traps. Machined with no
 *  material named reads as metal. */
export type MaterialClass = "wood" | "metal" | "plastic";
export function materialClass(material: string | undefined, process: JointProcess): MaterialClass {
  if (isWood(material)) return "wood";
  if (material && METAL.test(material)) return "metal";
  return process === "CNC" ? "metal" : "plastic";
}
const classB = (i: JointInput) => materialClass(i.materialB, i.processB);
const wood = (i: JointInput) => materialClass(i.materialA, i.processA) === "wood" && classB(i) === "wood";
/** Wood left behind a blind hole, so it never breaks through a face. */
const WOOD_SKIN_MM = 3;

/** The largest furniture dowel whose symmetric blind holes (L/2 + 0.5 deep)
 *  leave WOOD_SKIN_MM in both walls, longest stocked first. */
function woodDowel(i: JointInput): HardwarePick | undefined {
  const stated = statedKey(i, "wood_dowel");
  for (const d of stated ? [Number(stated)] : [8, 6]) {
    if (i.lateral !== undefined && i.lateral < 2 * d) continue;
    const key = String(d);
    const L = [...standardLengths("wood_dowel", key)].reverse().find((l) => l / 2 + 0.5 + WOOD_SKIN_MM <= Math.min(i.wallA, i.wallB));
    if (L !== undefined) return { role: "dowel", family: "wood_dowel", key, length: L };
  }
  return undefined;
}

/** W1: wood panels align on glued furniture dowels. */
const W1: JointRule = {
  id: "W1",
  when: (i) => fixed(i) && i.intent === "alignment" && wood(i),
  // A brief's furniture dowels glue any two parts that hold them, wood named or not.
  can: (i) => fixed(i) && (i.intent === "alignment" || i.intent === "permanent"),
  uses: ["wood_dowel"],
  fit: (i) => {
    const p = woodDowel(i);
    if (!p) return `walls ${mm(i.wallA)}/${mm(i.wallB)}: no Ø6 furniture dowel's half length + 0.5 leaves ${WOOD_SKIN_MM} in both`;
    return decision("W1", "dowel", `Ø${p.key}×${p.length} wood dowel, glued in both`, ["wood alignment: glued fluted furniture dowels"], {
      parts: [p], dims: { d: Number(p.key), length: p.length!, depth: p.length! / 2 + 0.5 },
    });
  },
};

/** W2: wood panels meant to come apart: a 15mm cam in b's face grips a bolt
 *  screwed into a's face, through an Ø8 hole in b's edge, with a glued dowel
 *  either side where the walls hold one. Needs b's panel thickness
 *  (`lateral`); the cam opens on b's face toward b.port's +y. */
const W2: JointRule = {
  id: "W2",
  when: (i) => fastens(i) && wood(i) && (i.intent === "removable" || i.intent === "serviceable"),
  can: (i) => fastens(i) && wood(i),
  uses: ["cam_lock", "cam_bolt", "wood_dowel"],
  fit: (i) => {
    const cam = familyDims("cam_lock", "15")!;
    const [camD, panel] = [dim(cam, "d"), dim(cam, "minPanel")];
    if (i.lateral === undefined) return `b's panel thickness (lateral) is not declared: a 15mm cam needs ${panel}`;
    if (i.lateral < panel) return `lateral ${mm(i.lateral)} < 15mm cam panel ${panel}`;
    const distance = [34, 24].find((t) => i.wallB >= t + camD / 2 + WOOD_SKIN_MM);
    if (distance === undefined) return `wallB ${mm(i.wallB)} < cam drilling distance 24 + ${camD / 2} + ${WOOD_SKIN_MM}`;
    const bolt = familyDims("cam_bolt", String(distance))!;
    const threadL = dim(bolt, "threadL");
    if (i.wallA < threadL + 1 + WOOD_SKIN_MM) return `wallA ${mm(i.wallA)} < cam bolt thread ${threadL} + 1 + ${WOOD_SKIN_MM}`;
    // System 32: a dowel 32mm either side, where a's face holds them.
    const dowel = i.roomA === undefined || i.roomA >= 2 * (32 + 4 + WOOD_SKIN_MM) ? woodDowel(i) : undefined;
    return decision("W2", "cam_lock", `15mm cam lock on a ${distance}mm bolt${dowel ? ` + 2 Ø${dowel.key}×${dowel.length} dowels` : ""}`, [
      `wood, ${i.intent}: cam lock, which comes apart and goes back`,
      `${distance}mm drilling distance: the longest wallB ${mm(i.wallB)} holds`,
      dowel ? `Ø${dowel.key} dowels 32mm either side carry the shear` : "no furniture dowel fits 32mm either side in these walls: the cam alone",
    ], {
      parts: [{ role: "cam", family: "cam_lock", key: "15" }, { role: "cam_bolt", family: "cam_bolt", key: String(distance) }, ...(dowel ? [dowel] : [])],
      dims: {
        distance, camD, camDepth: dim(cam, "drillDepth"), edgeHole: dim(cam, "edgeHole"), panel: i.lateral,
        pilot: dim(bolt, "pilot"), pilotDepth: threadL + 1, ...(dowel ? { dowelLength: dowel.length!, dowelDepth: dowel.length! / 2 + 0.5, dowelOffset: 32 } : {}),
      },
    });
  },
};

/** W3: any other wood panel joint: a 7×50 confirmat through a's face into
 *  b's edge, its shoulder in a's Ø7 hole, its thread in b's Ø5 pilot. */
const W3: JointRule = {
  id: "W3",
  when: (i) => fastens(i) && wood(i),
  uses: ["confirmat"],
  fit: (i) => {
    const r = familyDims("confirmat", "7")!;
    const L = standardLengths("confirmat", "7")[0]!;
    const hh = (dim(r, "headD") - dim(r, "d")) / 2;
    const thread = L - i.wallA;
    if (i.wallA < hh + dim(r, "shoulderL") / 2) return `wallA ${mm(i.wallA)} < confirmat head ${mm(hh)} + half its shoulder ${mm(dim(r, "shoulderL") / 2)}`;
    if (thread < L / 2) return `wallA ${mm(i.wallA)} leaves the ${L}mm confirmat only ${mm(thread)} of thread in b (needs ${L / 2})`;
    if (i.wallB < thread + 1 + WOOD_SKIN_MM) return `wallB ${mm(i.wallB)} < confirmat reach ${mm(thread)} + 1 + ${WOOD_SKIN_MM}`;
    if (i.lateral !== undefined && i.lateral < dim(r, "drillB") + 2 * WOOD_SKIN_MM) return `lateral ${mm(i.lateral)} < Ø${dim(r, "drillB")} pilot + 2·${WOOD_SKIN_MM}`;
    return decision("W3", "confirmat", `7×${L} confirmat screw`, [`wood, ${i.intent}: a confirmat connector screw, never a tapped hole or an insert`], {
      parts: [{ role: "screw", family: "confirmat", key: "7", length: L }],
      dims: { headD: dim(r, "headD"), drillA: dim(r, "drillA"), drillB: dim(r, "drillB"), pilotDepth: r2(thread + 1) },
    });
  },
};

// ---------- Studs ----------

/** Wall left behind a stud's blind hole: wood's skin, else the parts' minimum. */
const skinOf = (i: JointInput) => (wood(i) ? WOOD_SKIN_MM : minWallBoth(i));

/** W4: a double-ended dowel screw, half in each part's pilot hole (IKEA's
 *  leg into a table top). Only as stated. The longest stocked length whose
 *  half + 1 leaves the skin in both walls, at least 2.5·d into each. */
const W4: JointRule = {
  id: "W4",
  when: (i) => fastens(i) && i.prefer?.family === "dowel_screw",
  can: fastens,
  uses: ["dowel_screw"],
  fit: (i) => {
    const key = statedKey(i, "dowel_screw") ?? (atLeast(i.load, "medium") ? "8" : "6");
    const [d, skin] = [n("dowel_screw", key, "d"), skinOf(i)];
    const L = [...standardLengths("dowel_screw", key)].reverse().find((l) => l / 2 >= 2.5 * d && l / 2 + 1 + skin <= Math.min(i.wallA, i.wallB));
    if (L === undefined) return `walls ${mm(i.wallA)}/${mm(i.wallB)}: no stocked Ø${key} dowel screw (${standardLengths("dowel_screw", key).join(", ")}) reaches 2.5·d into both with ${skin} left behind`;
    return decision("W4", "stud", `Ø${key}×${L} dowel screw, half in each part`, [`a double-ended dowel screw as stated, ${L / 2}mm into each part's Ø${n("dowel_screw", key, "pilot")} pilot`], {
      parts: [{ role: "stud", family: "dowel_screw", key, length: L }],
      dims: { d, length: L, depth: L / 2 + 1, pilot: n("dowel_screw", key, "pilot") },
    });
  },
};

/** W5: a countersunk chipboard screw (DIN 7505) through a's clearance into
 *  a pilot in b, as stated. The shortest stocked length that bites 4·d into
 *  b and leaves the skin behind its tip; the pilot at the hardwood Ø, which
 *  is over the modelled core, so screw and pilot share nothing (G5). */
const W5: JointRule = {
  id: "W5",
  when: (i) => fastens(i) && i.prefer?.family === "chipboard",
  can: fastens,
  uses: ["chipboard"],
  fit: (i) => {
    const key = statedKey(i, "chipboard") ?? { none: "3.5", light: "4", medium: "4.5", heavy: "5" }[i.load];
    const [d, headD, pilot] = [n("chipboard", key, "d"), n("chipboard", key, "headD"), n("chipboard", key, "pilotHard")];
    const skin = skinOf(i);
    if (i.wallA < (headD - d) / 2 + 1) return `wallA ${mm(i.wallA)} < countersunk Ø${key} head ${mm((headD - d) / 2)} + 1`;
    const L = standardLengths("chipboard", key).find((l) => l - i.wallA >= 4 * d && l - i.wallA + 1 + skin <= i.wallB);
    if (L === undefined) return `walls ${mm(i.wallA)}/${mm(i.wallB)}: no stocked Ø${key} chipboard screw (${standardLengths("chipboard", key).join(", ")}) bites 4·d into b with ${skin} behind its tip`;
    return decision("W5", "confirmat", `Ø${key}×${L} countersunk chipboard screw`, [`a chipboard screw as stated, ${mm(L - i.wallA)} into b's Ø${pilot} pilot`], {
      parts: [{ role: "screw", family: "chipboard", key, length: L }],
      dims: { headD, drillA: r2(d + 0.5), drillB: pilot, pilotDepth: r2(L - i.wallA + 1) },
    });
  },
};

/** W6: a machine screw into a hex-drive threaded insert screwed into wood
 *  (the brief's "M6 connector screws" in a beech rail), as stated. The
 *  shortest stocked insert at least 1.5·d long that leaves the skin behind
 *  it, then the screw by R4's window. Heat-set inserts are for plastics. */
const W6: JointRule = {
  id: "W6",
  when: (i) => fastens(i) && classB(i) === "wood" && i.prefer?.family === "wood_insert",
  can: (i) => fastens(i) && classB(i) === "wood",
  uses: [...SCREWS, "wood_insert"],
  fit: (i) => {
    const { thread, reason } = pickThread(i);
    if (!familyDims("wood_insert", thread)) return `no ${thread} wood insert stocked (${Object.keys(CATALOG.families.wood_insert!.dims).join(", ")})`;
    const skin = skinOf(i);
    const insL = standardLengths("wood_insert", thread).find((l) => l >= 1.5 * majorDiameter(thread) && l + skin <= i.wallB);
    if (insL === undefined) return `wallB ${mm(i.wallB)} < a ${thread} wood insert ${mm(1.5 * majorDiameter(thread))}+ long + ${skin} behind it`;
    const h = pickHead(i, thread, { recessed: true });
    if (typeof h === "string") return h;
    // Through most of the insert; past it the pilot runs on, short of the skin.
    const window = { min: [1, 0, h.offset + 0.75 * insL] as Lin, max: [1, 1, h.offset - skin - 0.5] as Lin };
    const L = screwLength(i, thread, h, window);
    if (typeof L === "string") return L;
    return decision("W6", "insert", `${thread}×${L} ${h.head} into a ${thread}×${insL} wood insert`, [
      `wood b, ${i.intent}: a hex-drive threaded insert screwed into its pilot, never a tapped or heat-set thread`, reason, h.reason,
    ], {
      thread, head: h.head,
      parts: [screwPart(thread, h, L), { role: "insert", family: "wood_insert", key: thread, length: insL }], window,
      dims: { recess: h.recess, offset: h.offset, insertLength: insL, pocketDepth: r2(L - h.clamp + 0.5) },
    });
  },
};

/** R8: a threaded-rod stud, half threaded into each part (a leg screwed onto
 *  a top or a frame). Only as stated. The shortest stocked length that
 *  engages each side the material's minimum and leaves the skin behind. */
const R8: JointRule = {
  id: "R8",
  when: (i) => fastens(i) && i.prefer?.family === "threaded_rod",
  can: fastens,
  uses: ["threaded_rod"],
  fit: (i) => {
    const { thread, reason } = pickThread(i);
    if (!familyDims("threaded_rod", thread)) return `no ${thread} threaded rod stocked`;
    const spec = threadSpec(thread)!;
    const engageIn = (process: JointProcess, material?: string) =>
      isWood(material) ? 2 * majorDiameter(thread) : process === "CNC" ? spec.engagementMin[(material ?? "").toLowerCase().includes("steel") ? "steel" : "aluminum"]! : spec.engagementMin.fdm!;
    const engage = Math.max(engageIn(i.processA, i.materialA), engageIn(i.processB, i.materialB));
    const skin = skinOf(i);
    const L = standardLengths("threaded_rod", thread).find((l) => l / 2 >= engage && l / 2 + 1 + skin <= Math.min(i.wallA, i.wallB));
    if (L === undefined) return `walls ${mm(i.wallA)}/${mm(i.wallB)}: no stocked ${thread} rod engages ${mm(engage)} into both with ${skin} left behind`;
    return decision("R8", "stud", `${thread}×${L} threaded-rod stud, half in each part`, [`threaded rod as stated, ${L / 2}mm into each part's tapped hole (≥ ${mm(engage)} engaged)`, reason], {
      thread, parts: [{ role: "stud", family: "threaded_rod", key: thread, length: L }],
      dims: { d: majorDiameter(thread), length: L, depth: L / 2 + 1 },
    });
  },
};

// ---------- Motion ----------

const revolute = (i: JointInput) => i.motion === "revolute";
/** Pin or bushing Ø by load, unless hinted or stated. */
const PIVOT_D = { none: 3, light: 5, medium: 8, heavy: 10 };

/** A pivot that moves now and then (an idler arm, a latch, a lid) turns on a
 *  pin or bushings up to a medium load; rolling bearings are for continuous
 *  duty or a heavy load. */
const casual = (i: JointInput) => (i.duty ?? "occasional") === "occasional" && !atLeast(i.load, "heavy");

/** Shaft Ø from the load, unless hinted. */
const shaftFor = (i: JointInput) => {
  const bore = (family: string) => {
    const key = statedKey(i, family);
    return key ? dim(familyDims(family, key)!, "bore") : undefined;
  };
  const pin = statedKey(i, "shaft");
  return i.shaftHint ?? bore("bearing") ?? bore("bearing_flanged") ?? bore("bushing") ?? (pin ? Number(pin) : undefined) ?? { none: 5, light: 5, medium: 8, heavy: 10 }[i.load];
};

/** Retention: a set-screw collar where one is stocked, else an e-clip (which
 *  needs a grooved shaft, so the shaft becomes a fabricated part). */
function retention(d: number): HardwarePick & { note: string } {
  const collar = canonicalKey("collar", String(d));
  if (collar) return { role: "collar", family: "collar", key: collar, note: `Ø${d} set-screw collars, one outside each bearing` };
  const clip = Object.entries(CATALOG.families.eclip!.dims).find(([, r]) => Number(r.shaftMin) <= d && d <= Number(r.shaftMax));
  return { role: "eclip", family: "eclip", key: clip?.[0] ?? "", note: `no Ø${d} collar stocked: e-clips in shaft grooves (the shaft is fabricated)` };
}

/** A shaft that carries a hub, with a D-flat where one is stocked so the hub
 *  turns with it. */
function shaftPart(d: number): (HardwarePick & { note: string }) | string {
  const key = canonicalKey("d_shaft", String(d));
  if (key) return { role: "shaft", family: "d_shaft", key, note: `Ø${d} D-shaft so the hub turns with it` };
  const round = canonicalKey("shaft", String(d));
  if (!round) return `no Ø${d} shaft stocked (give a shaftHint the catalog carries)`;
  return { role: "shaft", family: "shaft", key: round, note: `no Ø${d} D-shaft stocked: round shaft, the hub needs its own set screw` };
}

interface Spindle {
  d: number;
  key: string;
  od: number;
  width: number;
  /** The flange's width when the brief states flanged bearings, else 0. */
  flange: number;
  keep: HardwarePick;
  parts: HardwarePick[];
  reasons: string[];
}

/** Two deep-groove bearings, one in each face of a, a shaft through them
 *  fixed in b's hub, a collar outside each. Largest OD first (the higher
 *  rating), stepping down while two bearings and a shoulder do not fit wallA.
 *  Flanged ones when the brief states them, each flange on its face. */
function spindleFor(i: JointInput, one = false): Spindle | string {
  const d = shaftFor(i);
  const mw = minWallA(i);
  const past = pastA(i);
  if (past) return past;
  const family = i.prefer?.family === "bearing_flanged" ? "bearing_flanged" : "bearing";
  const stated = statedKey(i, family);
  const all = Object.entries(CATALOG.families[family]!.dims).filter(([k, r]) => r.bore === d && (!stated || k === stated));
  if (stated && all.length === 0) return `bearing ${stated} has a Ø${n(family, stated, "bore")} bore, not the Ø${d} shaft`;
  const candidates = all
    .filter(([, r]) => i.roomA === undefined || dim(r, "od") + 2 * mw <= i.roomA)
    .sort((a, b) => dim(b[1], "od") - dim(a[1], "od"));
  if (all.length === 0) return `no deep-groove bearing with a Ø${d} bore`;
  if (candidates.length === 0) return `room around the axis in a Ø${mm(i.roomA!)} < bearing OD ${mm(Math.min(...all.map(([, r]) => dim(r, "od"))))} + 2 × ${mw}`;
  const count = one ? 1 : 2;
  const fits = candidates.find(([, r]) => i.wallA >= count * dim(r, "width") + mw);
  if (!fits) {
    const w = Math.min(...candidates.map(([, r]) => dim(r, "width")));
    return `wallA ${mm(i.wallA)} < ${one ? "" : "2 × "}bearing width ${mm(w)} + ${mw}`;
  }
  if (i.wallB < d) return `wallB ${mm(i.wallB)} < hub engagement Ø${d}`;
  const [key, row] = fits;
  const shaft = shaftPart(d);
  if (typeof shaft === "string") return shaft;
  const keep = retention(d);
  if (!keep.key) return `no collar or e-clip for a Ø${d} shaft`;
  return {
    d, key, od: dim(row, "od"), width: dim(row, "width"), flange: family === "bearing_flanged" ? dim(row, "flangeW") : 0, keep,
    parts: [
      { role: "bearing_a", family, key },
      ...(one ? [] : [{ role: "bearing_b", family, key }]),
      { role: shaft.role, family: shaft.family, key: shaft.key },
      { role: keep.role, family: keep.family, key: keep.key },
    ],
    reasons: [
      `Ø${d} shaft for a ${i.load} load${i.shaftHint ? " (hinted)" : ""}`,
      one ? `${key}: the largest-OD Ø${d} bearing that fits in wallA ${mm(i.wallA)}` : `${key}: the largest-OD Ø${d} bearing that fits twice in wallA ${mm(i.wallA)}`,
      one ? "one bearing here, its partner in b's other support: the pair takes the moment" : "two bearings: one cannot take a moment load",
      shaft.note,
      keep.note,
    ],
  };
}

/** The spindles seat their second bearing or bushing wallA behind a.port, so
 *  a wall longer than a's material there mints a seat outside the part (a
 *  hinge declaring its whole 40mm leaf as wallA from a middle knuckle face). */
function pastA(i: JointInput): string | undefined {
  if (i.depthA !== undefined && i.wallA > i.depthA + 0.5)
    return `wallA ${mm(i.wallA)} runs past a: its envelope holds only ${mm(i.depthA)} behind a.port along the axis`;
  return undefined;
}

const M1: JointRule = {
  id: "M1",
  when: (i) => revolute(i) && !i.driven && !casual(i),
  can: (i) => revolute(i) && !i.driven,
  uses: [...SPINDLE, "bearing_flanged"],
  fit: (i) => {
    const s = spindleFor(i);
    if (typeof s === "string") return s;
    return decision("M1", "bearings", `Ø${s.d} shaft on 2×${s.key} bearings`, [
      `revolute, ${i.duty === "continuous" ? "continuous" : `${i.load} load`}: rolling bearings`,
      ...s.reasons,
    ], { parts: s.parts, dims: { d: s.d, od: s.od, width: s.width } });
  },
};

/** Bearings in b, on an axle fixed in a: a V-wheel or roller on a thin plate,
 *  where M1's two seats in a do not fit (real-linear-actuator: 625s in the
 *  wheel, a 3mm gantry plate). Only when a is thinner than the axle; the
 *  axle is pressed into a at least half its Ø; a collar past b's far face
 *  keeps b on it. */
const M1h: JointRule = {
  id: "M1h",
  // Only for a plate thinner than the axle: anything thicker takes M1's seats.
  when: (i) => revolute(i) && !i.driven && !casual(i) && i.wallA < shaftFor(i),
  can: (i) => revolute(i) && !i.driven && i.wallA < shaftFor(i),
  uses: SPINDLE,
  fit: (i) => {
    if (i.bBuiltIn !== undefined) {
      // A catalog V-wheel carries its own two 625s: the axle through them
      // into a and a keeper past b are all it needs (real-linear-actuator cut
      // bearing pockets into the catalog wheel, which takes no features).
      const d = i.bBuiltIn;
      const shaft = shaftPart(d);
      if (typeof shaft === "string") return shaft;
      if (i.wallA < d / 2) return `wallA ${mm(i.wallA)} < axle socket ${mm(d / 2)} (half its Ø)`;
      const keep = retention(d);
      if (!keep.key) return `no collar or e-clip for a Ø${d} axle`;
      return decision("M1h", "hub_bearings", `Ø${d} axle through b's own bearings, fixed in a`, [
        "revolute: b is a catalog wheel with its bearings built in", shaft.note, keep.note,
      ], { parts: [{ role: "axle_shaft", family: shaft.family, key: shaft.key }, { role: "axle_collar", family: keep.family, key: keep.key }].map((p) => (keep.role === "eclip" && p.role === "axle_collar" ? { ...p, role: "axle_eclip" } : p)), dims: { d, od: 0, width: 0, builtIn: 1 } });
    }
    const inB = { ...i, wallA: i.wallB, wallB: Infinity, minWallA: minWallOf(i), roomA: undefined, depthA: undefined };
    const two = spindleFor(inB);
    // A wheel too thin for two takes one, at its far face, when the load is
    // light: a spool holder's 30mm gear on one 608 (real-spool-holder), the
    // way the product is built. The axle carries the moment in a.
    const light = i.load === "none" || i.load === "light";
    const s = typeof two === "string" && light && !i.pairedB ? spindleFor(inB, true) : two;
    if (typeof s === "string") return (typeof two === "string" ? two : s).replace("wallA", "wallB").replace(" in a ", " in b ");
    if (i.wallA < s.d / 2) return `wallA ${mm(i.wallA)} < axle socket ${mm(s.d / 2)} (half its Ø)`;
    const one = s !== two;
    const role: Record<string, string> = one ? { bearing_a: "hub_bearing_b" } : { bearing_a: "hub_bearing_a", bearing_b: "hub_bearing_b" };
    return decision("M1h", "hub_bearings", `${one ? "one" : "2×"}${one ? ` ${s.key} bearing` : `${s.key} bearings`} in b on a Ø${s.d} axle fixed in a`, [
      `revolute, ${i.duty === "continuous" ? "continuous" : `${i.load} load`}: rolling bearings, seated in b because a is too thin for two`,
      ...(one
        ? [`Ø${s.d} axle for a ${i.load} load`, `${s.key}: one, at b's far face: wallB ${mm(i.wallB)} holds one, not two; a light load, the axle takes the moment in a`, ...s.reasons.slice(3)]
        : s.reasons.map((r) => r.replace("wallA", "wallB"))),
    ], { parts: s.parts.map((p) => ({ ...p, role: role[p.role] ?? `axle_${p.role}` })), dims: { d: s.d, od: s.od, width: s.width } });
  },
};

/** M1p: a shaft spanning two supports (a winch drum between 6mm side
 *  plates, a roller): one deep-groove bearing in each, a collar either side
 *  of each one's wall. M1's two bearings per wall need 2·w + minWall (15.2
 *  for a 608), which a stated 6mm plate never holds. Needs b's coaxial joint
 *  on its far support (`pairedB`); after M1, which is stiffer when it fits. */
const M1p: JointRule = {
  id: "M1p",
  when: (i) => revolute(i) && !i.driven && !casual(i) && !!i.pairedB,
  can: (i) => revolute(i) && !i.driven && !!i.pairedB,
  uses: SPINDLE,
  fit: (i) => {
    const s = spindleFor(i, true);
    if (typeof s === "string") return s;
    // Each side's shaft stops short of b's middle, where the other side's
    // starts: two full-depth shafts met inside the winch drum (G5 3077mm³).
    const engage = r2(Math.min(i.wallB, (i.pairSpan ?? Infinity) / 2 - 0.5));
    if (engage < s.d) return `b's faces ${mm(i.pairSpan!)} apart leave each shaft ${mm(engage)} of hub, under its Ø${s.d}`;
    return decision("M1p", "bearings", `Ø${s.d} shaft on one ${s.key} here, one in the far support`, [
      `revolute, b between two supports: one bearing in each`, ...s.reasons,
      ...(engage < i.wallB ? [`each shaft runs ${mm(engage)} into b, half its span`] : []),
    ], { parts: s.parts, dims: { d: s.d, od: s.od, width: s.width, ...(engage < i.wallB ? { engage } : {}) } });
  },
};

/** b turning between two supports, one flanged bearing in each (a pan-tilt
 *  cradle, a clevis): the bearing in a's face with its flange on the face, a
 *  washer on its inner race spacing b off the flange, a shaft from the
 *  bearing's foot fixed in b's hub. Each flange stops b moving toward its own
 *  support, so the pair holds b both ways with no collar; one alone does not,
 *  so the rule needs b's coaxial joint on its far side (`pairedB`). */
const M1f: JointRule = {
  id: "M1f",
  // Only as stated: unstated, M1's two bearings per support are stiffer.
  when: (i) => revolute(i) && !i.driven && !!i.pairedB && i.prefer?.family === "bearing_flanged",
  can: (i) => revolute(i) && !i.driven && !!i.pairedB,
  uses: ["bearing_flanged", "d_shaft", "shaft", "washer"],
  fit: (i) => {
    const d = shaftFor(i);
    const mw = minWallA(i);
    const past = pastA(i);
    if (past) return past;
    const stated = statedKey(i, "bearing_flanged");
    const all = Object.entries(CATALOG.families.bearing_flanged!.dims).filter(([k, r]) => r.bore === d && (!stated || k === stated));
    if (all.length === 0) return stated ? `flanged bearing ${stated} has a Ø${n("bearing_flanged", stated, "bore")} bore, not the Ø${d} shaft` : `no flanged bearing with a Ø${d} bore`;
    const roomy = all.filter(([, r]) => i.roomA === undefined || dim(r, "od") + 2 * mw <= i.roomA).sort((a, b) => dim(b[1], "od") - dim(a[1], "od"));
    if (roomy.length === 0) return `room around the axis in a Ø${mm(i.roomA!)} < flanged bearing OD ${mm(Math.min(...all.map(([, r]) => dim(r, "od"))))} + 2 × ${mw}`;
    const fits = roomy.find(([, r]) => i.wallA >= dim(r, "width") + mw);
    if (!fits) return `wallA ${mm(i.wallA)} < flanged bearing width ${mm(Math.min(...roomy.map(([, r]) => dim(r, "width"))))} + ${mw}`;
    if (i.wallB < d) return `wallB ${mm(i.wallB)} < hub engagement Ø${d}`;
    const [key, row] = fits;
    const shaft = shaftPart(d);
    if (typeof shaft === "string") return shaft;
    const washer = canonicalKey("washer", `M${d}`);
    if (!washer) return `no M${d} washer to space b off the flange`;
    return decision("M1f", "flanged_bearing", `Ø${d} shaft on a ${key} flanged bearing, its pair in the far support`, [
      `revolute, b between two supports: one flanged bearing in each, the flanges holding b axially`,
      `${key}${stated ? " as stated" : `: the largest-OD Ø${d} flanged bearing that fits wallA ${mm(i.wallA)}`}`,
      shaft.note,
      `an M${d} washer on the inner race keeps b off the flange`,
    ], {
      parts: [{ role: "bearing", family: "bearing_flanged", key }, { role: shaft.role, family: shaft.family, key: shaft.key }, { role: "spacer", family: "washer", key: washer }],
      dims: { d, od: dim(row, "od"), width: dim(row, "width"), flange: dim(row, "flangeW"), gap: n("washer", washer, "thickness") },
    });
  },
};

/** Occasional and light: a printed pin when allowed, else bronze bushings.
 *  The pin runs through b and an e-clip in a groove past b's far face keeps b
 *  on it. b goes on along the pin, so not when b sits between a's knuckles
 *  (`trappedB`: the folding phone stand's leaf could never reach its pin) —
 *  unless the two print in place, captive with no clip. */
const M2pin: JointRule = {
  id: "M2p",
  when: (i) => revolute(i) && !i.driven && (!!i.printInPlace || (casual(i) && !atLeast(i.load, "medium") && !!i.allowPrinted && !i.trappedB)),
  can: (i) => revolute(i) && !i.driven && (!!i.printInPlace || (!!i.allowPrinted && !i.trappedB)),
  uses: ["eclip"],
  fit: (i) => {
    const d = i.shaftHint ?? (i.load === "none" ? 4 : 5);
    if (i.wallB < d) return `wallB ${mm(i.wallB)} < printed pin engagement ${d}`;
    if (i.printInPlace) {
      return decision("M2p", "printed_pin", `print-in-place Ø${d} pin, captive`, [
        "revolute, print in place: the pin prints on a inside b's knuckle, no hardware",
        `Ø${r2(d + PRINT_IN_PLACE_GAP_MM)} bore: ${PRINT_IN_PLACE_GAP_MM}mm on the Ø so the two prints separate`,
      ], { dims: { d, bore: r2(d + PRINT_IN_PLACE_GAP_MM), length: r2(i.wallB) } });
    }
    const clip = Object.entries(CATALOG.families.eclip!.dims).find(([, r]) => Number(r.shaftMin) <= d && d <= Number(r.shaftMax));
    if (!clip) return `no e-clip for a Ø${d} pin`;
    const [key, row] = clip;
    const gw = dim(row, "grooveWidth");
    return decision("M2p", "printed_pin", `printed Ø${d} pin pivot, e-clipped`, [
      "revolute, occasional, light, printed allowed: a pin printed on a",
      `a DIN 6799 ${key} e-clip in a groove just past b's far face keeps b on the pin`,
    ], {
      parts: [{ role: "pin_clip", family: "eclip", key }],
      dims: { d, bore: r2(d + FDM_SLIP_FIT_MM), length: r2(i.wallB + gw + 0.5), groove: dim(row, "groove"), grooveWidth: gw },
    });
  },
};

/** Occasional and light, walls too thin for bushings (or no printed pin): a
 *  separate ISO 2338 pin pressed 1.5·d or more into a and turning in b's bore
 *  at the slip band. The longest stocked pin both walls hold, from the
 *  largest Ø at or under the load's (or the hinted one). When a already
 *  declares a slip bore for a stocked pin on the axis, the pin turns in a too:
 *  a press hole there would be a second, smaller hole on the same axis. */
const M2d: JointRule = {
  id: "M2d",
  when: (i) => revolute(i) && !i.driven && casual(i),
  can: (i) => revolute(i) && !i.driven,
  uses: ["dowel", "filament_pin", "wire_nail"],
  fit: (raw) => {
    // A pin can only go as deep into a as a's material runs behind the face
    // (real-folding-phone-stand: wallA 36.7 declared, 25.8 of plate there, a
    // 31.7mm hole no code could cut).
    const i = raw.depthA !== undefined && raw.depthA < raw.wallA ? { ...raw, wallA: raw.depthA } : raw;
    // An axle nail, when stated (a pinewood car's wheels): its shank tip is
    // pressed into a, the shank runs right through b, and the head sits just
    // past b's outer face, holding b on. DIN 1151 lengths only.
    const nail = statedKey(i, "wire_nail") ?? (i.prefer?.family === "wire_nail" ? "" : undefined);
    if (nail !== undefined) {
      const keys = Object.keys(CATALOG.families.wire_nail!.dims).map(Number).filter((d) => (nail ? String(d) === nail || Number(nail) === d : d <= (i.shaftHint ?? PIVOT_D[i.load]))).sort((a, b) => b - a);
      const tried: string[] = [];
      for (const d of keys) {
        const key = canonicalKey("wire_nail", String(d))!;
        for (const L of [...standardLengths("wire_nail", key)].sort((a, b) => a - b)) {
          // b turns freely on the shank with up to 2mm of end play under the head.
          const run = r2(Math.max(i.wallB + 0.5, L - i.wallA));
          const press = r2(L - run);
          if (run - i.wallB > 2.5 || press < 1.5 * d) {
            tried.push(`Ø${d}×${L}: ${press < 1.5 * d ? `presses only ${mm(press)} into a` : `leaves ${mm(run - i.wallB)} of play past b`}`);
            continue;
          }
          return decision("M2d", "pin", `Ø${d}×${L} axle nail pressed into a, b turning on its shank`, [
            `revolute, occasional, ${i.load}: an axle nail, as stated`,
            `${L}mm: ${press}mm pressed into a (wallA ${mm(i.wallA)}), ${run}mm through b and its end play`,
          ], { parts: [{ role: "pin", family: "wire_nail", key, length: L }], dims: { d, length: L, press, run } });
        }
      }
      return `stated axle nail: ${tried.join("; ") || "no DIN 1151 size fits"}; wallA is how deep a's material runs behind its face for the nail`;
    }
    // Filament stock when stated, or hinted at a Ø only filament comes in (1.75).
    const stockOf = (f: string) => Object.keys(CATALOG.families[f]!.dims).map(Number);
    const family = statedKey(i, "filament_pin") || (i.shaftHint !== undefined && !stockOf("dowel").includes(i.shaftHint) && stockOf("filament_pin").includes(i.shaftHint)) ? "filament_pin" : "dowel";
    const stated = statedKey(i, family);
    const preferred = i.shaftHint ?? (stated ? Number(stated) : PIVOT_D[i.load]);
    const stocked = stockOf(family);
    const loose = stocked.find((d) => i.boreA !== undefined && i.boreA > d && i.boreA - d <= FDM_SLIP_FIT_MM && (i.shaftHint ?? d) === d);
    if (loose !== undefined && i.wallA >= loose && i.wallB >= loose) {
      const key = canonicalKey(family, String(loose))!;
      const L = [...standardLengths(family, key)].reverse().find((l) => l >= 2 * loose && l <= i.wallA + i.wallB);
      if (L !== undefined) {
        const run = r2(Math.min(i.wallB, L - loose));
        return decision("M2d", "pin", `Ø${loose}×${L} loose pin, turning in a and b`, [
          `revolute, occasional, ${i.load}: a separate pin, no bushings`,
          `a already declares a Ø${i.boreA} bore on the axis, a slip bore for a Ø${loose} pin: the pin turns in a as in b (a loose-pin hinge; cap or peen its ends to keep it)`,
          `${L}mm: the longest stocked that stays inside a ${mm(i.wallA)} + b ${mm(i.wallB)}`,
        ], { parts: [{ role: "pin", family, key, length: L }], dims: { d: loose, length: L, press: r2(L - run), run, slipA: 1 } });
      }
    }
    const sizes = i.shaftHint || stated ? stocked.filter((d) => d === preferred) : stocked.filter((d) => d <= preferred).sort((a, b) => b - a);
    if (sizes.length === 0) return `no Ø${preferred} pin stocked`;
    for (const d of sizes) {
      if (i.wallA < 1.5 * d || i.wallB < d) continue;
      const key = canonicalKey(family, String(d))!;
      const L = [...standardLengths(family, key)].reverse().find((l) => l >= 2.5 * d && l <= i.wallA + i.wallB);
      if (L === undefined) continue;
      const run = r2(Math.min(i.wallB, L - 1.5 * d));
      return decision("M2d", "pin", `Ø${d}×${L} pin pressed in a, turning in b`, [
        `revolute, occasional, ${i.load}: a separate pin, no bushings`,
        `Ø${d}: the largest${i.shaftHint ? " (hinted)" : ` at or under the ${i.load}-load Ø${preferred}`} pressed 1.5·d into a and bearing d in b`,
        `${L}mm: the longest stocked that stays inside a ${mm(i.wallA)} + b ${mm(i.wallB)}`,
      ], { parts: [{ role: "pin", family, key, length: L }], dims: { d, length: L, press: r2(L - run), run } });
    }
    return `walls ${mm(i.wallA)}/${mm(i.wallB)}: no Ø${sizes.join("/Ø")} pin presses 1.5·d into a and bears d in b on a stocked length`;
  },
};

const M2: JointRule = {
  id: "M2",
  when: (i) => revolute(i) && !i.driven && casual(i),
  can: (i) => revolute(i) && !i.driven,
  uses: ["bushing", "d_shaft", "shaft", "collar", "eclip"],
  fit: (i) => {
    const stated = statedKey(i, "bushing");
    const d = i.shaftHint ?? (stated ? dim(familyDims("bushing", stated)!, "bore") : Number(statedKey(i, "shaft") ?? PIVOT_D[i.load]));
    const mw = minWallA(i);
    const fam = CATALOG.families.bushing!;
    const key = Object.keys(fam.dims).find((k) => fam.dims[k]!.bore === d && (!stated || k === stated));
    if (!key) return `no bushing with a Ø${d} bore`;
    const past = pastA(i);
    if (past) return past;
    if (i.roomA !== undefined && dim(fam.dims[key]!, "od") + 2 * mw > i.roomA)
      return `room around the axis in a Ø${mm(i.roomA)} < bushing OD ${mm(dim(fam.dims[key]!, "od"))} + 2 × ${mw}`;
    const length = [...(fam.lengths?.[key] ?? [])].reverse().find((l) => 2 * l + mw <= i.wallA);
    if (length === undefined) return `wallA ${mm(i.wallA)} < 2 × bushing ${Math.min(...(fam.lengths?.[key] ?? [0]))} + ${mw}`;
    if (i.wallB < d) return `wallB ${mm(i.wallB)} < hub engagement Ø${d}`;
    const shaft = shaftPart(d);
    if (typeof shaft === "string") return shaft;
    const keep = retention(d);
    if (!keep.key) return `no collar or e-clip for a Ø${d} shaft`;
    return decision("M2", "bushings", `Ø${d} shaft in 2×${key}×${length} bushings`, [
      `revolute, occasional, ${i.load}: plain bushings`, shaft.note, keep.note,
    ], {
      parts: [
        { role: "bushing_a", family: "bushing", key, length },
        { role: "bushing_b", family: "bushing", key, length },
        { role: shaft.role, family: shaft.family, key: shaft.key },
        { role: keep.role, family: keep.family, key: keep.key },
      ],
      dims: { d, od: dim(fam.dims[key]!, "od"), width: length },
    });
  },
};

/** Hobby and serial-bus servos by torque class: SG90 1.8, MG996R 11,
 *  STS3215 19.5 kg·cm (catalog `torqueKgCm`). */
const SERVO_BY_TORQUE = { low: ["sg90", "SG90"], medium: ["mg996r", "MG996R"], high: ["sts3215", "STS3215"] } as const;
const SERVOS: string[] = Object.values(SERVO_BY_TORQUE).map(([f]) => f);
/** Motors a brief may name for a direct drive, picked as stated. */
const STATED_DIRECT = [...SERVOS, "nema14"];

/** Which motor and how it couples: a servo for occasional low speed (by
 *  torque), N20 for continuous low speed and high torque, brushless for high
 *  speed, NEMA 17 when precise or in between. A heavy load never hangs on a
 *  motor's own bearings. A stated servo or NEMA 14 drives b directly. */
export function pickDrive(i: JointInput): { motor: HardwarePick; coupling: "direct" | "gt2" | "gear"; reason: string } {
  const speed = i.speedClass ?? "medium";
  const torque = i.torqueClass ?? "low";
  const motor = (family: string, key: string): HardwarePick => ({ role: "motor", family, key });
  const stated = i.prefer?.family;
  if (stated && STATED_DIRECT.includes(stated)) {
    const key = canonicalKey(stated, i.prefer?.key ?? "") ?? Object.keys(CATALOG.families[stated]!.dims)[0]!;
    return { motor: motor(stated, key), coupling: "direct", reason: `${key} as stated, direct` };
  }
  if (i.load === "heavy") return { motor: motor("nema17", "NEMA17"), coupling: "gear", reason: "heavy load: NEMA 17 through a gear pair, off the motor's bearings" };
  if ((i.ratio !== undefined && i.ratio !== 1) || i.centerMm !== undefined) {
    const asked = i.ratio !== undefined && i.ratio !== 1 ? `a ${i.ratio}:1 ratio` : "an offset motor";
    if (torque === "high" || speed === "low") return { motor: motor("nema17", "NEMA17"), coupling: "gear", reason: `${asked} at ${torque === "high" ? "high torque" : "low speed"}: NEMA 17 through a spur pair` };
    return { motor: motor("nema17", "NEMA17"), coupling: "gt2", reason: `${asked}: NEMA 17 through a GT2 belt` };
  }
  if (i.precise) return { motor: motor("nema17", "NEMA17"), coupling: "direct", reason: "precise: NEMA 17 stepper, direct" };
  if (speed === "high") return { motor: motor("brushless", torque === "low" ? "2204" : "2306"), coupling: "direct", reason: "high speed: brushless outrunner, direct" };
  if (speed === "low" && (i.duty ?? "occasional") === "occasional") {
    const [family, key] = SERVO_BY_TORQUE[torque];
    return { motor: motor(family, key), coupling: "direct", reason: `occasional, low speed, ${torque} torque: ${key} servo (${n(family, key, "torqueKgCm")} kg·cm), direct` };
  }
  if (speed === "low" && torque === "high") return { motor: motor("n20", "N20"), coupling: "direct", reason: "continuous low speed, high torque: N20 gearmotor, direct" };
  if (speed === "low") return { motor: motor("nema17", "NEMA17"), coupling: "gear", reason: "continuous low speed: NEMA 17 through a reduction" };
  return { motor: motor("nema17", "NEMA17"), coupling: "direct", reason: `${speed} speed: NEMA 17, direct` };
}

/** How far a motor's output reaches past its mounting face, mm. */
function motorReach(family: string, key: string): number {
  if (family === "nema17" || family === "nema14") return n(family, key, "shaftL");
  if (family === "n20") return n(family, key, "shaftL");
  if (family === "brushless") return n(family, key, "shaftL") - 0.5;
  return n(family, key, "splineH");
}

/** Driven revolute: the motor's own bearings carry b, so no shaft is added. */
const D1: JointRule = {
  id: "D1",
  when: (i) => revolute(i) && !!i.driven && pickDrive(i).coupling === "direct",
  uses: ["nema17", "brushless", "n20", ...STATED_DIRECT],
  fit: (i) => {
    const drive = pickDrive(i);
    const { family, key } = drive.motor;
    const out = n(family, key, SERVOS.includes(family) ? "splineD" : "shaftD");
    // A serial-bus servo with a screwed horn (STS3215): b's face bears on the
    // horn and four screws through b hold it; four M2s through a into the
    // case's pilots hold the servo. Nothing engages a hub.
    const row = familyDims(family, key)!;
    if (typeof row.hornPcd === "number") {
      return decision("D1", "direct_drive", `${key} driving b through its horn`, [
        `revolute, driven: ${drive.reason}`, "direct: the servo's own bearings carry b",
        `b screwed to the horn: 4×${row.hornThread} on PCD ${row.hornPcd}; the case screwed to a: 4×M2 into its pilots`,
      ], {
        parts: [drive.motor, { role: "case_screw", family: "shcs", key: "M2" }, { role: "horn_screw", family: "shcs", key: String(row.hornThread) }],
        dims: { d: out, engage: 0, through: 0 },
      });
    }
    const reach = motorReach(family, key);
    // NEMA and N20 mount under a with the shaft up through it; the brushless
    // and the servo sit on a's face with the output above it.
    const through = family === "nema17" || family === "nema14" || family === "n20" ? i.wallA + 1 : 0.5;
    const engage = Math.min(i.wallB, reach - through);
    if (engage < Math.min(out, 3)) return `${key} shaft ${mm(reach)} < ${through > 1 ? `wallA ${mm(i.wallA)} + 1 + ` : ""}hub engagement ${mm(Math.min(out, 3))}`;
    return decision("D1", "direct_drive", `${key} driving b directly`, [`revolute, driven: ${drive.reason}`, "direct: the motor's own bearings carry b"], {
      parts: [drive.motor],
      dims: { d: out, engage: r2(engage), through },
    });
  },
};

// ---------- Offset drives ----------

/** Every belt and gear drive puts a NEMA 17 under a, its shaft up through a
 *  beside the driven axis: the only stocked motor with a D-flat Ø5 shaft long
 *  enough to carry a pulley or a gear. */
const NEMA = "NEMA17";
const nema = (field: string) => n("nema17", NEMA, field);
const motorWall = (i: JointInput) => i.wallMotor ?? i.wallA;

/** Undefined when the motor shaft still grips an element of axial length
 *  `engage` sitting `z` above a's face, else why not and what wallMotor would. */
function motorGrip(i: JointInput, z: number, engage: number, what: string): string | undefined {
  const top = nema("shaftL") - motorWall(i);
  if (top - z >= engage - 1e-9) return undefined;
  return `the NEMA 17 shaft ends ${mm(top)} above a's face (a is ${mm(motorWall(i))} thick where the motor mounts), short of ${what} (${mm(z)} + ${mm(engage)}): mount the motor where a is at most ${mm(nema("shaftL") - z - engage)} thick (wallMotor)`;
}

export const gt2PitchD = (teeth: number) => (teeth * 2) / Math.PI;

/** Pitch length of a belt around two pulleys `c` apart, and its inverse. */
export const beltLength = (c: number, d1: number, d2: number) => 2 * c + (Math.PI * (d1 + d2)) / 2 + (d2 - d1) ** 2 / (4 * c);
export function beltCenter(length: number, d1: number, d2: number): number {
  const b = 2 * length - Math.PI * (d1 + d2);
  return (b + Math.sqrt(b * b - 8 * (d2 - d1) ** 2)) / 8;
}

/** The driven half of an offset drive: M1's spindle, with a washer on
 *  bearing_a's inner race where M1's upper collar was, so the driven pulley or
 *  gear on top of it turns clear of the outer race. No washer that size: the
 *  upper collar stays, as M1 has it. */
function drivenSpindle(i: JointInput): (Spindle & { spacer: HardwarePick; gap: number }) | string {
  const s = spindleFor(i);
  if (typeof s === "string") return s;
  const key = canonicalKey("washer", `M${s.d}`);
  if (key) return { ...s, spacer: { role: "spacer", family: "washer", key }, gap: s.flange + n("washer", key, "thickness") };
  if (s.keep.family !== "collar") return `no M${s.d} washer or collar to space the driven wheel off bearing_a`;
  return { ...s, spacer: { role: "spacer", family: "collar", key: s.keep.key }, gap: s.flange + n("collar", s.keep.key, "width") };
}

/** Motor axis to driven axis, least: the motor body (under a) clear of the
 *  housing round bearing_b and of the lower retention, and its pilot bore
 *  clear of bearing_a's seat. */
const motorClear = (s: Spindle, i: JointInput) =>
  Math.max(
    nema("face") / 2 + Math.max(n(s.keep.family, s.keep.key, "od") / 2, s.od / 2 + 2 * minWallA(i)) + 1,
    s.od / 2 + nema("pilotD") / 2 + 2 * minWallA(i),
  );

/** The stocked pulley pair nearest the ratio, smaller pulleys on a tie. */
function pulleyPair(ratio: number, motorBore: number, drivenBore: number): { m: string; d: string } | string {
  const rows = Object.entries(CATALOG.families.gt2_pulley!.dims);
  let best: { m: string; d: string; err: number; size: number } | undefined;
  for (const [mk, mr] of rows.filter(([, r]) => r.bore === motorBore)) {
    for (const [dk, dr] of rows.filter(([, r]) => r.bore === drivenBore)) {
      const err = Math.abs(dim(dr, "teeth") / dim(mr, "teeth") - ratio) / ratio;
      const size = dim(dr, "teeth") + dim(mr, "teeth");
      if (!best || err < best.err - 1e-9 || (Math.abs(err - best.err) < 1e-9 && size < best.size)) best = { m: mk, d: dk, err, size };
    }
  }
  if (!best) return `no GT2 pulleys with Ø${motorBore} and Ø${drivenBore} bores`;
  if (best.err > 0.05) return `ratio ${ratio}: the nearest stocked GT2 pair is ${best.m} → ${best.d}, ${(best.err * 100).toFixed(0)}% off`;
  return best;
}

/** Hub, flanges and rim of a pulley row, and the height of its rim's middle. */
export const pulleyHeight = (r: DimsRow) => (typeof r.hubL === "number" ? r.hubL : 0) + 2 * dim(r, "flangeW") + dim(r, "toothWidth");
export const rimMid = (r: DimsRow) => (typeof r.hubL === "number" ? r.hubL : 0) + dim(r, "flangeW") + dim(r, "toothWidth") / 2;

/** DB: an offset motor or a ratio at speed: two GT2 pulleys on a stocked
 *  closed loop. The loop length is snapped up to stock and the centre solved
 *  back from it, so the belt is at its pitch length on round motor holes.
 *  Tension beyond that needs a slotted mount, which no probe can verify yet. */
const DB: JointRule = {
  id: "DB",
  when: (i) => revolute(i) && !!i.driven && pickDrive(i).coupling === "gt2",
  can: (i) => revolute(i) && !!i.driven,
  uses: [...SPINDLE, "bearing_flanged", "washer", "nema17", "gt2_pulley", "gt2_loop"],
  fit: (i) => {
    const ratio = i.ratio ?? 1;
    const s = drivenSpindle(i);
    if (typeof s === "string") return s;
    const pair = pulleyPair(ratio, nema("shaftD"), s.d);
    if (typeof pair === "string") return pair;
    const [mr, dr] = [familyDims("gt2_pulley", pair.m)!, familyDims("gt2_pulley", pair.d)!];
    const [zm, zd] = [dim(mr, "teeth"), dim(dr, "teeth")];
    const [pm, pd] = [gt2PitchD(zm), gt2PitchD(zd)];
    const flanges = (dim(mr, "flangeD") + dim(dr, "flangeD")) / 2 + 2;
    const cMin = Math.max(motorClear(s, i), flanges, i.centerMm ?? 0);
    const L = pickLength("gt2_loop", "6", { min: beltLength(cMin, pm, pd) });
    if (L === undefined) return `centre ${mm(cMin)} needs a ${mm(beltLength(cMin, pm, pd))}mm GT2 loop, longer than any stocked (${standardLengths("gt2_loop", "6").join(", ")})`;
    const c = r2(beltCenter(L, pm, pd));
    if (i.centerMm !== undefined && c > i.centerMm + 5) return `the shortest stocked loop that fits (${L}mm) puts the motor ${mm(c)} off, past the ${mm(i.centerMm)} asked: ask for centerMm ${mm(c)} or leave it out`;
    const small = Math.min(zm, zd);
    const inMesh = (small * (Math.PI - 2 * Math.asin(Math.abs(pd - pm) / (2 * c)))) / (2 * Math.PI);
    if (inMesh < 6) return `${inMesh.toFixed(1)} teeth in mesh on the ${small}T pulley at centre ${mm(c)}, 6 needed: ask for a longer centerMm`;
    const zMotor = r2(s.gap + Math.max(0, rimMid(dr) - rimMid(mr)));
    const zDriven = r2(s.gap + Math.max(0, rimMid(mr) - rimMid(dr)));
    const grip = motorGrip(i, zMotor, dim(mr, "hubL"), `the ${zm}T pulley's hub`);
    if (grip) return grip;
    return decision("DB", "belt_drive", `NEMA 17, ${zm}T → ${zd}T GT2 on a ${L}mm loop at ${mm(c)}, Ø${s.d} shaft on 2×${s.key}`, [
      `revolute, driven: ${pickDrive(i).coupling === "gt2" ? pickDrive(i).reason : "a GT2 belt, as stated"}`,
      `ratio ${ratio}: ${zm}T on the motor, ${zd}T driven (${(zd / zm).toFixed(2)})`,
      `centre ${mm(c)}: the stocked ${L}mm loop's, at least ${mm(cMin)} (motor clear of the spindle, flanges apart${i.centerMm ? ", as asked" : ""})`,
      ...s.reasons,
      `${s.spacer.family === "washer" ? `an M${s.d} washer` : `a Ø${s.d} collar`} spaces the driven pulley off bearing_a`,
      "tension: the centre is solved for the loop's pitch length; the motor holes stay round",
    ], {
      parts: [
        ...s.parts, s.spacer,
        { role: "motor", family: "nema17", key: NEMA },
        { role: "motor_pulley", family: "gt2_pulley", key: pair.m },
        { role: "driven_pulley", family: "gt2_pulley", key: pair.d },
        { role: "belt", family: "gt2_loop", key: "6", length: L },
      ],
      dims: { d: s.d, od: s.od, width: s.width, center: c, gap: s.gap, zMotor, zDriven, zB: r2(zDriven + pulleyHeight(dr) + 1), teethMotor: zm, teethDriven: zd },
    });
  },
};

/** Teeth per gear: under 17 at 20° they undercut; the registry's involute
 *  builder (kernel gear.py) goes to 150. The search keeps to 41 first, so a
 *  bigger count never wins a smaller module: it only builds a ratio that
 *  needs more than 41 teeth at every module the load allows. */
export const GEAR_TEETH = [17, 150] as const;
const GEAR_TEETH_FIRST = 41;
/** Least module by load, stepping up the catalog's modules until a pair
 *  reaches the centre; the face width is 6 modules. */
const GEAR_MODULE = { none: 0.8, light: 1, medium: 1.5, heavy: 2 } as const;

/** DG: high torque, low speed, a heavy load, or a centre too short for a
 *  belt: a spur pair from the gear registry. Tooth counts from the ratio
 *  (within 2%), the centre m·(z1+z2)/2, nearest a requested centre or else
 *  the least that clears the motor. The motor gear is turned half a tooth when
 *  it has an even count, so a gap faces the driven gear's tooth on +x. */
const DG: JointRule = {
  id: "DG",
  when: (i) => revolute(i) && !!i.driven && pickDrive(i).coupling !== "direct",
  can: (i) => revolute(i) && !!i.driven,
  uses: [...SPINDLE, "bearing_flanged", "washer", "nema17", "spur_gear"],
  fit: (i) => {
    const drive = pickDrive(i);
    const ratio = i.ratio ?? (drive.coupling === "gear" ? 2 : 1);
    const s = drivenSpindle(i);
    if (typeof s === "string") return s;
    const cMin = motorClear(s, i);
    const modules = Object.values(CATALOG.families.spur_gear!.dims).map((r) => dim(r, "module")).filter((m) => m >= GEAR_MODULE[i.load]).sort((a, b) => a - b);
    let best: { m: number; zm: number; zd: number; c: number; score: number } | undefined;
    search: for (const cap of [GEAR_TEETH_FIRST, GEAR_TEETH[1]]) for (const m of modules) {
      const roots = (z: number, bore: number) => m * (z - 2.5) >= bore + 2 * Math.max(minWallOf(i), m);
      for (let zm = GEAR_TEETH[0]; zm <= cap; zm++) {
        const zd = Math.round(ratio * zm);
        if (zd < GEAR_TEETH[0] || zd > cap || Math.abs(zd / zm - ratio) / ratio > 0.02) continue;
        if (!roots(zm, nema("shaftD")) || !roots(zd, s.d)) continue;
        const c = (m * (zm + zd)) / 2;
        if (c < cMin) continue;
        const score = i.centerMm ? Math.abs(c - i.centerMm) : c;
        if (!best || score < best.score - 1e-9) best = { m, zm, zd, c, score };
      }
      if (best) break search;
    }
    if (!best) return `no pair of m${modules.join("/m")} gears with ${GEAR_TEETH.join("..")} teeth within 2% of ratio ${ratio} reaches centre ${mm(cMin)} (the motor clear of the spindle)`;
    const m = best.m;
    const t = r2(6 * m);
    const grip = motorGrip(i, s.gap, Math.min(t, 1.5 * nema("shaftD")), `the ${best.zm}T gear`);
    if (grip) return grip;
    const key = canonicalKey("spur_gear", `m${m}`)!;
    return decision("DG", "gear_drive", `NEMA 17, ${best.zm}T → ${best.zd}T m${m} spur pair at ${mm(best.c)}, Ø${s.d} shaft on 2×${s.key}`, [
      `revolute, driven: ${drive.coupling === "gear" ? drive.reason : i.prefer?.family === "spur_gear" ? "a spur pair, as stated" : "no stocked belt loop fits the centre asked: a spur pair"}`,
      `module ${m}, ${t}mm face: ${m === GEAR_MODULE[i.load] ? `the ${i.load} load's` : `the least whose pair reaches the motor's centre (a ${i.load} load needs m${GEAR_MODULE[i.load]})`}`,
      `ratio ${ratio}: ${best.zm}T on the motor, ${best.zd}T driven (${(best.zd / best.zm).toFixed(2)})`,
      `centre m·(z1+z2)/2 = ${mm(best.c)}${i.centerMm ? `, nearest the ${mm(i.centerMm)} asked` : `, the least clearing the motor (${mm(cMin)})`}`,
      ...s.reasons,
      `${s.spacer.family === "washer" ? `an M${s.d} washer` : `a Ø${s.d} collar`} spaces the driven gear off bearing_a`,
    ], {
      parts: [
        ...s.parts, s.spacer,
        { role: "motor", family: "nema17", key: NEMA },
        { role: "motor_gear", family: "spur_gear", key },
        { role: "driven_gear", family: "spur_gear", key },
      ],
      dims: {
        d: s.d, od: s.od, width: s.width, center: best.c, gap: s.gap, zMotor: s.gap, zDriven: s.gap, zB: r2(s.gap + t + 1),
        module: m, thickness: t, teethMotor: best.zm, teethDriven: best.zd, phase: best.zm % 2 === 0 ? r2(180 / best.zm) : 0,
      },
    });
  },
};

const prismatic = (i: JointInput) => i.motion === "prismatic";

/** Short and light: LM-UU on a rod held in a. */
const P1: JointRule = {
  id: "P1",
  when: (i) => prismatic(i) && !i.driven && (i.strokeMm ?? 50) <= 150 && !atLeast(i.load, "medium"),
  can: (i) => prismatic(i) && !i.driven,
  uses: ["shaft", "lm_uu"],
  fit: (i) => {
    if ((i.count ?? 1) > 1) return onePerJoint(i, "rod");
    const key = statedKey(i, "lm_uu") ?? (i.load === "none" ? "LM6UU" : "LM8UU");
    const lm = familyDims("lm_uu", key)!;
    const d = dim(lm, "bore");
    const mw = minWallOf(i);
    if (i.wallB < dim(lm, "length") + mw) return `wallB ${mm(i.wallB)} < ${key} ${mm(dim(lm, "length"))} + ${mw}`;
    if (i.wallA < d + minWallA(i)) return `wallA ${mm(i.wallA)} < rod socket ${d} + ${minWallA(i)}`;
    return decision("P1", "rod_slide", `${key} on a Ø${d} rod`, [`prismatic, stroke ${i.strokeMm ?? 50}, ${i.load} load: linear ball bushing on a rod`], {
      parts: [{ role: "rod", family: "shaft", key: canonicalKey("shaft", String(d))! }, { role: "linear_bearing", family: "lm_uu", key }],
      dims: { d, od: dim(lm, "od"), length: dim(lm, "length"), stroke: i.strokeMm ?? 50, socket: r2(i.wallA - minWallA(i)) },
    });
  },
};

/** Screws holding catalog hardware (a rail, an idler) to a: the fixed-joint
 *  rules pick them, with the hardware as the clamped part, so a printed a gets
 *  inserts and a machined one tapped holes, exactly as a bolted joint would.
 *  Only those two: a nut trap needs a's far side. `clamp` is the hardware
 *  under the head; the hardware has no counterbore to cut, so the head sits
 *  on it. */
function hardwareScrews(i: JointInput, thread: string, clamp: number, wallHost: number, load: JointInput["load"]): JointDecision | string {
  const input: JointInput = {
    intent: "removable", load, access: "one_side", wallA: r2(clamp), wallB: wallHost, processA: "CNC", processB: i.processA,
    materialB: i.materialA, minWall: minWallA(i), threadHint: thread, noRecess: true,
  };
  const shortfalls: string[] = [];
  for (const rule of JOINT_RULES.filter((r) => r.id === "R2" || r.id === "R4")) {
    if (!rule.when(input)) continue;
    const out = rule.fit(input);
    if (typeof out !== "string") return out;
    shortfalls.push(`${rule.id} ${out.replaceAll("wallB", "a's wall")}`);
  }
  return shortfalls.join("; ");
}

/** The rail's fixing screws: its mountThread at the catalog pitch, the head
 *  on the counterbore floor. */
export const railScrews = (i: JointInput, rail: string) => {
  const row = familyDims("mgn_rail", rail)!;
  return hardwareScrews(i, String(row.mountThread), dim(row, "height") - dim(row, "cboreDepth"), i.wallA, "light");
};

/** Screw positions along a rail of `length`, centred like its holes. */
export function railHoles(rail: string, length: number): number[] {
  const p = n("mgn_rail", rail, "pitch");
  const count = Math.max(1, Math.floor(length / p));
  return Array.from({ length: count }, (_, k) => r2((k - (count - 1) / 2) * p));
}

/** Rail, carriage and the rail's screws. */
function railFor(i: JointInput): { reasons: string[]; parts: HardwarePick[]; dims: Record<string, number> } | string {
  const rail = atLeast(i.load, "medium") ? "MGN12" : "MGN9";
  const car = `${rail}C`;
  const stroke = i.strokeMm ?? 50;
  const carL = n("mgn_carriage", car, "length");
  const L = pickLength("mgn_rail", rail, { min: stroke + carL });
  if (L === undefined) return `stroke ${stroke} + carriage ${carL} is longer than any stocked ${rail} rail`;
  const screws = railScrews(i, rail);
  if (typeof screws === "string") return `${rail} rail screws: ${screws}`;
  return {
    reasons: [`${rail}×${L}: the shortest stocked rail for stroke ${stroke} + carriage ${carL}`, `rail screws: ${railHoles(rail, L).length}× ${screws.summary}`],
    parts: [
      { role: "rail", family: "mgn_rail", key: rail, length: L },
      { role: "carriage", family: "mgn_carriage", key: car },
      ...screws.parts.map((p) => ({ ...p, role: `rail_${p.role}` })),
    ],
    dims: { stroke, railLength: L, carriage: carL },
  };
}

/** Slides do not pattern: `count` would mint every copy on one axis. */
const onePerJoint = (i: JointInput, what: string) => `one ${what} per joint, not count ${i.count}: declare a joint per ${what}, each on its own a.port and b.port`;

/** Long or loaded: a profile rail on a and a carriage under b. */
const P2: JointRule = {
  id: "P2",
  when: (i) => prismatic(i) && !i.driven,
  uses: ["mgn_rail", "mgn_carriage", ...SCREWS, "heatset_std", "heatset_short"],
  fit: (i) => {
    if ((i.count ?? 1) > 1) return onePerJoint(i, "rail");
    const r = railFor(i);
    if (typeof r === "string") return r;
    const [rail, car] = [r.parts[0]!, r.parts[1]!];
    return decision("P2", "rail", `${rail.key}×${rail.length} rail and ${car.key}`, [`prismatic, stroke ${r.dims.stroke}, ${i.load} load: profile rail`, ...r.reasons], {
      parts: r.parts, dims: r.dims,
    });
  },
};

/** PL: a driven slide, short and not fast: a T8 lead screw on a NEMA 17
 *  through a coupler, its flanged nut in b, and an Ø8 rod through an LM8UU
 *  beside it so b cannot turn with the screw. The axis is a's face normal. */
const PL: JointRule = {
  id: "PL",
  when: (i) => prismatic(i) && !!i.driven && (i.speedClass ?? "medium") !== "high" && (i.strokeMm ?? 50) <= 300,
  can: (i) => prismatic(i) && !!i.driven,
  uses: ["nema17", "coupler", "lead_screw", "lead_nut", "shaft", "lm_uu"],
  fit: (i) => {
    const stroke = i.strokeMm ?? 50;
    const mw = minWallOf(i);
    const [cp, nut, lm] = [familyDims("coupler", "5x8")!, familyDims("lead_nut", "T8")!, familyDims("lm_uu", "LM8UU")!];
    // The motor sits on the screw's axis, under a.port: a's wall there is
    // wallA. A wallMotor thicker than that is an offset drive's, not this.
    const onAxis = { ...i, wallMotor: Math.min(i.wallMotor ?? i.wallA, i.wallA) };
    // The coupler sits 1mm off a's face, or higher, centred on the shaft's
    // tip, when a is thin enough that the shaft would run past its middle
    // into the screw (asm-lead-screw-lift's 8mm base: G5, 46mm³).
    const gap = r2(Math.max(1, nema("shaftL") - motorWall(onAxis) + 0.5 - dim(cp, "length") / 2));
    const grip = motorGrip(onAxis, gap, 0.4 * dim(cp, "length"), "the coupler's lower bore");
    if (grip) return grip;
    // A platform thinner than the LM8UU (the brief's 8mm) keeps its wall and
    // grows a boss under it, toward a, round the bearing.
    const lmBoss = i.guided ? 0 : r2(Math.max(0, dim(lm, "length") + mw - i.wallB));
    const lmBossD = r2(dim(lm, "od") + 2 * (mw + 2));
    // An end plate too thin for the guide rod's socket (the brief's 3mm)
    // keeps its wall and grows a boss on its face round the socket instead.
    const boss = i.guided ? 0 : r2(Math.max(0, 8 + minWallA(i) - i.wallA));
    const z0 = r2(gap + dim(cp, "length") + dim(nut, "flangeT") + 1);
    const screwStart = r2(gap + dim(cp, "length") / 2);
    const need = z0 - screwStart + stroke + i.wallB;
    const L = pickLength("lead_screw", "T8", { min: need });
    if (L === undefined) return `stroke ${stroke} needs a ${mm(need)}mm T8 screw, longer than any stocked`;
    const guide = Math.ceil(Math.max(dim(nut, "flangeD") / 2 + dim(lm, "od") / 2, nema("pilotD") / 2 + 4, lmBoss ? dim(cp, "od") / 2 + lmBossD / 2 + 1 : 0) + mw);
    if (lmBoss && z0 - lmBoss < boss + 1) return `wallB ${mm(i.wallB)}: the LM8UU's ${mm(lmBoss)} boss under b would reach a at stroke 0 (b sits ${mm(z0)} up)`;
    return decision("PL", "lead_screw", `T8×${L} lead screw from a NEMA 17, nut in b${i.guided ? "" : `, Ø8 guide rod ${guide} off`}`, [
      `prismatic, driven, stroke ${stroke}, ${i.speedClass ?? "medium"} speed: lead screw`,
      "NEMA 17 under a, a 5→8 coupler, the screw standing from it",
      i.guided ? "b already rides its own guide (wheels or a carriage), which stops it turning with the screw: no guide rod" : `an Ø8 rod and LM8UU ${guide}mm off the screw stop b turning with it`,
      ...(boss ? [`wallA ${mm(i.wallA)} < the rod's socket 8 + ${minWallA(i)}: a Ø${mm(8 + 2 * (minWallA(i) + 2))} boss ${mm(boss)} tall on a's face holds it`] : []),
      ...(lmBoss ? [`wallB ${mm(i.wallB)} < LM8UU ${mm(dim(lm, "length"))} + ${mw}: a Ø${mm(lmBossD)} boss ${mm(lmBoss)} tall under b holds it`] : []),
    ], {
      parts: [
        { role: "motor", family: "nema17", key: NEMA },
        { role: "coupler", family: "coupler", key: "5x8" },
        { role: "lead_screw", family: "lead_screw", key: "T8", length: L },
        { role: "lead_nut", family: "lead_nut", key: "T8" },
        ...(i.guided ? [] : [{ role: "rod", family: "shaft", key: "8" }, { role: "linear_bearing", family: "lm_uu", key: "LM8UU" }]),
      ],
      dims: { stroke, gap, z0, guide, lead: n("lead_screw", "T8", "lead"), screwStart, socket: r2(i.wallA + boss - minWallA(i)), boss, bossD: r2(8 + 2 * (minWallA(i) + 2)), lmBoss, lmBossD, od: dim(lm, "od"), length: dim(lm, "length") },
    });
  },
};

/** The idler's screw: through a washer and the idler into a boss on a. */
export function idlerScrews(i: JointInput, boss: number) {
  const [w, idl] = [familyDims("washer", "M5")!, familyDims("gt2_idler", "20T-5")!];
  return hardwareScrews(i, "M5", dim(w, "thickness") + pulleyHeight(idl), boss + i.wallA, "medium");
}

/** PB: a driven slide, long or fast: PB's rail, a NEMA 17 at one end and an
 *  idler at the other, an open GT2 belt round them that b clamps in a slot.
 *  The belt runs beside the carriage, at the motor pulley's rim height. */
const PB: JointRule = {
  id: "PB",
  when: (i) => prismatic(i) && !!i.driven,
  uses: ["mgn_rail", "mgn_carriage", ...SCREWS, "heatset_std", "heatset_short", "nema17", "gt2_pulley", "gt2_idler", "washer", "gt2_belt"],
  fit: (i) => {
    const r = railFor(i);
    if (typeof r === "string") return r;
    const [pul, idl, w] = [familyDims("gt2_pulley", "20T-5")!, familyDims("gt2_idler", "20T-5")!, familyDims("washer", "M5")!];
    const belt = familyDims("gt2_belt", "6")!;
    const gap = 1;
    const grip = motorGrip(i, gap, dim(pul, "hubL"), "the 20T pulley's hub");
    if (grip) return grip;
    const rim = gap + rimMid(pul);
    const boss = r2(rim - rimMid(idl) - dim(w, "thickness"));
    const screws = idlerScrews(i, boss);
    if (typeof screws === "string") return `idler screw: ${screws}`;
    const car = familyDims("mgn_carriage", r.parts[1]!.key)!;
    const x = r2(r.dims.railLength! / 2 + nema("face") / 2 + 2);
    const tip = gt2TipD(20);
    const y = r2(dim(car, "width") / 2 + 2 + dim(belt, "thickness") + tip / 2);
    const need = beltLength(2 * x, gt2PitchD(20), gt2PitchD(20));
    const length = Math.ceil(need / 2) * 2;
    if (pickLength("gt2_belt", "6", { min: length }) === undefined) return `a ${length}mm belt is longer than any stocked GT2 roll`;
    return decision("PB", "belt_carriage", `GT2 belt from a NEMA 17 round an idler, ${r.parts[0]!.key} rail`, [
      `prismatic, driven, stroke ${r.dims.stroke}, ${i.speedClass ?? "medium"} speed: belt-driven carriage`,
      ...r.reasons,
      `motor and idler ${x}mm either side of the rail's middle, the belt ${y}mm beside it`,
      `idler on a ${boss}mm boss: ${screws.summary}`,
    ], {
      parts: [
        ...r.parts,
        { role: "motor", family: "nema17", key: NEMA },
        { role: "motor_pulley", family: "gt2_pulley", key: "20T-5" },
        { role: "idler", family: "gt2_idler", key: "20T-5" },
        { role: "idler_washer", family: "washer", key: "M5" },
        ...screws.parts.map((p) => ({ ...p, role: `idler_${p.role}` })),
        { role: "belt", family: "gt2_belt", key: "6", length },
      ],
      dims: {
        ...r.dims, gap, drive: x, beltY: y, rim: r2(rim), boss,
        slotDepth: r2(rim + dim(belt, "width") / 2 + 0.5 - dim(car, "height")),
      },
    });
  },
};

/** First fit wins. Motion rules come first: a revolute joint is never bolted. */
export const JOINT_RULES: JointRule[] = [D1, DB, DG, M1f, M1, M1h, M1p, M2pin, M2, M2d, PL, PB, P1, P2, C1, W1, W2, W4, W5, W6, W3, R8, R1, R1b, R2, R3, R4, R7, R5, R6, R3f];

export function selectJoint(input: JointInput): JointDecision | { error: string } {
  const tag = input.id ? `${input.id}: ` : "";
  const p = input.prefer?.recipe || input.prefer?.family ? input.prefer : undefined;
  if (p) return selectStated(input, p, tag);
  // Printed assembled: no other rule's hardware could go in.
  if (input.printInPlace) {
    const out = revolute(input) ? M2pin.fit(input) : "printInPlace is for revolute joints";
    return typeof out === "string" ? { error: `${tag}print in place: ${out}` } : out;
  }
  const shortfalls: string[] = [];
  for (const rule of JOINT_RULES) {
    if (!rule.when(input)) continue;
    const out = rule.fit(input);
    if (typeof out !== "string") return out;
    shortfalls.push(`${rule.id} ${out}`);
  }
  if (shortfalls.length === 0) {
    return { error: `${tag}no joint rule covers ${input.motion ?? "fixed"} / ${input.intent} / ${input.load} / ${input.access} on ${input.processB}` };
  }
  return { error: `${tag}${shortfalls.join("; ")}` };
}

/** "R3", "bearing 608": what the brief named. */
export const statedName = (p: NonNullable<CadJoint["prefer"]>) => [p.recipe, p.family, p.key].filter(Boolean).join(" ");

/** Whether a decision is the hardware the brief named. */
/** Families that are all "a plain pin of this Ø": a brief's "2.2mm axle"
 *  or "1.75mm pin" is whichever of them stocks that Ø. */
const PIN_LIKE = ["shaft", "d_shaft", "dowel", "filament_pin", "wire_nail"];

/** The stated part as the catalog knows it. A size written with its length
 *  ("confirmat 7x70", "M4x12") is the size; a pin-like Ø the stated family
 *  does not stock is the pin-like family that does (real-pinewood-car's
 *  "shaft 2.2" is a 2.2 axle nail; real-cube-shelf's "7x70" a 7mm confirmat). */
export function statedPrefer(p: NonNullable<CadJoint["prefer"]>): NonNullable<CadJoint["prefer"]> {
  if (!p.family || !p.key || !CATALOG.families[p.family] || canonicalKey(p.family, p.key)) return p;
  const size = /^(.+?)\s*[x×]\s*\d+(\.\d+)?$/i.exec(p.key)?.[1];
  if (size && canonicalKey(p.family, size)) return { ...p, key: size };
  if (PIN_LIKE.includes(p.family)) {
    const alt = PIN_LIKE.find((f) => f !== p.family && CATALOG.families[f] && canonicalKey(f, size ?? p.key!));
    if (alt) return { ...p, family: alt, key: size ?? p.key };
  }
  return p;
}

export function honours(d: JointDecision, raw: NonNullable<CadJoint["prefer"]>): boolean {
  const p = statedPrefer(raw);
  if (p.recipe && p.recipe !== d.rule && p.recipe !== d.recipe) return false;
  if (!p.family) return true;
  // A stated bearing is the wheel's own when b carries them built in (a
  // catalog V-wheel's two 625s): real-linear-actuator stated "bearing 625".
  if (d.dims.builtIn && sameFamily(p.family, "bearing")) return true;
  return d.parts.some((x) => sameFamily(p.family!, x.family) && (!p.key || x.key === canonicalKey(x.family, p.key)));
}

/** The brief named the hardware: only the rules that can use it are tried,
 *  and when none fits, the error says what the stated part needs. Never a
 *  substitute. */
function selectStated(input: JointInput, raw: NonNullable<CadJoint["prefer"]>, tag: string): JointDecision | { error: string } {
  let p = statedPrefer(raw);
  // b's own bearings serve a stated bearing: the rule picks only the axle.
  if (input.bBuiltIn !== undefined && p.family && sameFamily(p.family, "bearing")) p = { ...p, family: undefined, key: undefined };
  // The rules read the stated part from the input: give them the catalog's.
  if (p !== raw) input = { ...input, prefer: p };
  const say = `${tag}stated ${statedName(p)}`;
  if (p.family && !CATALOG.families[p.family]) return { error: `${say}: the catalog has no family "${p.family}" (${Object.keys(CATALOG.families).join(", ")})` };
  if (p.family && p.key && !canonicalKey(p.family, p.key)) return { error: `${say}: the catalog has no ${p.family} "${p.key}" (${Object.keys(CATALOG.families[p.family]!.dims).join(", ")})` };
  if (p.family && !JOINT_RULES.some((r) => r.uses.some((f) => sameFamily(p.family!, f)))) return { error: `${say}: no joint rule supports ${p.family} yet` };
  // Heat-set inserts melt into thermoplastics; wood takes a screw-in insert.
  if (p.family?.startsWith("heatset") && classB(input) === "wood") {
    return { error: `${say}: heat-set inserts are pressed into molten thermoplastic, and b (${input.materialB}) is wood: state wood_insert ${p.key ?? ""} (a hex-drive threaded insert for wood) instead`.replace(" )", ")") };
  }
  const byId = JOINT_RULES.some((r) => r.id === p.recipe);
  const shortfalls: string[] = [];
  const tried = new Set<JointRule["fit"]>();
  // The rules that would serve this joint anyway come first, in their usual
  // order (a light hinge pin stays a pin, not bearings); the stated part may
  // then reach past a rule's preferences (an FDM through-bolt).
  const order = [...JOINT_RULES.filter((r) => r.when(input)), ...JOINT_RULES.filter((r) => !r.when(input))];
  for (const rule of order) {
    if (tried.has(rule.fit) || !(rule.can ?? rule.when)(input)) continue;
    if ((byId && rule.id !== p.recipe) || (p.family && !rule.uses.some((f) => sameFamily(p.family!, f)))) continue;
    tried.add(rule.fit);
    const out = rule.fit(input);
    if (typeof out === "string") shortfalls.push(`${rule.id} ${out}`);
    else if (honours(out, p)) return out;
    else shortfalls.push(`${rule.id} would use ${out.summary}`);
  }
  if (shortfalls.length === 0) return { error: `${say}: no rule uses it on a ${input.motion ?? "fixed"} ${input.intent}${input.driven ? " driven" : ""} joint` };
  return { error: `${say}: ${shortfalls.join("; ")}` };
}

/** Declarations other than a thicker wall under which a rule fits, so a
 *  repair round can keep a wall the brief states. */
export function jointEscapes(i: JointInput): string[] {
  const tries: [string, Partial<JointInput>][] = [
    ["declare b's joint on its far support too (same b, its own coaxial b.port facing the other way)", { pairedB: true }],
    ["declare access both_sides", { access: "both_sides" }],
    ["set allowPrinted", { allowPrinted: true }],
  ];
  return tries.flatMap(([say, patch]) => {
    if (Object.entries(patch).every(([k, v]) => i[k as keyof JointInput] === v)) return [];
    const d = selectJoint({ ...i, ...patch });
    return "error" in d ? [] : [`${say} for ${d.rule}'s ${d.summary}`];
  });
}
