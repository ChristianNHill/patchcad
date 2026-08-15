import type { z } from "zod";
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
 * generation context exposes neighbor CONTRACTS only — there is no field
 * through which a backend could leak neighbor code into a prompt.
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
}

export interface RepairCtx<P = unknown> extends GenerateCtx<P> {
  failedCode: string;
  failure: { stage: string; report: string };
  attempt: number;
}

export interface PromptSpec {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
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
