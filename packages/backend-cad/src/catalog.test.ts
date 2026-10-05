import { describe, expect, it } from "vitest";
import raw from "../catalog/hardware.json" with { type: "json" };
import {
  CATALOG,
  Catalog,
  Sku,
  familyDims,
  parseSku,
  pickLength,
  skuFor,
  standardLengths,
  threadSpec,
} from "./catalog.js";

/** The catalog is data the registry, the bindings and the kernel all trust, so
 *  these check its shape and the handful of numbers worth knowing by heart. */

const THREADS = ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8"];

describe("catalog schema", () => {
  it("parses the shipped file", () => {
    expect(() => Catalog.parse(raw)).not.toThrow();
  });

  it("rejects a thread-keyed row for a thread it does not know", () => {
    const bad = structuredClone(raw) as { families: { shcs: { dims: Record<string, unknown> } } };
    bad.families.shcs.dims.M7 = { headD: 1, headH: 1, socketAf: 1 };
    expect(() => Catalog.parse(bad)).toThrow(/unknown thread M7/);
  });

  it("rejects a vendor entry nobody verified", () => {
    const base = { id: "ISO4762-M3x12", family: "shcs", key: "M3", length: 12 };
    const vendor = { pn: "PN-FROM-A-PERSON", url: "https://example.com/p" };
    expect(Sku.safeParse({ ...base, vendors: { mcmaster: vendor } }).success).toBe(false);
    expect(Sku.safeParse({ ...base, vendors: { mcmaster: { ...vendor, verifiedAt: "2026-10-02" } } }).success).toBe(true);
    // Vendors are optional, and the shipped catalog invents none.
    expect(Sku.safeParse(base).success).toBe(true);
    expect(CATALOG.skus.filter((s) => s.vendors)).toEqual([]);
  });

  it("rejects a SKU for a size the catalog lacks", () => {
    const bad = { ...structuredClone(raw), skus: [{ id: "BRG-699", family: "bearing", key: "699" }] };
    expect(() => Catalog.parse(bad)).toThrow(/no bearing 699/);
  });
});

