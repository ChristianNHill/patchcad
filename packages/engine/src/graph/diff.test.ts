import { describe, expect, it } from "vitest";
import type { Contract, GraphDoc } from "@patchcad/shared";
import { computeDirtySet, diffContract } from "./diff.js";

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    name: "n",
    summary: "s",
    params: [],
    provides: [],
    requires: [],
    payload: {},
    hash: "",
    ...overrides,
  };
}

describe("diffContract", () => {
  it("summary change is value-only, not shape", () => {
    const a = contract({ summary: "old" });
    const b = contract({ summary: "new" });
    const d = diffContract(a, b);
    expect(d.valueChanged).toBe(true);
    expect(d.shapeChanged).toBe(false);
    expect(d.shapeChangedProvides).toEqual([]);
  });

  it("adding a provides port is a shape change scoped to that port", () => {
    const a = contract({ provides: [{ key: "main", type: "component", description: "" }] });
    const b = contract({
      provides: [
        { key: "main", type: "component", description: "" },
        { key: "onQuickView", type: "callback", description: "" },
      ],
    });
    const d = diffContract(a, b);
    expect(d.shapeChanged).toBe(true);
    expect(d.shapeChangedProvides).toEqual(["onQuickView"]);
  });

  it("payload change marks all provides suspect", () => {
    const a = contract({
      provides: [
        { key: "p1", type: "component", description: "" },
        { key: "p2", type: "component", description: "" },
      ],
      payload: { exports: ["A"] },
    });
    const b = { ...a, payload: { exports: ["A", "B"] } };
    const d = diffContract(a, b);
    expect(d.shapeChangedProvides.sort()).toEqual(["p1", "p2"]);
  });
});

describe("computeDirtySet", () => {
  const graph = {
    schemaVersion: 1,
    id: "p",
    backend: "web-code",
    brief: { goal: "", constraints: [], clarifications: [] },
    nodes: {},
    edges: [
      { id: "e1", from: "theme", fromPort: "tokens", to: "grid", toPort: "tokens" },
      { id: "e2", from: "theme", fromPort: "tokens", to: "header", toPort: "tokens" },
      { id: "e3", from: "theme", fromPort: "fonts", to: "footer", toPort: "fonts" },
      { id: "e4", from: "grid", fromPort: "main", to: "shell", toPort: "grid" },
    ],
    assembly: { entryNodeId: "shell" },
    layout: {},
    rev: 0,
  } as unknown as GraphDoc;

  it("propagates only along shape-changed ports, then transitively", () => {
    const dirty = computeDirtySet(graph, "theme", ["tokens"]);
    // footer consumes only the untouched "fonts" port — stays clean.
    expect(dirty.has("footer")).toBe(false);
    expect(dirty.has("grid")).toBe(true);
    expect(dirty.has("header")).toBe(true);
    // shell is downstream of grid, which is now suspect on all its ports.
    expect(dirty.has("shell")).toBe(true);
  });

  it("empty changed-port list dirties nothing", () => {
    expect(computeDirtySet(graph, "theme", []).size).toBe(0);
  });
});
