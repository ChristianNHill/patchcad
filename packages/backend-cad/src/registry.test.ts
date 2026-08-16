import { describe, expect, it } from "vitest";
import type { NodeRecord } from "@patchcad/shared";
import { METRIC, REGISTRY_HARDWARE, resolveDeterministic, resolveHardware } from "./registry.js";

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
  it("covers screw, nut and insert", () => {
    expect([...REGISTRY_HARDWARE].sort()).toEqual(["fastener", "insert", "nut"]);
  });

  it("emits a complete module per kind", () => {
    for (const kind of REGISTRY_HARDWARE) {
      const code = resolveHardware(node({ kind, params: { thread: "M4" } }));
      expect(code, kind).toContain("def build(p)");
      expect(code, kind).toContain("from build123d import *");
    }
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
