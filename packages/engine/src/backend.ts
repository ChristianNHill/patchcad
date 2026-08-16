import type { z } from "zod";
import type { LlmImage } from "./llm.js";
import type {
  Contract,
  GraphDoc,
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
  attempt: number;
  /** Total generation rounds this cook is allowed, so a prompt can say
   *  "attempt 3 of 5" — a last round reads differently from a first. */
  maxAttempts: number;
  /** Every EARLIER failure, oldest first (`failure` is the latest, and is not
   *  repeated here). Without these the model re-tries approaches it already
   *  burned a round on; empty on the first repair. */
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
  notes?: string;
}

export interface ExecuteResult {
  ok: boolean;
  stage: string;
  report: string;
}

export interface VerifyResult {
  ok: boolean;
  stage: string;
  report: string;
  /** What the checks measured on a PASS, for the user rather than the model.
   *  Domain-shaped, so the engine only persists it — see NodeMeasurements. */
  measurements?: unknown;
}

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

/** Filesystem root the backend materializes into (project/.preview etc.). */
export interface Workspace {
  root: string;
}

export interface PreviewAdapter {
  /** Start (or attach to) the live preview; returns the URL the studio iframes. */
  start(graph: GraphDoc, ws: Workspace): Promise<{ url: string }>;
  /** One node's artifact changed — swap just that module. */
  hotSwap(graph: GraphDoc, ws: Workspace, nodeIds: string[]): Promise<void>;
  /** T0: push new param values without any rebuild. */
  pushParams(nodeId: string, params: Record<string, ParamValue>): Promise<void>;
  stop(): Promise<void>;
}

export interface NodeKindSpec {
  kind: string;
  description: string;
  /** Guidance the architect prompt embeds (sizing, responsibilities). */
  guidance: string;
}

export interface GraphLint {
  id: string;
  run(graph: GraphDoc): string[];
}

export type FailureClass = "code-invalid" | "contract-infeasible" | "unknown";

export interface DomainBackend<P = unknown> {
  id: string;

  /** Generation rounds this domain gets per node: 1 generate + (N-1) repairs.
   *  Domains differ in how much a repair round is worth — a CAD gate failure
   *  carries a measured number to correct, so extra rounds convert to fixes
   *  more often than a type error does. Omit to take the engine default. */
  maxAttempts?: number;

  planning: {
    nodeKinds: NodeKindSpec[];
    /** Validates Contract.payload for this domain. */
    payloadSchema: z.ZodType<P>;
    graphLints: GraphLint[];
    /** Domain-specific fragment merged into the architect system prompt. */
    architectGuidance: string;
  };

  /** Nodes the domain resolves deterministically (registry fasteners, stock
   * parts): return code and the cook commits it — verified, zero LLM calls —
   * with cause "registry". Return null to fall through to library/generator. */
  deterministicArtifact?(node: NodeRecord): { code: string; testCode?: string } | null;

  /**
   * A picture of the node's current artifact, for a model to look at.
   *
   * Optional, and returning null is always fine: a domain with nothing visual
   * to show, or code that did not build far enough to render, simply skips the
   * image and the repair stays text-only.
   */
  renderArtifact?(node: NodeRecord, ws: Workspace): Promise<LlmImage | null>;

  /** Extract the node's REAL interface (a .d.ts for code nodes) after verify.
   * Stored on artifact.dts; neighbor verification then checks against actual
   * types instead of any-stubs, catching inner-shape drift. */
  extractInterface?(node: NodeRecord, ws: Workspace): Promise<string | null>;

  buildGeneratePrompt(ctx: GenerateCtx<P>): PromptSpec;
  buildRepairPrompt(ctx: RepairCtx<P>): PromptSpec;

  /** Compile/execute the node's artifact (esbuild for code, kernel for CAD). */
  execute(node: NodeRecord, ws: Workspace): Promise<ExecuteResult>;
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

  previewAdapter: PreviewAdapter;

  /** Whole-graph invariants; dirty whenever any node is dirty. */
  globalCheck(graph: GraphDoc, ws: Workspace): Promise<CheckResult>;
}
