import { z } from "zod";

/**
 * The graph is the source of truth. Everything here is persisted in
 * patchcad.json (minus code bodies, which live in nodes/<id>/vN.code.*).
 */

// ---------- Params (the T0 surface) ----------

/** Presentation hints for the studio. Deliberately NOT part of the contract
 *  hash (see engine graph/diff.ts contractHash): grouping a param or labelling
 *  its unit changes nothing the generated code, the kernel, or a neighbor
 *  depends on, so it must not dirty a graph — nor orphan the node library,
 *  which is keyed by that same hash. */
export const ParamUi = z.object({
  /** Section this param is filed under in the inspector, e.g. "holes". */
  group: z.string().optional(),
  /** Suffix shown after the value: "mm", "°". Display only — never parsed. */
  unit: z.string().optional(),
});
export type ParamUi = z.infer<typeof ParamUi>;

const paramCommon = {
  name: z.string(),
  description: z.string().default(""),
  ui: ParamUi.optional(),
};

export const ParamDecl = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("number"),
    ...paramCommon,
    default: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
  }),
  z.object({
    type: z.literal("string"),
    ...paramCommon,
    default: z.string(),
  }),
  z.object({
    type: z.literal("boolean"),
    ...paramCommon,
    default: z.boolean(),
  }),
  z.object({
    type: z.literal("enum"),
    ...paramCommon,
    default: z.string(),
    options: z.array(z.string()).min(1),
  }),
  z.object({
    type: z.literal("color"),
    ...paramCommon,
    default: z.string(),
  }),
]);
export type ParamDecl = z.infer<typeof ParamDecl>;

export const ParamValue = z.union([z.number(), z.string(), z.boolean()]);
export type ParamValue = z.infer<typeof ParamValue>;

// ---------- Ports ----------

export const PortDecl = z.object({
  key: z.string(),
  /** Domain-scoped type label, e.g. "component" | "store" | "tokens" for code,
   *  "BORE" | "SCREW_BOSS" | ... for CAD. */
  type: z.string(),
  description: z.string().default(""),
});
export type PortDecl = z.infer<typeof PortDecl>;

// ---------- Contract ----------

export const Contract = z.object({
  name: z.string(),
  /** What neighbors are told about this node — part of the hermetic context. */
  summary: z.string(),
  params: z.array(ParamDecl).default([]),
  provides: z.array(PortDecl).default([]),
  requires: z.array(PortDecl).default([]),
  /** Domain-specific payload (CodeContractPayload, CadContractPayload, ...).
   *  Validated by the active DomainBackend's payloadSchema. */
  payload: z.unknown(),
  /** hash of canonical JSON of everything above — the dirty-detection unit.
   *  Recomputed by the engine on every contract mutation. */
  hash: z.string().default(""),
});
export type Contract = z.infer<typeof Contract>;

// ---------- Chat / threads ----------

export const ChatMessage = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  at: z.number(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

// ---------- Node ----------

export const NodeStatus = z.enum([
  "planned",
  "queued",
  "generating",
  "building",
  "verifying",
  "repairing",
  "ready",
  "dirty",
  "error_code",
  "error_contract",
  "cancelled",
]);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const CookFailure = z.object({
  stage: z.string(),
  message: z.string(),
  attribution: z.enum(["code-invalid", "contract-infeasible", "unknown"]),
});
export type CookFailure = z.infer<typeof CookFailure>;

export const Artifact = z.object({
  code: z.string(),
  testCode: z.string().default(""),
  /** Machine-checkable interface extracted from the committed code (real
   * .d.ts for web nodes) — consumers typecheck against THIS, not any-stubs,
   * so inner-shape drift fails verification instead of crashing at runtime. */
  dts: z.string().optional(),
  hash: z.string(),
});
export type Artifact = z.infer<typeof Artifact>;

export const NodeVersionMeta = z.object({
  version: z.number(),
  contractHash: z.string(),
  artifactHash: z.string(),
  cause: z.string(),
  at: z.number(),
});
export type NodeVersionMeta = z.infer<typeof NodeVersionMeta>;

export const NodeCost = z.object({
  calls: z.number().default(0),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  usd: z.number().default(0),
});
export type NodeCost = z.infer<typeof NodeCost>;

export const NodeRecord = z.object({
  id: z.string(),
  /** Domain-defined kind: shell|component|state|style|data|logic (code),
   *  part|fastener|assembly (CAD), ... */
  kind: z.string(),
  title: z.string(),
  /** The architect's natural-language spec for this node. */
  spec: z.string(),
  contract: Contract,
  /** After first cook, contracts are pinned: only architect-approved diffs change them. */
  pinned: z.boolean().default(false),
  /** Current T0 values (defaults come from contract.params). */
  params: z.record(ParamValue).default({}),
  deps: z.array(z.string()).default([]),
  artifact: Artifact.nullable().default(null),
  thread: z.array(ChatMessage).default([]),
  status: NodeStatus.default("planned"),
  statusDetail: CookFailure.optional(),
  version: z.number().default(0),
  history: z.array(NodeVersionMeta).default([]),
  cost: NodeCost.default({ calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 }),
});
export type NodeRecord = z.infer<typeof NodeRecord>;

// ---------- Edges ----------

export const Edge = z.object({
  id: z.string(),
  from: z.string(),
  fromPort: z.string(),
  to: z.string(),
  toPort: z.string(),
});
export type Edge = z.infer<typeof Edge>;

// ---------- GraphDoc ----------

export const NodeLayout = z.object({
  x: z.number(),
  y: z.number(),
  manual: z.boolean().default(false),
});
export type NodeLayout = z.infer<typeof NodeLayout>;

export const GraphDoc = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  /** Which DomainBackend interprets this graph: "web-code" | "cad". */
  backend: z.string(),
  brief: z.object({
    goal: z.string(),
    constraints: z.array(z.string()).default([]),
    clarifications: z.array(ChatMessage).default([]),
  }),
  nodes: z.record(NodeRecord),
  edges: z.array(Edge),
  assembly: z.object({ entryNodeId: z.string() }),
  layout: z.record(NodeLayout).default({}),
  /** Bumped on every applyOp — optimistic-concurrency + persistence stamp. */
  rev: z.number().default(0),
});
export type GraphDoc = z.infer<typeof GraphDoc>;