describe("catalog coverage", () => {
  it("has every thread, in clearance > nominal > tap drill order", () => {
    for (const t of THREADS) {
      const s = threadSpec(t)!;
      expect(s, t).toBeDefined();
      const nominal = Number(t.slice(1));
      expect(s.clearance, t).toBeGreaterThan(nominal);
      expect(nominal, t).toBeGreaterThan(s.tapDrill);
      expect(s.engagementMin.fdm, t).toBeGreaterThan(s.engagementMin.steel!);
    }
  });

  it("covers every category the plan names", () => {
    const listFamilies = (category: string) =>
      Object.entries(CATALOG.families).filter(([, f]) => f.category === category).map(([name]) => name);
    expect(listFamilies("fasteners")).toEqual(
      expect.arrayContaining(["shcs", "button", "csk", "hex_nut", "washer", "dowel", "heatset_short", "heatset_std"]),
    );
    expect(listFamilies("bearings")).toEqual(expect.arrayContaining(["bearing", "bearing_flanged"]));
    expect(listFamilies("plain_bearings")).toEqual(expect.arrayContaining(["bushing"]));
    expect(listFamilies("shafts")).toEqual(expect.arrayContaining(["shaft", "d_shaft", "collar", "eclip"]));
    expect(listFamilies("linear")).toEqual(expect.arrayContaining(["lm_uu", "mgn_rail", "mgn_carriage"]));
    expect(listFamilies("transmission")).toEqual(expect.arrayContaining(["gt2_pulley", "gt2_belt", "spur_gear"]));
    expect(listFamilies("motors")).toEqual(expect.arrayContaining(["nema17", "nema14", "brushless", "n20", "sg90", "mg996r", "sts3215"]));
    expect(listFamilies("fasteners")).toEqual(expect.arrayContaining(["wood_dowel", "confirmat", "cam_lock", "cam_bolt", "dowel_screw", "filament_pin", "wire_nail"]));
    expect(listFamilies("misc")).toEqual(expect.arrayContaining(["disc_magnet", "oring", "standoff"]));
  });

  // real-step-stool: furniture screws were M6 SHCS. Wood screws are their own
  // family, and the thread is modelled at its core so a hardwood pilot clears it.
  it("stocks DIN 7505 chipboard screws 3.5-5 apart from SHCS, core under the hardwood pilot", () => {
    for (const k of ["3.5", "4", "4.5", "5"]) {
      const r = familyDims("chipboard", k)!;
      expect(r.d, k).toBe(Number(k));
      expect(r.headD, k).toBe(2 * Number(k));
      expect(r.core as number, k).toBeLessThanOrEqual(r.pilotHard as number);
      expect(standardLengths("chipboard", k).length, k).toBeGreaterThan(0);
    }
    expect(CATALOG.families.chipboard!.kind).toBe("fastener");
  });

  it("seats a V-slot wheel kit on two catalog 625 bearings", () => {
    const w = familyDims("v_wheel", "SOLID")!;
    const b = familyDims("bearing", String(w.bearing))!;
    expect(w.seatD).toBe(b.od);
    expect(w.bore).toBe(b.bore);
    // Two 5mm bearings and the 1mm shim stand past the 10.23 wheel, half each side.
    expect(2 * (b.width as number) + (w.shim as number)).toBeCloseTo((w.width as number) + 2 * (w.proud as number), 6);
  });

  it("gives every thread-keyed fastener family M3, M4 and M5", () => {
    for (const f of ["shcs", "button", "csk", "hex_nut", "washer", "heatset_std", "heatset_short"]) {
      for (const t of ["M3", "M4", "M5"]) expect(familyDims(f, t), `${f} ${t}`).toBeDefined();
    }
  });

  it("covers the deep-groove series 623–608, 6800–6805, 6900–6902 and F623–F608", () => {
    for (const k of ["623", "624", "625", "626", "627", "628", "629", "608", "6800", "6805", "6900", "6902"]) {
      expect(familyDims("bearing", k), k).toBeDefined();
    }
    for (const k of ["F623", "F625", "F608"]) expect(familyDims("bearing_flanged", k), k).toBeDefined();
    expect(familyDims("bearing", "MR85")).toMatchObject({ bore: 5, od: 8, width: 2.5 });
    expect(familyDims("bearing", "mr105")).toMatchObject({ bore: 5, od: 10, width: 4 });
  });

  it("orders every row sensibly", () => {
    for (const [family, f] of Object.entries(CATALOG.families)) {
      for (const [key, r] of Object.entries(f.dims)) {
        const at = `${family} ${key}`;
        if (typeof r.od === "number" && typeof r.bore === "number") expect(r.od, at).toBeGreaterThan(r.bore);
        if (typeof r.od === "number" && typeof r.id === "number") expect(r.od, at).toBeGreaterThan(r.id);
        if (typeof r.headD === "number") expect(r.headD, at).toBeGreaterThan(Number(key.slice(1)));
        if (typeof r.minBossOd === "number") expect(r.minBossOd, at).toBeGreaterThan(r.holeD as number);
        if (typeof r.pocketDepth === "number") expect(r.pocketDepth, at).toBeGreaterThan(r.length as number);
        if (typeof r.flangeD === "number" && typeof r.od === "number") expect(r.flangeD, at).toBeGreaterThan(r.od);
        for (const ref of ["setScrew", "holeThread", "mountThread"]) {
          if (ref in r) expect(threadSpec(String(r[ref])), `${at} ${ref}`).toBeDefined();
        }
      }
      for (const lengths of Object.values(f.lengths ?? {})) {
        expect([...lengths].sort((a, b) => a - b), family).toEqual(lengths);
      }
    }
  });

  it("gives every family that is cut or sold by length a stocked length per size", () => {
    const byLength = ["shcs", "button", "csk", "dowel", "threaded_rod", "bushing", "shaft", "d_shaft", "mgn_rail", "gt2_belt", "nema17", "standoff",
      "wood_dowel", "confirmat", "dowel_screw", "filament_pin", "wire_nail", "nema14"];
    for (const family of byLength) {
      for (const key of Object.keys(CATALOG.families[family]!.dims)) {
        expect(standardLengths(family, key).length, `${family} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("marks what was not transcribed from a standard", () => {
    for (const f of ["heatset_std", "heatset_short", "mgn_rail", "mgn_carriage", "brushless", "n20", "sg90", "gt2_pulley",
      "confirmat", "cam_lock", "cam_bolt", "dowel_screw", "mg996r", "sts3215"]) {
      expect(CATALOG.families[f]!.dimsSource, f).toBe("family-typical");
    }
    // A row can be less certain than its family.
    expect(familyDims("button", "M3")!.dimsSource ?? CATALOG.families.button!.dimsSource).toBe("standard");
    expect(familyDims("button", "M2")!.dimsSource).toBe("family-typical");
  });
});

describe("golden values", () => {
  it("matches the standards on the sizes people use most", () => {
    expect(threadSpec("M3")).toMatchObject({ pitch: 0.5, clearance: 3.4, tapDrill: 2.5 });
    expect(threadSpec("M8")).toMatchObject({ pitch: 1.25, clearance: 9, tapDrill: 6.8 });
    expect(familyDims("shcs", "M3")).toMatchObject({ headD: 5.5, headH: 3 });
    // DIN 1151 A, NEMA 14 faceplate, and the Feetech STS3215 drawing.
    expect(familyDims("wire_nail", "2.2")).toMatchObject({ d: 2.2, headD: 4.4 });
    expect(familyDims("nema14", "NEMA14")).toMatchObject({ face: 35, holePitch: 26, pilotD: 22, shaftD: 5 });
    // Waveshare ST3215 DXF: case 32 (35 with the Ø19.2 × 3 horn), M2 pilots 20.7 × 20.5 off-centre.
    expect(familyDims("sts3215", "STS3215")).toMatchObject({ bodyL: 45.23, bodyW: 24.73, bodyH: 32, splineD: 19.2, splineH: 3, hornPcd: 14, holePitch: 20.7, holeRowPitch: 20.5, holeD: 1.6 });
    expect(familyDims("button", "M4")).toMatchObject({ headD: 7.6, headH: 2.2 });
    expect(familyDims("csk", "M5")).toMatchObject({ headD: 11.2, headH: 3.1, angle: 90 });
    expect(familyDims("hex_nut", "M6")).toMatchObject({ af: 10, height: 5.2 });
    expect(familyDims("washer", "M4")).toMatchObject({ id: 4.3, od: 9, thickness: 0.8 });
    expect(familyDims("bearing", "608")).toMatchObject({ bore: 8, od: 22, width: 7 });
    expect(familyDims("bearing", "625")).toMatchObject({ bore: 5, od: 16, width: 5 });
    expect(familyDims("bearing", "6805")).toMatchObject({ bore: 25, od: 37, width: 7 });
    expect(familyDims("lm_uu", "LM8UU")).toMatchObject({ bore: 8, od: 15, length: 24 });
    expect(familyDims("nema17", "NEMA17")).toMatchObject({ face: 42.3, holePitch: 31, pilotD: 22, shaftD: 5 });
  });
});

describe("lookup", () => {
  it("is case- and spelling-tolerant about keys", () => {
    expect(familyDims("shcs", "m4")).toBe(familyDims("shcs", "M4"));
    expect(familyDims("oring", "3.0")).toBe(familyDims("oring", "3"));
    expect(familyDims("lm_uu", "lm8uu")).toBeDefined();
    expect(familyDims("shcs", "M10")).toBeUndefined();
  });

  it("mints and parses SKU ids both ways", () => {
    expect(skuFor("shcs", "m3", 12)).toEqual({ id: "ISO4762-M3x12", family: "shcs", key: "M3", length: 12 });
    expect(skuFor("bearing", "608")?.id).toBe("BRG-608");
    expect(skuFor("shcs", "M3", 13)).toBeUndefined(); // not stocked
    for (const id of ["ISO4762-M3x12", "BRG-608", "BRG-F608", "MAG-6x3", "BUSH-8x12x10", "ROD-8x200", "GT2P-20T-5", "NEMA-NEMA17x40"]) {
      expect(parseSku(id)?.id, id).toBe(id);
    }
    expect(parseSku("BRG-F608")?.family).toBe("bearing_flanged");
    expect(parseSku("BUSH-8x12x10")).toMatchObject({ key: "8x12", length: 10 });
    expect(parseSku("ISO4762-M99x12")).toBeUndefined();
  });

  it("picks the shortest stocked length in range", () => {
    expect(pickLength("shcs", "M3", { min: 13.5 })).toBe(16);
    expect(pickLength("shcs", "M3", { min: 13.5, max: 15 })).toBeUndefined();
    expect(pickLength("csk", "M4", { min: 9, max: 12 })).toBe(10);
    expect(pickLength("shcs", "M3", { min: 31 })).toBeUndefined(); // ISO 4762 M3 stops at 30
  });
});
