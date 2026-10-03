import type { GraphDoc, NodeCost } from "@patchcad/shared";

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

/** The subscription provider bills a flat plan; its dollar figures are what
 *  the same tokens would cost at API list price, not money spent. */
export function isListPrice(providerId: string | undefined): boolean {
  return !!providerId?.includes("subscription");
}
