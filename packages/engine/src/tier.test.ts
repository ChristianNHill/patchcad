import { describe, expect, it } from "vitest";
import type { NodeRecord } from "@patchcad/shared";
import { classifyReprompt } from "./tier.js";
import type { LlmProvider } from "./llm.js";
import type { TierHints } from "./backend.js";

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

describe("classifyReprompt with backend tier hints", () => {
  const part = {
    id: "bracket",
    kind: "part",
    title: "Bracket",
    contract: {
      name: "Bracket",
      summary: "",
      params: [{ type: "number", name: "thickness", description: "", default: 4 }],
      provides: [{ key: "mount_hole", type: "CLEARANCE_HOLE", description: "" }],
      requires: [],
      payload: { ports: [{ name: "mount_hole" }, { name: "base_face" }] },
      hash: "x",
    },
  } as unknown as NodeRecord;

  const hints: TierHints = {
    addsInterface: /\badd (?:a |an )?(?:hole|port|mount)/i,
    sizeWords: /\b(?:hole|thick\w*|bigger|size)\b|\d\s*mm\b/i,
    classifierGuide: "T2 — reshape inside the ports. T3 — move a port.",
  };

  const table: [message: string, tier: "T2" | "T3"][] = [
    ["make the mount hole 5mm", "T3"],
    ["make the mountHole bigger", "T3"],
    ["set thickness to 6mm", "T3"],
    ["add a hole for a cable", "T3"],
    ["make the base face bigger", "T3"],
    // The port's own name supplies no size word.
    ["add a fillet around the mount hole", "T2"],
    ["make it rounder", "T2"],
    ["make it 5mm bigger", "T2"], // no port or param named
    ["smoother edges on the base face", "T2"],
  ];

  for (const [message, tier] of table) {
    it(`${tier}: "${message}"`, async () => {
      expect((await classifyReprompt(mustNotCall, part, message, hints)).tier).toBe(tier);
    });
  }

  it("hands the classifier the backend's vocabulary", async () => {
    let system = "";
    const provider: LlmProvider = {
      id: "stub",
      complete: async (req) => {
        system = req.system;
        return { data: { tier: "T2", reason: "stub" }, usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, model: "stub" } as never;
      },
    };
    await classifyReprompt(provider, part, "change the param defaults", hints);
    expect(system).toContain("T3 — move a port.");
    expect(system).not.toContain("exports");
  });
});
