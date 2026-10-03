import type { z } from "zod";
import type { LlmImage } from "./llm.js";
import type { ArchitectOutput } from "./architect.js";
import type {
  Contract,
  GraphDoc,
  JointDecl,
  NodeRecord,
  ParamValue,
  ChatMessage,
} from "@patchcad/shared";

/**
 * The contract between the domain-agnostic engine and a domain backend
 * (web-code, cad, ...). Hermeticity is enforced by construction: the
 * generation context exposes neighbor CONTRACTS only — `ContractView` has no
 * code field, so a neighbor's implementation cannot reach a prompt.
 *
 * `exemplars` is the one place code from elsewhere enters a prompt, and it is
 * deliberately not an exception: entries come from OTHER graphs, and
 * selectExemplars (exemplars.ts) drops any whose contract hash appears in the
 * requesting graph — because a node captured into the library can later be a
 * neighbor of the node being generated. That filter is the invariant; it has a
 * test, not just this comment.
 */

/** What a generator is allowed to know about a neighbor. No code field. */
export interface ContractView {
  nodeId: string;
  direction: "upstream" | "downstream";
  /** Which of this node's ports connect to the neighbor. */
  viaPorts: { fromPort: string; toPort: string }[];
  contract: Pick<
    Contract,
    "name" | "summary" | "params" | "provides" | "requires" | "payload"
  >;
}

export interface GenerateCtx<P = unknown> {
  brief: GraphDoc["brief"];
  node: {
    id: string;
    kind: string;
    title: string;
    spec: string;
    contract: Contract & { payload: P };
    params: Record<string, ParamValue>;
    thread: ChatMessage[];
    /** Present on regeneration so the model modifies rather than rewrites. */
    currentCode?: string;
  };
  upstream: ContractView[];
  downstream: ContractView[];
  /** Verified worked examples mined from the node library — never from this
   *  graph. Empty when no library is configured or nothing suitable is stored. */
  exemplars?: Exemplar[];
  /** Set on a FRESH START: repairs stopped improving, so the cook asks for a
   *  new part from scratch rather than another patch on the same code. Every
   *  failure so far, oldest first — the approaches already tried, so the fresh
   *  attempt does not walk back into one. Absent on a first generate. */
  priorFailures?: { stage: string; report: string }[];
  /** Every node's current param values, defaults filled in. Values, never
   *  code: they let a backend print contract expressions such as a pose
   *  component "param(plate.thickness) / 2" as the numbers its gates check. */
  paramValues?: Record<string, Record<string, ParamValue>>;
  /** Images the user attached to THIS node's thread (a reprompt with a
   *  picture). The user's spec for this part, never a neighbour's anything. */
  refImages?: LlmImage[];
}

/** A library entry rendered as a worked example: the interface that was asked
 *  for, and the code that satisfied it and passed every gate. */
export interface Exemplar {
  title: string;
  kind: string;
  contract: Contract;
  code: string;
}

export interface RepairCtx<P = unknown> extends GenerateCtx<P> {
  failedCode: string;
  failure: { stage: string; report: string };
  /** Which round `failedCode` came from. Repairs build on the best-scoring
   *  attempt so far, which is not always the latest — a repair that made
   *  things worse is dropped rather than patched again. */
  basedOnAttempt?: number;
  attempt: number;
  /** Total generation rounds this cook is allowed, so a prompt can say
   *  "attempt 3 of 5" — a last round reads differently from a first. */
  maxAttempts: number;
  /** Every failure this cook so far except `failure` (the one being repaired,
   *  which is the best-scoring, not always the latest), oldest first. Without
   *  these the model re-tries approaches it already burned a round on; empty
   *  on the first repair. */
  priorFailures: { stage: string; report: string }[];
  /**
   * What the failed artifact actually looks like, when the backend could
   * render it. Present only when the code built a shape — a part that failed
   * to execute has nothing to show. This is the one input that can catch
   * "compiles, measures fine, looks wrong", which no gate can see.
   */
  render?: LlmImage;
}

