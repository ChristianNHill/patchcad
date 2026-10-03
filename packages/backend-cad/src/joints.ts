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

const Dim = z.union([z.number(), z.string()]);
const Level = z.enum(["low", "medium", "high"]);
const End = z.object({ node: z.string(), port: z.string() });

/** What the architect declares per joint: intent, never hardware. Walls are
 *  numbers or T1 expressions ("param(base.thickness)"), so a joint tracks the
 *  parts it joins. */
export const CadJoint = z.object({
  id: z.string(),
  a: End.describe("the part that stays put (housing, frame, base): a FLAT_FACE port where the joint is, +z toward b"),
  b: End.describe("the part joined to it, which moves for motion joints: a FLAT_FACE port facing a"),
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
  /** Revolute travel in degrees; continuous joints sweep the full turn. */
  limits: z.tuple([z.number(), z.number()]).optional(),
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
  minWall?: number;
  flush?: boolean;
  count?: number;
  threadHint?: string;
  shaftHint?: number;
  strokeMm?: number;
  ratio?: number;
  centerMm?: number;
  wallMotor?: number;
  allowPrinted?: boolean;
  lateral?: number;
  /** a is a catalog part (a rail, an idler), so no counterbore can be cut in it. */
  noRecess?: boolean;
}

/** One catalog part a joint needs. `role` becomes the node id suffix. */
export interface HardwarePick {
  role: string;
  family: string;
  key: string;
  length?: number;
}

export type Recipe =
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
  | "rod_slide"
  | "rail"
  | "direct_drive"
  | "belt_drive"
  | "gear_drive"
  | "lead_screw"
  | "belt_carriage";

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
  /** A decision, or the shortfall that stopped it ("wallB 3.0 < insert 5.8 + 1.2"). */
  fit: (i: JointInput) => JointDecision | string;
}

const LOADS = ["none", "light", "medium", "heavy"] as const;
const atLeast = (load: JointInput["load"], floor: JointInput["load"]) => LOADS.indexOf(load) >= LOADS.indexOf(floor);
const mm = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const r2 = (n: number) => Math.round(n * 100) / 100;
const minWallOf = (i: JointInput) => i.minWall ?? FDM_MIN_WALL_MM;
const n = (family: string, key: string, field: string) => dim(familyDims(family, key)!, field);

// ---------- Fasteners ----------

/** threadHint wins; else light M3, medium M4, heavy M5, stepping up to M6 or
 *  M8 under a heavy load only when both walls are at least 3·d. */
