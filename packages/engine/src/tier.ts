import { z } from "zod";
import type { NodeRecord } from "@patchcad/shared";
import type { LlmProvider } from "./llm.js";
import type { TierHints } from "./backend.js";

/**
 * Tier routing for free-text reprompts:
 *   T2 — satisfiable within the pinned contract → regenerate this node only.
 *   T3 — requires an interface change → architect renegotiates the contract,
 *        user approves, dirty wave re-cooks affected descendants.
 *
 * Rules run first, in two strengths: unambiguous interface language routes T3
 * directly (no LLM — weak classifiers flip-flop on exactly these), no
 * interface-shaped language routes T2 directly, and only the ambiguous middle
 * consults the LLM classifier. A backend's `tierHints` add its own words in
 * front of these (CAD: "make the mount hole 5mm" names a pinned port and a
 * size, so only the architect can do it).
 */

export type Tier = "T2" | "T3";

const STRONG_T3 =
  /\bcontract\b|\b(add|expose|new|remove|rename)\b.{0,30}\b(export|port)\b|\brename\b.{0,20}\b(prop|param)\b/i;

const INTERFACE_HINTS =
  /\b(add|remove|rename|new|expose|emit|accept|change)\b.{0,40}\b(export|prop|props|port|param|parameter|callback|event|hook|api|interface|contract)\b/i;

const GENERIC_GUIDE = [
  "T2 — the request can be satisfied by rewriting the node's internals",
  "     without changing what it exports/accepts.",
  "T3 — the request requires changing the node's interface (new/removed/",
  "     renamed exports, props, params, or ports), which affects neighbors.",
].join("\n");

/** "mount_hole", "mountHole" and "mount-hole" all read as "mount hole". */
const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the message name one of the node's contract ports or params next to a
 *  size word? The name is cut out before the size test, so a port called
 *  "mount_hole" does not supply its own "hole": "add a fillet around the
 *  mount hole" is still a T2 shape edit. */
function namesSizedInterface(node: NodeRecord, message: string, sizeWords: RegExp): boolean {
  const payloadPorts = (node.contract.payload as { ports?: { name?: unknown }[] } | undefined)?.ports;
  const names = [
    ...node.contract.provides.map((p) => p.key),
    ...node.contract.requires.map((p) => p.key),
    ...node.contract.params.map((p) => p.name),
    ...(Array.isArray(payloadPorts) ? payloadPorts.map((p) => p.name).filter((n): n is string => typeof n === "string") : []),
  ].map(words);
  let rest = ` ${words(message)} `;
  let named = false;
  // Longest first, so "mount hole" is cut whole before a param called "hole".
  for (const name of [...new Set(names)].sort((a, b) => b.length - a.length)) {
    const cut = rest.replace(new RegExp(`(?<![a-z0-9])${escapeRe(name)}(?![a-z0-9])`, "g"), " ");
    if (cut !== rest) named = true;
    rest = cut;
  }
  return named && sizeWords.test(rest);
}

const ClassifierSchema = z.object({
  tier: z.enum(["T2", "T3"]),
  reason: z.string(),
});

export async function classifyReprompt(
  provider: LlmProvider,
  node: NodeRecord,
  message: string,
  hints?: TierHints,
): Promise<{ tier: Tier; reason: string }> {
  if (hints?.addsInterface.test(message)) {
    return { tier: "T3", reason: "adds an interface feature; escalating to the architect" };
  }
  if (hints && namesSizedInterface(node, message, hints.sizeWords)) {
    return { tier: "T3", reason: "resizes a pinned port or param; escalating to the architect" };
  }
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
        "PINNED interface contract. Decide:",
        hints?.classifierGuide ?? GENERIC_GUIDE,
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
