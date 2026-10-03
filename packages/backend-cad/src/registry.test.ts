import { describe, expect, it } from "vitest";
import type { NodeRecord } from "@patchcad/shared";
import {
  FASTENING_HARDWARE,
  METRIC,
  REGISTRY_HARDWARE,
  resolveDeterministic,
  resolveHardware,
  skuOf,
  unresolvedHardware,
} from "./registry.js";
import { cadHardwareResolvesLint } from "./index.js";
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
    // Containment, not equality: drive families keep adding kinds. Every kind
    // building is the per-family module test's job.
    expect([...REGISTRY_HARDWARE]).toEqual(
      expect.arrayContaining([
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
          ]),
    );
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
    expect(skuOf(node({ kind: "fastener", params: { sku: "BRG-608" } }))).toBeNull();
    expect(resolveHardware(node({ kind: "fastener", params: { sku: "BRG-608" } }))).toContain("raise ValueError(");
    expect(resolveHardware(node({ kind: "bearing", params: { sku: "BRG-608" } }))).toContain("annulus(11, ");
  });

  it("cuts a part's own HUB_BORE at its fit band's middle, not the nominal", () => {
    // spur-gear-pair: a Ø5 gear bore failed the slip band 5.05..5.25 for good.
    const hub = (params: Record<string, string | number>, sourcing?: object) =>
      ({ params: [], payload: { ports: [{ name: "bore", type: "HUB_BORE", params: { diameter: 5, ...params } }], ...(sourcing ? { sourcing } : {}) } }) as never;
    expect(resolveHardware(node({ kind: "gear", contract: { params: [] } as never }))).toContain("Cylinder(p.bore / 2");
    expect(resolveHardware(node({ kind: "gear", contract: hub({}) }))).toContain("Cylinder((p.bore + 0.15) / 2");
    expect(resolveHardware(node({ kind: "gear", contract: hub({ fit: "press" }) }))).toContain("Cylinder((p.bore - 0.05) / 2");
    expect(resolveHardware(node({ kind: "gear", contract: hub({}, { class: "fabricate", process: "cnc", material: "steel" }) }))).toContain("(p.bore + 0.025)");
    // Every bored catalog family: the pulley's Ø5 bore, cut at 5.15.
    expect(resolveHardware(node({ kind: "pulley", params: { sku: "GT2P-20T-5" }, contract: hub({}) }))).toContain("Cylinder(2.575, ");
    expect(resolveHardware(node({ kind: "pulley", params: { sku: "GT2P-20T-5" } }))).toContain("Cylinder(2.5, ");
  });

  it("builds a size-keyed part from `size` when there is no SKU", () => {
    expect(resolveHardware(node({ kind: "bearing", params: { size: "608" } }))).toBe(
      resolveHardware(node({ kind: "bearing", params: { sku: "BRG-608" } })),
    );
  });

  it("loads a vendor STEP when the SKU has one, falling back to the parametric model only when it is missing", () => {
    CATALOG.skus.push({ id: "BRG-625", family: "bearing", key: "625", stepFile: "625-2rs.step" });
    try {
      const code = resolveHardware(node({ kind: "bearing", params: { sku: "BRG-625" } }))!;
      expect(code).toContain('return load_import("625-2rs.step")');
      // A STEP that is there but broken must fail, not hide behind the fallback.
      expect(code).toContain("except FileNotFoundError:");
      expect(code).not.toContain("except Exception");
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

  it("leaves a non-hardware kind to the generator", () => {
    expect(resolveHardware(node({ kind: "part", params: { thread: "M4" } }))).toBeNull();
  });

  it("never hands hardware with an unknown thread or sku to the generator", () => {
    // null here meant the engine fell through to the LLM and generated a screw.
    for (const params of [{ thread: "M10" }, { sku: "ISO4032-M10" }, { sku: "BRG-608" }] as Record<string, string>[]) {
      const code = resolveHardware(node({ kind: "nut", params }));
      expect(code, JSON.stringify(params)).toContain("raise ValueError(");
      expect(code).toContain("names no nut in the hardware catalog");
    }
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

describe("cadHardwareResolvesLint", () => {
  const graph = (nodes: NodeRecord[]) =>
    ({ nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: [] }) as never;

  it("fails a hardware node whose sku or thread names no catalog row, at plan time", () => {
    const problems = cadHardwareResolvesLint.run(
      graph([
        node({ id: "nut-a", kind: "nut", params: { thread: "M10" } }),
        node({ id: "j1_screw", kind: "fastener", params: { sku: "ISO4762-M3x13" } }),
        node({ id: "ok", kind: "nut", params: { thread: "M4" } }),
        node({ id: "plate", kind: "part" }),
      ]),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^nut-a: nut thread "M10" names no nut in the hardware catalog \(hex_nut has M2, /);
    expect(problems[1]).toMatch(/^j1_screw: fastener sku "ISO4762-M3x13"/);
    expect(unresolvedHardware(node({ kind: "gear" }))).toBeNull();
  });
});
