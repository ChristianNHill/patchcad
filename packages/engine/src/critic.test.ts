import { describe, expect, it } from "vitest";
import type { GraphDoc } from "@patchcad/shared";
import { critiqueAssembly } from "./critic.js";
import type { LlmProvider, LlmRequest } from "./llm.js";

const image = { mediaType: "image/png" as const, dataB64: "iVBORw0KGgo=" };

const graph = {
  id: "clamp",
  brief: { goal: "clamp a bracket to a plate", constraints: [], clarifications: [], design: "chunky, chamfered" },
  nodes: {
    "base-plate": { id: "base-plate", kind: "part", title: "Base Plate", spec: "a plate", contract: { summary: "flat plate with holes" }, artifact: { code: "x" } },
    "m4-screw": { id: "m4-screw", kind: "fastener", title: "M4×12", spec: "screw", contract: { summary: "" }, artifact: { code: "y" } },
    uncooked: { id: "uncooked", kind: "part", title: "Later", spec: "not yet", contract: { summary: "" }, artifact: null },
  },
} as unknown as GraphDoc;

function capture(reply: unknown) {
  const seen: LlmRequest<unknown>[] = [];
  const provider: LlmProvider = {
    id: "stub",
    complete: async (req) => {
      seen.push(req as LlmRequest<unknown>);
      return { data: (req.schema as { parse: (v: unknown) => unknown }).parse(reply), usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "stub" } as never;
    },
  };
  return { provider, seen };
}

describe("critiqueAssembly", () => {
  const clean = { ok: true, summary: "reads as intended", problems: [] };

  it("sends the picture and names every cooked part", async () => {
    const { provider, seen } = capture(clean);
    await critiqueAssembly({ provider, graph, image });
    const msg = seen[0]!.messages[0]!;
    expect(msg.images).toEqual([image]);
    expect(msg.content).toContain("base-plate");
    expect(msg.content).toContain("m4-screw");
    // A node with no artifact is not in the picture, so naming it would only
    // invite the model to hallucinate about something it cannot see.
    expect(msg.content).not.toContain("uncooked");
  });

  it("gives the model the intent, not just the geometry", async () => {
    const { provider, seen } = capture(clean);
    await critiqueAssembly({ provider, graph, image });
    expect(seen[0]!.messages[0]!.content).toContain("clamp a bracket to a plate");
    expect(seen[0]!.messages[0]!.content).toContain("chunky, chamfered");
  });

  it("tells the model what it may not comment on", async () => {
    // Everything visible has already passed dimensional checks; a critic
    // second-guessing those is pure noise.
    const { provider, seen } = capture(clean);
    await critiqueAssembly({ provider, graph, image });
    expect(seen[0]!.system).toContain("passed automated dimension checks");
    expect(seen[0]!.system).toContain("An empty problems list");
  });

  it("routes to the repair role, not the generator", async () => {
    const { provider, seen } = capture(clean);
    await critiqueAssembly({ provider, graph, image });
    expect(seen[0]!.role).toBe("repair");
  });

  it("returns findings that name a node and a fix", async () => {
    const { provider } = capture({
      ok: false,
      summary: "the screw is not in anything",
      problems: [
        { severity: "blocking", nodeId: "m4-screw", issue: "floating clear of the plate", suggestion: "mate its axis to the shared hole" },
      ],
    });
    const c = await critiqueAssembly({ provider, graph, image });
    expect(c.ok).toBe(false);
    expect(c.problems[0]).toMatchObject({ severity: "blocking", nodeId: "m4-screw" });
    expect(c.problems[0]!.suggestion).toContain("mate its axis");
  });

  it("accepts a verdict with no problems at all", async () => {
    const { provider } = capture({ ok: true, summary: "fine" });
    expect((await critiqueAssembly({ provider, graph, image })).problems).toEqual([]);
  });
});
