import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeArchitectSchema, makeArchitectWireSchema, planGraph } from "./architect.js";
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

/** The CAD payload subtree alone makes the structured-outputs grammar "too
 *  large" (measured live: the full schema is rejected on every call, and
 *  stubbing payload to a string compiles at 3569 bytes). So the wire schema
 *  types payload as a JSON string and the validation schema parses it back. */
describe("the wire/validation schema split", () => {
  const payload = z.object({ units: z.string(), depth: z.number() });
  const schema = makeArchitectSchema(payload, ["part"]);

  const emission = (payloadValue: unknown) => ({
    rationale: "r", design: "",
    nodes: [{ id: "test-plate", kind: "part", title: "t", spec: "s",
              contract: { name: "n", summary: "s", params: [], provides: [], requires: [],
                          payload: payloadValue },
              dependsOn: [] }],
    edges: [], entryNodeId: "test-plate",
  });

  it("accepts the payload as its real object", () => {
    const out = schema.safeParse(emission({ units: "mm", depth: 4 }));
    expect(out.success).toBe(true);
  });

  it("accepts the payload as a JSON string, and parses it back to the object", () => {
    const out = schema.safeParse(emission(JSON.stringify({ units: "mm", depth: 4 })));
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.nodes[0]!.contract.payload).toEqual({ units: "mm", depth: 4 });
    }
  });

  it("rejects a string payload that decodes to the WRONG shape, with the real error", () => {
    const out = schema.safeParse(emission(JSON.stringify({ units: "mm" })));
    expect(out.success).toBe(false);
  });

  it("rejects an unparseable string with a payload error, not a crash", () => {
    const out = schema.safeParse(emission("not json {"));
    expect(out.success).toBe(false);
  });

  it("the wire schema demands a STRING payload", () => {
    const wire = makeArchitectWireSchema(["part"]);
    expect(wire.safeParse(emission(JSON.stringify({ units: "mm", depth: 4 }))).success).toBe(true);
    expect(wire.safeParse(emission({ units: "mm", depth: 4 })).success).toBe(false);
  });
});
