import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeArchitectSchema, makeArchitectWireSchema, normalizeArchitectOutput, planGraph } from "./architect.js";
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

/** A provider with one port used to have any misnamed edge silently rewired to
 *  it. In CAD that port is a pose, so the guess could mate a part on a face
 *  nobody chose; now the edge stays as written and the lint names it. */
describe("normalizeArchitectOutput no longer guesses a sole provides port", () => {
  const port = (key: string) => ({ key, type: "FLAT_FACE", description: "" });
  const withPorts = (id: string, provides: string[], requires: string[]) => ({
    ...node(id, false),
    contract: { ...node(id, false).contract, provides: provides.map(port), requires: requires.map(port) },
  });
  const out = {
    rationale: "r",
    design: "",
    nodes: [withPorts("base", ["top_face"], []), withPorts("lid", [], ["seat"])],
    edges: [{ from: "base", fromPort: "lid_face", to: "lid", toPort: "seat" }],
    entryNodeId: "base",
  };

  it("keeps the edge's port as the model wrote it", () => {
    const res = normalizeArchitectOutput(structuredClone(out) as never, { enforceShell: false });
    expect(res.edges).toEqual([{ from: "base", fromPort: "lid_face", to: "lid", toPort: "seat" }]);
  });

  it("and the architect loop sees it as a lint naming the only candidate", async () => {
    const provider = {
      id: "s",
      complete: async <T>() => ({ data: structuredClone(out) as T, usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "s" }),
    } as unknown as LlmProvider;
    const quiet = { ...backend, planning: { ...backend.planning, graphLints: [] } } as unknown as DomainBackend<unknown>;
    await expect(planGraph({ provider, backend: quiet, projectId: "t", goal: "g" })).rejects.toThrow(
      /"lid_face" is not a provides port of base \(its only provides port is "top_face"/,
    );
  });
});

/** Phase 4.5: a domain's expandPlan runs on every emission, right after
 *  normalization and before the lints, and the repair round is shown the
 *  model's own emission, not the hardware expansion minted for it. */
describe("planning.expandPlan", () => {
  const joint = { id: "j1", a: { node: "test-plate", port: "f" }, b: { node: "test-plate", port: "g" }, wall: 3 };
  const withJoint = (wall: number) => ({ ...emission(false), joints: JSON.stringify([{ ...joint, wall }]) });

  function recording(walls: number[]) {
    const seen: { messages: { role: string; content: string }[]; wire: unknown }[] = [];
    let call = 0;
    const provider = {
      id: "rec",
      complete: async <T>(req: { messages: { role: string; content: string }[]; schema: z.ZodTypeAny; wireSchema: unknown }) => {
        seen.push({ messages: req.messages, wire: req.wireSchema });
        return { data: req.schema.parse(withJoint(walls[call++]!)) as T, usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "rec" };
      },
    } as unknown as LlmProvider;
    return { provider, seen };
  }

  const jointSchema = z.object({ id: z.string(), a: z.object({ node: z.string(), port: z.string() }), b: z.object({ node: z.string(), port: z.string() }), wall: z.number() });
  const expanding = {
    ...backend,
    planning: {
      ...backend.planning,
      jointSchema,
      // Mints one hardware node per joint, the way CAD mints j1_screw.
      expandPlan: (out: { nodes: { id: string }[]; joints?: { id: string }[] }) => ({
        ...out,
        nodes: [...out.nodes, ...(out.joints ?? []).map((j) => ({ ...node(`${j.id}_screw`, false), id: `${j.id}_screw` }))],
      }),
      graphLints: [
        {
          run: (g: { nodes: Record<string, unknown>; joints: { wall: number }[] }) => [
            ...(g.nodes.j1_screw ? [] : ["expansion did not run before the lints"]),
            ...g.joints.filter((j) => j.wall < 5).map((j) => `joint j1: wallB ${j.wall}.0 < insert 5.8 + 1.2`),
          ],
        },
      ],
    },
  } as unknown as DomainBackend<unknown>;

  it("expands before linting, and a thin wall is a repairable lint", async () => {
    const { provider, seen } = recording([3, 8]);
    const res = await planGraph({ provider, backend: expanding, projectId: "t", goal: "g" });
    expect(res.lintRounds).toEqual([["joint j1: wallB 3.0 < insert 5.8 + 1.2"]]);
    expect(Object.keys(res.graph.nodes)).toEqual(["test-plate", "j1_screw"]);
    expect(res.graph.joints).toEqual([{ ...joint, wall: 8 }]);
    // The repair saw the model's own draft: no minted node in it.
    const draft = seen[1]!.messages.find((m) => m.role === "assistant")!.content;
    expect(draft).not.toContain("j1_screw");
    expect(draft).toContain('"wall":3');
  });

  it("puts joints on the wire as one JSON string, and only for a domain that has them", () => {
    const withJoints = makeArchitectWireSchema(["part"], true);
    expect(withJoints.safeParse({ ...emission(false), nodes: emission(false).nodes.map((n) => ({ ...n, contract: { ...n.contract, payload: "{}" } })), joints: "[]" }).success).toBe(true);
    expect(Object.keys(makeArchitectWireSchema(["part"]).shape)).not.toContain("joints");
  });
});
