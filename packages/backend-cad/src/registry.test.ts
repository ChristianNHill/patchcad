import { describe, expect, it } from "vitest";
import type { NodeRecord } from "@patchcad/shared";
import {
  FASTENING_HARDWARE,
  METRIC,
  REGISTRY_HARDWARE,
  resolveDeterministic,
  resolveHardware,
} from "./registry.js";

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
      "fastener",
      "gear",
      "insert",
      "nut",
      "threaded_rod",
    ]);
  });

  it("only the joining hardware needs justifying by a hole port", () => {
    // A gear meshes with another gear rather than bolting to anything.
    expect(FASTENING_HARDWARE.has("gear")).toBe(false);
    for (const kind of FASTENING_HARDWARE) expect(REGISTRY_HARDWARE.has(kind), kind).toBe(true);
  });

  it("emits a complete module per kind", () => {
    for (const kind of REGISTRY_HARDWARE) {
      const code = resolveHardware(node({ kind, params: { thread: "M4" } }));
      expect(code, kind).toContain("def build(p)");
      expect(code, kind).toContain("from build123d import *");
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

  it("gives the threaded rod its ISO pitch from the table", () => {
    expect(resolveHardware(node({ kind: "threaded_rod", params: { thread: "M4" } }))).toContain("pitch=0.7");
    expect(resolveHardware(node({ kind: "threaded_rod", params: { thread: "M5" } }))).toContain("pitch=0.8");
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
    expect(resolveHardware(node({ kind: "nut", params: { thread: "M6" } }))).toBeNull();
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
    for (const kind of REGISTRY_HARDWARE) {
      expect(resolveDeterministic(node({ kind, params: { thread: "M4" } })), kind).toContain("def build(p)");
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
