import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  Edge,
  GraphDoc,
  ParamDeclNoUi,
  PortDecl,
  type ChatMessage,
} from "@patchcad/shared";
import type { DomainBackend } from "./backend.js";
import type { LlmProvider, LlmUsage } from "./llm.js";
import { contractHash } from "./graph/diff.js";

/**
 * The architect pass: one call, whole graph — nodes and contracts emitted
 * together so port pairings stay mutually consistent. Output is forced
 * through a schema; post-parse lints catch what schemas can't (cycles,
 * unsatisfied requires, port mismatches), with one automatic repair
 * round-trip before surfacing failures.
 */

/**
 * The whole-graph emission is the largest single output in the system — a
 * 15-node graph carries every contract, port pose and envelope — and reasoning
 * tokens are billed against the same ceiling. Both call sites used to pass
 * nothing and inherit the adapter default, which is 32000 on the OpenAI-compat
 * adapter but 16000 on the Anthropic one: moving a project between providers
 * silently halved the architect's headroom, and running out means truncated
 * JSON, a failed parse, a full re-emission, and then a hard throw. Pin it here
 * so the budget is a property of the pass, not of whoever is serving it.
 */
const ARCHITECT_MAX_TOKENS = 32000;

/**
 * The emission keeps the top tier. Measured on one goal, opus, direct path:
 * high took 135.0s and 11,673 output tokens for $0.3036, medium 52.3s and 4,984
 * for $0.1364. Cheaper and faster, and I set medium on the strength of it, which
 * was wrong twice over.
 *
 * The evidence cannot carry the claim. Temperature is unset (1.0) and thinking is
 * on, so decomposition varies run to run at FIXED effort. Six nodes at high
 * against five at medium is n=1 versus n=1 and cannot separate an effort effect
 * from sampling noise. Arguing that fewer nodes meant medium was also better was
 * reaching for a quality story after the cost number was already in hand.
 *
 * And the economics run the other way. This is one call per project, and the
 * contracts it pins constrain every generator downstream. Recorded whole-project
 * costs are $0.35 for a 7-node bracket and about $1 for an 11-node app, so the
 * $0.17 saved on the plan is erased by a single extra repair wave, let alone a
 * replan or a user re-prompting a bad decomposition. Latency is the weak counter
 * now that the reply streams: 135s of visible progress is not 135s of dead
 * spinner. Revisit against the eval harness, which is the only thing that can
 * actually measure plan quality.
 */
const ARCHITECT_EFFORT = "high" as const;

/**
 * Repairs are a different job. A lint repair is "fix these named problems and
 * re-emit", not a decomposition decision, so the deliberation that earns its
 * keep above buys little here. This is where the measured saving belongs.
 */
const ARCHITECT_REPAIR_EFFORT = "low" as const;

const SLUG = /^[a-z][a-z0-9-]{1,40}$/;

/** The validation schema accepts payload as its real object OR a JSON string
 *  encoding one, because the WIRE schema (below) types it as a string: the CAD
 *  payload subtree alone makes the structured-outputs grammar "too large", so
 *  the model emits the payload as a string the grammar can compile, and this
 *  parses it back before the real payloadSchema judges it. An unparseable
 *  string falls through unparsed and fails payloadSchema with a real message. */
function stringOr<P>(payloadSchema: z.ZodType<P>): z.ZodType<P, z.ZodTypeDef, unknown> {
  return z.preprocess((v) => {
    // Raw value first: if the inner schema already accepts it, do not touch it.
    // Without this, wrapping a payloadSchema that IS a string (the wire twin)
    // parsed a valid JSON string into an object and then failed z.string().
    if (payloadSchema.safeParse(v).success) return v;
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    return v;
  }, payloadSchema);
}

/** The wire-side twin of makeArchitectSchema: same graph shape, payload as a
 *  JSON string. Measured: the full schema is grammar-rejected ("too large") on
 *  every call, and stubbing payload alone to a string compiles. */
