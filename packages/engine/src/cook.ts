import { hashValue } from "@patchcad/shared";
import type { DomainBackend, GenerateCtx, RepairCtx, Workspace } from "./backend.js";
import type { LlmProvider } from "./llm.js";
import type { NodeLibrary } from "./library.js";
import type { GraphStore } from "./graph/store.js";

/**
 * The cook scheduler. Generation is embarrassingly parallel: every node's
 * generator sees only contracts (known up front), never neighbor code, so
 * there is no topological wait — topology matters only at assembly.
 *
 * Per-node loop: generate → execute → verify → (repair to the backend's
 * budget) → commit. Failures are attributed code-invalid (retry generator) vs
 * contract-infeasible (architect must re-plan) by the backend.
 */

/** Generation rounds when a backend states no preference: 1 generate + 2
 *  repairs. Backends override via `DomainBackend.maxAttempts`. */
const DEFAULT_MAX_ATTEMPTS = 3;

export interface CookDeps {
  store: GraphStore;
  backend: DomainBackend<unknown>;
  provider: LlmProvider;
  workspace: Workspace;
  /** Contract-hash reuse: a hit skips the generator entirely (still verified). */
  library?: NodeLibrary;
  concurrency?: number;
  signal?: AbortSignal;
}

export interface CookSummary {
  succeeded: string[];
  failed: { nodeId: string; stage: string; message: string }[];
}

export async function cookNodes(deps: CookDeps, nodeIds: string[]): Promise<CookSummary> {
  const summary: CookSummary = { succeeded: [], failed: [] };
  const queue = [...nodeIds];
  const workers = Math.max(1, Math.min(deps.concurrency ?? 4, queue.length));

  for (const id of queue) deps.store.setStatus(id, "queued");

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (queue.length > 0) {
        if (deps.signal?.aborted) return;
        const id = queue.shift()!;
        try {
          await cookOne(deps, id);
          summary.succeeded.push(id);
        } catch (err) {
          summary.failed.push({
            nodeId: id,
            stage: "cook",
            message: (err as Error).message,
          });
        }
      }
    }),
  );

  // Barrier: assembly + global check once the wave settles.
  const graph = deps.store.doc;
  await deps.backend.assemble(graph, deps.workspace);
  deps.store.emit({ type: "checker:status", projectId: graph.id, status: "checking", problems: [] });
  const check = await deps.backend.globalCheck(graph, deps.workspace);
  deps.store.emit({
    type: "checker:status",
    projectId: graph.id,
    status: check.ok ? "clean" : "failing",
    problems: check.problems,
  });

  return summary;
}

