import { describe, expect, it } from "vitest";
import { z } from "zod";
import { planGraph } from "./architect.js";
import type { DomainBackend, LlmProvider } from "./index.js";

/** PlanResult.repaired was the entire observability of the repair loop, and it
 *  hid one missing guidance rule behind 14 identical-looking repair rounds.
 *  This drives the loop with a scripted provider: emission one trips a lint,
 *  emission two passes, and the result must carry WHAT the round was for. */

const node = (id: string, blocked: boolean) => ({
  id, kind: "part", title: id, spec: "s",
  contract: { name: id, summary: "s", params: [], provides: [], requires: [],
              payload: { blocked } },
  dependsOn: [],
});

const emission = (blocked: boolean) => ({
  rationale: "r",
  design: "",
  nodes: [node("test-plate", blocked)],
  edges: [],
  entryNodeId: "test-plate",
});

function scripted(): LlmProvider {
  let call = 0;
  return {
    id: "scripted",
    complete: async <T>() => {
      call++;
      return { data: emission(call === 1) as T, usage: { inputTokens: 1, outputTokens: 1, usd: 0.01 }, model: "scripted" };
    },
  } as LlmProvider;
}

const backend = {
  id: "cad",
  planning: {
    nodeKinds: [{ kind: "part", description: "d", guidance: "g" }],
    payloadSchema: z.object({ blocked: z.boolean() }),
    architectGuidance: [],
    graphLints: [
      {
        id: "test-blocked",
        run: (g: { nodes: Record<string, { contract: { payload: unknown } }> }) =>
          Object.values(g.nodes)
            .filter((n) => (n.contract.payload as { blocked: boolean }).blocked)
            .map(() => "test-blocked: the payload says no"),
      },
    ],
  },
} as unknown as DomainBackend<unknown>;

describe("the repair loop records what each round was for", () => {
  it("carries the tripped lint's message out on PlanResult", async () => {
    const res = await planGraph({ provider: scripted(), backend, projectId: "t", goal: "g" });
    expect(res.repaired).toBe(true);
    expect(res.lintRounds).toHaveLength(1);
    expect(res.lintRounds[0]![0]).toContain("test-blocked");
  });

  it("is empty when the first emission passes", async () => {
    const provider = {
      id: "s",
      complete: async <T>() => ({ data: emission(false) as T, usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "s" }),
    } as unknown as LlmProvider;
    const res = await planGraph({ provider, backend, projectId: "t", goal: "g" });
    expect(res.repaired).toBe(false);
    expect(res.lintRounds).toEqual([]);
  });
});
