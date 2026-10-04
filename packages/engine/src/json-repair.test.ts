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

  // real-planetary-gearbox: "Expected double-quoted property name" at 5423
  // and 11638 on three runs, through this repair: V8 says that only when an
  // object member starts with something other than " or }.
  it("drops // and block comments outside strings, keeping // inside them", () => {
    const raw = `{
  "nodes": [
    {"id": "sun", "z": 9}, // the pinion on the motor shaft
    /* three planets at 120° */
    {"id": "planet", "url": "http://x/y"}
  ],
  // edges follow
  "edges": []
}`;
    expect(parseJsonLoose(raw)).toEqual({ nodes: [{ id: "sun", z: 9 }, { id: "planet", url: "http://x/y" }], edges: [] });
  });

  it("re-quotes single-quoted keys and strings, and drops doubled commas", () => {
    expect(parseJsonLoose(`{'id': 'ring', "teeth": 27,, "note": 'it\\'s internal', 2d: 1}`)).toEqual({ id: "ring", teeth: 27, note: "it's internal", "2d": 1 });
  });

  it("turns values no JSON has into what they mean", () => {
    expect(parseJsonLoose('{"a": NaN, "b": [Infinity, -Infinity, undefined], "c": True, "d": None, "e": false}')).toEqual({ a: null, b: [null, null, null], c: true, d: null, e: false });
  });

  it("throws the strict error when nothing parses", () => {
    expect(() => parseJsonLoose("no object here")).toThrow(/no JSON object/);
  });
});