export interface PromptSpec {
  system: string;
  messages: { role: "user" | "assistant"; content: string; images?: LlmImage[] }[];
  /** Forced output schema; the LLM adapter enforces it. */
  schema: z.ZodType<GeneratedArtifact, z.ZodTypeDef, unknown>;
  role: "generator" | "repair";
}

export interface GeneratedArtifact {
  code: string;
  testCode?: string;
}

export interface ExecuteResult {
  ok: boolean;
  stage: string;
  report: string;
  /** How close a failure came to passing: higher = closer to passing; backends
   *  that omit it are treated as equal. Repairs build on the best score. */
  score?: number;
}

export interface VerifyResult {
  ok: boolean;
  stage: string;
  report: string;
  /** How close a failure came to passing: higher = closer to passing; backends
   *  that omit it are treated as equal. Repairs build on the best score. */
  score?: number;
  /** What the checks measured on a PASS, for the user rather than the model.
   *  Domain-shaped, so the engine only persists it — see NodeMeasurements. */
  measurements?: unknown;
}

/** An assembly-level failure pinned on the parts that produce it. Every
 *  finding is also one of `problems`; this is the structured copy. */
export interface CheckFinding {
  nodeA: string;
  nodeB: string;
  /** Domain-named. CAD: clash | gap | fit. */
  kind: string;
  measured: number;
  expected: number;
  message: string;
  /** The backend can name whose CODE is at fault (one part's material in its
   *  partner's envelope): cookNodes then gives that node a repair round with
   *  `report` as the failure, up to its attempt budget, before the block
   *  stands as contract-infeasible. */
  repair?: { nodeId: string; report: string };
}

export interface CheckResult {
  ok: boolean;
  problems: string[];
  /** Attributed failures. The engine blocks the named nodes (applyCheck), so a
   *  backend lists here only what a user should act on part by part. */
  findings?: CheckFinding[];
  /** Reported, never blocking: also in `problems`, but applyCheck ignores
   *  them, so no node changes status. For checks with no calibrated
   *  threshold yet (CAD: silhouette IoU against a reference image). */
  advisories?: CheckAdvisory[];
  /** Some comparison did not run (checker down, a pair not compared). The
   *  engine then keeps every existing block: silence is not a clear. */
  incomplete?: boolean;
}

/** A non-blocking assembly finding, with the nodes most responsible. */
export interface CheckAdvisory {
  /** Domain-named. CAD: silhouette. */
  kind: string;
  nodes: string[];
  measured: number;
  expected: number;
  message: string;
  view?: string;
  ref?: string;
}

/** Filesystem root the backend materializes into (project/.preview etc.). */
export interface Workspace {
  root: string;
}

export interface PreviewAdapter {
  /** Start (or attach to) the live preview; returns the URL the studio iframes. */
  start(ws: Workspace): Promise<{ url: string }>;
  /** One node's artifact changed — swap just that module. */
  hotSwap(graph: GraphDoc, ws: Workspace, nodeIds: string[]): Promise<void>;
  stop(): Promise<void>;
}

export interface NodeKindSpec {
  kind: string;
  description: string;
  /** Guidance the architect prompt embeds (sizing, responsibilities). */
  guidance: string;
}

export type GraphLint = { run(graph: GraphDoc): string[] };

/** What a request to change a pinned interface sounds like in one domain. The
 *  engine's own rules know only web vocabulary (exports, props, callbacks). */
export interface TierHints {
  /** Always an interface change, e.g. "add a hole": routes T3 with no LLM. */
  addsInterface: RegExp;
  /** Words that move a measured interface dimension. Together with one of the
   *  node's contract ports or params named in the same message, T3 with no
   *  LLM call: "make the mount hole 5mm" changes a pinned diameter. */
  sizeWords: RegExp;
  /** The classifier's T2/T3 definitions, in this domain's terms. */
  classifierGuide: string;
}

