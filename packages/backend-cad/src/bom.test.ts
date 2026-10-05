import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { GraphDoc, type NodeRecord } from "@patchcad/shared";
import rawSuppliers from "../catalog/suppliers.json" with { type: "json" };
import { buildBom, bomCsv, buyRow } from "./bom.js";
import { CATALOG, CATEGORIES, SUPPLIERS, Suppliers, parseSku, type Sku } from "./catalog.js";
import { designationOf, orderLinks, searchTerms, supplierGroup } from "./ordering.js";
import { CadBackend } from "./index.js";
import { instructionsDocument, buildSequence } from "./instructions.js";

/** A bought catalog node: just enough record for skuOf and the length param. */
function hw(id: string, kind: string, params: Record<string, string | number>): NodeRecord {
  return {
    id,
    kind,
    title: id,
    spec: "",
    status: "ready",
    params,
    contract: { name: id, summary: "", params: [], provides: [], requires: [], payload: { units: "mm", ports: [] }, hash: "" },
    artifact: { code: "def build(p): pass", version: 1, hash: "h" },
  } as unknown as NodeRecord;
}

const row = (kind: string, params: Record<string, string | number>) => buyRow(hw("n", kind, params));

describe("designation", () => {
  it("names each family the way a supplier lists it", () => {
    expect(row("fastener", { sku: "ISO4762-M3x12" }).designation).toBe("ISO 4762 M3×12 socket head cap screw");
    expect(row("fastener", { sku: "ISO7380-M4x10" }).designation).toBe("ISO 7380-1 M4×10 button head socket screw");
    // ISO 7380-1 starts at M3: an M2 button head is not called by it.
    expect(row("fastener", { sku: "ISO7380-M2x6" }).designation).toBe("M2×6 button head socket screw");
    expect(row("nut", { sku: "ISO4032-M4" }).designation).toBe("ISO 4032 M4 hex nut");
    expect(row("washer", { sku: "ISO7089-M5" }).designation).toBe("ISO 7089 M5 flat washer");
    expect(row("bearing", { sku: "BRG-608" }).designation).toBe("608 deep groove ball bearing 8×22×7");
    // The catalog's 688 row is the shielded width.
    expect(row("bearing", { sku: "BRG-688" }).designation).toMatch(/^688ZZ deep groove ball bearing 8×16×5$/);
    // Only rows transcribed from DIN 705 A carry its name.
    expect(row("collar", { sku: "COLLAR-8" }).designation).toBe("8 mm bore shaft collar, Ø16×8, M4 set screw");
    expect(row("collar", { sku: "COLLAR-16" }).designation).toBe("DIN 705 A 16 shaft collar, Ø28×12, M6 set screw");
    expect(row("motor", { sku: "NEMA-NEMA17x40" }).designation).toBe("NEMA 17 stepper motor, 40 mm body");
    expect(row("belt", { sku: "GT2L-6x200" }).designation).toBe("GT2 200 mm closed timing belt, 6 mm wide");
    expect(row("linear_bearing", { sku: "LIN-LM8UU" }).designation).toBe("LM8UU linear ball bearing 8×15×24");
    expect(row("pulley", { sku: "GT2P-20T-5" }).designation).toBe("GT2 20T timing pulley 5 mm bore, for 6 mm belt");
    expect(row("magnet", { sku: "MAG-6x3" }).designation).toBe("Ø6×3 mm neodymium disc magnet");
    expect(row("fastener", { sku: "DIN7505-4x30" }).designation).toBe("DIN 7505 A 4×30 countersunk chipboard screw, PZ2");
  });

  it("gives a cut rod its cut length, and searches for the stock", () => {
    const r = row("shaft", { sku: "ROD-8", length: 178.6 });
    expect(r.sku).toBe("ROD-8x178.6");
    expect(r.designation).toBe("Ø8 h6 ground rod, cut to 178.6 mm");
    expect(searchTerms(r.designation)).toBe("8 mm h6 ground rod");
    expect(searchTerms("ISO 4762 M3×12 socket head cap screw, A2 stainless")).toBe("ISO 4762 M3x12 socket head cap screw");
    expect(searchTerms("Ø6×3 mm neodymium disc magnet", "N52")).toBe("6x3 mm neodymium disc magnet N52");
  });

  it("names an architect's gear by module and teeth", () => {
    const gear = hw("g", "gear", { module: 1, teeth: 20 });
    expect(buyRow(gear).designation).toBe("module 1 spur gear 20 teeth, 20° pressure angle");
  });

  it("ends with the sku's material when the catalog names one", () => {
    const sku: Sku = { id: "ISO4762-M3x12", family: "shcs", key: "M3", length: 12, material: "A2 stainless" };
    expect(designationOf(hw("n", "fastener", {}), sku)).toBe("ISO 4762 M3×12 socket head cap screw, A2 stainless");
    expect(orderLinks(sku, "shcs", designationOf(hw("n", "fastener", {}), sku))[0]!.url).toBe("https://www.mcmaster.com/ISO%204762%20M3x12%20socket%20head%20cap%20screw%20A2%20stainless");
  });
});

