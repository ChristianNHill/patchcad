import { describe, expect, it } from "vitest";
import { LlmCallError, type LlmProvider, type LlmRequest } from "@patchcad/engine";
import { z } from "zod";
import { addCost, addUsage, budgeted, metered } from "./spend.js";

const usage = (usd: number) => ({ inputTokens: 100, outputTokens: 10, usd });

const req: LlmRequest<string> = {
  role: "generator",
  system: "",
  messages: [],
  schema: z.string(),
  label: "test",
};

/** Answers every call with the next price in the list; a negative price throws
 *  an LlmCallError that still carries its usage. */
function priced(prices: number[]): LlmProvider & { calls: number } {
  const p = {
    id: "fake",
    calls: 0,
    async complete<T>() {
      const usd = prices[p.calls++]!;
      if (usd < 0) throw new LlmCallError("schema failed", usage(-usd));
      return { data: "ok" as T, usage: usage(usd) };
    },
  };
  return p;
}

describe("addUsage", () => {
  it("counts the call and sums tokens and dollars", () => {
    const cost = { calls: 1, inputTokens: 5, outputTokens: 5, usd: 0.5 };
    addUsage(cost, usage(0.25));
    expect(cost).toEqual({ calls: 2, inputTokens: 105, outputTokens: 15, usd: 0.75 });
  });
});

describe("addCost", () => {
  it("folds a node's whole record, call count included", () => {
    const ledger = { calls: 2, inputTokens: 10, outputTokens: 1, usd: 0.1 };
    addCost(ledger, { calls: 5, inputTokens: 500, outputTokens: 50, usd: 1.5 });
    expect(ledger).toEqual({ calls: 7, inputTokens: 510, outputTokens: 51, usd: 1.6 });
  });
});

describe("metered", () => {
  it("reports successful calls and failed calls that consumed tokens", async () => {
    const seen: number[] = [];
    const p = metered(priced([0.1, -0.2]), (u) => seen.push(u.usd));
    await p.complete(req);
    await expect(p.complete(req)).rejects.toThrow("schema failed");
    expect(seen).toEqual([0.1, 0.2]);
  });
});

describe("budgeted", () => {
  it("refuses the call after the cap is reached, without reaching the provider", async () => {
    const inner = priced([0.6, 0.6, 0.6]);
    const p = budgeted(inner, 1);
    await p.complete(req);
    await p.complete(req);
    await expect(p.complete(req)).rejects.toThrow("cook budget $1.00 reached ($1.20 spent)");
    expect(inner.calls).toBe(2);
  });

  it("counts the spend of a failed call toward the cap", async () => {
    const inner = priced([-1.5, 0.1]);
    const p = budgeted(inner, 1);
    await expect(p.complete(req)).rejects.toThrow("schema failed");
    await expect(p.complete(req)).rejects.toThrow("cook budget");
    expect(inner.calls).toBe(1);
  });

  it("gives each wrapper its own budget", async () => {
    const inner = priced([0.9, 0.9]);
    await budgeted(inner, 1).complete(req);
    await budgeted(inner, 1).complete(req);
    expect(inner.calls).toBe(2);
  });
});