export async function cookOne(deps: CookDeps, nodeIdValue: string): Promise<void> {
  const { store, backend, provider, workspace } = deps;
  const graph = store.doc;
  const projectId = graph.id;
  const log = (line: string) =>
    store.emit({ type: "job:log", projectId, nodeId: nodeIdValue, line });

  // cookOne must be self-sufficient on status: direct callers (reprompt) may
  // hand it a node in any settled state, and only `queued` legally reaches
  // `generating`/`building`.
  if (store.node(nodeIdValue).status !== "queued") {
    store.setStatus(nodeIdValue, "queued");
  }

  const baseVersion = store.node(nodeIdValue).version;
  const baseContractHash = store.node(nodeIdValue).contract.hash;

  /** Real interface (.d.ts) of the verified artifact — neighbors typecheck
   * against it from now on. Best-effort: extraction failures never block. */
  const storeInterface = async () => {
    if (!backend.extractInterface) return;
    try {
      const dts = await backend.extractInterface(store.node(nodeIdValue), workspace);
      if (dts) {
        store.applyOp((g) => {
          const n = g.nodes[nodeIdValue]!;
          if (n.artifact) n.artifact = { ...n.artifact, dts };
        });
      }
    } catch {
      /* advisory */
    }
  };

  const commit = (cause: string) => {
    const node = store.node(nodeIdValue);
    if (node.contract.hash !== baseContractHash || node.version !== baseVersion) {
      throw new Error("superseded: contract or version changed mid-cook");
    }
    store.applyOp(
      (g) => {
        const n = g.nodes[nodeIdValue]!;
        n.version += 1;
        n.pinned = true;
        n.history.push({
          version: n.version,
          contractHash: n.contract.hash,
          artifactHash: n.artifact!.hash,
          cause,
          at: Date.now(),
        });
      },
      { immediate: true },
    );
    store.setStatus(nodeIdValue, "ready");
    store.emit({
      type: "node:committed",
      projectId,
      nodeId: nodeIdValue,
      version: store.node(nodeIdValue).version,
    });
  };

  /** Shared no-LLM commit path: registry and library artifacts still run the
   * full execute+verify gauntlet before committing. Returns the failure
   * report on a gate miss, null on success. */
  const tryPrebuilt = async (code: string, testCode: string, cause: string, dts?: string): Promise<string | null> => {
    store.setStatus(nodeIdValue, "building");
    store.applyOp((g) => {
      const n = g.nodes[nodeIdValue]!;
      n.artifact = { code, testCode, dts, hash: hashValue(code) };
    });
    const exec = await backend.execute(store.node(nodeIdValue), workspace);
    let failure: { stage: string; report: string } | null = exec.ok ? null : exec;
    if (exec.ok) {
      store.setStatus(nodeIdValue, "verifying");
      const verify = await backend.verify(store.node(nodeIdValue), graph, workspace);
      if (verify.ok) {
        await storeInterface();
        commit(cause);
        await backend.previewAdapter.hotSwap(store.doc, workspace, [nodeIdValue]);
        log(`ready (v${store.node(nodeIdValue).version}, ${cause})`);
        return null;
      }
      failure = verify;
    }
    log(`${cause} artifact failed ${failure!.stage}: ${failure!.report.slice(0, 200)}`);
    // Fall through to generation (repairing → generating is legal).
    store.setStatus(nodeIdValue, "repairing");
    return `${failure!.stage}: ${failure!.report}`;
  };

  // -- registry fast path: domain-deterministic parts never touch an LLM --
  const prebuilt = backend.deterministicArtifact?.(store.node(nodeIdValue));
  if (prebuilt) {
    log("registry part — deterministic code, no LLM call");
    const failed = await tryPrebuilt(prebuilt.code, prebuilt.testCode ?? "", "registry");
    if (!failed) return;
    // Never fall through to an LLM for registry parts — surface instead.
    store.setStatus(nodeIdValue, "error_code", {
      stage: "registry",
      message: `registry artifact failed gates: ${failed.slice(0, 1800)}`,
      attribution: "code-invalid",
    });
    throw new Error(`${nodeIdValue}: registry artifact failed gates`);
  }

  // -- library fast path: exact contract-hash hit skips the generator --
  const unspecialized = store.node(nodeIdValue).thread.length === 0;
  if (deps.library && unspecialized) {
    const hit = await deps.library.lookup(backend.id, baseContractHash);
    if (hit) {
      log("library hit — reusing verified code, no LLM call");
      if ((await tryPrebuilt(hit.code, hit.testCode, "library", hit.dts)) === null) return;
      log("library entry failed re-verification — regenerating");
    }
  }

  const makeCtx = (): GenerateCtx<unknown> => {
    const node = store.node(nodeIdValue);
    const views = store.contractViews(nodeIdValue);
    return {
      brief: graph.brief,
      node: {
        id: node.id,
        kind: node.kind,
        title: node.title,
        spec: node.spec,
        // zod infers `payload` as optional; GenerateCtx pins it present.
        contract: node.contract as GenerateCtx<unknown>["node"]["contract"],
        params: node.params,
        thread: node.thread,
        currentCode: node.artifact?.code,
      },
      upstream: views.upstream,
      downstream: views.downstream,
    };
  };

  const failures: { stage: string; report: string }[] = [];
  let code = "";
  let testCode = "";

  const maxAttempts = backend.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deps.signal?.aborted) throw new Error("cancelled");

    // -- generate (or repair) --
    store.setStatus(nodeIdValue, attempt === 1 ? "generating" : "repairing");
    if (attempt > 1) store.setStatus(nodeIdValue, "generating");
    const prompt =
      attempt === 1
        ? backend.buildGeneratePrompt(makeCtx())
        : backend.buildRepairPrompt({
            ...makeCtx(),
            failedCode: code,
            failure: failures.at(-1)!,
            // Everything before the latest, so the model can see which
            // approaches are already spent rather than rediscovering them.
            priorFailures: failures.slice(0, -1),
            attempt,
            maxAttempts,
          } as RepairCtx<unknown>);

    log(attempt === 1 ? "generating…" : `repair attempt ${attempt}…`);
    let result;
    try {
      result = await provider.complete({
        role: prompt.role,
        label: `${prompt.role}:${nodeIdValue}`,
        system: prompt.system,
        messages: prompt.messages,
        schema: prompt.schema,
        signal: deps.signal,
      });
    } catch (err) {
      // Provider failures (quota, rate limit, network) must land the node in
      // a resumable error state — never leave it stuck mid-transition.
      const message = (err as Error).message;
      log(`llm call failed: ${message.slice(0, 200)}`);
      store.setStatus(nodeIdValue, "error_code", {
        stage: "llm",
        message: message.slice(0, 2000),
        attribution: "unknown",
      });
      throw err;
    }
    code = result.data.code;
    testCode = result.data.testCode ?? "";

    store.applyOp((g) => {
      const n = g.nodes[nodeIdValue]!;
      n.artifact = { code, testCode, hash: hashValue(code) };
      n.cost.calls += 1;
      n.cost.inputTokens += result.usage.inputTokens;
      n.cost.outputTokens += result.usage.outputTokens;
      n.cost.usd += result.usage.usd;
    });
    store.emit({
      type: "cost:update",
      projectId,
      nodeId: nodeIdValue,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      usd: result.usage.usd,
    });

    // -- execute --
    store.setStatus(nodeIdValue, "building");
    const exec = await backend.execute(store.node(nodeIdValue), workspace);
    if (!exec.ok) {
      failures.push({ stage: exec.stage, report: exec.report });
      log(`execute failed: ${exec.report.slice(0, 200)}`);
      continue;
    }

    // -- verify --
    store.setStatus(nodeIdValue, "verifying");
    const verify = await backend.verify(store.node(nodeIdValue), graph, workspace);
    if (!verify.ok) {
      failures.push({ stage: verify.stage, report: verify.report });
      log(`verify failed: ${verify.report.slice(0, 200)}`);
      continue;
    }

    // -- commit (guarded: superseded cooks are discarded) --
    await storeInterface();
    commit(attempt === 1 ? "generate" : `repair-${attempt}`);
    // Freshly verified, unspecialized code joins the library for future briefs.
    if (deps.library && unspecialized) {
      const n = store.node(nodeIdValue);
      void deps.library
        .capture(backend.id, n.contract.hash, {
          code,
          testCode,
          kind: n.kind,
          title: n.title,
          dts: n.artifact?.dts,
        })
        .catch(() => {});
    }
    await backend.previewAdapter.hotSwap(store.doc, workspace, [nodeIdValue]);
    log(`ready (v${store.node(nodeIdValue).version}, attempt ${attempt})`);
    return;
  }

  // Budget exhausted — attribute and surface.
  const attribution = backend.classifyFailure({
    node: store.node(nodeIdValue),
    failures,
    attempts: maxAttempts,
  });
  const last = failures.at(-1)!;
  const detail = {
    stage: last.stage,
    message: last.report.slice(0, 2000),
    attribution,
  };
  store.setStatus(
    nodeIdValue,
    attribution === "contract-infeasible" ? "error_contract" : "error_code",
    detail,
  );
  throw new Error(`${nodeIdValue}: ${attribution} after ${maxAttempts} attempts (${last.stage})`);
}