export function makeArchitectWireSchema(kinds?: string[]) {
  return makeArchitectSchema(
    z
      .string()
      .describe(
        "STRICT JSON string encoding this node's domain payload object (ports, envelope, process, ...). JSON, not prose.",
      ),
    kinds,
  );
}

export function makeArchitectSchema<P>(payloadSchema: z.ZodType<P>, kinds?: string[]) {
  // Constraining kind to the backend's taxonomy makes invented kinds
  // unrepresentable at decode time (grammar-constrained samplers included).
  const kindSchema =
    kinds && kinds.length > 0 ? z.enum(kinds as [string, ...string[]]) : z.string();
  return z.object({
    nodes: z
      .array(
        z.object({
          id: z.string().describe("kebab-case slug, unique in the graph"),
          kind: kindSchema,
          title: z.string(),
          spec: z.string().describe("2-3 sentence natural-language spec for this node's generator"),
          contract: z.object({
            name: z.string(),
            summary: z.string().describe("what neighbors are told about this node"),
            params: z.array(ParamDeclNoUi).describe("live-tunable parameters (the T0 surface)"),
            provides: z.array(PortDecl),
            requires: z.array(PortDecl),
            payload: stringOr(payloadSchema),
          }),
        }),
      )
      .min(1)
      .max(15),
    edges: z.array(
      z.object({
        from: z.string(),
        fromPort: z.string(),
        to: z.string(),
        toPort: z.string(),
      }),
    ),
    entryNodeId: z.string(),
    rationale: z.string().describe("one paragraph: why this decomposition"),
    design: z
      .string()
      .default("")
      .describe(
        "2-3 sentences of NON-STRUCTURAL shared intent every generator will see: proportion, edge treatment (fillet vs chamfer and roughly what radius), wall feel, how the whole thing should read. No dimensions, no per-part instructions — those belong in contracts."
      ),
  });
}
export type ArchitectOutput = z.infer<ReturnType<typeof makeArchitectSchema<unknown>>>;

function architectSystem(backend: DomainBackend<unknown>): string {
  const kinds = backend.planning.nodeKinds
    .map((k) => `- ${k.kind}: ${k.description} ${k.guidance}`)
    .join("\n");
  return [
    "You are the architect for a patch-graph editor. You decompose a goal into",
    "a graph of nodes, each with a PINNED interface contract. You never write",
    "implementation code — generators do that later, one hermetic call per node,",
    "seeing only their own spec and their neighbors' contracts.",
    "",
    "Node kinds:",
    kinds,
    "",
    backend.planning.architectGuidance,
    "",
    "Rules:",
    "- Node ids are kebab-case slugs; the graph must be acyclic.",
    "- Every `requires` port must be satisfied by exactly one edge from a",
    "  neighbor's `provides` port of the same type.",
    "- Contracts are the ONLY interface between nodes. Anything a neighbor",
    "  needs must be expressed in the contract, never assumed.",
    "- Declare live-tunable parameters generously: sizes, counts, colors,",
    "  labels — anything a user might want to slide without regenerating.",
    "- Prefer boundaries a user thinks in (header, grid, theme), not",
    "  per-function granularity.",
    "- Write the `design` paragraph. Generators are hermetic: they see their own",
    "  contract and their neighbours' contracts, and nothing else. That means",
    "  they have NO way to agree on anything a contract does not pin, so unless",
    "  you say it once here, every part invents its own edge treatment and",
    "  proportions and the assembly reads as several projects. Keep it to shared",
    "  intent — never dimensions, never per-part instructions.",
  ].join("\n");
}

/**
 * Deterministic cleanup of syntactic slop weaker models produce, applied
 * BEFORE linting: camelCase ids → kebab, "node.port" strings in edge
 * endpoints → node part, duplicate node ids dropped (keep-first). Semantic
 * problems (wrong ports, cycles) still surface through lints + repair.
 */