describe("order links", () => {
  const verifiedSku: Sku = {
    id: "ISO4762-M3x12",
    family: "shcs",
    key: "M3",
    length: 12,
    vendors: { mcmaster: { pn: "PN-ENTERED-BY-A-PERSON", url: "https://www.mcmaster.com/PN-ENTERED-BY-A-PERSON/", verifiedAt: "2026-10-04" } },
  };

  afterEach(() => {
    CATALOG.skus.splice(0, CATALOG.skus.length);
  });

  it("puts verified vendor entries first, and never searches that vendor again", () => {
    const links = orderLinks(verifiedSku, "shcs", "ISO 4762 M3×12 socket head cap screw");
    expect(links[0]).toEqual({
      vendor: "McMaster-Carr", url: "https://www.mcmaster.com/PN-ENTERED-BY-A-PERSON/", kind: "verified", pn: "PN-ENTERED-BY-A-PERSON", verifiedAt: "2026-10-04",
    });
    expect(links.slice(1).every((l) => l.kind === "search")).toBe(true);
    expect(links.filter((l) => l.vendor === "McMaster-Carr")).toHaveLength(1);
  });

  it("carries a verified entry from the catalog through the BOM and its CSV", () => {
    CATALOG.skus.push(verifiedSku);
    const bom = buildBom(graph([hw("s", "fastener", { sku: "ISO4762-M3x12" })]));
    expect(bom.buy[0]!.orderFrom[0]).toMatchObject({ kind: "verified", pn: "PN-ENTERED-BY-A-PERSON" });
    expect(bomCsv(bom)).toContain("McMaster-Carr PN-ENTERED-BY-A-PERSON (verified 2026-10-04)");
  });

  it("encodes the designation into each supplier's search URL", () => {
    const [first] = row("fastener", { sku: "ISO4762-M3x12" }).orderFrom;
    expect(first).toEqual({ vendor: "McMaster-Carr", kind: "search", url: "https://www.mcmaster.com/ISO%204762%20M3x12%20socket%20head%20cap%20screw" });
    const misumi = row("shaft", { sku: "ROD-8", length: 100 }).orderFrom[0]!;
    expect(misumi.url).toBe("https://us.misumi-ec.com/vona2/result/?Keyword=8%20mm%20h6%20ground%20rod");
    // & and # in a designation cannot break out of the query.
    const odd = orderLinks(null, undefined, "A&B #1");
    expect(odd.map((l) => l.url)).toContain("https://www.amazon.com/s?k=A%26B%20%231");
  });

  it("never shows a part number unless the catalog has a verified entry", () => {
    // Every size of every family, as the shipped catalog stands (no vendors).
    for (const [family, f] of Object.entries(CATALOG.families)) {
      for (const key of Object.keys(f.dims)) {
        const len = f.lengths?.[key]?.[0];
        const sku = parseSku(`${f.skuPrefix}-${key}${len ? `x${len}` : ""}`);
        if (!sku || sku.family !== family) continue;
        const links = orderLinks(sku, family, designationOf(hw("n", f.kind, {}), sku));
        expect(links.length, `${family} ${key}`).toBeGreaterThanOrEqual(2);
        for (const l of links) {
          expect(l.kind, `${family} ${key}`).toBe("search");
          expect(l).not.toHaveProperty("pn");
        }
      }
    }
  });

  it("orders each family from a group that fits it", () => {
    expect(supplierGroup("heatset_std")).toBe("inserts");
    expect(supplierGroup("bearing")).toBe("bearings");
    expect(supplierGroup("nema17")).toBe("steppers");
    expect(supplierGroup("chipboard")).toBe("wood_fasteners");
    expect(supplierGroup("gt2_pulley")).toBe("transmission");
    expect(supplierGroup(undefined)).toBe("general");
    // The marketplace is the last resort in every group.
    for (const vendors of Object.values(SUPPLIERS.groups)) expect(vendors.at(-1)).toBe("amazon");
  });
});

