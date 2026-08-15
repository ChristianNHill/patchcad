import { z } from "zod";
import type { NodeRecord } from "@patchcad/shared";
import type { LlmProvider } from "./llm.js";

/**
 * Tier routing for free-text reprompts:
 *   T2 — satisfiable within the pinned contract → regenerate this node only.
 *   T3 — requires an interface change → architect renegotiates the contract,
 *        user approves, dirty wave re-cooks affected descendants.
 *
 * Rules run first, in two strengths: unambiguous interface language routes T3
 * directly (no LLM — weak classifiers flip-flop on exactly these), no
 * interface-shaped language routes T2 directly, and only the ambiguous middle
 * consults the LLM classifier.
 */

export type Tier = "T2" | "T3";

const STRONG_T3 =
  /\bcontract\b|\b(add|expose|new|remove|rename)\b.{0,30}\b(export|port)\b|\brename\b.{0,20}\b(prop|param)\b/i;

const INTERFACE_HINTS =
  /\b(add|remove|rename|new|expose|emit|accept|change)\b.{0,40}\b(export|prop|props|port|param|parameter|callback|event|hook|api|interface|contract)\b/i;

const ClassifierSchema = z.object({
  tier: z.enum(["T2", "T3"]),
  reason: z.string(),
});

export async function classifyReprompt(
  provider: LlmProvider,
  node: NodeRecord,
  message: string,
): Promise<{ tier: Tier; reason: string }> {
  if (STRONG_T3.test(message)) {
    return { tier: "T3", reason: "explicit interface-change language; escalating to the architect" };
  }
  if (!INTERFACE_HINTS.test(message)) {
    return { tier: "T2", reason: "no interface-shaped language; regenerate within the pinned contract" };
  }
  try {
    const result = await provider.complete({
      role: "classifier",
      label: `tier:${node.id}`,
      maxTokens: 300,
      system: [
        "You route edit requests for a node in a patch graph. The node has a",
        "PINNED interface contract (exports, props, params, ports). Decide:",
        "T2 — the request can be satisfied by rewriting the node's internals",
        "     without changing what it exports/accepts.",
        "T3 — the request requires changing the node's interface (new/removed/",
        "     renamed exports, props, params, or ports), which affects neighbors.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: [
            `Node: ${node.title} (${node.kind})`,
            `Contract exports/ports: ${JSON.stringify({
              provides: node.contract.provides,
              params: node.contract.params.map((p) => p.name),
              payload: node.contract.payload,
            })}`,
            `Request: "${message}"`,
            `Answer with tier T2 or T3 and a one-sentence reason.`,
          ].join("\n"),
        },
      ],
      schema: ClassifierSchema,
    });
    return result.data;
  } catch {
    // Classifier failure must never block a reprompt — default to T2.
    return { tier: "T2", reason: "classifier unavailable; defaulting to in-contract regeneration" };
  }
}
