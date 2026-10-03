import { describe, expect, it } from "vitest";
import type { EngineEvent, GraphDoc, NodeRecord } from "@patchcad/shared";
import { reduceEvent, type EventState } from "./events.js";

const zero = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
const node = (id: string, extra: Partial<NodeRecord> = {}) =>
  ({ id, status: "ready", version: 0, params: {}, cost: zero, ...extra }) as unknown as NodeRecord;
const graph = (id: string, nodes: NodeRecord[]) =>
  ({
    id,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    ledger: { planning: zero, classifier: zero, renegotiate: zero, nodes: zero },
  }) as unknown as GraphDoc;

const base = (): EventState => ({
  graph: graph("open", [node("a"), node("b")]),
  statuses: { a: "ready", b: "ready" },
  failures: { a: { stage: "verify", message: "x", attribution: "self" } as never },
  logs: ["[a] old"],
  planState: { status: "idle" },
  cadSceneRev: 3,
  checker: { status: "failing", problems: ["p"] },
  undo: { depth: 1, label: "x" },
  proposal: { nodeId: "a" } as never,
  selectedNodeId: "a",
  selectedCode: "code",
  printability: { a: { composite: 1 } },
});

const cases: { name: string; event: EngineEvent; expect: (patch: Partial<EventState>, s: EventState) => void }[] = [
  {
    name: "a background project's event changes nothing",
    event: { type: "job:log", projectId: "other", nodeId: "a", line: "hi" },
    expect: (p) => expect(p).toEqual({}),
  },
  {
    name: "graph:replaced on the same project keeps proposal, checker and logs",
    event: { type: "graph:replaced", projectId: "open", graph: graph("open", [node("a", { status: "dirty" })]) },
    expect: (p) => {
      expect(p.statuses).toEqual({ a: "dirty" });
      expect(p.failures).toEqual({});
      expect(p).not.toHaveProperty("proposal");
      expect(p).not.toHaveProperty("logs");
      expect(p).not.toHaveProperty("selectedNodeId");
    },
  },
  {
    name: "graph:replaced by another project resets what the old one left",
    event: { type: "graph:replaced", projectId: "next", graph: graph("next", [node("z")]) },
    expect: (p) => {
      expect(p.proposal).toBeNull();
      expect(p.checker).toEqual({ status: "clean", problems: [] });
      expect(p.logs).toEqual([]);
      expect(p.printability).toEqual({});
      expect(p.selectedNodeId).toBeNull();
      expect(p.selectedCode).toBe("");
    },
  },
  {
    name: "graph:replaced drops a selection whose node is gone",
    event: { type: "graph:replaced", projectId: "open", graph: graph("open", [node("b")]) },
    expect: (p) => expect(p.selectedNodeId).toBeNull(),
  },
  {
    name: "node:status records a failure and clears it on recovery",
    event: { type: "node:status", projectId: "open", nodeId: "a", status: "ready" },
    expect: (p) => {
      expect(p.statuses?.a).toBe("ready");
      expect(p.failures).toEqual({});
    },
  },
  {
    name: "plan:phase is ignored when nothing is planning",
    event: { type: "plan:phase", projectId: "slug", phase: "checking", detail: "" },
    expect: (p) => expect(p).toEqual({}),
  },
  {
    name: "job:log appends",
    event: { type: "job:log", projectId: "open", nodeId: "b", line: "hello" },
    expect: (p) => expect(p.logs).toEqual(["[a] old", "[b] hello"]),
  },
  {
    name: "node:committed bumps the scene",
    event: { type: "node:committed", projectId: "open", nodeId: "a", version: 2 },
    expect: (p) => expect(p.cadSceneRev).toBe(4),
  },
  {
    name: "checker:status replaces the checker",
    event: { type: "checker:status", projectId: "open", status: "clean", problems: [] },
    expect: (p) => expect(p.checker).toEqual({ status: "clean", problems: [] }),
  },
  {
    name: "undo:stack replaces the undo state",
    event: { type: "undo:stack", projectId: "open", depth: 0, label: "" },
    expect: (p) => expect(p.undo).toEqual({ depth: 0, label: "" }),
  },
  {
    name: "cost:update on a node folds in without mutating the old record",
    event: { type: "cost:update", projectId: "open", nodeId: "a", inputTokens: 10, outputTokens: 5, usd: 0.5 },
    expect: (p, s) => {
      expect(p.graph!.nodes.a!.cost).toEqual({ calls: 1, inputTokens: 10, outputTokens: 5, usd: 0.5 });
      expect(s.graph!.nodes.a!.cost).toBe(zero);
      expect(p.graph!.nodes.b).toBe(s.graph!.nodes.b);
    },
  },
  {
    name: "cost:update on a bucket folds into the ledger",
    event: { type: "cost:update", projectId: "open", bucket: "planning", inputTokens: 1, outputTokens: 1, usd: 1 },
    expect: (p) => expect(p.graph!.ledger.planning).toEqual({ calls: 1, inputTokens: 1, outputTokens: 1, usd: 1 }),
  },
  {
    name: "cost:update for an unknown node changes nothing",
    event: { type: "cost:update", projectId: "open", nodeId: "gone", inputTokens: 1, outputTokens: 1, usd: 1 },
    expect: (p) => expect(p).toEqual({}),
  },
];

describe("reduceEvent", () => {
  for (const c of cases) {
    it(c.name, () => {
      const s = base();
      c.expect(reduceEvent(s, c.event), s);
    });
  }

  it("updates a planning phase", () => {
    const s = { ...base(), planState: { status: "planning", goal: "g", phase: "drafting", detail: "", startedAt: 0 } as const };
    const p = reduceEvent(s, { type: "plan:phase", projectId: "slug", phase: "repairing", detail: "d" });
    expect(p.planState).toMatchObject({ phase: "repairing", detail: "d" });
  });
});