export type FailureClass = "code-invalid" | "contract-infeasible" | "unknown";

export interface DomainBackend<P = unknown> {
  id: string;

  /** Generation rounds this domain gets per node: 1 generate + (N-1) repairs.
   *  Domains differ in how much a repair round is worth — a CAD gate failure
   *  carries a measured number to correct, so extra rounds convert to fixes
   *  more often than a type error does. Omit to take the engine default. */
  maxAttempts?: number;

  /** How hard the generator should think, and how much room it gets to answer.
   *
   *  These belong to the domain, not the scheduler: what a part costs to write
   *  is a fact about the domain's language and its gates. They live here for the
   *  same reason `maxAttempts` does — and because hardcoding them in the engine
   *  had a concrete cost. A flat `maxTokens` chosen against one adapter's
   *  default (16000) was a silent REDUCTION against another's (32000), so the
   *  same constant raised the ceiling or lowered it depending on which provider
   *  a role happened to be routed to.
   *
   *  Omit either to leave it to the provider. Note `effort` is only honoured by
   *  adapters that have such a control; the rest ignore it, like every other
   *  optional field on LlmRequest.
   *
   *  This governs GENERATION, where the domain knows what writing one part in
   *  its own language costs. The architect pass keeps its own constants in
   *  architect.ts, and that is not the same mistake: the architect is the
   *  engine's own call rather than a domain's, and its budget is pinned there
   *  precisely so it stops depending on which adapter happens to serve it,
   *  which is the failure this comment describes. */
  generation?: {
    effort?: "low" | "medium" | "high";
    maxTokens?: number;
    /** Parallel drafts on round 1; the gates pick (first pass wins, otherwise
     *  the best score becomes the repair base). Omit for one. */
    firstRoundCandidates?: number;
    /** Nodes cooked at once. Omit for 4. */
    concurrency?: number;
    /** From round `fromAttempt` on, generate under these settings instead.
     *  Raise `maxTokens` with `effort`: more thinking under the same ceiling
     *  is how a round returns no code at all. */
    escalate?: {
      fromAttempt: number;
      effort?: "low" | "medium" | "high";
      maxTokens?: number;
    };
  };

  planning: {
    nodeKinds: NodeKindSpec[];
    /** Validates Contract.payload for this domain. */
    payloadSchema: z.ZodType<P>;
    graphLints: GraphLint[];
    /** Unit suffix to stamp on planned numeric params, e.g. "mm". The architect
     *  is not asked to choose presentation (`ui` is stripped from its schema to
     *  stay inside the structured-output optional-parameter budget), so without
     *  this every slider in a freshly planned project shows a bare number — in a
     *  domain where every number is millimetres. Omit where a domain has no one
     *  natural unit. */
    paramUnit?: string;
    /** Domain-specific fragment merged into the architect system prompt. */
    architectGuidance: string;
    /** Replaces the architect's generic decomposition rules (param and
     *  granularity advice), which are written for web components — "prefer
     *  boundaries like header, grid, theme" contradicts a domain where one
     *  part is a complete answer. The structural rules (ids, edges, contracts,
     *  `design`) stay. Omit to keep the generic ones. */
    architectRules?: string[];
    /** Reprompt routing in this domain's words (tier.ts). */
    tierHints?: TierHints;
    /** Payload keys no neighbor's code reads (CAD: visualChecks, sourcing
     *  notes). Editing them changes the hash but not the shape, so nothing
     *  downstream goes dirty (diffContract). */
    advisoryPayloadKeys?: string[];
    /** Joints the architect may declare: what a joint must do, never its
     *  hardware. Travels as one JSON string on the wire, like the payload. Omit
     *  for a domain without joints. */
    jointSchema?: z.ZodType<JointDecl, z.ZodTypeDef, unknown>;
    /** Deterministic expansion of an emission, run right after
     *  normalizeArchitectOutput on every round and before the lints: joints
     *  become hardware nodes, host ports and edges. Hermetic by construction,
     *  since it runs before any cook and writes only contracts. On a live
     *  graph (reexpandGraph) `live` carries each node's current param values,
     *  so a decision reads the walls the user actually has. */
    expandPlan?(out: ArchitectOutput, live?: Record<string, Record<string, ParamValue>>): ArchitectOutput;
  };

