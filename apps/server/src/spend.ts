import type { NodeCost } from "@patchcad/shared";
import { LlmCallError, type LlmProvider, type LlmRequest, type LlmUsage } from "@patchcad/engine";

/** Fold one call's usage into a cost record, in place. */
export function addUsage(cost: NodeCost, usage: LlmUsage): NodeCost {
  cost.calls += 1;
  cost.inputTokens += usage.inputTokens;
  cost.outputTokens += usage.outputTokens;
  cost.usd += usage.usd;
  return cost;
}

/** Fold a whole cost record (many calls) into another, in place. */
export function addCost(into: NodeCost, from: NodeCost): NodeCost {
  into.calls += from.calls;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.usd += from.usd;
  return into;
}

/** The same provider, reporting every call's usage — including a failed call
 *  that still consumed tokens. The engine's planning, classifier and
 *  renegotiation paths bill nothing themselves; this is how the ledger sees
 *  them without the engine knowing a ledger exists. */
export function metered(provider: LlmProvider, onUsage: (usage: LlmUsage) => void): LlmProvider {
  return {
    id: provider.id,
    async complete<T>(req: LlmRequest<T>) {
      try {
        const result = await provider.complete(req);
        onUsage(result.usage);
        return result;
      } catch (err) {
        if (err instanceof LlmCallError && err.usage) onUsage(err.usage);
        throw err;
      }
    },
  };
}

/** A spend cap shared by everything one cook pays for: LLM calls through
 *  `budgeted`, and mesh generation through the server's MeshSource. */
export class Budget {
  constructor(
    readonly maxUsd: number,
    public spent = 0,
  ) {}

  /** Throws once the cap is reached. */
  check(what = "cook"): void {
    if (this.spent >= this.maxUsd) {
      throw new Error(
        `${what} budget $${this.maxUsd.toFixed(2)} reached ($${this.spent.toFixed(2)} spent) — ` +
          `re-cook to resume, or raise maxUsd in ~/.patchcad/config.json`,
      );
    }
  }

  add(usd: number): void {
    this.spent += usd;
  }
}

/** A per-cook spend cap, checked before each call. A throw here takes the
 *  engine's provider-failure path, so the node lands in `error_code` and the
 *  next re-cook (a fresh cook, a fresh budget) resumes it. Calls already in
 *  flight when the cap is crossed still finish, so a parallel wave can overshoot
 *  by at most its concurrency. */
export function budgeted(provider: LlmProvider, budget: Budget): LlmProvider {
  const gate: LlmProvider = {
    id: provider.id,
    async complete<T>(req: LlmRequest<T>) {
      budget.check();
      return provider.complete(req);
    },
  };
  return metered(gate, (usage) => budget.add(usage.usd));
}
