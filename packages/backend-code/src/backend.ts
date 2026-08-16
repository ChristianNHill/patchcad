import { z } from "zod";
import type { GraphDoc, NodeRecord } from "@patchcad/shared";
import type {
  CheckResult,
  ContractView,
  DomainBackend,
  ExecuteResult,
  FailureClass,
  GenerateCtx,
  GeneratedArtifact,
  GraphLint,
  NodeKindSpec,
  PromptSpec,
  RepairCtx,
  VerifyResult,
  Workspace,
} from "@patchcad/engine";
import { CodeContractPayload } from "./payload.js";
import { assemble } from "./assemble.js";
import { executeNode, verifyNode } from "./verify.js";
import { extractDts, typecheckNode } from "./typecheck.js";
import { VitePreviewAdapter, type VitePreviewOptions } from "./preview.js";

const GeneratedArtifactSchema: z.ZodType<GeneratedArtifact> = z.object({
  code: z.string(),
  testCode: z.string().optional(),
  notes: z.string().optional(),
});

const NODE_KINDS: NodeKindSpec[] = [
  {
    kind: "shell",
    description: "The composition root: page layout that imports and arranges the components.",
    guidance: "Exactly one per graph; it is the assembly entry. Keep it thin — layout only, no business logic.",
  },
  {
    kind: "component",
    description: "A presentational React component.",
    guidance: "Props in, UI out. State lives in state nodes, styling tokens in the style node.",
  },
  {
    kind: "state",
    description: "A state store (hooks/context) owning app data and mutations.",
    guidance: "Export hooks; no JSX except providers.",
  },
  {
    kind: "style",
    description: "Design tokens and shared styling primitives.",
    guidance: "Export a tokens object and small styled helpers; single source of visual truth.",
  },
  {
    kind: "data",
    description: "Data fetching or mock data.",
    guidance: "Export typed data access functions; mock data is fine for v1.",
  },
  {
    kind: "logic",
    description: "Pure functions / domain logic.",
    guidance: "No React imports; fully unit-testable.",
  },
];

const GRAPH_LINTS: GraphLint[] = [
  {
    id: "one-shell",
    run(graph) {
      const shells = Object.values(graph.nodes).filter((n) => n.kind === "shell");
      return shells.length === 1 ? [] : [`expected exactly 1 shell node, found ${shells.length}`];
    },
  },
  {
    id: "acyclic",
    run(graph) {
      const problems: string[] = [];
      const visiting = new Set<string>();
      const done = new Set<string>();
      const outs = new Map<string, string[]>();
      for (const e of graph.edges) {
        outs.set(e.from, [...(outs.get(e.from) ?? []), e.to]);
      }
      const visit = (id: string): boolean => {
        if (done.has(id)) return true;
        if (visiting.has(id)) return false;
        visiting.add(id);
        for (const next of outs.get(id) ?? []) if (!visit(next)) return false;
        visiting.delete(id);
        done.add(id);
        return true;
      };
      for (const id of Object.keys(graph.nodes)) {
        if (!visit(id)) {
          problems.push(`dependency cycle involving ${id}`);
          break;
        }
      }
      return problems;
    },
  },
  {
    id: "requires-satisfied",
    run(graph) {
      const problems: string[] = [];
      for (const node of Object.values(graph.nodes)) {
        for (const req of node.contract.requires) {
          const satisfied = graph.edges.some(
            (e) => e.to === node.id && e.toPort === req.key,
          );
          if (!satisfied) problems.push(`${node.id}.requires.${req.key} has no incoming edge`);
        }
      }
      return problems;
    },
  },
  {
    id: "payload-valid",
    run(graph) {
      const problems: string[] = [];
      for (const node of Object.values(graph.nodes)) {
        const parsed = CodeContractPayload.safeParse(node.contract.payload);
        if (!parsed.success) problems.push(`${node.id}: invalid code payload — ${parsed.error.issues[0]?.message}`);
      }
      return problems;
    },
  },
];

