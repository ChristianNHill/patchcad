import { describe, it, expect } from "vitest";
import { fnv1a64, hashValue } from "@patchcad/shared";

/**
 * Contract hashes key the node library on disk (~/.patchcad/library/<backend>/<hash>.json)
 * and drive dirty detection. If fnv1a64 ever moves, every cached entry is
 * orphaned silently — nothing fails, the library just stops hitting.
 *
 * These values are golden: changing them is a cache migration, not a refactor.
 * Literals are escaped rather than typed, because a raw multi-byte character
 * survives an editor round-trip only by luck, and a mangled input would pin
 * the wrong hash while still looking right.
 */
describe("fnv1a64 is stable across encoder changes", () => {
  const golden: Array<[string, string]> = [
    ["", "cbf29ce484222325"],
    ["a", "af63dc4c8601ec8c"],
    ["hello world", "779a65e7023cd2e7"],
    ["plate", "fda90e4e16a0fe03"],
    ["Ø8 bore", "07de9b2588d9644c"], // 2-byte
    ["café", "48e8823acfa40d89"], // 2-byte
    ["日本語", "ee9ee2b5c854ef87"], // 3-byte
    ["\u{1d11e}\u{1d54f}\u{1f389}", "8da5c35323ad5097"], // 4-byte, surrogate pairs
    ["M4×12 SHCS", "5c71f43e6d7e1712"],
    ["߿ࠀ￿", "2d8a49a525231170"], // exact 2/3-byte boundaries
  ];

  for (const [input, expected] of golden) {
    it(`hashes ${JSON.stringify(input)} unchanged`, () => {
      expect(fnv1a64(input)).toBe(expected);
    });
  }

  it("hashes a realistic contract payload unchanged", () => {
    const payload = JSON.stringify({
      ports: { bolt: { type: "CLEARANCE_HOLE", diameter: 4.5 } },
      params: { thickness: 5 },
    });
    expect(fnv1a64(payload)).toBe("f1922d9f13241256");
  });

  it("sorts keys before hashing, so field order cannot move a library key", () => {
    expect(hashValue({ b: 1, a: 2 })).toBe(hashValue({ a: 2, b: 1 }));
  });
});
