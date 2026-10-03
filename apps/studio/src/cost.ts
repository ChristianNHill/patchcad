import type { GraphDoc, NodeCost } from "@patchcad/shared";
import type { LlmRoute } from "./store";

/** Everything this project has cost: every node's own spend plus the ledger
 *  (the plan, classifications, renegotiations, deleted nodes). The chip used to
 *  sum nodes only, so the architect call, usually the biggest single one, never
 *  appeared in it. `ledger` is optional so a graph from an older server still
 *  totals its nodes. */
export function projectSpend(graph: Pick<GraphDoc, "nodes"> & { ledger?: GraphDoc["ledger"] }): {
  calls: number;
  tokens: number;
  usd: number;
} {
  const records: NodeCost[] = [
    ...Object.values(graph.nodes).map((n) => n.cost),
    ...Object.values(graph.ledger ?? {}),
  ];
  let calls = 0;
  let tokens = 0;
  let usd = 0;
  for (const c of records) {
    calls += c.calls;
    tokens += c.inputTokens + c.outputTokens;
    usd += c.usd;
  }
  return { calls, tokens, usd };
}

/** How the dollar figure was billed. "list": a subscription (or local)
 *  priced at API list rate for attribution, not money spent. "mixed": some
 *  routes, typically vision, go to an API key. An older server sends no
 *  `paid`, so its id is all there is to go on. */
export type Billing = "api" | "list" | "mixed";
export function billing(provider: { id: string; paid?: LlmRoute[] } | null | undefined): Billing {
  if (!provider) return "api";
  if (!provider.paid) return provider.id.includes("subscription") ? "list" : "api";
  if (provider.paid.length === 0) return "list";
  const roles: LlmRoute[] = ["architect", "generator", "repair", "classifier"];
  return roles.every((r) => provider.paid!.includes(r)) ? "api" : "mixed";
}
