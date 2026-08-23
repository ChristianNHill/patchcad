import { describe, expect, it } from "vitest";
import { GraphDoc, type NodeStatus } from "@patchcad/shared";
import { EventBus } from "../events.js";
import { GraphStore } from "./store.js";

/** The status machine is the only path node state may change through, so a
 * state it cannot leave is a node no re-cook can rescue. */

function storeWith(status: NodeStatus) {
  const graph = GraphDoc.parse({
    schemaVersion: 1,
    id: "test",
    backend: "mock",
    brief: { goal: "", constraints: [], clarifications: [] },
    nodes: {
      widget: {
        id: "widget",
        kind: "component",
        title: "Widget",
        spec: "",
        contract: {
          name: "Widget",
          summary: "",
          params: [],
          provides: [],
          requires: [],
          payload: {},
          hash: "",
        },
        params: {},
        artifact: null,
        thread: [],
        status,
        version: 0,
        history: [],
        cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
      },
    },
    edges: [],
    assembly: { entryNodeId: "widget" },
    rev: 0,
  });
  return new GraphStore(graph, new EventBus(), async () => {});
}

/** A process death or a guard that returns without settling leaves a node in
 * one of these. cook.ts queues before it does anything else, so if any of them
 * could not reach `queued` the node would be stuck for good — every subsequent
 * cook-dirty failing instantly on the illegal transition. */
const IN_FLIGHT: NodeStatus[] = ["queued", "generating", "building", "verifying", "repairing"];

describe("status machine", () => {
  for (const status of IN_FLIGHT) {
    it(`a node stranded in "${status}" can be requeued`, () => {
      const store = storeWith(status);
      expect(() => store.setStatus("widget", "queued")).not.toThrow();
      expect(store.node("widget").status).toBe("queued");
    });
  }

  it("still rejects a genuinely illegal transition", () => {
    const store = storeWith("planned");
    expect(() => store.setStatus("widget", "ready")).toThrow(/illegal status transition/);
  });

  it("settled states reach queued too, so cook-dirty can resume anything", () => {
    for (const status of ["ready", "dirty", "error_code", "error_contract", "cancelled"] as NodeStatus[]) {
      const store = storeWith(status);
      expect(() => store.setStatus("widget", "queued")).not.toThrow();
    }
  });
});
