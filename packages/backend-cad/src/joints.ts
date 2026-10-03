import { z } from "zod";
import { CATALOG, canonicalKey, dim, familyDims, pickLength, standardLengths, threadSpec } from "./catalog.js";
import { FDM_SLIP_FIT_MM, majorDiameter } from "./grounding.js";

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
  minWall?: number;
  flush?: boolean;
  count?: number;
  threadHint?: string;
  shaftHint?: number;
  strokeMm?: number;
  allowPrinted?: boolean;
  lateral?: number;
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
  | "direct_drive";

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
  if (opts.recessed && i.wallA >= cboreDepth + Math.max(2 * mw, majorDiameter(thread))) {
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

/** R3: heavy and reachable from both sides: through-bolt, nut, two washers. */
const R3: JointRule = {
  id: "R3",
  when: (i) => fastens(i) && i.processB === "FDM" && i.load === "heavy" && i.access === "both_sides",
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
    return decision("R3", "through_bolt", `${thread}×${L} through-bolt, nut and washers`, [`heavy load, both sides reachable: through-bolt`, reason], {
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
function shaftPart(d: number): HardwarePick & { note: string } {
  const key = canonicalKey("d_shaft", String(d));
  if (key) return { role: "shaft", family: "d_shaft", key, note: `Ø${d} D-shaft so the hub turns with it` };
  return { role: "shaft", family: "shaft", key: canonicalKey("shaft", String(d)) ?? String(d), note: `no Ø${d} D-shaft stocked: round shaft, the hub needs its own set screw` };
}

/** Two deep-groove bearings, one in each face of a, a shaft through them
 *  fixed in b's hub, a collar outside each. Largest OD first (the higher
 *  rating), stepping down while two bearings and a shoulder do not fit wallA. */
const M1: JointRule = {
  id: "M1",
  when: (i) => revolute(i) && !i.driven && !casual(i),
  fit: (i) => {
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
    const keep = retention(d);
    if (!keep.key) return `no collar or e-clip for a Ø${d} shaft`;
    return decision("M1", "bearings", `Ø${d} shaft on 2×${key} bearings`, [
      `revolute, ${i.duty === "continuous" ? "continuous" : `${i.load} load`}: rolling bearings`,
      `Ø${d} shaft for a ${i.load} load${i.shaftHint ? " (hinted)" : ""}`,
      `${key}: the largest-OD Ø${d} bearing that fits twice in wallA ${mm(i.wallA)}`,
      "two bearings: one cannot take a moment load",
      shaft.note,
      keep.note,
    ], {
      parts: [
        { role: "bearing_a", family: "bearing", key },
        { role: "bearing_b", family: "bearing", key },
        { role: shaft.role, family: shaft.family, key: shaft.key },
        { role: keep.role, family: keep.family, key: keep.key },
      ],
      dims: { d, od: dim(row, "od"), width: dim(row, "width") },
    });
  },
};

/** Occasional and light: a printed pin when allowed, else bronze bushings. */
const M2pin: JointRule = {
  id: "M2p",
  when: (i) => revolute(i) && !i.driven && casual(i) && !!i.allowPrinted,
  fit: (i) => {
    const d = i.shaftHint ?? (i.load === "none" ? 4 : 5);
    if (i.wallB < d) return `wallB ${mm(i.wallB)} < printed pin engagement ${d}`;
    return decision("M2p", "printed_pin", `printed Ø${d} pin pivot`, ["revolute, occasional, light, printed allowed: a pin printed on a"], {
      dims: { d, bore: r2(d + FDM_SLIP_FIT_MM), length: i.wallB },
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
  when: (i) => revolute(i) && !!i.driven,
  fit: (i) => {
    const drive = pickDrive(i);
    if (drive.coupling !== "direct") return `${drive.reason}; a ${drive.coupling} drive needs a motor bracket the rules cannot place yet`;
    const { family, key } = drive.motor;
    const out = family === "nema17" || family === "n20" ? n(family, key, "shaftD") : family === "brushless" ? n(family, key, "shaftD") : n(family, key, "splineD");
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

/** Long or loaded: a profile rail on a and a carriage under b. */
const P2: JointRule = {
  id: "P2",
  when: (i) => prismatic(i) && !i.driven,
  fit: (i) => {
    const rail = atLeast(i.load, "medium") ? "MGN12" : "MGN9";
    const car = `${rail}C`;
    const stroke = i.strokeMm ?? 50;
    const carL = n("mgn_carriage", car, "length");
    const L = pickLength("mgn_rail", rail, { min: stroke + carL });
    if (L === undefined) return `stroke ${stroke} + carriage ${carL} is longer than any stocked ${rail} rail`;
    return decision("P2", "rail", `${rail}×${L} rail and ${car}`, [`prismatic, stroke ${stroke}, ${i.load} load: profile rail`], {
      parts: [{ role: "rail", family: "mgn_rail", key: rail, length: L }, { role: "carriage", family: "mgn_carriage", key: car }],
      dims: { stroke, railLength: L, carriage: carL },
    });
  },
};

const PD: JointRule = {
  id: "PD",
  when: (i) => prismatic(i) && !!i.driven,
  fit: () => "a driven slide needs a lead screw or a belt the rules cannot place yet",
};

/** First fit wins. Motion rules come first: a revolute joint is never bolted. */
export const JOINT_RULES: JointRule[] = [D1, M1, M2pin, M2, PD, P1, P2, R1, R1b, R2, R3, R4, R5, R6, R7];

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
