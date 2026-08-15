import { describe, expect, it } from "vitest";
import type { NodeRecord } from "@patchcad/shared";
import { classifyReprompt } from "./tier.js";
import type { LlmProvider } from "./llm.js";

const node = {
  id: "data-fetcher",
  kind: "data",
  title: "Data Fetcher",
  contract: {
    name: "DataFetcher",
    summary: "",
    params: [],
    provides: [{ key: "fetchHabitData", type: "function", description: "" }],
    requires: [],
    payload: {},
    hash: "x",
  },
} as unknown as NodeRecord;

/** Fast paths are deterministic — reaching the LLM at all is the failure. */
const mustNotCall: LlmProvider = {
  id: "trap",
  complete: () => {
    throw new Error("classifier LLM called on a rule-decided message");
  },
};

describe("classifyReprompt rule tiers", () => {
  it("routes cosmetic asks T2 without an LLM call", async () => {
    const r = await classifyReprompt(mustNotCall, node, "use warmer colors and a bolder font");
    expect(r.tier).toBe("T2");
  });

  it("routes explicit contract language T3 without an LLM call", async () => {
    for (const msg of [
      "expose a new resetAll export in your contract",
      "add a new export so other nodes can clear data",
      "rename the streakCount port to weeklyStreak",
    ]) {
      const r = await classifyReprompt(mustNotCall, node, msg);
      expect(r.tier, msg).toBe("T3");
    }
  });

  it("consults the LLM only for the ambiguous middle", async () => {
    let called = false;
    const provider: LlmProvider = {
      id: "stub",
      complete: async () => {
        called = true;
        return { data: { tier: "T3", reason: "stub" }, usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, model: "stub" } as never;
      },
    };
    const r = await classifyReprompt(provider, node, "accept an optional callback prop for clicks");
    expect(called).toBe(true);
    expect(r.tier).toBe("T3");
  });

  it("defaults to T2 when the classifier is unavailable", async () => {
    const broken: LlmProvider = {
      id: "down",
      complete: async () => {
        throw new Error("connection refused");
      },
    };
    const r = await classifyReprompt(broken, node, "accept an optional callback prop for clicks");
    expect(r.tier).toBe("T2");
  });
});