  /** Nodes the domain resolves deterministically (registry fasteners, stock
   * parts): return code and the cook commits it — verified, zero LLM calls —
   * with cause "registry". Return null to fall through to library/generator. */
  deterministicArtifact?(node: NodeRecord): { code: string; testCode?: string } | null;

  /**
   * Work a node needs done before its deterministic artifact can build, such
   * as generating the mesh a CAD mesh node loads. Return null (synchronously)
   * when there is nothing to do; otherwise the promise resolves to what the
   * work cost, billed to the node, or null when it cost nothing. A throw lands
   * the node in error_code.
   */
  prepareArtifact?(
    node: NodeRecord,
    ws: Workspace,
    graph: GraphDoc,
    signal?: AbortSignal,
    log?: (line: string) => void,
  ): Promise<{ usd: number } | null> | null;

  /**
   * A picture of the node's current artifact, for a model to look at.
   *
   * Optional, and returning null is always fine: a domain with nothing visual
   * to show, or code that did not build far enough to render, simply skips the
   * image and the repair stays text-only.
   */
  renderArtifact?(node: NodeRecord, ws: Workspace): Promise<LlmImage | null>;

  /** Failure stages where the part built a shape worth rendering for the
   *  repair (CAD: port probes and envelope). The engine's own looks-wrong
   *  stage always renders. Omit and repairs stay text-only. */
  renderStages?: string[];

  /** Failure stages no code change can pass (CAD: a contract the gates could
   *  not read or resolve). A round that ends in one stops the cook at once and
   *  goes to classifyFailure: the rest of the budget would rewrite correct code
   *  against the same declaration. */
  terminalStages?: string[];

  /** System prompt for the visual judge (inspect.ts): what the render shows
   *  and how to read it, in this domain's terms. Omit for a generic one. */
  inspectSystem?: string;

  /** Extract the node's REAL interface (a .d.ts for code nodes) after verify.
   * Stored on artifact.dts; neighbor verification then checks against actual
   * types instead of any-stubs, catching inner-shape drift. */
  extractInterface?(node: NodeRecord, ws: Workspace): Promise<string | null>;

  buildGeneratePrompt(ctx: GenerateCtx<P>): PromptSpec;
  buildRepairPrompt(ctx: RepairCtx<P>): PromptSpec;

  /** Compile/execute the node's artifact (esbuild for code, kernel for CAD).
   *  `graph` is passed by the cook so a backend can run its verify checks in
   *  the same build; callers without one (T0 re-execution) may omit it. */
  execute(node: NodeRecord, ws: Workspace, graph?: GraphDoc): Promise<ExecuteResult>;
  /** Check the contract's postconditions against the executed artifact. */
  verify(node: NodeRecord, graph: GraphDoc, ws: Workspace): Promise<VerifyResult>;

  /** Called only once the budget is spent, so `attempts` IS the resolved
   *  budget (not a running count). Heuristics counting repeated failures must
   *  therefore scale with it: "2 failures" is a majority of 3 rounds but a
   *  minority of 5, and misreading that files a fixable bug as unfixable. */
  classifyFailure(evidence: {
    node: NodeRecord;
    failures: { stage: string; report: string }[];
    attempts: number;
  }): FailureClass;

  /** Materialize the whole graph into the workspace (glue, stubs, configs). */
  assemble(graph: GraphDoc, ws: Workspace): Promise<void>;

  previewAdapter?: PreviewAdapter;

  /** Whole-graph invariants; dirty whenever any node is dirty. */
  globalCheck(graph: GraphDoc, ws: Workspace): Promise<CheckResult>;
}