export function normalizeArchitectOutput(
  out: ArchitectOutput,
  opts: {
    /** Web-code invariant: exactly one shell = the entry node. Backends
     * without a "shell" kind (CAD) skip promotion/demotion entirely. */
    enforceShell?: boolean;
  } = {},
): ArchitectOutput {
  const enforceShell = opts.enforceShell ?? true;
  const slug = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "node";

  const idMap = new Map<string, string>();
  const seen = new Set<string>();
  const nodes: ArchitectOutput["nodes"] = [];
  for (const n of out.nodes) {
    const id = slug(n.id);
    idMap.set(n.id, id);
    if (seen.has(id)) continue; // duplicate — keep first
    seen.add(id);
    nodes.push({ ...n, id });
  }

  const endpoint = (raw: string) => {
    const base = raw.includes(".") ? raw.split(".")[0]! : raw;
    return idMap.get(base) ?? slug(base);
  };

  // Models sometimes stuff "provides.foo" / "requires.bar" into port fields,
  // or pack the port into the endpoint string ("node.provides.foo").
  const port = (raw: string) => raw.replace(/^(provides|requires)\./, "").split(".").pop() ?? raw;

  const edges = out.edges.map((e) => ({
    ...e,
    from: endpoint(e.from),
    fromPort: port(e.fromPort),
    to: endpoint(e.to),
    toPort: port(e.toPort),
  }));
  // Drop exact-duplicate edges weak models often emit.
  const edgeSeen = new Set<string>();
  const dedupedEdges = edges.filter((e) => {
    const key = `${e.from}.${e.fromPort}>${e.to}.${e.toPort}`;
    if (edgeSeen.has(key)) return false;
    edgeSeen.add(key);
    return true;
  });

  // Reconcile edges with contracts — edges are authoritative:
  //  · models often draw call-direction ("controls → logic.startTimer");
  //    our edges are dependency-direction. If the named port lives on the
  //    *target's provides*, flip the edge.
  //  · a consumer that forgot to declare the matching `requires` port gets it
  //    materialized with the provider port's type; a mistyped one is coerced.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const reconciled: typeof dedupedEdges = [];
  for (const e of dedupedEdges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    // Edges to nodes the model never declared are unrecoverable noise.
    if (!from || !to || e.from === e.to) continue;

    let edge = e;
    let providerPort = from.contract.provides.find((p) => p.key === e.fromPort);
    if (!providerPort) {
      // Model drew call-direction, or named the port on the other end — flip.
      const flipped = to.contract.provides.find(
        (p) => p.key === e.toPort || p.key === e.fromPort,
      );
      if (flipped) {
        edge = { from: e.to, fromPort: flipped.key, to: e.from, toPort: flipped.key };
        providerPort = flipped;
      } else {
        // Last resort: a single-provides provider means the intent is clear.
        const sole = from.contract.provides.length === 1 ? from.contract.provides[0] : undefined;
        if (!sole) continue; // unresolvable — drop
        edge = { ...e, fromPort: sole.key };
        providerPort = sole;
      }
    }

    const consumer = byId.get(edge.to)!;
    const req = consumer.contract.requires.find((p) => p.key === edge.toPort);
    if (!req) {
      consumer.contract.requires.push({
        key: edge.toPort,
        type: providerPort.type,
        description: `wired from ${edge.from}.${providerPort.key}`,
      });
    } else if (req.type !== providerPort.type) {
      req.type = providerPort.type;
    }
    reconciled.push(edge);
  }

  // Exactly one shell: the entry keeps (or gains) the role, others demote.
  const entryId = endpoint(out.entryNodeId);
  const entryNode = byId.get(entryId) ?? nodes[0];
  if (enforceShell) {
    for (const n of nodes) {
      if (n.kind === "shell" && n !== entryNode) n.kind = "component";
    }
    if (entryNode && nodes.some(() => true)) entryNode.kind = "shell";
  }

  // Edges are authoritative: a `requires` port nothing wires into can never
  // be imported (the hermetic lint forbids it), so drop it from the contract.
  for (const n of nodes) {
    n.contract.requires = n.contract.requires.filter((r) =>
      reconciled.some((e) => e.to === n.id && e.toPort === r.key),
    );
  }

  return { ...out, nodes, edges: reconciled, entryNodeId: entryNode?.id ?? entryId };
}