describe("suppliers schema", () => {
  it("parses the shipped file and covers every catalog category", () => {
    expect(() => Suppliers.parse(rawSuppliers)).not.toThrow();
    for (const c of CATEGORIES) expect(SUPPLIERS.groups[SUPPLIERS.byCategory[c]!], c).toBeDefined();
  });

  it("rejects a template without {q}, an unknown vendor, or a family the catalog lacks", () => {
    const bad = (patch: (s: typeof rawSuppliers) => void) => {
      const s = structuredClone(rawSuppliers);
      patch(s);
      return Suppliers.safeParse(s).success;
    };
    expect(bad((s) => (s.vendors.amazon.search = "https://www.amazon.com/s"))).toBe(false);
    expect(bad((s) => (s.groups.fasteners = ["nobody"]))).toBe(false);
    expect(bad((s) => ((s.byFamily as Record<string, string>).warp_drive = "general"))).toBe(false);
  });
});

function graph(nodes: NodeRecord[]) {
  return GraphDoc.parse({
    schemaVersion: 1,
    id: "g",
    backend: "cad",
    brief: { goal: "", constraints: [], clarifications: [] },
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: [],
    assembly: { entryNodeId: nodes[0]!.id },
  });
}

describe("examples", () => {
  function example(name: string) {
    const root = new URL(`../../../examples/${name}/`, import.meta.url);
    const g = GraphDoc.parse(JSON.parse(readFileSync(new URL("patchcad.json", root), "utf8")));
    for (const n of Object.values(g.nodes)) {
      const f = new URL(`nodes/${n.id}/v1.code.py`, root);
      if (existsSync(f)) n.artifact = { ...n.artifact!, code: readFileSync(f, "utf8") };
    }
    return g;
  }

  it("cad-belt-drive: every bought row has a designation and search links, and only bought rows do", () => {
    const g = example("cad-belt-drive");
    const bom = buildBom(g);
    expect(bom.buy.length).toBeGreaterThan(3);
    for (const r of bom.buy) {
      expect(r.designation, r.sku).not.toBe("");
      expect(r.orderFrom.length, r.sku).toBeGreaterThanOrEqual(2);
    }
    const csv = bomCsv(bom).split("\n");
    expect(csv[0]).toContain("designation");
    expect(csv[0]).toContain("search_link");
  });

  it("cad-joints: the instructions list each bought part's designation and where to order it", () => {
    const g = example("cad-joints");
    const scene = new CadBackend().solveScene(g);
    const { document } = instructionsDocument(g, scene, buildSequence(g, scene));
    expect(document.items.map((i) => i.designation)).toEqual(expect.arrayContaining(["ISO 7380-1 M3×10 button head socket screw"]));
    expect(document.order.map((o) => [o.designation, o.qty])).toEqual(expect.arrayContaining([["ISO 7380-1 M3×10 button head socket screw", 4]]));
    for (const o of document.order) expect(o.links.every((l) => l.kind === "search")).toBe(true);
  });
});
