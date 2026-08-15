import { z } from "zod";
import { Contract, ParamDecl, PortDecl, type GraphDoc } from "@patchcad/shared";
import type { DomainBackend } from "./backend.js";
import type { LlmProvider, LlmUsage } from "./llm.js";
import { contractHash } from "./graph/diff.js";

/**
 * T3 contract renegotiation: the bounded form of an architect replan. When a
 * reprompt needs an interface change, the architect re-emits the TARGET
 * node's contract (and spec), seeing only that node + its 1-hop neighbors'
 * contracts. The result is a proposal — never auto-applied; the server diffs
 * it (diffContract → computeDirtySet) and the studio shows the blast radius
 * before the user accepts.
 *
 * v1 bounds (deterministically enforced, not just prompted):
 *  - `requires` is frozen to the node's current wiring — renegotiation never
 *    rewires the graph (that's the full neighborhood replan, later).
 *  - provides ports that neighbors consume keep their key AND type — additive
 *    and payload changes are the sanctioned surface. A dropped/retyped
 *    consumed port is restored and reported, not silently applied.
 */

export function makeRenegotiationSchema<P>(payloadSchema: z.ZodType<P>) {
  return z.object({
    contract: z.object({
      name: z.string(),
      summary: z.string().describe("what neighbors are told about this node"),
      params: z.array(ParamDecl).describe("live-tunable parameters (the T0 surface)"),
      provides: z.array(PortDecl),
      requires: z.array(PortDecl),
      payload: payloadSchema,
    }),
    spec: z.string().describe("updated 2-3 sentence generator spec reflecting the change"),
    rationale: z.string().describe("one or two sentences: what changed in the interface and why"),
  });
}

export interface RenegotiationResult {
  contract: Contract;
  spec: string;
  rationale: string;
  usage: LlmUsage;
  /** Deterministic guard-rail interventions, surfaced to the user verbatim. */
  constraintsApplied: string[];
}

export async function renegotiateContract(opts: {
  provider: LlmProvider;
  backend: DomainBackend<unknown>;
  graph: GraphDoc;
  nodeId: string;
  message: string;
  signal?: AbortSignal;
}): Promise<RenegotiationResult> {
  const node = opts.graph.nodes[opts.nodeId];
  if (!node) throw new Error(`renegotiate: unknown node ${opts.nodeId}`);

  const consumers = opts.graph.edges.filter((e) => e.from === opts.nodeId);
  const providers = opts.graph.edges.filter((e) => e.to === opts.nodeId);
  const neighborIds = [...new Set([...consumers.map((e) => e.to), ...providers.map((e) => e.from)])];
  const neighbors = neighborIds
    .map((id) => opts.graph.nodes[id])
    .filter((n): n is NonNullable<typeof n> => Boolean(n));

  const consumedPorts = new Set(consumers.map((e) => e.fromPort));

  const system = [
    "You are the architect for a patch-graph editor, renegotiating ONE node's",
    "interface contract because a user request cannot be satisfied within the",
    "current pinned contract. You never write implementation code — a hermetic",
    "generator will re-cook the node against the contract you emit, and every",
    "downstream consumer of a changed port will be re-cooked too.",
    "",
    opts.backend.planning.architectGuidance,
    "",
    "Rules:",
    "- Emit the COMPLETE updated contract, not a diff.",
    "- Change as little as possible: every changed or removed port dirties its",
    "  consumers and costs a re-cook. Keep unchanged ports byte-identical.",
    "- `requires` ports are FROZEN — copy them exactly as given; rewiring the",
    "  graph is out of scope for this renegotiation.",
    "- Provides ports marked [CONSUMED] must keep their key and type. Add new",
    "  ports or evolve the payload instead of renaming what neighbors import.",
    "- Update the spec so a generator with no other context builds the right thing.",
  ].join("\n");

  const portLine = (p: { key: string; type: string; description?: string }, consumed: boolean) =>
    `  - ${p.key} (${p.type})${consumed ? " [CONSUMED]" : ""}${p.description ? ` — ${p.description}` : ""}`;

  const userMessage = [
    `Target node: ${node.id} (${node.kind}) — "${node.title}"`,
    `Current spec: ${node.spec}`,
    `Current contract:`,
    JSON.stringify(
      {
        name: node.contract.name,
        summary: node.contract.summary,
        params: node.contract.params,
        payload: node.contract.payload,
      },
      null,
      1,
    ),
    `Provides:`,
    ...node.contract.provides.map((p) => portLine(p, consumedPorts.has(p.key))),
    `Requires (frozen — copy verbatim):`,
    ...node.contract.requires.map((p) => portLine(p, false)),
    "",
    `1-hop neighbor contracts (context only — you may NOT change them):`,
    ...neighbors.map((n) =>
      [
        `- ${n.id}: ${n.contract.summary}`,
        `    provides: ${n.contract.provides.map((p) => `${p.key}(${p.type})`).join(", ") || "none"}`,
      ].join("\n"),
    ),
    "",
    `User request for ${node.id}: "${opts.message}"`,
    "",
    "Emit the updated contract, spec, and rationale.",
  ].join("\n");

  const schema = makeRenegotiationSchema(opts.backend.planning.payloadSchema);
  const result = await opts.provider.complete({
    role: "architect",
    label: `renegotiate:${opts.nodeId}`,
    system,
    messages: [{ role: "user", content: userMessage }],
    schema,
    signal: opts.signal,
  });

  // Deterministic armor — the bounds hold even when the model ignores them.
  const constraintsApplied: string[] = [];
  const proposed = result.data.contract;

  const provides = [...proposed.provides];
  for (const key of consumedPorts) {
    const original = node.contract.provides.find((p) => p.key === key);
    if (!original) continue;
    const kept = provides.find((p) => p.key === key);
    if (!kept) {
      provides.push(original);
      constraintsApplied.push(`restored consumed port "${key}" the proposal dropped`);
    } else if (kept.type !== original.type) {
      kept.type = original.type;
      constraintsApplied.push(`kept consumed port "${key}" at type "${original.type}"`);
    }
  }

  if (JSON.stringify(proposed.requires) !== JSON.stringify(node.contract.requires)) {
    constraintsApplied.push("requires ports are frozen during renegotiation; proposal's changes ignored");
  }

  // Weak models sometimes return a blank spec; an accepted proposal must never
  // blank the generator's instructions.
  let spec = result.data.spec.trim();
  if (spec.length < 20) {
    spec = node.spec;
    constraintsApplied.push("proposal omitted an updated spec; keeping the current one");
  }

  const contract = Contract.parse({
    name: proposed.name,
    summary: proposed.summary,
    params: proposed.params,
    provides,
    requires: node.contract.requires,
    payload: proposed.payload,
    hash: "",
  });
  contract.hash = contractHash(contract);

  return {
    contract,
    spec,
    rationale: result.data.rationale,
    usage: result.usage,
    constraintsApplied,
  };
}
