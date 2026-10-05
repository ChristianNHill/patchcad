import type { NodeRecord } from "@patchcad/shared";
import { CATALOG, familyDims, SUPPLIERS, type DimsRow, type Sku } from "./catalog.js";

/**
 * What a bought part IS, in the words you would order it by, and where to
 * look for it. Everything here comes from the catalog: the designation from
 * the family's standard and dims, the links from `catalog/suppliers.json`.
 *
 * A part number appears only when the catalog sku carries a vendor entry a
 * person verified (`skus[].vendors`, zod requires `verifiedAt`). Every other
 * link is a SEARCH for the designation, labelled as one, never a product.
 */

export type OrderLink =
  | { vendor: string; url: string; kind: "verified"; pn: string; verifiedAt: string }
  | { vendor: string; url: string; kind: "search" };

/** 684-689, MR85 and MR105 rows carry the shielded widths (hardware.json
 *  `bearing.note`): an open bearing of that number is narrower. */
const SHIELDED_ONLY = /^(68[4-9]|MR85|MR105)$/i;

const num = (row: DimsRow, k: string) => (typeof row[k] === "number" ? (row[k] as number) : undefined);
const fmt = (v: number) => String(Math.round(v * 100) / 100);

function paramOf(node: NodeRecord, name: string): unknown {
  return node.params[name] ?? node.contract.params.find((p) => p.name === name)?.default;
}

/** The part's length: the sku's stocked one, else the node's own `length`
 *  (a cut rod), to a tenth of a millimetre. */
function lengthOf(node: NodeRecord, sku: Sku): number | undefined {
  if (sku.length !== undefined) return sku.length;
  const len = Number(paramOf(node, "length"));
  return Number.isFinite(len) && len > 0 ? Math.round(len * 10) / 10 : undefined;
}

/** "ISO 7380-1 (M3 and up; …)" → "ISO 7380-1"; families whose standard
 *  string is a sentence keep only the leading designation. */
function standardOf(family: string): string | undefined {
  const s = CATALOG.families[family]?.standard;
  const m = s && /^(ISO|DIN|EN)\s[\d-]+(\s[A-Z](?=\s|$))?/.exec(s);
  return m ? m[0] : undefined;
}

