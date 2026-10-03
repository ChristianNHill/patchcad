import type { GraphDoc, NodeRecord } from "@patchcad/shared";
import type { CadContractPayload } from "./index.js";
import { solveAssembly, type AssemblyNode } from "./assembly.js";
import { resolvePose } from "./bindings.js";
import { CATALOG, skuFor, type Sku } from "./catalog.js";
import { skuOf } from "./registry.js";
import { sourcingOf } from "./sourcing.js";

/**
 * The bill of materials, built from the graph after a cook. A row exists only
 * for a node with a committed artifact, because everything in the BOM is
 * generated geometry: a node that never produced a part is listed under
 * `notGenerated`, never as a phantom line someone might order.
 *
 * Quantities are placed copies (the assembly solver's instances), so four
 * screws through one seat are one row of four.
 */

export const UNVERIFIED_PN = "unverified — order by standard";
const FILAMENT_D_MM = 1.75;

/** g/cm³, first match wins; printed parts default to PLA. */
const DENSITY: [RegExp, number][] = [
  [/stainless|\b30[34]\b|\b316\b/i, 8.0],
  [/steel|\bs235\b|\bc45\b/i, 7.85],
  [/titanium|ti-?6al/i, 4.43],
  [/brass/i, 8.5],
  [/copper/i, 8.96],
  [/alumin|\b[5-7]0[0-9]{2}\b/i, 2.7],
  [/petg/i, 1.27],
  [/\babs\b/i, 1.04],
  [/\basa\b/i, 1.07],
  [/tpu/i, 1.21],
  [/pa ?12|pa ?11|nylon/i, 1.01],
  [/pom|delrin|acetal/i, 1.41],
  [/acrylic|pmma/i, 1.19],
  [/polycarbonate|\bpc\b/i, 1.2],
  [/resin/i, 1.15],
  [/pla/i, 1.24],
];

export function densityOf(material: string | undefined, process?: string): number {
  const m = material ?? (process === "resin" ? "resin" : process === "sls" || process === "mjf" ? "PA12" : "PLA");
  return DENSITY.find(([re]) => re.test(m))?.[1] ?? 1.24;
}

export interface BuyRow {
  sku: string;
  description: string;
  standard: string;
  qty: number;
  nodes: string[];
  vendors: { vendor: string; pn: string; url: string }[] | typeof UNVERIFIED_PN;
}

interface MadeRow {
  nodeId: string;
  title: string;
  qty: number;
  process: string;
  material: string;
  volumeMm3: number | null;
  massG: number | null;
}

export interface PrintRow extends MadeRow {
  /** Upper bound: the solid volume as 1.75 mm filament, before infill. */
  filamentM: number | null;
}

export interface FabricateRow extends MadeRow {
  finish: string | null;
  /** Gates passed, so the vendor package can be built. */
  ready: boolean;
  vendorPackage: string | null;
}

export interface Bom {
  buy: BuyRow[];
  print: PrintRow[];
  fabricate: FabricateRow[];
  notGenerated: { nodeId: string; title: string; class: string; status: string }[];
}

/** Placed copies per node, from the same solve the viewport uses. */
function instanceCounts(graph: GraphDoc): Record<string, number> {
  const nodes: AssemblyNode[] = Object.values(graph.nodes).map((n) => {
    const ports: AssemblyNode["ports"] = {};
    for (const p of (n.contract.payload as CadContractPayload | undefined)?.ports ?? []) {
      try {
        ports[p.name] = resolvePose(graph, p.pose);
      } catch {
        // unresolvable pose: the node still counts once
      }
    }
    return { id: n.id, ports };
  });
  const mates = graph.edges.map((e) => ({ fromNode: e.from, fromPort: e.fromPort, toNode: e.to, toPort: e.toPort }));
  const { instances } = solveAssembly(nodes, mates, graph.assembly.entryNodeId);
  return Object.fromEntries(Object.values(graph.nodes).map((n) => [n.id, Math.max(1, instances[n.id]?.length ?? 1)]));
}

function volumeOf(node: NodeRecord): number | null {
  const v = (node.measurements?.data as { volume_mm3?: unknown } | undefined)?.volume_mm3;
  return typeof v === "number" ? v : null;
}

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * The node's SKU at its actual length. Joint-minted hardware names the size
 * (`ISO7380-M3`) and carries the length as its own param, so without this
 * every M3 screw merged into one lengthless row and no vendor `…x12` matched.
 * A length the family does not stock keeps its own id rather than vanishing.
 */
