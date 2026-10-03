import { z } from "zod";
import raw from "../catalog/hardware.json" with { type: "json" };

/**
 * The hardware catalog: every standard part the registry can build, as data.
 *
 * It is plain JSON (`catalog/hardware.json`) so the Python kernel reads the
 * same numbers, and it is parsed here at load so a bad edit fails the first
 * import rather than a cook. Geometry comes from the standards, never from a
 * vendor: McMaster has no open API and scraping it is against its terms. A
 * vendor part number is optional, entered by a person, and rejected without
 * the date someone checked it.
 */

const DimsSource = z.enum(["standard", "nominal", "family-typical"]);

/** One size's dimensions. Strings are references to other rows (a collar's
 *  set-screw thread, a carriage's rail), numbers are mm or degrees. */
const DimsRow = z.object({ dimsSource: DimsSource.optional() }).catchall(z.union([z.number(), z.string()]));
export type DimsRow = z.infer<typeof DimsRow>;

const Thread = z.object({
  pitch: z.number().positive(),
  clearance: z.number().positive(),
  tapDrill: z.number().positive(),
  engagementMin: z.record(z.number().positive()),
});
export type ThreadSpec = z.infer<typeof Thread>;

export const CATEGORIES = [
  "fasteners",
  "bearings",
  "plain_bearings",
  "shafts",
  "linear",
  "transmission",
  "motors",
  "misc",
] as const;
export type Category = (typeof CATEGORIES)[number];

const Family = z.object({
  category: z.enum(CATEGORIES),
  /** The node kind that builds it. Several families can share one. */
  kind: z.string(),
  /** Thread-keyed rows are named M3, M4…; size-keyed rows by designation. */
  keyedBy: z.enum(["thread", "size"]),
  skuPrefix: z.string(),
  standard: z.string().optional(),
  note: z.string().optional(),
  dimsSource: DimsSource,
  dims: z.record(DimsRow),
  /** Stocked lengths per key, ascending. Absent for fixed-size parts. */
  lengths: z.record(z.array(z.number().positive())).optional(),
});
export type Family = z.infer<typeof Family>;

const VendorRef = z.object({ pn: z.string().min(1), url: z.string().url(), verifiedAt: z.string().date() });

export const Sku = z.object({
  id: z.string(),
  family: z.string(),
  key: z.string(),
  length: z.number().positive().optional(),
  material: z.string().optional(),
  vendors: z.record(VendorRef).optional(),
  /** A vendor STEP the user dropped into the project's imports; resolved by
   *  load_import, with the parametric model as the fallback. */
  stepFile: z.string().optional(),
});
export type Sku = z.infer<typeof Sku>;

export const Catalog = z
  .object({
    version: z.number(),
    notes: z.record(z.string()).optional(),
    threads: z.record(Thread),
    families: z.record(Family),
    skus: z.array(Sku),
  })
  .superRefine((c, ctx) => {
    for (const [name, f] of Object.entries(c.families)) {
      for (const key of Object.keys(f.dims)) {
        if (f.keyedBy === "thread" && !c.threads[key]) {
          ctx.addIssue({ code: "custom", path: ["families", name, "dims", key], message: `unknown thread ${key}` });
        }
      }
      for (const key of Object.keys(f.lengths ?? {})) {
        if (!f.dims[key]) ctx.addIssue({ code: "custom", path: ["families", name, "lengths", key], message: "no dims row" });
      }
    }
    for (const [i, s] of c.skus.entries()) {
      if (!c.families[s.family]?.dims[s.key]) {
        ctx.addIssue({ code: "custom", path: ["skus", i], message: `no ${s.family} ${s.key} in the catalog` });
      }
    }
  });
export type Catalog = z.infer<typeof Catalog>;

export const CATALOG: Catalog = Catalog.parse(raw);

/** Designations compare case-insensitively, and numerically when they are
 *  numbers: "m4" is M4, "3.0" is the 3 row. */
const norm = (key: string) => {
  const t = key.trim();
  return /^\d+(\.\d+)?$/.test(t) ? String(Number(t)) : t.toUpperCase();
};

/** The catalog's own spelling of a key, or undefined when the family lacks it. */
export function canonicalKey(family: string, key: string): string | undefined {
  const rows = CATALOG.families[family]?.dims;
  return rows ? Object.keys(rows).find((k) => norm(k) === norm(key)) : undefined;
}

export function threadSpec(thread: string): ThreadSpec | undefined {
  const key = Object.keys(CATALOG.threads).find((k) => norm(k) === norm(thread));
  return key ? CATALOG.threads[key] : undefined;
}

export function familyDims(family: string, key: string): DimsRow | undefined {
  const k = canonicalKey(family, key);
  return k ? CATALOG.families[family]!.dims[k] : undefined;
}

/** A numeric dim, or a thrown error naming the row — codegen and bindings only
 *  ask for fields the family is known to carry, so a miss is a catalog bug. */
export function dim(row: DimsRow, field: string): number {
  const v = row[field];
  if (typeof v !== "number") throw new Error(`catalog row has no numeric "${field}"`);
  return v;
}

export function standardLengths(family: string, key: string): number[] {
  const k = canonicalKey(family, key);
  return (k && CATALOG.families[family]!.lengths?.[k]) || [];
}

/** Shortest stocked length inside [min, max] — the least screw that does the job. */
export function pickLength(family: string, key: string, range: { min: number; max?: number }): number | undefined {
  return standardLengths(family, key).find((l) => l >= range.min - 1e-9 && (range.max === undefined || l <= range.max + 1e-9));
}

/** Families a node kind can build, default first. */
export function familiesOfKind(kind: string): string[] {
  return Object.entries(CATALOG.families)
    .filter(([, f]) => f.kind === kind)
    .map(([name]) => name);
}

/**
 * The SKU for a size: the catalog's own record when one exists (it may carry
 * vendors or a STEP file), otherwise one minted from the family prefix,
 * "ISO4762-M3x12". A length that is not stocked is not a SKU.
 */
export function skuFor(family: string, key: string, length?: number): Sku | undefined {
  const f = CATALOG.families[family];
  const k = canonicalKey(family, key);
  if (!f || !k) return undefined;
  if (length !== undefined && f.lengths?.[k] && !f.lengths[k]!.includes(length)) return undefined;
  const id = `${f.skuPrefix}-${k}${length !== undefined ? `x${length}` : ""}`;
  return CATALOG.skus.find((s) => s.id === id) ?? { id, family, key: k, ...(length !== undefined ? { length } : {}) };
}

/** Inverse of skuFor: which family, size and length an id names. Families can
 *  share a prefix (BRG-608, BRG-F608), so every matching family is tried. */
export function parseSku(id: string): Sku | undefined {
  const listed = CATALOG.skus.find((s) => s.id.toUpperCase() === id.trim().toUpperCase());
  if (listed) return listed;
  for (const [family, f] of Object.entries(CATALOG.families)) {
    const head = `${f.skuPrefix}-`;
    if (!id.toUpperCase().startsWith(head.toUpperCase())) continue;
    const rest = id.slice(head.length);
    const exact = canonicalKey(family, rest);
    if (exact) return skuFor(family, exact);
    const m = /^(.+)x(\d+(?:\.\d+)?)$/i.exec(rest);
    const key = m && canonicalKey(family, m[1]!);
    if (key) return skuFor(family, key, Number(m[2]));
  }
  return undefined;
}
