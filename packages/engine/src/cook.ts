import { hashValue } from "@patchcad/shared";
import type { DomainBackend, GenerateCtx, RepairCtx, Workspace } from "./backend.js";
import { selectExemplars } from "./exemplars.js";
import { findReusable } from "./similarity.js";
import { inspectNode } from "./inspect.js";
import type { LlmImage, LlmProvider } from "./llm.js";
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
  /**
   * Look at each node after it passes its gates, and allow ONE rewrite if it
   * is plainly the wrong object. Off by default: it costs a render plus a
   * vision call per node, and the gates already catch everything measurable.
   */
  inspect?: boolean;
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

  /** Keep what a passing verify measured. Everything here is advisory display
   *  data — it never feeds cooking, so it lives on the node, well clear of the
   *  contract hash. Stamped with the params in force so a later slider drag
   *  (which re-executes but does not re-probe) cannot pass stale numbers off
   *  as current. */
  const storeMeasurements = (measurements: unknown) => {
    if (measurements === undefined || measurements === null) return;
    const node = store.node(nodeIdValue);
    const paramsHash = hashValue(node.params);
    store.applyOp((g) => {
      g.nodes[nodeIdValue]!.measurements = { version: node.version, paramsHash, data: measurements };
    });
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
        storeMeasurements(verify.measurements);
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

    // No exact hit: try the nearest stored contracts. An exact hash is a very
    // narrow key — one renamed summary or one extra param and a perfectly good
    // node is invisible — but a near match cannot be trusted on inspection, so
    // it is not: each candidate runs the same execute + verify gauntlet a
    // generated artifact faces, and a miss just falls through to the generator.
    // The trade is one kernel round trip against one LLM call.
    const tried = new Set<string>([baseContractHash]);
    for (const cand of await findReusable({
      library: deps.library,
      backendId: backend.id,
      contract: store.node(nodeIdValue).contract,
      kind: store.node(nodeIdValue).kind,
      exclude: tried,
    })) {
      log(`trying a near-match from the library: "${cand.entry.title}" — no LLM call`);
      const failed = await tryPrebuilt(cand.entry.code, cand.entry.testCode, "library-near", cand.entry.dts);
      if (failed === null) return;
      log(`"${cand.entry.title}" did not satisfy this contract (${failed.slice(0, 120)})`);
    }
  }

  // Mined once per cook, not per attempt: the graph and the node's contract
  // cannot move mid-cook (the commit guard enforces that), so re-querying on
  // every repair round would return the same entries.
  const exemplars =
    deps.library && unspecialized
      ? await selectExemplars({
          library: deps.library,
          backendId: backend.id,
          node: store.node(nodeIdValue),
          graph: store.doc,
        })
      : [];
  if (exemplars.length > 0) {
    log(`${exemplars.length} library exemplar(s): ${exemplars.map((e) => e.title).join(", ")}`);
  }

  const makeCtx = (): GenerateCtx<unknown> => {
    const node = store.node(nodeIdValue);
    const views = store.contractViews(nodeIdValue);
    return {
      exemplars,
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
  /** Appearance buys ONE rewrite, never more: a model judging a picture is not
   *  an oracle, and the code in hand already passes every gate. */
  let inspectRetries = 0;

  /** Blocking verdict, or null for anything else — including every failure
   *  mode of looking itself, since a render or vision hiccup must not cost a
   *  part that already verified. */
  const inspectArtifact = async () => {
    try {
      const image = await backend.renderArtifact!(store.node(nodeIdValue), workspace);
      if (!image) return null;
      const node = store.node(nodeIdValue);
      const verdict = await inspectNode({
        provider,
        node: { title: node.title, spec: node.spec, kind: node.kind },
        contractSummary: node.contract.summary,
        image,
        signal: deps.signal,
      });
      return !verdict.looksRight && verdict.severity === "blocking" ? verdict : null;
    } catch {
      return null;
    }
  };

  const maxAttempts = backend.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deps.signal?.aborted) throw new Error("cancelled");

    // -- generate (or repair) --
    store.setStatus(nodeIdValue, attempt === 1 ? "generating" : "repairing");
    if (attempt > 1) store.setStatus(nodeIdValue, "generating");
    // Show the model what it actually built. Only worth doing on a repair,
    // and only when the artifact got far enough to have a shape — a part that
    // failed to execute has nothing to look at. Best-effort throughout:
    // a render failure must never cost the repair round itself.
    let render: LlmImage | undefined;
    if (attempt > 1 && backend.renderArtifact) {
      try {
        render = (await backend.renderArtifact(store.node(nodeIdValue), workspace)) ?? undefined;
        if (render) log("attached a render of the failed part to the repair");
      } catch {
        /* advisory */
      }
    }

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
            render,
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

    // -- inspect: does it LOOK like the part that was asked for? --
    // Gates prove measurements; only a picture catches "measurably correct and
    // completely the wrong object". Worth at most one rewrite, and never on the
    // last attempt — committing something that passes beats committing nothing.
    if (
      deps.inspect &&
      backend.renderArtifact &&
      inspectRetries < 1 &&
      attempt < maxAttempts
    ) {
      const verdict = await inspectArtifact();
      if (verdict) {
        inspectRetries += 1;
        failures.push({ stage: "LOOKS", report: `${verdict.issue}\nsuggested fix: ${verdict.fix}` });
        log(`looks wrong: ${verdict.issue}`);
        continue; // spend one round on it; the gates still guard the result
      }
    }

    // -- commit (guarded: superseded cooks are discarded) --
    await storeInterface();
    commit(attempt === 1 ? "generate" : `repair-${attempt}`);
    storeMeasurements(verify.measurements);
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
          // Stored so this entry can later serve as a worked example — the
          // hash is one-way, so code without its contract teaches only style.
          contract: n.contract,
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
