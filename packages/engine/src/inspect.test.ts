import { describe, expect, it } from "vitest";
import { inspectFeedback, inspectNode } from "./inspect.js";
import type { LlmProvider } from "./llm.js";

const img = { mediaType: "image/png" as const, dataB64: "iVBORw0KGgo=" };

function judge(answers: unknown[]) {
  const seen: string[] = [];
  const provider: LlmProvider = {
    id: "stub",
    complete: async (req) => {
      seen.push(req.messages[0]!.content);
      const data = (req.schema as { parse: (v: unknown) => unknown }).parse({ answers });
      return { data, usage: { inputTokens: 1, outputTokens: 1, usd: 0 } } as never;
    },
  };
  return { provider, seen };
}

const node = { title: "Pod", spec: "a pod with a cockpit opening", kind: "part" };

describe("inspectNode (CADCodeVerify-style judge)", () => {
  it("fails only on no; unsure and yes pass", async () => {
    const { provider, seen } = judge([
      { question: "Is the cockpit opening on the top face?", answer: "yes", evidence: "top view" },
      { question: "Does the boom taper toward the tail?", answer: "unsure", evidence: "hidden" },
      { question: "Are there two skids?", answer: "no", evidence: "front view shows one" },
    ]);
    const questions = [
      "Is the cockpit opening on the top face?",
      "Does the boom taper toward the tail?",
      "Are there two skids?",
    ];
    const r = await inspectNode({ provider, node, questions, image: img });
    expect(r.answers).toHaveLength(3);
    expect(r.failed.map((a) => a.question)).toEqual(["Are there two skids?"]);
    // Every question reaches the judge, numbered.
    expect(seen[0]).toContain("3. Are there two skids?");
  });

  it("all unsure is a pass", async () => {
    const { provider } = judge([{ question: "Q?", answer: "unsure" }]);
    const r = await inspectNode({ provider, node, questions: ["Q?"], image: img });
    expect(r.failed).toEqual([]);
  });

  it("feedback lists only the failed questions, with evidence", async () => {
    const { provider } = judge([
      { question: "Is it hollow?", answer: "yes", evidence: "iso shows the rim" },
      { question: "Are there two skids?", answer: "no", evidence: "front view shows one" },
    ]);
    const r = await inspectNode({ provider, node, questions: ["Is it hollow?", "Are there two skids?"], image: img });
    const text = inspectFeedback(r.failed);
    expect(text).toContain("Are there two skids? — front view shows one");
    expect(text).not.toContain("Is it hollow?");
  });
});
