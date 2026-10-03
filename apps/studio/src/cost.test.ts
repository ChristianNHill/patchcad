import { describe, expect, it } from "vitest";
import { ProjectLedger, type GraphDoc } from "@patchcad/shared";
import { isListPrice, projectSpend } from "./cost";

const cost = (calls: number, tokens: number, usd: number) => ({
  calls,
  inputTokens: tokens,
  outputTokens: 0,
  usd,
});
const zero = cost(0, 0, 0);

const node = (c: ReturnType<typeof cost>) => ({ cost: c }) as GraphDoc["nodes"][string];

describe("projectSpend", () => {
  it("adds the ledger to the nodes", () => {
    const graph = {
      nodes: { plate: node(cost(3, 3000, 0.3)), screw: node(zero) },
      ledger: {
        planning: cost(2, 20000, 0.5),
        classifier: cost(1, 100, 0.001),
        renegotiate: cost(1, 5000, 0.1),
        nodes: cost(4, 4000, 0.2),
      },
    };
    const total = projectSpend(graph);
    expect(total.calls).toBe(11);
    expect(total.tokens).toBe(32100);
    expect(total.usd).toBeCloseTo(1.101);
  });

  it("still parses a ledger saved with the retired inspect bucket", () => {
    const ledger = ProjectLedger.parse({ planning: cost(2, 20000, 0.5), inspect: zero });
    expect(ledger).not.toHaveProperty("inspect");
    expect(projectSpend({ nodes: {}, ledger })).toEqual({ calls: 2, tokens: 20000, usd: 0.5 });
  });

  it("totals nodes alone when the graph has no ledger", () => {
    expect(projectSpend({ nodes: { plate: node(cost(1, 10, 0.01)) } })).toEqual({ calls: 1, tokens: 10, usd: 0.01 });
  });
});

describe("isListPrice", () => {
  it("is true for the subscription provider, alone or composed", () => {
    expect(isListPrice("subscription")).toBe(true);
    expect(isListPrice("composite(subscription+vision:claude)")).toBe(true);
    expect(isListPrice("claude")).toBe(false);
    expect(isListPrice(undefined)).toBe(false);
  });
});