function describeNeighbor(view: ContractView): string {
  const payload = CodeContractPayload.safeParse(view.contract.payload);
  const exports = payload.success
    ? payload.data.exports.map((e) => `${e.name} (${e.exportKind}${e.signature ? `: ${e.signature}` : ""})`).join(", ")
    : "(unknown)";
  const props = payload.success && payload.data.propsType ? `\n  props: ${payload.data.propsType}` : "";
  return [
    `- ${view.contract.name} — import from "@nodes/${view.nodeId}"`,
    `  ${view.contract.summary}`,
    `  exports: ${exports}${props}`,
  ].join("\n");
}

function generatorSystem(): string {
  return [
    "You are a code generator for one node in a patch graph. You write exactly one ES module.",
    "",
    "Hard rules:",
    '- Import neighbors ONLY via their "@nodes/<id>" specifiers listed below, and only the exports named in their contracts.',
    '- Read live parameters with `usePatchcadParam(nodeId, key, fallback)` from "@patchcad/preview-runtime" for every param declared in your contract.',
    "- Export exactly the names your contract declares, with the declared kinds.",
    "- React function components only; no class components (Fast Refresh).",
    "- No external packages beyond react and @patchcad/preview-runtime.",
    "- Style inline or via the style node's tokens if it is a neighbor.",
    "- TypeScript (.tsx). Self-contained: no TODOs, no placeholders.",
    "",
    "Return JSON: { code, testCode?, notes? }. `code` is the full module source.",
  ].join("\n");
}

