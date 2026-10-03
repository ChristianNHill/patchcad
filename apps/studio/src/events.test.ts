import { describe, expect, it } from "vitest";
import type { EngineEvent, GraphDoc, NodeRecord } from "@patchcad/shared";
import { belongsToOpenProject, mergeNode } from "./events.js";

const node = (id: string, version: number) => ({ id, version, params: {} }) as unknown as NodeRecord;
const graph = (nodes: NodeRecord[]) =>
  ({ id: "open", nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) }) as unknown as GraphDoc;

describe("belongsToOpenProject", () => {
  const status = (projectId: string): EngineEvent => ({ type: "node:status", projectId, nodeId: "a", status: "ready" });

  it("drops a background project's events", () => {
    expect(belongsToOpenProject(status("other"), "open")).toBe(false);
    expect(belongsToOpenProject(status("open"), "open")).toBe(true);
  });

  it("drops project events when nothing is open", () => {
    expect(belongsToOpenProject(status("open"), undefined)).toBe(false);
  });

  it("always lets the switch and a pending plan's phases through", () => {
    expect(belongsToOpenProject({ type: "graph:replaced", projectId: "other", graph: graph([]) }, "open")).toBe(true);
    expect(belongsToOpenProject({ type: "plan:phase", projectId: "new-slug", phase: "drafting", detail: "" }, "open")).toBe(true);
  });
});

describe("mergeNode", () => {
  it("replaces the record without mutating the old graph", () => {
    const before = graph([node("a", 0), node("b", 1)]);
    const after = mergeNode(before, node("a", 3));
    expect(after.nodes.a!.version).toBe(3);
    expect(after.nodes.b).toBe(before.nodes.b);
    expect(before.nodes.a!.version).toBe(0);
  });

  it("does not resurrect a deleted node", () => {
    const before = graph([node("a", 0)]);
    expect(mergeNode(before, node("gone", 2))).toBe(before);
  });
});