function skuAtLength(node: NodeRecord): Sku | null {
  const sku = skuOf(node);
  if (!sku || sku.length !== undefined || !CATALOG.families[sku.family]!.lengths) return sku;
  const len = Number(node.params.length ?? node.contract.params.find((p) => p.name === "length")?.default);
  if (!Number.isFinite(len) || len <= 0) return sku;
  return skuFor(sku.family, sku.key, len) ?? { ...sku, id: `${sku.id}x${len}`, length: len };
}

function buyRow(node: NodeRecord): Omit<BuyRow, "qty" | "nodes"> {
  const sku = skuAtLength(node);
  if (!sku) return { sku: node.kind, description: node.title, standard: "—", vendors: UNVERIFIED_PN };
  const family = CATALOG.families[sku.family]!;
  const vendors = Object.entries(sku.vendors ?? {}).map(([vendor, v]) => ({ vendor, pn: v.pn, url: v.url }));
  return {
    sku: sku.id,
    description: `${sku.family} ${sku.key}${sku.length !== undefined ? `×${sku.length}` : ""}${sku.material ? `, ${sku.material}` : ""}`,
    standard: family.standard ?? `none (${family.dimsSource} dims)`,
    vendors: vendors.length > 0 ? vendors : UNVERIFIED_PN,
  };
}

export function buildBom(graph: GraphDoc): Bom {
  const counts = instanceCounts(graph);
  const bom: Bom = { buy: [], print: [], fabricate: [], notGenerated: [] };
  const buy = new Map<string, BuyRow>();
  for (const node of Object.values(graph.nodes)) {
    const s = sourcingOf(node);
    if (!node.artifact?.code) {
      bom.notGenerated.push({ nodeId: node.id, title: node.title, class: s.class, status: node.status });
      continue;
    }
    const placed = counts[node.id] ?? 1;
    if (s.class === "buy") {
      const row = buyRow(node);
      const prev = buy.get(row.sku);
      if (prev) {
        prev.qty += placed;
        prev.nodes.push(node.id);
      } else buy.set(row.sku, { ...row, qty: placed, nodes: [node.id] });
      continue;
    }
    const volume = volumeOf(node);
    const material = s.material ?? (s.class === "print" ? "PLA" : "unspecified");
    const mass = volume === null ? null : round((volume / 1000) * densityOf(s.material, s.process), 1);
    const made = { nodeId: node.id, title: node.title, qty: s.qty ?? placed, process: s.process ?? "unspecified", material, volumeMm3: volume === null ? null : round(volume, 0), massG: mass };
    if (s.class === "print") {
      const filament = volume === null ? null : round(volume / (Math.PI * (FILAMENT_D_MM / 2) ** 2) / 1000, 2);
      bom.print.push({ ...made, filamentM: filament });
    } else {
      const ready = node.status === "ready";
      bom.fabricate.push({
        ...made,
        finish: s.finish ?? null,
        ready,
        vendorPackage: ready ? `/api/project/parts/${encodeURIComponent(node.id)}/vendor-package` : null,
      });
    }
  }
  bom.buy = [...buy.values()].sort((a, b) => a.sku.localeCompare(b.sku));
  return bom;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One table, three sections, then what was never generated. */
export function bomCsv(bom: Bom): string {
  const head = ["section", "item", "description", "standard", "process", "material", "qty", "volume_mm3", "mass_g", "filament_m", "vendors", "vendor_package", "status"];
  const rows: unknown[][] = [
    ...bom.buy.map((r) => [
      "buy", r.sku, r.description, r.standard, "", "", r.qty, "", "", "",
      typeof r.vendors === "string" ? r.vendors : r.vendors.map((v) => `${v.vendor} ${v.pn}`).join("; "), "", "generated",
    ]),
    ...bom.print.map((r) => ["print", r.nodeId, r.title, "", r.process, r.material, r.qty, r.volumeMm3, r.massG, r.filamentM, "", "", "generated"]),
    ...bom.fabricate.map((r) => [
      "fabricate", r.nodeId, r.title, "", r.process, r.material, r.qty, r.volumeMm3, r.massG, "", "",
      r.vendorPackage ?? "", r.ready ? "custom — send to vendor" : "gates not passed",
    ]),
    ...bom.notGenerated.map((r) => [r.class, r.nodeId, r.title, "", "", "", "", "", "", "", "", "", `not generated (${r.status})`]),
  ];
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}