function contractBlock(ctx: GenerateCtx<CodeContractPayload>): string {
  const c = ctx.node.contract;
  const params = c.params
    .map((p) => `- ${p.name} (${p.type}, default ${JSON.stringify(p.default)}): ${p.description}`)
    .join("\n");
  return [
    `# Your node: ${ctx.node.title} (id: ${ctx.node.id}, kind: ${ctx.node.kind})`,
    `Spec: ${ctx.node.spec}`,
    `Module: ${c.payload.module}`,
    `Exports you MUST provide: ${c.payload.exports.map((e) => `${e.name} (${e.exportKind})`).join(", ")}`,
    c.payload.propsType ? `Props type: ${c.payload.propsType}` : "",
    params ? `Live params (via usePatchcadParam("${ctx.node.id}", ...)):\n${params}` : "",
    c.payload.postconditions.length
      ? `Postconditions (encode each in testCode):\n${c.payload.postconditions.map((p) => `- ${p}`).join("\n")}`
      : "",
    "",
    `# App brief\n${ctx.brief.goal}`,
    ctx.brief.constraints.length ? `Constraints:\n${ctx.brief.constraints.map((s) => `- ${s}`).join("\n")}` : "",
    "",
    ctx.upstream.length
      ? `# Upstream neighbors (import these)\n${ctx.upstream.map(describeNeighbor).join("\n")}`
      : "# Upstream neighbors: none",
    ctx.downstream.length
      ? `# Downstream consumers (they rely on your exports — do not deviate from the contract)\n${ctx.downstream
          .map((v) => `- ${v.contract.name}: ${v.contract.summary}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export class CodeBackend implements DomainBackend<CodeContractPayload> {
  id = "web-code";
  previewAdapter: VitePreviewAdapter;

  planning = {
    nodeKinds: NODE_KINDS,
    payloadSchema: CodeContractPayload as z.ZodType<CodeContractPayload>,
    graphLints: GRAPH_LINTS,
    architectGuidance: [
      "Decompose into 5–12 nodes, each under ~150 lines: exactly one shell,",
      "state nodes owning stores, one style node owning tokens, presentational",
      "components, data nodes for fetch/mock, logic nodes for pure functions.",
      "Every contract's payload.module must be `@nodes/<node-id>`.",
      "Params are the user's live control panel: give every one a plain-words",
      "`description` and a real min/max, and use `ui` for presentation only —",
      '{"group": "layout", "unit": "px"} — which stays outside the contract hash.',
    ].join(" "),
  };

  /** The engine default, stated explicitly so classifyFailure can compare
   *  against it instead of a bare literal. */
  readonly maxAttempts = 3;

  constructor(previewOpts: VitePreviewOptions) {
    this.previewAdapter = new VitePreviewAdapter(previewOpts);
  }

  buildGeneratePrompt(ctx: GenerateCtx<CodeContractPayload>): PromptSpec {
    const thread = ctx.node.thread.map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));
    const current = ctx.node.currentCode
      ? `\n\n# Current code (modify, don't rewrite from scratch)\n\`\`\`tsx\n${ctx.node.currentCode}\n\`\`\``
      : "";
    return {
      role: "generator",
      system: generatorSystem(),
      messages: [...thread, { role: "user", content: contractBlock(ctx) + current }],
      schema: GeneratedArtifactSchema,
    };
  }

  buildRepairPrompt(ctx: RepairCtx<CodeContractPayload>): PromptSpec {
    return {
      role: "repair",
      system: generatorSystem(),
      messages: [
        {
          role: "user",
          content: [
            contractBlock(ctx),
            "",
            `# Your previous attempt failed at stage "${ctx.failure.stage}" (attempt ${ctx.attempt})`,
            "```",
            ctx.failure.report,
            "```",
            "# The failing code",
            "```tsx",
            ctx.failedCode,
            "```",
            "Fix the failure. Keep the contract exactly as specified.",
          ].join("\n"),
        },
      ],
      schema: GeneratedArtifactSchema,
    };
  }

  async execute(node: NodeRecord, _ws: Workspace): Promise<ExecuteResult> {
    return executeNode(node);
  }

  async verify(node: NodeRecord, graph: GraphDoc, ws: Workspace): Promise<VerifyResult> {
    // Cheap contract/hermeticity checks first, then the real TS checker.
    const contractCheck = verifyNode(node, graph);
    if (!contractCheck.ok) return contractCheck;
    return typecheckNode(node, graph, ws);
  }

  /** Real .d.ts of the committed module — consumers typecheck against it. */
  async extractInterface(node: NodeRecord, ws: Workspace): Promise<string | null> {
    return extractDts(node, ws);
  }

  classifyFailure(evidence: {
    node: NodeRecord;
    failures: { stage: string; report: string }[];
    attempts: number;
  }): FailureClass {
    const last = evidence.failures.at(-1);
    if (!last) return "unknown";
    // Neighbor-contract-rooted type errors are the contract's fault, but only
    // once a full budget failed to shake them out. Compared against this
    // backend's own budget rather than a literal, so raising the budget
    // cannot silently turn this into an always-true test.
    if (/@nodes\/[\w-]+.*(has no exported member|not assignable)/s.test(last.report)) {
      return evidence.attempts >= this.maxAttempts ? "contract-infeasible" : "code-invalid";
    }
    return "code-invalid";
  }

  async assemble(graph: GraphDoc, ws: Workspace): Promise<void> {
    await assemble(graph, ws);
  }

  /** Whole-graph invariant: the assembled workspace must actually bundle.
   * Catches cross-node breakage (bad imports, missing exports, syntax) that
   * per-node verification can't see. */
  async globalCheck(_graph: GraphDoc, ws: Workspace): Promise<CheckResult> {
    const { build } = await import("esbuild");
    const path = await import("node:path");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    try {
      const result = await build({
        entryPoints: [path.join(ws.root, "src", "main.tsx")],
        bundle: true,
        write: false,
        logLevel: "silent",
        jsx: "automatic",
        absWorkingDir: ws.root,
        alias: {
          "@nodes": path.join(ws.root, "src", "nodes"),
          "@patchcad/preview-runtime": require.resolve("@patchcad/preview-runtime"),
        },
      });
      const problems = result.errors.map(
        (e) => `${e.location?.file ?? "?"}:${e.location?.line ?? 0} ${e.text}`,
      );
      return { ok: problems.length === 0, problems };
    } catch (err) {
      const messages =
        (err as { errors?: { location?: { file?: string; line?: number }; text: string }[] })
          .errors ?? [];
      const problems = messages.length
        ? messages.map((e) => `${e.location?.file ?? "?"}:${e.location?.line ?? 0} ${e.text}`)
        : [(err as Error).message];
      return { ok: false, problems };
    }
  }
}
