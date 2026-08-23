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

/**
 * ParamDecl without `ui`. Spelled out per variant rather than derived, because
 * mapping over a discriminated union's options loses the per-option type that
 * `.omit` and `z.discriminatedUnion` both need — KEEP THIS IN STEP WITH THE
 * UNION ABOVE when adding a param type.
 *
 * This exists for the architect. Structured outputs caps a schema at 24
 * optional parameters, and because `ui` sits in `paramCommon` it was inlined
 * once per variant — `ui`, `ui.group` and `ui.unit` across five variants was 15
 * of the whole-graph schema's 31 optionals, on its own over half the budget.
 * Dropping it there is also just correct: `ui` is presentation, which is why it
 * is stripped from contractHash, and a planner has no business choosing an
 * inspector grouping. The studio and T2 contract edits still set it.
 */
export const ParamDeclNoUi = z.discriminatedUnion("type", [
  ParamDecl.options[0].omit({ ui: true }),
  ParamDecl.options[1].omit({ ui: true }),
  ParamDecl.options[2].omit({ ui: true }),
  ParamDecl.options[3].omit({ ui: true }),
  ParamDecl.options[4].omit({ ui: true }),
]);
export type ParamDeclNoUi = z.infer<typeof ParamDeclNoUi>;

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

/** What verification actually measured, kept from the last PASSING verify.
 *  Failures already survive as statusDetail; without this the passing numbers
 *  were computed, cached kernel-side, returned to Node and then dropped, so
 *  nothing ever showed the user that the gates agreed with the contract. */
export const NodeMeasurements = z.object({
  /** Node version these were probed at. */
  version: z.number(),
  /** Hash of the params they were probed with. A T0 edit re-executes a part
   *  but does not re-probe it, so the studio compares this against the live
   *  params and says the numbers are stale rather than implying they are current. */
  paramsHash: z.string(),
  /** Domain-shaped: CAD stores volume/area/bbox, per-port probe results,
   *  envelope containment, and the advisory printability block. */
  data: z.unknown(),
});
export type NodeMeasurements = z.infer<typeof NodeMeasurements>;

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
  /** Excluded from export and from the rendered scene, but STILL SOLVED — a
   *  hidden node keeps its pose so anything mated to it stays put. Changes no
   *  contract and no hash, so hiding never dirties anything. */
  hidden: z.boolean().default(false),
  deps: z.array(z.string()).default([]),
  artifact: Artifact.nullable().default(null),
  thread: z.array(ChatMessage).default([]),
  status: NodeStatus.default("planned"),
  statusDetail: CookFailure.optional(),
  measurements: NodeMeasurements.nullable().default(null),
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
    /** Non-structural intent every generator sees: proportion, edge treatment,
     *  how the thing should read. Hermeticity gives parts no way to agree on
     *  anything the contract does not pin, so without this each one invents its
     *  own styling and the assembly looks like several projects. Architect
     *  output, not neighbour code, so the invariant holds. */
    design: z.string().default(""),
  }),
  nodes: z.record(NodeRecord),
  edges: z.array(Edge),
  assembly: z.object({ entryNodeId: z.string() }),
  layout: z.record(NodeLayout).default({}),
  /** Bumped on every applyOp — optimistic-concurrency + persistence stamp. */
  rev: z.number().default(0),
});
export type GraphDoc = z.infer<typeof GraphDoc>;