/** ISO 7380-1, ISO 10642 and the like start at M3: no standard for M2/M2.5. */
function inStandard(family: string, key: string): boolean {
  const s = CATALOG.families[family]?.standard ?? "";
  const from = /\(M(\d+(?:\.\d+)?) and up/.exec(s);
  const k = /^M(\d+(?:\.\d+)?)$/i.exec(key);
  return !from || !k || Number(k[1]) >= Number(from[1]);
}

type Designer = (key: string, row: DimsRow, len: number | undefined, node: NodeRecord) => string;

const by = (std: string | undefined, rest: string) => (std ? `${std} ${rest}` : rest);
const sized = (key: string, len: number | undefined) => `${key}${len !== undefined ? `×${fmt(len)}` : ""}`;

const DESIGN: Record<string, Designer> = {
  shcs: (k, _r, l) => by(standardOf("shcs"), `${sized(k, l)} socket head cap screw`),
  button: (k, _r, l) => by(inStandard("button", k) ? standardOf("button") : undefined, `${sized(k, l)} button head socket screw`),
  csk: (k, _r, l) => by(inStandard("csk", k) ? standardOf("csk") : undefined, `${sized(k, l)} countersunk socket screw`),
  hex_nut: (k) => by(standardOf("hex_nut"), `${k} hex nut`),
  washer: (k) => by(standardOf("washer"), `${k} flat washer`),
  heatset_std: (k, r) => `${k} heat-set threaded insert, Ø${fmt(num(r, "od")!)}×${fmt(num(r, "length")!)} mm`,
  heatset_short: (k, r) => `${k} heat-set threaded insert, short, Ø${fmt(num(r, "od")!)}×${fmt(num(r, "length")!)} mm`,
  wood_insert: (k, r, l) => `${k} hex-drive threaded insert for wood, Ø${fmt(num(r, "od")!)}${l !== undefined ? `×${fmt(l)}` : ""} mm`,
  dowel: (k, _r, l) => by(standardOf("dowel"), `Ø${sized(k, l)} m6 dowel pin`),
  wood_dowel: (k, _r, l) => by(standardOf("wood_dowel"), `Ø${sized(k, l)} fluted beech dowel`),
  confirmat: (k, r, l) => `Ø${sized(k, l)} confirmat furniture screw, ${fmt(num(r, "socketAf")!)} mm hex`,
  chipboard: (k, _r, l) => by(standardOf("chipboard"), `${sized(k, l)} countersunk chipboard screw, PZ2`),
  cam_lock: (k) => `Ø${k} cam lock housing (Minifix-type)`,
  cam_bolt: (k) => `cam connecting bolt, ${k} mm drilling distance`,
  dowel_screw: (k, _r, l) => `Ø${sized(k, l)} double-ended dowel screw`,
  filament_pin: (k, _r, l) => `${k} mm 3D-printer filament${l !== undefined ? `, cut to ${fmt(l)} mm` : ""}`,
  wire_nail: (k, _r, l) => by(standardOf("wire_nail"), `${sized(k, l)} round plain-head wire nail`),
  threaded_rod: (k, _r, l) => by(standardOf("threaded_rod"), `${k} threaded rod${l !== undefined ? `, cut to ${fmt(l)} mm` : ""}`),
  bearing: (k, r) =>
    `${k}${SHIELDED_ONLY.test(k) ? "ZZ" : ""} deep groove ball bearing ${fmt(num(r, "bore")!)}×${fmt(num(r, "od")!)}×${fmt(num(r, "width")!)}`,
  bearing_flanged: (k, r) =>
    `${k} flanged ball bearing ${fmt(num(r, "bore")!)}×${fmt(num(r, "od")!)}×${fmt(num(r, "width")!)}, flange Ø${fmt(num(r, "flangeD")!)}`,
  bushing: (_k, r, l) => `sintered bronze plain bushing ${fmt(num(r, "bore")!)}×${fmt(num(r, "od")!)}${l !== undefined ? `×${fmt(l)}` : ""}`,
  shaft: (k, _r, l) => `Ø${k} h6 ground rod${l !== undefined ? `, cut to ${fmt(l)} mm` : ""}`,
  d_shaft: (k, r, l) => `Ø${k} D-shaft, ${fmt(num(r, "flatDepth")!)} mm flat${l !== undefined ? `, cut to ${fmt(l)} mm` : ""}`,
  // Only the rows transcribed from DIN 705 A carry its name; the smaller
  // sizes are family-typical and are ordered by bore.
  collar: (k, r) => `${r.dimsSource === "standard" ? `DIN 705 A ${k}` : `${k} mm bore`} shaft collar, Ø${fmt(num(r, "od")!)}×${fmt(num(r, "width")!)}, ${r.setScrew} set screw`,
  eclip: (k, r) => by(standardOf("eclip"), `${k} retaining washer (E-clip), for Ø${fmt(num(r, "shaftMin")!)}-${fmt(num(r, "shaftMax")!)} shafts`),
  lm_uu: (k, r) => `${k} linear ball bearing ${fmt(num(r, "bore")!)}×${fmt(num(r, "od")!)}×${fmt(num(r, "length")!)}`,
  mgn_rail: (k, _r, l) => `${k} miniature linear guide rail${l !== undefined ? `, ${fmt(l)} mm` : ""}`,
  mgn_carriage: (k, r) => `${k} miniature linear guide carriage (standard block) for ${r.rail} rail`,
  v_wheel: (_k, r) => `solid V-wheel kit, Delrin, 2× ${r.bearing} bearings, Ø${fmt(num(r, "bore")!)} bore`,
  gt2_pulley: (_k, r) => `GT2 ${r.teeth}T timing pulley ${fmt(num(r, "bore")!)} mm bore, for 6 mm belt`,
  gt2_idler: (_k, r) => `GT2 ${r.teeth}T toothed idler ${fmt(num(r, "bore")!)} mm bore, for 6 mm belt`,
  gt2_belt: (k, _r, l) => `GT2 ${k} mm open timing belt${l !== undefined ? `, ${fmt(l)} mm` : ""}`,
  gt2_loop: (k, _r, l) => `GT2 ${l !== undefined ? `${fmt(l)} mm ` : ""}closed timing belt, ${k} mm wide`,
  coupler: (_k, r) => `${fmt(num(r, "boreA")!)}×${fmt(num(r, "boreB")!)} mm flexible shaft coupler, Ø${fmt(num(r, "od")!)}×${fmt(num(r, "length")!)}`,
  lead_screw: (k, r, l) => `${k}×${fmt(num(r, "lead")!)} trapezoidal lead screw${l !== undefined ? `, ${fmt(l)} mm` : ""}`,
  lead_nut: (k) => `${k} flanged brass lead screw nut`,
  nema17: (_k, _r, l) => `NEMA 17 stepper motor${l !== undefined ? `, ${fmt(l)} mm body` : ""}`,
  nema14: (_k, _r, l) => `NEMA 14 stepper motor${l !== undefined ? `, ${fmt(l)} mm body` : ""}`,
  brushless: (k, r) => `${k} brushless outrunner motor, Ø${fmt(num(r, "shaftD")!)} shaft`,
  n20: (_k, r) => `N20 micro metal gearmotor, Ø${fmt(num(r, "shaftD")!)} D-shaft`,
  sg90: () => "SG90 9 g micro servo",
  mg996r: () => "MG996R metal-gear servo",
  sts3215: () => "Feetech STS3215 serial bus servo",
  disc_magnet: (k) => `${k.replace(/^(\d+(?:\.\d+)?)x/, "Ø$1×")} mm neodymium disc magnet`,
  oring: (k, _r, _l, node) => {
    const id = Number(paramOf(node, "id"));
    return `O-ring${Number.isFinite(id) && id > 0 ? ` ${fmt(id)} mm ID ×` : ""} ${k} mm cross-section`;
  },
  standoff: (k, r, l) => `${sized(k, l)} hex standoff, female-female, ${fmt(num(r, "af")!)} mm AF`,
};

/**
 * A precise, orderable description of a catalog part at this node's size and
 * length: "ISO 4762 M3×12 socket head cap screw", "Ø8 h6 ground rod, cut to
 * 178.6 mm". The sku's material, when the catalog names one, ends it.
 */
export function designationOf(node: NodeRecord, sku: Sku): string {
  const row = familyDims(sku.family, sku.key) ?? {};
  const family = CATALOG.families[sku.family]!;
  const len = family.lengths ? lengthOf(node, sku) : undefined;
  const base =
    DESIGN[sku.family]?.(sku.key, row, len, node) ??
    by(standardOf(sku.family), `${sized(sku.key, len)} ${sku.family.replace(/_/g, " ")}`);
  return sku.material ? `${base}, ${sku.material}` : base;
}

/** An architect's gear names module and teeth, not a sku. */
export function gearDesignation(module: number, teeth: number): string {
  const pa = num(familyDims("spur_gear", `m${module}`) ?? {}, "pressureAngle");
  return `module ${fmt(module)} spur gear ${teeth} teeth${pa ? `, ${fmt(pa)}° pressure angle` : ""}`;
}

/**
 * Search terms from a designation: its first clause (designations put what
 * identifies the part first and detail after a comma, so a cut length or a
 * flange Ø never narrows a search to nothing), plus the material when the
 * sku names one. A lone Ø reads as millimetres, × as x.
 */
export function searchTerms(designation: string, material?: string): string {
  const head = designation.split(", ")[0]!;
  return `${head}${material ? ` ${material}` : ""}`
    .replace(/Ø(\d+(?:\.\d+)?)(?![\d.×x])/g, "$1 mm")
    .replace(/Ø/g, "")
    .replace(/×/g, "x")
    .replace(/\s+/g, " ")
    .trim();
}

/** The supplier group for a family: its own mapping, else its category's. */
export function supplierGroup(family: string | undefined): string {
  const f = family ? CATALOG.families[family] : undefined;
  return (family && SUPPLIERS.byFamily[family]) || (f && SUPPLIERS.byCategory[f.category]) || "general";
}

export function searchUrl(vendor: string, terms: string): string {
  return SUPPLIERS.vendors[vendor]!.search.replace("{q}", encodeURIComponent(terms));
}

/**
 * Where to order: every verified vendor entry on the sku first (its PN and
 * the date a person checked it), then a search link per supplier in the
 * family's group, best-fit first. A vendor with a verified entry gets no
 * second, search link.
 */
export function orderLinks(sku: Sku | null, family: string | undefined, designation: string): OrderLink[] {
  const verified: OrderLink[] = Object.entries(sku?.vendors ?? {}).map(([vendor, v]) => ({
    vendor: SUPPLIERS.vendors[vendor]?.name ?? vendor,
    url: v.url,
    kind: "verified",
    pn: v.pn,
    verifiedAt: v.verifiedAt,
  }));
  const have = new Set(Object.keys(sku?.vendors ?? {}));
  const terms = searchTerms(designation, sku?.material);
  const search: OrderLink[] = SUPPLIERS.groups[supplierGroup(family)]!
    .filter((v) => !have.has(v))
    .map((v) => ({ vendor: SUPPLIERS.vendors[v]!.name, url: searchUrl(v, terms), kind: "search" }));
  return [...verified, ...search];
}
