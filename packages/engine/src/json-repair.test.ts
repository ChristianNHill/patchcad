import { describe, expect, it } from "vitest";
import { parseJsonLoose } from "./json-repair.js";

describe("parseJsonLoose", () => {
  it("parses clean and fenced JSON as JSON.parse does", () => {
    expect(parseJsonLoose('```json\n{"a":[1,2],"b":"}"}\n```')).toEqual({ a: [1, 2], b: "}" });
  });

  it("drops trailing commas and quotes bare keys", () => {
    expect(parseJsonLoose('{"nodes": [{"id": "a",}, {"id": "b"},], edges: [], "x": {y: 1,},}')).toEqual({
      nodes: [{ id: "a" }, { id: "b" }], edges: [], x: { y: 1 },
    });
  });

  it("leaves commas, colons and braces inside strings alone", () => {
    expect(parseJsonLoose('{"spec": "a, b: {c}", "n": 1,}')).toEqual({ spec: "a, b: {c}", n: 1 });
  });

  it("closes a reply cut off mid-string, mid-key or mid-value", () => {
    expect(parseJsonLoose('{"nodes": [{"id": "a"}, {"id": "b", "spec": "half a sent')).toEqual({ nodes: [{ id: "a" }, { id: "b", spec: "half a sent" }] });
    expect(parseJsonLoose('{"nodes": [{"id": "a"}], "edges": [{"from": "a", "to"')).toEqual({ nodes: [{ id: "a" }], edges: [{ from: "a" }] });
    expect(parseJsonLoose('{"nodes": [{"id": "a"}], "n": tr')).toEqual({ nodes: [{ id: "a" }] });
  });

  it("throws the strict error when nothing parses", () => {
    expect(() => parseJsonLoose("no object here")).toThrow(/no JSON object/);
  });
});