export function pickThread(i: JointInput): { thread: string; reason: string } {
  const hint = i.threadHint && Object.keys(CATALOG.threads).find((t) => t.toUpperCase() === i.threadHint!.toUpperCase());
  if (hint) return { thread: hint, reason: `thread ${hint} as hinted` };
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
  const mw = minWallOf(i);
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

/** R1: ISO 2338 dowel, press in a, slip in b, at least 1.5·d into each side. */
const R1: JointRule = {
  id: "R1",
  when: (i) => fixed(i) && i.intent === "alignment",
  fit: (i) => {
    const room = Math.min(i.wallA, i.wallB) - minWallOf(i) - 0.5;
    const preferred = { none: 3, light: 3, medium: 4, heavy: 5 }[i.load];
    const sizes = Object.keys(CATALOG.families.dowel!.dims).map(Number).filter((d) => d <= preferred).sort((a, b) => b - a);
    for (const d of sizes) {
      const key = canonicalKey("dowel", String(d))!;
      const L = pickLength("dowel", key, { min: 3 * d, max: 2 * room });
      if (L === undefined) continue;
      return decision("R1", "dowel", `Ø${d}×${L} dowel, press in a, slip in b`, [
        `alignment: ISO 2338 dowel`,
        `Ø${d}: the largest at or under the ${i.load}-load Ø${preferred} that fits ${mm(room)} each side`,
      ], { parts: [{ role: "dowel", family: "dowel", key, length: L }], dims: { d, length: L, depth: L / 2 + 0.5 } });
    }
    return `walls ${mm(i.wallA)}/${mm(i.wallB)}: no dowel Ø${preferred} or smaller reaches 1.5·d into both with ${minWallOf(i)} left`;
  },
};

/** R1b: the printed peg alignment falls back to when walls are too thin. */
const R1b: JointRule = {
  id: "R1b",
  when: (i) => fixed(i) && i.intent === "alignment" && i.allowPrinted !== false,
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
  when: (i) => fastens(i) && i.processB === "CNC",
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
 *  (R2 tried it first): through-bolt, nut, two washers. */
const R3: JointRule = {
  id: "R3",
  when: (i) => fastens(i) && i.access === "both_sides" && (i.load === "heavy" || i.processB === "CNC"),
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
    return decision("R3", "through_bolt", `${thread}×${L} through-bolt, nut and washers`, [i.load === "heavy" ? "heavy load, both sides reachable: through-bolt" : "metal b too thin to tap, both sides reachable: through-bolt", reason], {
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
  when: (i) => fastens(i) && i.processB === "FDM" && i.access === "both_sides",
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
  when: (i) => fastens(i) && i.processB === "FDM" && i.access === "one_side",
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

/** R7: snap fit. Off until snap probes exist. */
const R7: JointRule = {
  id: "R7",
  when: (i) => fastens(i) && i.processB === "FDM" && i.intent === "permanent" && !atLeast(i.load, "medium"),
  fit: () => (SNAP_ENABLED ? decision("R7", "snap", "snap fit", ["permanent, light, printed: snap"]) : "snap fits are disabled until a probe can verify one"),
};

// ---------- Motion ----------

const revolute = (i: JointInput) => i.motion === "revolute";
const casual = (i: JointInput) => (i.duty ?? "occasional") === "occasional" && !atLeast(i.load, "medium");

/** Shaft Ø from the load, unless hinted. */
const shaftFor = (i: JointInput) => i.shaftHint ?? { none: 5, light: 5, medium: 8, heavy: 10 }[i.load];

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
  keep: HardwarePick;
  parts: HardwarePick[];
  reasons: string[];
}

/** Two deep-groove bearings, one in each face of a, a shaft through them
 *  fixed in b's hub, a collar outside each. Largest OD first (the higher
 *  rating), stepping down while two bearings and a shoulder do not fit wallA. */
function spindleFor(i: JointInput): Spindle | string {
  const d = shaftFor(i);
  const mw = minWallOf(i);
  const candidates = Object.entries(CATALOG.families.bearing!.dims)
    .filter(([, r]) => r.bore === d)
    .sort((a, b) => dim(b[1], "od") - dim(a[1], "od"));
  if (candidates.length === 0) return `no deep-groove bearing with a Ø${d} bore`;
  const fits = candidates.find(([, r]) => i.wallA >= 2 * dim(r, "width") + mw);
  if (!fits) {
    const w = Math.min(...candidates.map(([, r]) => dim(r, "width")));
    return `wallA ${mm(i.wallA)} < 2 × bearing width ${mm(w)} + ${mw}`;
  }
  if (i.wallB < d) return `wallB ${mm(i.wallB)} < hub engagement Ø${d}`;
  const [key, row] = fits;
  const shaft = shaftPart(d);
  if (typeof shaft === "string") return shaft;
  const keep = retention(d);
  if (!keep.key) return `no collar or e-clip for a Ø${d} shaft`;
  return {
    d, key, od: dim(row, "od"), width: dim(row, "width"), keep,
    parts: [
      { role: "bearing_a", family: "bearing", key },
      { role: "bearing_b", family: "bearing", key },
      { role: shaft.role, family: shaft.family, key: shaft.key },
      { role: keep.role, family: keep.family, key: keep.key },
    ],
    reasons: [
      `Ø${d} shaft for a ${i.load} load${i.shaftHint ? " (hinted)" : ""}`,
      `${key}: the largest-OD Ø${d} bearing that fits twice in wallA ${mm(i.wallA)}`,
      "two bearings: one cannot take a moment load",
      shaft.note,
      keep.note,
    ],
  };
}

const M1: JointRule = {
  id: "M1",
  when: (i) => revolute(i) && !i.driven && !casual(i),
  fit: (i) => {
    const s = spindleFor(i);
    if (typeof s === "string") return s;
    return decision("M1", "bearings", `Ø${s.d} shaft on 2×${s.key} bearings`, [
      `revolute, ${i.duty === "continuous" ? "continuous" : `${i.load} load`}: rolling bearings`,
      ...s.reasons,
    ], { parts: s.parts, dims: { d: s.d, od: s.od, width: s.width } });
  },
};

/** Occasional and light: a printed pin when allowed, else bronze bushings.
 *  The pin runs through b and an e-clip in a groove past b's far face keeps b
 *  on it. */
const M2pin: JointRule = {
  id: "M2p",
  when: (i) => revolute(i) && !i.driven && casual(i) && !!i.allowPrinted,
  fit: (i) => {
    const d = i.shaftHint ?? (i.load === "none" ? 4 : 5);
    if (i.wallB < d) return `wallB ${mm(i.wallB)} < printed pin engagement ${d}`;
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

const M2: JointRule = {
  id: "M2",
  when: (i) => revolute(i) && !i.driven && casual(i),
  fit: (i) => {
    const d = i.shaftHint ?? (i.load === "none" ? 3 : 5);
    const mw = minWallOf(i);
    const fam = CATALOG.families.bushing!;
    const key = Object.keys(fam.dims).find((k) => fam.dims[k]!.bore === d);
    if (!key) return `no bushing with a Ø${d} bore`;
    const length = [...(fam.lengths?.[key] ?? [])].reverse().find((l) => 2 * l + mw <= i.wallA);
    if (length === undefined) return `wallA ${mm(i.wallA)} < 2 × bushing ${Math.min(...(fam.lengths?.[key] ?? [0]))} + ${mw}`;
    if (i.wallB < d) return `wallB ${mm(i.wallB)} < hub engagement Ø${d}`;
    const shaft = shaftPart(d);
    if (typeof shaft === "string") return shaft;
    const keep = retention(d);
    if (!keep.key) return `no collar or e-clip for a Ø${d} shaft`;
    return decision("M2", "bushings", `Ø${d} shaft in 2×${key}×${length} bushings`, [
      "revolute, occasional, light: plain bushings", shaft.note, keep.note,
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

/** Which motor and how it couples: servo for occasional low speed, N20 for
 *  low speed and high torque, brushless for high speed, NEMA 17 when precise
 *  or in between. A heavy load never hangs on a motor's own bearings. */
export function pickDrive(i: JointInput): { motor: HardwarePick; coupling: "direct" | "gt2" | "gear"; reason: string } {
  const speed = i.speedClass ?? "medium";
  const torque = i.torqueClass ?? "low";
  const motor = (family: string, key: string): HardwarePick => ({ role: "motor", family, key });
  if (i.load === "heavy") return { motor: motor("nema17", "NEMA17"), coupling: "gear", reason: "heavy load: NEMA 17 through a gear pair, off the motor's bearings" };
  if ((i.ratio !== undefined && i.ratio !== 1) || i.centerMm !== undefined) {
    const asked = i.ratio !== undefined && i.ratio !== 1 ? `a ${i.ratio}:1 ratio` : "an offset motor";
    if (torque === "high" || speed === "low") return { motor: motor("nema17", "NEMA17"), coupling: "gear", reason: `${asked} at ${torque === "high" ? "high torque" : "low speed"}: NEMA 17 through a spur pair` };
    return { motor: motor("nema17", "NEMA17"), coupling: "gt2", reason: `${asked}: NEMA 17 through a GT2 belt` };
  }
  if (i.precise) return { motor: motor("nema17", "NEMA17"), coupling: "direct", reason: "precise: NEMA 17 stepper, direct" };
  if (speed === "high") return { motor: motor("brushless", torque === "low" ? "2204" : "2306"), coupling: "direct", reason: "high speed: brushless outrunner, direct" };
  if (speed === "low" && torque === "high") return { motor: motor("n20", "N20"), coupling: "direct", reason: "low speed, high torque: N20 gearmotor, direct" };
  if (speed === "low" && (i.duty ?? "occasional") === "occasional") return { motor: motor("sg90", "SG90"), coupling: "direct", reason: "occasional, low speed: SG90 servo, direct" };
  if (speed === "low") return { motor: motor("nema17", "NEMA17"), coupling: "gear", reason: "continuous low speed: NEMA 17 through a reduction" };
  return { motor: motor("nema17", "NEMA17"), coupling: "direct", reason: `${speed} speed: NEMA 17, direct` };
}

/** How far a motor's output reaches past its mounting face, mm. */
function motorReach(family: string, key: string): number {
  if (family === "nema17") return n(family, key, "shaftL");
  if (family === "n20") return n(family, key, "shaftL");
  if (family === "brushless") return n(family, key, "shaftL") - 0.5;
  return n(family, key, "splineH");
}

/** Driven revolute: the motor's own bearings carry b, so no shaft is added. */
const D1: JointRule = {
  id: "D1",
  when: (i) => revolute(i) && !!i.driven && pickDrive(i).coupling === "direct",
  fit: (i) => {
    const drive = pickDrive(i);
    const { family, key } = drive.motor;
    const out = n(family, key, family === "sg90" ? "splineD" : "shaftD");
    const reach = motorReach(family, key);
    // NEMA and N20 mount under a with the shaft up through it; the brushless
    // and the servo sit on a's face with the output above it.
    const through = family === "nema17" || family === "n20" ? i.wallA + 1 : 0.5;
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
  return `the NEMA 17 shaft ends ${mm(top)} above a's face, short of ${what} (${mm(z)} + ${mm(engage)}): mount the motor where a is at most ${mm(nema("shaftL") - z - engage)} thick (wallMotor)`;
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
  if (key) return { ...s, spacer: { role: "spacer", family: "washer", key }, gap: n("washer", key, "thickness") };
  if (s.keep.family !== "collar") return `no M${s.d} washer or collar to space the driven wheel off bearing_a`;
  return { ...s, spacer: { role: "spacer", family: "collar", key: s.keep.key }, gap: n("collar", s.keep.key, "width") };
}

/** Motor axis to driven axis, least: the motor body (under a) clear of the
 *  housing round bearing_b and of the lower retention, and its pilot bore
 *  clear of bearing_a's seat. */
const motorClear = (s: Spindle, i: JointInput) =>
  Math.max(
    nema("face") / 2 + Math.max(n(s.keep.family, s.keep.key, "od") / 2, s.od / 2 + 2 * minWallOf(i)) + 1,
    s.od / 2 + nema("pilotD") / 2 + 2 * minWallOf(i),
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
    if (i.centerMm !== undefined && c > i.centerMm + 5) return `the shortest stocked loop that fits (${L}mm) puts the motor ${mm(c)} off, past the ${mm(i.centerMm)} asked`;
    const small = Math.min(zm, zd);
    const inMesh = (small * (Math.PI - 2 * Math.asin(Math.abs(pd - pm) / (2 * c)))) / (2 * Math.PI);
    if (inMesh < 6) return `${inMesh.toFixed(1)} teeth in mesh on the ${small}T pulley at centre ${mm(c)}, 6 needed: ask for a longer centerMm`;
    const zMotor = r2(s.gap + Math.max(0, rimMid(dr) - rimMid(mr)));
    const zDriven = r2(s.gap + Math.max(0, rimMid(mr) - rimMid(dr)));
    const grip = motorGrip(i, zMotor, dim(mr, "hubL"), `the ${zm}T pulley's hub`);
    if (grip) return grip;
    return decision("DB", "belt_drive", `NEMA 17, ${zm}T → ${zd}T GT2 on a ${L}mm loop at ${mm(c)}, Ø${s.d} shaft on 2×${s.key}`, [
      `revolute, driven: ${pickDrive(i).reason}`,
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

/** bd_warehouse's SpurGear at 20°: past 41 teeth the base circle falls inside
 *  the root and it refuses; under 17 the teeth undercut. */
export const GEAR_TEETH = [17, 41] as const;
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
  fit: (i) => {
    const drive = pickDrive(i);
    const ratio = i.ratio ?? (drive.coupling === "gear" ? 2 : 1);
    const s = drivenSpindle(i);
    if (typeof s === "string") return s;
    const cMin = motorClear(s, i);
    const modules = Object.values(CATALOG.families.spur_gear!.dims).map((r) => dim(r, "module")).filter((m) => m >= GEAR_MODULE[i.load]).sort((a, b) => a - b);
    let best: { m: number; zm: number; zd: number; c: number; score: number } | undefined;
    for (const m of modules) {
      const roots = (z: number, bore: number) => m * (z - 2.5) >= bore + 2 * Math.max(minWallOf(i), m);
      for (let zm = GEAR_TEETH[0]; zm <= GEAR_TEETH[1]; zm++) {
        const zd = Math.round(ratio * zm);
        if (zd < GEAR_TEETH[0] || zd > GEAR_TEETH[1] || Math.abs(zd / zm - ratio) / ratio > 0.02) continue;
        if (!roots(zm, nema("shaftD")) || !roots(zd, s.d)) continue;
        const c = (m * (zm + zd)) / 2;
        if (c < cMin) continue;
        const score = i.centerMm ? Math.abs(c - i.centerMm) : c;
        if (!best || score < best.score - 1e-9) best = { m, zm, zd, c, score };
      }
      if (best) break;
    }
    if (!best) return `no pair of m${modules.join("/m")} gears with ${GEAR_TEETH.join("..")} teeth within 2% of ratio ${ratio} reaches centre ${mm(cMin)} (the motor clear of the spindle)`;
    const m = best.m;
    const t = r2(6 * m);
    const grip = motorGrip(i, s.gap, Math.min(t, 1.5 * nema("shaftD")), `the ${best.zm}T gear`);
    if (grip) return grip;
    const key = canonicalKey("spur_gear", `m${m}`)!;
    return decision("DG", "gear_drive", `NEMA 17, ${best.zm}T → ${best.zd}T m${m} spur pair at ${mm(best.c)}, Ø${s.d} shaft on 2×${s.key}`, [
      `revolute, driven: ${drive.coupling === "gear" ? drive.reason : "no stocked belt loop fits the centre asked: a spur pair"}`,
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
  fit: (i) => {
    const key = i.load === "none" ? "LM6UU" : "LM8UU";
    const lm = familyDims("lm_uu", key)!;
    const d = dim(lm, "bore");
    const mw = minWallOf(i);
    if (i.wallB < dim(lm, "length") + mw) return `wallB ${mm(i.wallB)} < ${key} ${mm(dim(lm, "length"))} + ${mw}`;
    if (i.wallA < d + mw) return `wallA ${mm(i.wallA)} < rod socket ${d} + ${mw}`;
    return decision("P1", "rod_slide", `${key} on a Ø${d} rod`, [`prismatic, stroke ${i.strokeMm ?? 50}, ${i.load} load: linear ball bushing on a rod`], {
      parts: [{ role: "rod", family: "shaft", key: canonicalKey("shaft", String(d))! }, { role: "linear_bearing", family: "lm_uu", key }],
      dims: { d, od: dim(lm, "od"), length: dim(lm, "length"), stroke: i.strokeMm ?? 50, socket: r2(i.wallA - mw) },
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
    materialB: i.materialA, minWall: i.minWall, threadHint: thread, noRecess: true,
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

/** Long or loaded: a profile rail on a and a carriage under b. */
const P2: JointRule = {
  id: "P2",
  when: (i) => prismatic(i) && !i.driven,
  fit: (i) => {
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
  fit: (i) => {
    const stroke = i.strokeMm ?? 50;
    const mw = minWallOf(i);
    const [cp, nut, lm] = [familyDims("coupler", "5x8")!, familyDims("lead_nut", "T8")!, familyDims("lm_uu", "LM8UU")!];
    const gap = 1;
    const grip = motorGrip(i, gap, 0.4 * dim(cp, "length"), "the coupler's lower bore");
    if (grip) return grip;
    if (i.wallB < dim(lm, "length") + mw) return `wallB ${mm(i.wallB)} < LM8UU ${mm(dim(lm, "length"))} + ${mw} (the guide that stops b turning)`;
    if (i.wallA < 8 + mw) return `wallA ${mm(i.wallA)} < guide rod socket 8 + ${mw}`;
    const z0 = r2(gap + dim(cp, "length") + dim(nut, "flangeT") + 1);
    const need = z0 - (gap + dim(cp, "length") / 2) + stroke + i.wallB;
    const L = pickLength("lead_screw", "T8", { min: need });
    if (L === undefined) return `stroke ${stroke} needs a ${mm(need)}mm T8 screw, longer than any stocked`;
    const guide = Math.ceil(Math.max(dim(nut, "flangeD") / 2 + dim(lm, "od") / 2, nema("pilotD") / 2 + 4) + mw);
    return decision("PL", "lead_screw", `T8×${L} lead screw from a NEMA 17, nut in b, Ø8 guide rod ${guide} off`, [
      `prismatic, driven, stroke ${stroke}, ${i.speedClass ?? "medium"} speed: lead screw`,
      "NEMA 17 under a, a 5→8 coupler, the screw standing from it",
      `an Ø8 rod and LM8UU ${guide}mm off the screw stop b turning with it`,
    ], {
      parts: [
        { role: "motor", family: "nema17", key: NEMA },
        { role: "coupler", family: "coupler", key: "5x8" },
        { role: "lead_screw", family: "lead_screw", key: "T8", length: L },
        { role: "lead_nut", family: "lead_nut", key: "T8" },
        { role: "rod", family: "shaft", key: "8" },
        { role: "linear_bearing", family: "lm_uu", key: "LM8UU" },
      ],
      dims: { stroke, gap, z0, guide, lead: n("lead_screw", "T8", "lead"), screwStart: r2(gap + dim(cp, "length") / 2), socket: r2(i.wallA - mw), od: dim(lm, "od"), length: dim(lm, "length") },
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
export const JOINT_RULES: JointRule[] = [D1, DB, DG, M1, M2pin, M2, PL, PB, P1, P2, R1, R1b, R2, R3, R4, R7, R5, R6];

export function selectJoint(input: JointInput): JointDecision | { error: string } {
  const tag = input.id ? `${input.id}: ` : "";
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
