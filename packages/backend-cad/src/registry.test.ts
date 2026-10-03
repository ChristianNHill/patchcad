import { describe, expect, it } from "vitest";
import type { NodeRecord } from "@patchcad/shared";
import {
  FASTENING_HARDWARE,
  isoThreadedRodCode,
  METRIC,
  REGISTRY_HARDWARE,
  resolveDeterministic,
  resolveHardware,
  skuOf,
} from "./registry.js";
import { CATALOG, skuFor, standardLengths } from "./catalog.js";

/**
 * Registry hardware never reaches an LLM, so these are the only tests it gets
 * before the kernel gates. The measured-geometry check lives with the kernel
 * acceptance runs; this covers dispatch and the thread lookup.
 */

const node = (over: Partial<NodeRecord> = {}): NodeRecord =>
  ({
    id: "n",
    kind: "fastener",
    thread: [],
    params: {},
    contract: { params: [] },
    ...over,
  }) as unknown as NodeRecord;

describe("resolveHardware", () => {
  it("covers every registry class", () => {
    expect([...REGISTRY_HARDWARE].sort()).toEqual([
      "bearing",
      "belt",
      "bushing",
      "carriage",
      "collar",
      "dowel",
      "eclip",
      "fastener",
      "gear",
      "insert",
      "linear_bearing",
      "magnet",
      "motor",
      "nut",
      "oring",
      "pulley",
      "rail",
      "shaft",
      "standoff",
      "threaded_rod",
      "washer",
    ]);
  });

  it("only the joining hardware needs justifying by a hole port", () => {
    // A gear meshes with another gear rather than bolting to anything.
    expect(FASTENING_HARDWARE.has("gear")).toBe(false);
    for (const kind of FASTENING_HARDWARE) expect(REGISTRY_HARDWARE.has(kind), kind).toBe(true);
  });

  it("emits a complete module for every size of every catalog family", () => {
    for (const [family, f] of Object.entries(CATALOG.families)) {
      for (const key of Object.keys(f.dims)) {
        const sku = skuFor(family, key, standardLengths(family, key)[0])!;
        const code = resolveHardware(node({ kind: f.kind, params: { sku: sku.id } }));
        expect(code, sku.id).toContain("def build(p)");
        expect(code, sku.id).toContain("from build123d import *");
      }
    }
  });

  it("keeps the pre-catalog METRIC values exactly (golden)", () => {
    expect(METRIC.M3).toEqual({ clearance: 3.4, pitch: 0.5, tap: 2.5, shcsHeadD: 5.5, shcsHeadH: 3.0, insertD: 4.0, insertL: 5.8, nutAf: 5.5, nutH: 2.4 });
    expect(METRIC.M4).toEqual({ clearance: 4.5, pitch: 0.7, tap: 3.3, shcsHeadD: 7.0, shcsHeadH: 4.0, insertD: 5.6, insertL: 8.1, nutAf: 7.0, nutH: 3.2 });
    expect(METRIC.M5).toEqual({ clearance: 5.5, pitch: 0.8, tap: 4.2, shcsHeadD: 8.5, shcsHeadH: 5.0, insertD: 6.4, insertL: 9.5, nutAf: 8.0, nutH: 4.7 });
  });

  it("picks the family and default length from the SKU", () => {
    const button = resolveHardware(node({ params: { sku: "ISO7380-M3x10" } }))!;
    expect(button).toContain("fillet(");
    expect(button).toContain('p.get("length", 10)');
    expect(resolveHardware(node({ params: { sku: "ISO10642-M4x16" } }))).toContain("Cone(");
    // A bare thread is still an SHCS, so existing fastener nodes are unchanged.
    expect(resolveHardware(node({ params: { thread: "M4", length: 12 } }))).not.toContain("fillet(");
    expect(skuOf(node({ params: { thread: "M4" } }))?.family).toBe("shcs");
  });

  it("declines a SKU of another kind rather than reinterpreting it", () => {
    expect(resolveHardware(node({ kind: "fastener", params: { sku: "BRG-608" } }))).toBeNull();
    expect(resolveHardware(node({ kind: "bearing", params: { sku: "BRG-608" } }))).toContain("annulus(11, ");
  });

  it("builds a size-keyed part from `size` when there is no SKU", () => {
    expect(resolveHardware(node({ kind: "bearing", params: { size: "608" } }))).toBe(
      resolveHardware(node({ kind: "bearing", params: { sku: "BRG-608" } })),
    );
  });

  it("loads a vendor STEP when the SKU has one, falling back to the parametric model", () => {
    CATALOG.skus.push({ id: "BRG-625", family: "bearing", key: "625", stepFile: "625-2rs.step" });
    try {
      const code = resolveHardware(node({ kind: "bearing", params: { sku: "BRG-625" } }))!;
      expect(code).toContain('return load_import("625-2rs.step")');
      expect(code).toContain("except Exception:");
      expect(code).toContain("annulus(8, "); // the fallback ring is still there
    } finally {
      CATALOG.skus.pop();
    }
  });

  it("builds gears from params, so a param change needs no re-codegen", () => {
    const a = resolveHardware(node({ kind: "gear", params: { teeth: 20 } }));
    const b = resolveHardware(node({ kind: "gear", params: { teeth: 40 } }));
    expect(a).toBe(b);
    expect(a).toContain("SpurGear");
    // Injected into the kernel namespace, never imported — G0 stays closed.
    expect(a).not.toContain("bd_warehouse");
  });

  it("builds the threaded rod as one cylinder at its ISO pitch diameter", () => {
    // d - 0.6495·P: M4 (P 0.7) is Ø3.545, M5 (P 0.8) Ø4.48.
    expect(resolveHardware(node({ kind: "threaded_rod", params: { thread: "M4" } }))).toContain("Cylinder(1.7725, L)");
    expect(resolveHardware(node({ kind: "threaded_rod", params: { thread: "M5" } }))).toContain("Cylinder(2.24, L)");
    expect(resolveHardware(node({ kind: "threaded_rod", params: { thread: "M4" } }))).not.toContain("IsoThread");
    expect(isoThreadedRodCode("M4")).toContain("pitch=0.7");
  });

  it("takes the thread from live params first, contract default second", () => {
    expect(resolveHardware(node({ kind: "nut", params: { thread: "M5" } }))).toContain(
      `${METRIC.M5!.nutAf}`,
    );
    const byDefault = node({
      kind: "nut",
      params: {},
      contract: { params: [{ type: "enum", name: "thread", description: "", default: "M3", options: ["M3"] }] },
    } as unknown as Partial<NodeRecord>);
    expect(resolveHardware(byDefault)).toContain(`${METRIC.M3!.nutAf}`);
  });

  it("is case-insensitive about the thread", () => {
    expect(resolveHardware(node({ kind: "nut", params: { thread: "m4" } }))).toBe(
      resolveHardware(node({ kind: "nut", params: { thread: "M4" } })),
    );
  });

  it("declines rather than guessing an unknown thread or kind", () => {
    expect(resolveHardware(node({ kind: "nut", params: { thread: "M10" } }))).toBeNull();
    expect(resolveHardware(node({ kind: "part", params: { thread: "M4" } }))).toBeNull();
  });

  it("gives each thread its own geometry, which is why T1 re-codegens", () => {
    // An M5 nut is different code, not an M4 with new params.
    const m4 = resolveHardware(node({ kind: "nut", params: { thread: "M4" } }));
    const m5 = resolveHardware(node({ kind: "nut", params: { thread: "M5" } }));
    expect(m4).not.toBe(m5);
  });
});

describe("resolveDeterministic", () => {
  it("routes hardware to the registry", () => {
    // A kind's first family is its default when a node names a size, not a SKU.
    const defaults = new Map(Object.values(CATALOG.families).reverse().map((f) => [f.kind, f]));
    for (const f of defaults.values()) {
      const key = Object.keys(f.dims)[0]!;
      const params = { [f.keyedBy]: key, teeth: 20 };
      expect(resolveDeterministic(node({ kind: f.kind, params })), f.kind).toContain("def build(p)");
    }
  });

  it("loads an imported mesh, until the user reprompts it", () => {
    const imported = node({ kind: "imported", id: "piece-1" });
    expect(resolveDeterministic(imported)).toContain('load_import("piece-1.ply"');
    // A non-empty thread means the user specialized it — that goes to the
    // generator, which edits the mesh instead.
    expect(
      resolveDeterministic(node({ kind: "imported", id: "piece-1", thread: [{ role: "user", content: "drill it", at: 1 }] })),
    ).toBeNull();
  });

  it("leaves ordinary parts to the generator", () => {
    expect(resolveDeterministic(node({ kind: "part" }))).toBeNull();
  });
});