function genericLints(out: ArchitectOutput): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const n of out.nodes) {
    if (!SLUG.test(n.id)) problems.push(`node id "${n.id}" is not a kebab-case slug`);
    if (ids.has(n.id)) problems.push(`duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  if (!ids.has(out.entryNodeId)) problems.push(`entryNodeId "${out.entryNodeId}" is not a node`);
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  for (const e of out.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from) problems.push(`edge from unknown node "${e.from}"`);
    if (!to) problems.push(`edge to unknown node "${e.to}"`);
    if (from && !from.contract.provides.some((p) => p.key === e.fromPort))
      problems.push(`edge ${e.from}.${e.fromPort} → ${e.to}: "${e.fromPort}" is not a provides port of ${e.from}`);
    if (to && !to.contract.requires.some((p) => p.key === e.toPort))
      problems.push(`edge ${e.from} → ${e.to}.${e.toPort}: "${e.toPort}" is not a requires port of ${e.to}`);
    const fromType = from?.contract.provides.find((p) => p.key === e.fromPort)?.type;
    const toType = to?.contract.requires.find((p) => p.key === e.toPort)?.type;
    if (fromType && toType && fromType !== toType)
      problems.push(`edge ${e.from}.${e.fromPort} (${fromType}) → ${e.to}.${e.toPort} (${toType}): port types differ`);
  }
  return problems;
}

export function architectOutputToGraph(
  out: ArchitectOutput,
  projectIdValue: string,
  backendId: string,
  goal: string,
  /** Stamped onto numeric params as `ui.unit`. The architect's schema has no
   *  `ui` (it costs optional-parameter budget it cannot afford), so the domain
   *  supplies presentation the planner was never asked about. */
  paramUnit?: string,
): GraphDoc {
  const nodes: GraphDoc["nodes"] = {};
  for (const n of out.nodes) {
    const contract = {
      ...n.contract,
      params: paramUnit
        ? n.contract.params.map((prm) =>
            prm.type === "number" ? { ...prm, ui: { unit: paramUnit } } : prm,
          )
        : n.contract.params,
      hash: "",
    };
    contract.hash = contractHash(contract);
    nodes[n.id] = {
      id: n.id,
      kind: n.kind,
      title: n.title,
      spec: n.spec,
      contract,
      pinned: false,
      params: {},
      deps: [],
      artifact: null,
      thread: [],
      status: "planned",
      measurements: null,
      version: 0,
      history: [],
      cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
    };
  }
  const edges: Edge[] = out.edges.map((e, i) => ({
    id: `e${i}-${e.from}-${e.to}`,
    from: e.from,
    fromPort: e.fromPort,
    to: e.to,
    toPort: e.toPort,
  }));
  for (const e of edges) {
    const node = nodes[e.to];
    if (node && !node.deps.includes(e.from)) node.deps.push(e.from);
  }
  return GraphDoc.parse({
    schemaVersion: 1,
    id: projectIdValue,
    backend: backendId,
    brief: { goal, constraints: [], clarifications: [], design: out.design ?? "" },
    nodes,
    edges,
    assembly: { entryNodeId: out.entryNodeId },
    layout: {},
    rev: 0,
  });
}

export interface PlanResult {
  graph: GraphDoc;
  rationale: string;
  usage: LlmUsage;
  repaired: boolean;
  /** What each lint-repair round was fixing: the problems the previous emission
   *  failed on, verbatim. An audit found the architect paying a repair round on
   *  14 of 15 plans and NOTHING recorded which lint it kept tripping — the
   *  `repaired` boolean was the entire observability. The offender turned out
   *  to be one rule (face/hole conflict) missing from the guidance, findable in
   *  one probe once this existed and invisible for a week while it did not. */
  lintRounds: string[][];
}

export async function planGraph(opts: {
  provider: LlmProvider;
  backend: DomainBackend<unknown>;
  projectId: string;
  goal: string;
  clarifications?: ChatMessage[];
  /** Lint-repair round-trips (default 3 — weaker local models need the extra rounds). */
  maxRepairs?: number;
  signal?: AbortSignal;
}): Promise<PlanResult> {
  const kinds = opts.backend.planning.nodeKinds.map((k) => k.kind);
  const wireSchema = makeArchitectWireSchema(kinds);
  const schema = makeArchitectSchema(
    opts.backend.planning.payloadSchema,
    kinds,
  );
  const enforceShell = opts.backend.planning.nodeKinds.some((k) => k.kind === "shell");
  // THE PAYLOAD SPEC, in the prompt, because the grammar can no longer carry
  // it. The wire schema types payload as a JSON string (the full payload
  // subtree makes the compiled grammar "too large"), which fixed malformed JSON
  // completely — and removed the model's only sight of the payload's shape,
  // since the old grammar-rejection fallback had been embedding the whole
  // schema into the prompt as a side effect. A sweep after the split: 6 of 8
  // runs dead on payload VALIDATION (envelope volumes missing pose/dims,
  // process the wrong shape), $2.78 to learn that the fallback had been
  // documentation. Grammar constrains the graph; this documents the string.
  const payloadDoc = JSON.stringify(
    zodToJsonSchema(opts.backend.planning.payloadSchema, { target: "jsonSchema7", $refStrategy: "none" }),
  );
  const system =
    architectSystem(opts.backend) +
    `

Each node's contract.payload is a STRICT JSON string. The object it encodes MUST match this JSON schema exactly:
${payloadDoc}`;
  const goalMessage = { role: "user" as const, content: `Goal: ${opts.goal}` };

  const first = await opts.provider.complete({
    role: "architect",
    label: `architect:${opts.projectId}`,
    system,
    messages: [goalMessage],
    schema,
    wireSchema,
    maxTokens: ARCHITECT_MAX_TOKENS,
    effort: ARCHITECT_EFFORT,
    signal: opts.signal,
  });

  const usage: LlmUsage = { ...first.usage };
  let out = normalizeArchitectOutput(first.data, { enforceShell });
  let repaired = false;
  const lintRounds: string[][] = [];

  const lint = (o: ArchitectOutput): string[] => {
    const problems = genericLints(o);
    if (problems.length === 0) {
      const graph = architectOutputToGraph(o, opts.projectId, opts.backend.id, opts.goal, opts.backend.planning.paramUnit);
      for (const l of opts.backend.planning.graphLints) problems.push(...l.run(graph));
    }
    return problems;
  };

  let problems = lint(out);
  const maxRepairs = opts.maxRepairs ?? 3;
  for (let round = 1; problems.length > 0 && round <= maxRepairs; round++) {
    repaired = true;
    lintRounds.push([...problems]);
    const repair = await opts.provider.complete({
      role: "architect",
      label: `architect-repair-${round}:${opts.projectId}`,
      system,
      messages: [
        goalMessage,
        { role: "assistant", content: JSON.stringify(out) },
        {
          role: "user",
          content: [
            `Your graph failed validation:`,
            ...problems.map((p) => `- ${p}`),
            "",
            "Fix ONLY these problems and emit the corrected complete graph.",
            "Remember: every edge must connect an existing `provides` port to an",
            "existing `requires` port of the SAME type — declare the missing",
            "`requires` port (or fix the type) rather than inventing new edges.",
          ].join("\n"),
        },
      ],
      schema,
      wireSchema,
      maxTokens: ARCHITECT_MAX_TOKENS,
      effort: ARCHITECT_REPAIR_EFFORT,
      signal: opts.signal,
    });
    usage.inputTokens += repair.usage.inputTokens;
    usage.outputTokens += repair.usage.outputTokens;
    usage.usd += repair.usage.usd;
    out = normalizeArchitectOutput(repair.data, { enforceShell });
    problems = lint(out);
  }
  if (problems.length > 0) {
    throw new Error(`architect graph failed lints after ${maxRepairs} repairs:\n${problems.join("\n")}`);
  }

  return {
    graph: architectOutputToGraph(out, opts.projectId, opts.backend.id, opts.goal, opts.backend.planning.paramUnit),
    rationale: out.rationale,
    usage,
    repaired,
    lintRounds,
  };
}
