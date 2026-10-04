import { hashValue, type NodeRecord, type NodeStatus } from "@patchcad/shared";
import type {
  CheckResult,
  DomainBackend,
  GenerateCtx,
  PromptSpec,
  RepairCtx,
  VerifyResult,
  Workspace,
} from "./backend.js";
import { selectExemplars } from "./exemplars.js";
import { findReusable } from "./similarity.js";
import { inspectFeedback, inspectNode } from "./inspect.js";
import { LlmCallError, type LlmImage, type LlmProvider, type LlmUsage } from "./llm.js";
import type { LibraryListing, NodeLibrary } from "./library.js";
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

/** Repair rounds in a row that fail to beat the best score before the next
 *  round starts over from a fresh generate. */
const STALE_REPAIRS = 2;

/** The engine's own looks-wrong stage: a passing part, so always renderable. */
const LOOKS = "LOOKS";

type Failure = { stage: string; report: string };
type Draft = { code: string; testCode: string };
/** One generation round that did not commit. `executed`: it failed in
 *  verify, so the backend's execute gates passed. */
type Attempt = Draft & { attempt: number; failure: Failure; score?: number; executed?: boolean };

/** Unscored attempts rank equal, so ties go to the latest. */
const rank = (a: Attempt) => a.score ?? 0;

export interface CookDeps {
  store: GraphStore;
  backend: DomainBackend<unknown>;
  provider: LlmProvider;
  workspace: Workspace;
  /** Contract-hash reuse: a hit skips the generator entirely (still verified). */
  library?: NodeLibrary;
  signal?: AbortSignal;
  /**
   * Look at each node after it passes its gates, asking its contract's
   * `visualChecks`, and allow ONE rewrite if any answers no. Off by default: it
   * costs a render plus a vision call per node, and the gates already catch
   * everything measurable.
   */
  inspect?: boolean;
  /** Reads an image a user attached to a node's thread (ChatMessage.refs),
   *  so the generator sees it. Absent = such images are not sent. */
  loadRef?: (name: string) => Promise<LlmImage | null>;
}

export interface CookSummary {
  succeeded: string[];
  failed: { nodeId: string; stage: string; message: string }[];
}

/** A cook whose node a newer cook has claimed. It stops without touching the
 *  node: the newer cook owns its status and its commit. */
class Superseded extends Error {
  constructor(nodeId: string) {
    super(`${nodeId}: superseded by a newer cook`);
  }
}

/** The backend's deterministic artifact, with a throw RETURNED: the scheduler
 *  sorts on it, and cookOne fails the node with it. */
function deterministicArtifact(
  backend: DomainBackend<unknown>,
  node: NodeRecord,
): { code: string; testCode?: string } | null | Error {
  try {
    return backend.deterministicArtifact?.(node) ?? null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** One library listing per cook: reuse and exemplars both read it, and a
 *  listing reads every stored entry. */
function listOnce(library: NodeLibrary): NodeLibrary {
  const list = library.list?.bind(library);
  if (!list) return library;
  let all: Promise<LibraryListing[]> | undefined;
  return {
    lookup: (b, h) => library.lookup(b, h),
    capture: (b, h, e) => library.capture(b, h, e),
    list: async (b, opts) => (await (all ??= list(b))).filter((e) => !opts?.kind || e.kind === opts.kind),
  };
}

/** The checker status a check result shows, shared with every other caller of
 *  `globalCheck` so the problem bar means one thing. `extra` is problems found
 *  outside the check. Advisories never make it failing; a check that did not
 *  fully run never reads clean. */
export function checkStatus(check: CheckResult, extra: string[] = []): "clean" | "failing" {
  return check.ok && !check.incomplete && extra.length === 0 ? "clean" : "failing";
}

const IN_FLIGHT = new Set<NodeStatus>(["queued", "generating", "building", "verifying", "repairing"]);

export async function cookNodes(deps: CookDeps, nodeIds: string[]): Promise<CookSummary> {
  const summary: CookSummary = { succeeded: [], failed: [] };
  // Deterministic nodes first: a registry screw commits in a fraction of a
  // second and should not wait behind an LLM node for a worker.
  const noModel: string[] = [];
  const needsModel: string[] = [];
  for (const id of nodeIds) {
    const d = deterministicArtifact(deps.backend, deps.store.node(id));
    (d && !(d instanceof Error) ? noModel : needsModel).push(id);
  }
  const queue = [...noModel, ...needsModel];
  const workers = Math.max(1, Math.min(deps.backend.generation?.concurrency ?? 4, queue.length));

  // Claimed at queue time, so a cook already running on one of these stops
  // writing before this wave's `queued` can confuse its transitions.
  const tokens = new Map(queue.map((id) => [id, deps.store.beginCook(id)]));
  for (const id of queue) deps.store.setStatus(id, "queued");

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (queue.length > 0) {
        if (deps.signal?.aborted) return;
        const id = queue.shift()!;
        try {
          await cookOne(deps, id, tokens.get(id));
          summary.succeeded.push(id);
        } catch (err) {
          summary.failed.push({
            nodeId: id,
            stage: err instanceof Superseded ? "superseded" : "cook",
            message: (err as Error).message,
          });
        }
      }
    }),
  );

  if (deps.signal?.aborted) {
    // Never started: release them rather than leave them queued forever.
    for (const id of queue) {
      if (deps.store.cookToken(id) === tokens.get(id) && deps.store.node(id).status === "queued") {
        deps.store.setStatus(id, "cancelled");
      }
    }
    return summary;
  }

  // Barrier: assembly + global check once the wave settles.
  let check = await assembleAndCheck(deps);

  // A finding the backend pins on one part's code buys that part a repair
  // round, then the check runs again. Bounded by the node's own attempt
  // budget across waves; past it the block stands as applyCheck set it.
  const budget = deps.backend.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const spent = new Map<string, number>();
  for (;;) {
    const reports = new Map<string, string[]>();
    for (const f of check.findings ?? []) {
      const target = f.repair && deps.store.doc.nodes[f.repair.nodeId];
      if (!target || deps.backend.deterministicOnly?.(target) || (spent.get(target.id) ?? 0) >= budget) continue;
      reports.set(target.id, [...(reports.get(target.id) ?? []), f.repair!.report]);
    }
    if (reports.size === 0 || deps.signal?.aborted) break;
    await Promise.all(
      [...reports].map(async ([id, rs]) => {
        spent.set(id, (spent.get(id) ?? 0) + 1);
        await cookOne(deps, id, undefined, { stage: ASSEMBLY_STAGE, report: rs.join("\n") }).catch(() => {});
      }),
    );
    check = await assembleAndCheck(deps);
  }

  return summary;
}

async function assembleAndCheck(deps: CookDeps): Promise<CheckResult> {
  const graph = deps.store.doc;
  await deps.backend.assemble(graph, deps.workspace);
  deps.store.emit({ type: "checker:status", projectId: graph.id, status: "checking", problems: [] });
  const check = await deps.backend.globalCheck(graph, deps.workspace);
  applyCheck(deps.store, check);
  deps.store.emit({
    type: "checker:status",
    projectId: graph.id,
    status: checkStatus(check),
    problems: check.problems,
    findings: check.findings ?? [],
    advisories: check.advisories ?? [],
  });
  return check;
}

/** statusDetail.stage of a node blocked by the assembly check, not its own gates. */
export const ASSEMBLY_STAGE = "assembly";

/**
 * An assembly failure BLOCKS the parts it is attributed to. Before this a
 * clash was a line in the problem bar while both parts sat green, so nothing
 * said which part to open, and an export shipped the overlap. Each attributed
 * ready node goes to error_contract — the fault is a pose or a mate, which is
 * the contract's business, not the code's — and one the check no longer blames
 * goes back to ready. Nothing is re-cooked: the user decides whether that is a
 * T0 nudge, a reprompt or a contract edit, so no model is spent unasked.
 * Only nodes this function blocked are released; a node its own cook failed
 * keeps its status. An `incomplete` check releases nothing: a pair it did not
 * compare is not a pair it cleared.
 */
export function applyCheck(store: GraphStore, check: CheckResult): void {
  const blamed = new Map<string, string[]>();
  for (const f of check.findings ?? []) {
    for (const id of new Set(f.blame ?? [f.nodeA, f.nodeB])) blamed.set(id, [...(blamed.get(id) ?? []), f.message]);
  }
  for (const n of Object.values(store.doc.nodes)) {
    const message = blamed.get(n.id)?.join("\n");
    const blockedHere = n.status === "error_contract" && n.statusDetail?.stage === ASSEMBLY_STAGE;
    if (message && (n.status === "ready" || (blockedHere && n.statusDetail?.message !== message))) {
      store.setStatus(n.id, "error_contract", { stage: ASSEMBLY_STAGE, message, attribution: "contract-infeasible" });
    } else if (!message && blockedHere && !check.incomplete) {
      store.setStatus(n.id, "ready");
    }
  }
}

/**
 * Cook one node. `token` is the claim cookNodes took when it queued the node;
 * a direct caller (reprompt) omits it and the cook claims the node itself.
 * Whatever throws, the node never stays in flight: a cook that still owns it
 * settles it in error_code (cancelled on abort), and one a newer cook has
 * superseded leaves it alone.
 */
export async function cookOne(deps: CookDeps, nodeIdValue: string, token?: number, seed?: Failure): Promise<void> {
  const owner = token ?? deps.store.beginCook(nodeIdValue);
  try {
    await cookBody(deps, nodeIdValue, owner, seed);
  } catch (err) {
    const { store } = deps;
    const n = store.doc.nodes[nodeIdValue];
    if (!(err instanceof Superseded) && n && store.cookToken(nodeIdValue) === owner && IN_FLIGHT.has(n.status)) {
      try {
        if (deps.signal?.aborted) store.setStatus(nodeIdValue, "cancelled");
        else store.setStatus(nodeIdValue, "error_code", {
          stage: "cook",
          message: (err as Error).message.slice(0, 2000),
          attribution: "unknown",
        });
      } catch {
        /* the original error is the one worth reporting */
      }
    }
    throw err;
  }
}

/** `seed`: a failure found outside the node's own gates (an assembly clash
 *  pinned on its code). The cook is then ONE repair round of the committed
 *  code against that failure, and a miss puts the node back where the check
 *  had it rather than failing a part that passes its own gates. */
async function cookBody(deps: CookDeps, nodeIdValue: string, token: number, seed?: Failure): Promise<void> {
  const { store, backend, provider, workspace } = deps;
  const graph = store.doc;
  const projectId = graph.id;
  const log = (line: string) =>
    store.emit({ type: "job:log", projectId, nodeId: nodeIdValue, line });

  /** Throws unless this cook still owns the node. Every write to the node's
   *  status or artifact checks first, so a superseded cook cannot clobber the
   *  cook that replaced it. Billing is not guarded: that spend happened. */
  const own = () => {
    if (store.cookToken(nodeIdValue) !== token) throw new Superseded(nodeIdValue);
  };
  const setStatus = (status: NodeStatus, detail?: NodeRecord["statusDetail"]) => {
    own();
    store.setStatus(nodeIdValue, status, detail);
  };
  const checkAbort = () => {
    if (deps.signal?.aborted) throw new Error("cancelled");
  };

  // cookOne must be self-sufficient on status: direct callers (reprompt) may
  // hand it a node in any settled state, and only `queued` legally reaches
  // `generating`/`building`.
  if (store.node(nodeIdValue).status !== "queued") setStatus("queued");

  const baseVersion = store.node(nodeIdValue).version;
  const baseContractHash = store.node(nodeIdValue).contract.hash;

  /** Real interface (.d.ts) of the verified artifact — neighbors typecheck
   * against it from now on. Best-effort: extraction failures never block. */
  const storeInterface = async () => {
    if (!backend.extractInterface) return;
    try {
      const dts = await backend.extractInterface(store.node(nodeIdValue), workspace);
      if (dts && store.cookToken(nodeIdValue) === token) {
        store.applyOp((g) => {
          const n = g.nodes[nodeIdValue]!;
          if (n.artifact) n.artifact = { ...n.artifact, dts };
        });
      }
    } catch {
      /* advisory */
    }
  };

  /** Bump the version and record why. `measurements` is what a passing verify
   *  measured: advisory display data that never feeds cooking, so it lives on
   *  the node, well clear of the contract hash. It is stamped with the new
   *  version and the params in force, so a later slider drag (which
   *  re-executes but does not re-probe) cannot pass stale numbers off as
   *  current. Written in the same op as the version, BEFORE `node:committed`:
   *  the server reads the record on that event. */
  const commit = (cause: string, measurements: unknown) => {
    own();
    checkAbort();
    const node = store.node(nodeIdValue);
    if (node.contract.hash !== baseContractHash || node.version !== baseVersion) {
      throw new Error("superseded: contract or version changed mid-cook");
    }
    if (node.status !== "verifying") throw new Error(`commit refused: node is ${node.status}, not verifying`);
    store.applyOp(
      (g) => {
        const n = g.nodes[nodeIdValue]!;
        n.version += 1;
        n.history.push({
          version: n.version,
          contractHash: n.contract.hash,
          artifactHash: n.artifact!.hash,
          cause,
          at: Date.now(),
        });
        if (measurements !== undefined && measurements !== null) {
          n.measurements = { version: n.version, paramsHash: hashValue(n.params), data: measurements };
        }
        delete n.candidate;
        delete n.lastFailed;
      },
      { immediate: true },
    );
    setStatus("ready");
    store.emit({
      type: "node:committed",
      projectId,
      nodeId: nodeIdValue,
      version: store.node(nodeIdValue).version,
    });
  };

  /** `calls` is 0 for spend that was not a model call (prepareArtifact). */
  const bill = (usage: LlmUsage, calls = 1) => {
    store.applyOp((g) => {
      const n = g.nodes[nodeIdValue]!;
      n.cost.calls += calls;
      n.cost.inputTokens += usage.inputTokens;
      n.cost.outputTokens += usage.outputTokens;
      n.cost.usd += usage.usd;
    });
    store.emit({
      type: "cost:update",
      projectId,
      nodeId: nodeIdValue,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usd: usage.usd,
    });
  };

  /** The failed visual checks, or null for anything else — including every
   *  failure mode of looking itself, since a render or vision hiccup must not
   *  cost a part that already verified. A contract with no `visualChecks` is
   *  not looked at: with no question there is nothing to judge against but
   *  the judge's taste, and no render is spent finding that out. */
  const inspectArtifact = async (node: NodeRecord) => {
    try {
      const checks = (node.contract.payload as { visualChecks?: unknown } | undefined)?.visualChecks;
      const questions = Array.isArray(checks) ? checks.filter((q): q is string => typeof q === "string" && q.trim() !== "") : [];
      if (questions.length === 0) return null;
      const image = await backend.renderArtifact!(node, workspace);
      if (!image) return null;
      const result = await inspectNode({
        provider,
        node: { title: node.title, spec: node.spec, kind: node.kind },
        questions,
        image,
        system: backend.inspectSystem,
        signal: deps.signal,
      });
      bill(result.usage);
      return result.failed.length > 0 ? result.failed : null;
    } catch (err) {
      if (err instanceof LlmCallError && err.usage) bill(err.usage);
      return null;
    }
  };

  /** Shared no-LLM commit path: registry and library artifacts still run the
   * full execute+verify gauntlet before committing. Returns the failure
   * report on a gate miss, null on success. `look` adds the visual checks
   * before the commit, for code written for some OTHER part. */
  const tryPrebuilt = async (
    code: string,
    testCode: string,
    cause: string,
    dts?: string,
    look = false,
  ): Promise<string | null> => {
    checkAbort();
    // After an earlier prebuilt missed (repairing), building is reached via
    // queued: repairing → building is not a legal transition.
    if (store.node(nodeIdValue).status === "repairing") setStatus("queued");
    setStatus("building");
    const artifact = { code, testCode, dts, hash: hashValue(code) };
    const node = { ...store.node(nodeIdValue), artifact };
    const exec = await backend.execute(node, workspace, graph);
    let failure: { stage: string; report: string } | null = exec.ok ? null : exec;
    if (exec.ok) {
      checkAbort();
      setStatus("verifying");
      const verify = await backend.verify(node, graph, workspace);
      const verdict = verify.ok && look && deps.inspect && backend.renderArtifact ? await inspectArtifact(node) : null;
      if (verify.ok && !verdict) {
        own();
        store.applyOp((g) => {
          g.nodes[nodeIdValue]!.artifact = artifact;
        });
        await storeInterface();
        commit(cause, verify.measurements);
        await backend.previewAdapter?.hotSwap(store.doc, workspace, [nodeIdValue]);
        log(`ready (v${store.node(nodeIdValue).version}, ${cause})`);
        return null;
      }
      failure = verdict ? { stage: LOOKS, report: inspectFeedback(verdict) } : (verify as Failure);
    }
    log(`${cause} artifact failed ${failure!.stage}: ${failure!.report.slice(0, 200)}`);
    // Fall through to generation (repairing → generating is legal).
    setStatus("repairing");
    return `${failure!.stage}: ${failure!.report}`;
  };

  // What the node held before this cook. A fresh start modifies this, never a
  // failed draft. Only a commit ever replaces it: drafts are gated on copies.
  const original = store.node(nodeIdValue).artifact;

  // -- preparation: e.g. a generated mesh the deterministic artifact loads --
  try {
    const preparing = backend.prepareArtifact?.(store.node(nodeIdValue), workspace, graph, deps.signal, log);
    if (preparing) {
      setStatus("generating");
      const cost = await preparing;
      if (cost) bill({ inputTokens: 0, outputTokens: 0, usd: cost.usd }, 0);
      checkAbort();
    }
  } catch (err) {
    if (!(err instanceof Superseded) && !deps.signal?.aborted) {
      setStatus("error_code", { stage: "prepare", message: (err as Error).message.slice(0, 1800), attribution: "unknown" });
    }
    throw err;
  }

  const seeded = seed && original ? { code: original.code, testCode: original.testCode, attempt: 0, failure: seed } : undefined;

  // -- registry fast path: domain-deterministic parts never touch an LLM --
  const prebuilt = seeded ? null : deterministicArtifact(backend, store.node(nodeIdValue));
  if (prebuilt instanceof Error) {
    setStatus("error_code", { stage: "registry", message: prebuilt.message.slice(0, 1800), attribution: "unknown" });
    throw prebuilt;
  }
  if (prebuilt) {
    log("registry part — deterministic code, no LLM call");
    const failed = await tryPrebuilt(prebuilt.code, prebuilt.testCode ?? "", "registry");
    if (!failed) return;
    // Never fall through to an LLM for registry parts — surface instead.
    own();
    store.applyOp((g) => {
      g.nodes[nodeIdValue]!.lastFailed = { code: prebuilt.code, hash: hashValue(prebuilt.code), stage: "registry", report: failed.slice(0, 2000) };
    });
    store.emit({ type: "node:updated", projectId, node: store.node(nodeIdValue) });
    setStatus("error_code", {
      stage: "registry",
      message: `registry artifact failed gates: ${failed.slice(0, 1800)}`,
      attribution: "code-invalid",
    });
    throw new Error(`${nodeIdValue}: registry artifact failed gates`);
  }
  // Fail closed: past this point lie the library and the generator.
  if (backend.deterministicOnly?.(store.node(nodeIdValue))) {
    const why = seeded ? `an assembly repair (${seed!.stage}) was asked of it` : "it resolved no deterministic artifact";
    setStatus("error_code", {
      stage: "registry",
      message: `${store.node(nodeIdValue).kind} parts are built only by the registry, never generated, and ${why}.`,
      attribution: "code-invalid",
    });
    throw new Error(`${nodeIdValue}: registry-only node would reach the model`);
  }

  // -- regate: a dirty wave re-checks what the node already has --
  // The part in hand may still satisfy every gate, and then it commits with
  // no model asked. Only when nobody asked this part to change: its contract
  // is the committed one (a neighbor moved) or plan expansion rewrote it, and
  // no user message is newer than the commit. A person's edit to this
  // contract wants new code.
  const held = store.node(nodeIdValue);
  const lastCommit = held.history.at(-1);
  const lastAsk = held.thread.filter((m) => m.role === "user").at(-1)?.at ?? 0;
  const contractUnasked =
    lastCommit?.contractHash === held.contract.hash || held.expandedContractHash === held.contract.hash;
  if (!seeded && held.artifact && lastCommit?.artifactHash === held.artifact.hash && lastAsk <= lastCommit.at && contractUnasked) {
    log("re-checking the existing part against the current contract — no LLM call");
    const { code, testCode, dts } = held.artifact;
    if ((await tryPrebuilt(code, testCode, "regate", dts)) === null) return;
  }

  const library = deps.library && listOnce(deps.library);
  const reused = (hash: string) => void deps.library?.recordReuse?.(backend.id, hash).catch(() => {});

  // -- library fast path: exact contract-hash hit skips the generator --
  const unspecialized = store.node(nodeIdValue).thread.length === 0;
  if (library && unspecialized && !seeded) {
    const hit = await library.lookup(backend.id, baseContractHash);
    if (hit) {
      log("library hit — reusing verified code, no LLM call");
      if ((await tryPrebuilt(hit.code, hit.testCode, "library", hit.dts)) === null) return reused(baseContractHash);
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
      library,
      backendId: backend.id,
      contract: store.node(nodeIdValue).contract,
      kind: store.node(nodeIdValue).kind,
      title: store.node(nodeIdValue).title,
      spec: store.node(nodeIdValue).spec,
      exclude: tried,
    })) {
      log(`trying a near-match from the library: "${cand.entry.title}" — no LLM call`);
      // Always looked at when looking is on: these gates were passed by code
      // written for a different part, and only a picture says it is this one.
      const failed = await tryPrebuilt(cand.entry.code, cand.entry.testCode, "library-near", cand.entry.dts, true);
      if (failed === null) return reused(cand.entry.contractHash);
      log(`"${cand.entry.title}" did not satisfy this contract (${failed.slice(0, 120)})`);
    }
  }

  // Mined once per cook, not per attempt: the graph and the node's contract
  // cannot move mid-cook (the commit guard enforces that), so re-querying on
  // every repair round would return the same entries.
  const exemplars =
    library && unspecialized
      ? await selectExemplars({
          library,
          backendId: backend.id,
          node: store.node(nodeIdValue),
          graph: store.doc,
        })
      : [];
  if (exemplars.length > 0) {
    log(`${exemplars.length} library exemplar(s): ${exemplars.map((e) => e.title).join(", ")}`);
  }

  const refNames = store.node(nodeIdValue).thread.flatMap((m) => m.refs ?? []);
  const refImages = deps.loadRef
    ? (await Promise.all(refNames.map((r) => deps.loadRef!(r).catch(() => null)))).filter((i): i is LlmImage => i !== null)
    : [];

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
      ...(refImages.length ? { refImages } : {}),
      upstream: views.upstream,
      downstream: views.downstream,
      paramValues: Object.fromEntries(
        Object.values(store.doc.nodes).map((n) => [
          n.id,
          { ...Object.fromEntries(n.contract.params.map((p) => [p.name, p.default])), ...n.params },
        ]),
      ),
    };
  };

  const failures: Failure[] = [];
  /** Appearance buys ONE rewrite, never more: a model judging a picture is not
   *  an oracle, and the code in hand already passes every gate. */
  let inspectRetries = 0;

  const gen = backend.generation;
  const maxAttempts = seeded ? 1 : (backend.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  /** `n` parallel completions of one prompt. Every call that returns is billed;
   *  the round fails only if NONE of them yields code — one rate-limited draft
   *  out of three is not a reason to give up the other two. */
  const draft = async (prompt: PromptSpec, attempt: number, n: number): Promise<Draft[]> => {
    // Repairs keep the first round's tier unless the backend escalates, and an
    // escalation carries its own ceiling: more effort under the same maxTokens
    // returns no text at all.
    const tier = gen?.escalate && attempt >= gen.escalate.fromAttempt ? gen.escalate : gen;
    const settled = await Promise.allSettled(
      Array.from({ length: n }, () =>
        provider.complete({
          role: prompt.role,
          label: `${prompt.role}:${nodeIdValue}`,
          system: prompt.system,
          messages: prompt.messages,
          schema: prompt.schema,
          effort: tier?.effort,
          maxTokens: tier?.maxTokens,
          signal: deps.signal,
        }),
      ),
    );
    const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    for (const r of results) bill(r.usage);
    for (const s of settled) {
      if (s.status === "rejected" && s.reason instanceof LlmCallError && s.reason.usage) bill(s.reason.usage);
    }
    if (results.length === 0) {
      // Provider failures (quota, rate limit, network) must land the node in
      // a resumable error state — never leave it stuck mid-transition.
      checkAbort();
      const err = (settled[0] as PromiseRejectedResult).reason as Error;
      log(`llm call failed: ${err.message.slice(0, 200)}`);
      setStatus("error_code", {
        stage: "llm",
        message: err.message.slice(0, 2000),
        attribution: "unknown",
      });
      throw err;
    }
    const drafts = results
      .map((r) => ({ code: r.data.code, testCode: r.data.testCode ?? "" }))
      .filter((d) => d.code.trim() !== "");

    // No code at all is a provider failure the same prompt would reproduce, so
    // it lands in error_code instead of spending the budget on the gates.
    if (drafts.length === 0) {
      log("provider returned no code — not retrying, the prompt and budget are unchanged");
      setStatus("error_code", {
        stage: "llm",
        message:
          "the model returned an empty completion (no code). This is usually the whole " +
          "output budget going to reasoning tokens — raise maxTokens or lower effort for " +
          "this role, then re-cook.",
        attribution: "unknown",
      });
      throw new Error(`${nodeIdValue}: provider returned an empty completion`);
    }
    return drafts;
  };

  type Gated = { ok: true; verify: VerifyResult } | { ok: false; failure: Failure; score?: number; executed: boolean };

  /** Run drafts through execute + verify side by side. Each sees a shallow
   *  copy of the node carrying its own artifact, so candidates never share
   *  `node.artifact`; a kernel with a fixed pool just queues what it cannot
   *  run at once. Self-sufficient on status: building/verifying → building is
   *  not a legal transition, so a re-run routes via repairing. A backend that
   *  THROWS (kernel unreachable) fails that candidate at stage "execute". */
  const gate = async (ds: Draft[]): Promise<Gated[]> => {
    checkAbort();
    if (store.node(nodeIdValue).status !== "generating") {
      setStatus("repairing");
      setStatus("generating");
    }
    setStatus("building");
    const tag = (i: number) => (ds.length > 1 ? `candidate ${i + 1}: ` : "");
    const settled = await Promise.allSettled(
      ds.map(async (d, i): Promise<Gated> => {
        const node = { ...store.node(nodeIdValue), artifact: { code: d.code, testCode: d.testCode, hash: hashValue(d.code) } };
        const exec = await backend.execute(node, workspace, graph);
        if (!exec.ok) {
          log(`${tag(i)}execute failed: ${exec.report.slice(0, 200)}`);
          return { ok: false, failure: { stage: exec.stage, report: exec.report }, score: exec.score, executed: false };
        }
        const verify = await backend.verify(node, graph, workspace);
        if (!verify.ok) {
          log(`${tag(i)}verify failed: ${verify.report.slice(0, 200)}`);
          return { ok: false, failure: { stage: verify.stage, report: verify.report }, score: verify.score, executed: true };
        }
        return { ok: true, verify };
      }),
    );
    const results = settled.map((r, i): Gated => {
      if (r.status === "fulfilled") return r.value;
      const report = `the backend threw: ${(r.reason as Error)?.message ?? String(r.reason)}`;
      log(`${tag(i)}${report.slice(0, 200)}`);
      return { ok: false, failure: { stage: "execute", report }, executed: false };
    });
    checkAbort();
    setStatus("verifying");
    return results;
  };

  /** Make a draft that passed every gate the node's artifact, right before
   *  its commit. Nothing else writes `artifact`: a failed draft never
   *  replaces the committed part (or, via persist, its version's code file). */
  const install = (d: Draft) => {
    own();
    store.applyOp((g) => {
      g.nodes[nodeIdValue]!.artifact = { code: d.code, testCode: d.testCode, hash: hashValue(d.code) };
    });
  };

  /** Commit the artifact `gate` just verified (guarded: superseded cooks are
   *  discarded). */
  const finish = async (cause: string, d: Draft, verify: VerifyResult, capture: boolean, attempts?: number) => {
    await storeInterface();
    commit(cause, verify.measurements);
    // Freshly verified, unspecialized code joins the library for future briefs.
    if (capture && library && unspecialized) {
      const n = store.node(nodeIdValue);
      void library
        .capture(backend.id, n.contract.hash, {
          code: d.code,
          testCode: d.testCode,
          kind: n.kind,
          title: n.title,
          dts: n.artifact?.dts,
          // Stored so this entry can later serve as a worked example — the
          // hash is one-way, so code without its contract teaches only style.
          contract: n.contract,
          attemptsToPass: attempts,
        })
        .catch(() => {});
    }
    await backend.previewAdapter?.hotSwap(store.doc, workspace, [nodeIdValue]);
    log(`ready (v${store.node(nodeIdValue).version}, ${cause})`);
  };

  /** Show the model what it actually built. Only when the failure says the
   *  part got far enough to have a shape worth looking at — a part that failed
   *  to execute has nothing to show, and a render is a kernel round trip plus
   *  image tokens. Best-effort: a render failure must never cost the round. */
  const renderFailed = async (a: Attempt): Promise<LlmImage | undefined> => {
    if (!backend.renderArtifact || !(a.failure.stage === LOOKS || backend.renderStages?.includes(a.failure.stage))) {
      return undefined;
    }
    try {
      const node = store.node(nodeIdValue);
      const shown = { ...node, artifact: { code: a.code, testCode: a.testCode, hash: hashValue(a.code) } };
      const render = (await backend.renderArtifact(shown, workspace)) ?? undefined;
      if (render) log("attached a render of the failed part to the repair");
      return render;
    } catch {
      return undefined; /* advisory */
    }
  };

  const startingCode = original?.code;
  const candidates = Math.max(1, gen?.firstRoundCandidates ?? 1);
  /** The repair base: best score so far, ties to the latest. */
  let best: Attempt | undefined = seeded;
  /** Gate-passing code a looks-wrong verdict sent back for a rewrite. */
  let bestPassing: (Draft & { verify: VerifyResult }) | undefined;
  /** The latest round, which the failure the node surfaces describes. */
  let lastRound: Attempt | undefined;
  /** Consecutive repair rounds that did not beat `best`. */
  let stale = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deps.signal?.aborted) throw new Error("cancelled");

    // -- generate (or repair) --
    // Two hops, deliberately: building/verifying → generating is NOT a legal
    // transition, so a repair has to route through "repairing" to get back to
    // "generating". Collapsing these throws "illegal status transition".
    setStatus(attempt === 1 ? "generating" : "repairing");
    if (attempt > 1) setStatus("generating");

    // Patching the same code again after it stopped improving keeps refining
    // an approach that is not converging. Start over instead, carrying the
    // ledger so the new attempt knows which approaches are spent.
    const fresh = stale >= STALE_REPAIRS;
    if (fresh) stale = 0;

    let prompt: PromptSpec;
    let repairedFrom: Attempt | undefined;
    if ((attempt === 1 && !seeded) || fresh) {
      const ctx = makeCtx();
      prompt = backend.buildGeneratePrompt({
        ...ctx,
        node: { ...ctx.node, currentCode: startingCode },
        priorFailures: fresh ? [...failures] : undefined,
      });
    } else {
      const base = best!;
      repairedFrom = base;
      prompt = backend.buildRepairPrompt({
        ...makeCtx(),
        failedCode: base.code,
        failure: base.failure,
        basedOnAttempt: base.attempt,
        // Everything but the failure being repaired, so the model can see which
        // approaches are already spent rather than rediscovering them.
        priorFailures: failures.filter((f) => f !== base.failure),
        attempt,
        maxAttempts,
        render: await renderFailed(base),
      } as RepairCtx<unknown>);
    }

    const n = attempt === 1 && !seeded ? candidates : 1;
    log(
      seeded
        ? `repairing the committed part against ${seed!.stage}…`
        : attempt === 1
        ? n > 1 ? `generating ${n} candidates…` : "generating…"
        : fresh
          ? `fresh start, attempt ${attempt} — ${STALE_REPAIRS} repairs did not improve`
          : `repair attempt ${attempt} (from attempt ${best!.attempt})…`,
    );
    const drafts = await draft(prompt, attempt, n);

    // The gates pick among drafts: first pass wins, otherwise the best score
    // (first on a tie) represents the round. One ledger entry per ROUND, so
    // classifyFailure still reads failures against the round budget.
    let round: Attempt | undefined;
    const results = await gate(drafts);
    for (const [i, d] of drafts.entries()) {
      const gated = results[i]!;
      if (gated.ok) {
        // -- inspect: does it LOOK like the part that was asked for? --
        // Gates prove measurements; only a picture catches "measurably correct
        // and completely the wrong object". Worth at most one rewrite, and
        // never on the last attempt — committing something that passes beats
        // committing nothing.
        const verdict =
          deps.inspect && backend.renderArtifact && inspectRetries < 1 && attempt < maxAttempts
            ? await inspectArtifact({ ...store.node(nodeIdValue), artifact: { code: d.code, testCode: d.testCode, hash: hashValue(d.code) } })
            : null;
        if (!verdict) {
          install(d);
          // Which failure a repair cleared, for the pitfall miner. No code.
          if (repairedFrom && repairedFrom.failure.stage !== LOOKS) {
            const { stage, report } = repairedFrom.failure;
            void deps.library?.recordFix?.(backend.id, { stage, report }).catch(() => {});
          }
          await finish(seeded ? `repair-${seed!.stage}` : attempt === 1 ? "generate" : `repair-${attempt}`, d, gated.verify, !seeded, attempt);
          return;
        }
        log(`looks wrong: ${verdict.map((a) => a.question).join(" / ")}`);
        // The first looks-wrong pass is the rewrite base: passing code outranks
        // every gate failure. Later passing candidates are still looked at
        // before a round is spent on it.
        if (bestPassing) continue;
        bestPassing = { ...d, verify: gated.verify };
        round = {
          ...d,
          attempt,
          failure: { stage: LOOKS, report: inspectFeedback(verdict) },
          score: Number.POSITIVE_INFINITY,
        };
        continue;
      }
      const a: Attempt = { ...d, attempt, failure: gated.failure, score: gated.score, executed: gated.executed };
      if (!round || rank(a) > rank(round)) round = a;
    }
    if (round?.failure.stage === LOOKS) inspectRetries += 1;

    failures.push(round!.failure);
    lastRound = round;
    // Staleness is only measurable when the backend scores; without scores
    // every round ties and the loop chains repairs exactly as it always did.
    if (attempt > 1 && !fresh && round!.score !== undefined && best?.score !== undefined) {
      stale = rank(round!) > rank(best) ? 0 : stale + 1;
    }
    if (!best || rank(round!) >= rank(best)) best = round;
    if (backend.terminalStages?.includes(round!.failure.stage)) {
      log(`stopping: no code change can pass ${round!.failure.stage}`);
      break;
    }
  }

  // A looks-wrong verdict sent passing code back, and nothing since passed.
  // Appearance never fails a node: re-run the gates on that code (so the
  // backend's materialized artifact is that code, not the last failure) and
  // ship it. Not captured — a model said it looks wrong.
  if (bestPassing) {
    const [gated] = await gate([bestPassing]);
    if (gated?.ok) {
      install(bestPassing);
      await finish("generate-inspect-fallback", bestPassing, gated.verify, false);
      return;
    }
  }

  // A seeded round that missed its own gates: the committed part still
  // passes them, so it goes back to the block the check put it under.
  if (seeded) {
    setStatus("error_contract", { stage: seed!.stage, message: seed!.report.slice(0, 2000), attribution: "contract-infeasible" });
    return;
  }

  // Budget exhausted — attribute and surface.
  const attribution = backend.classifyFailure({
    node: store.node(nodeIdValue),
    failures,
    attempts: failures.length,
  });
  // The failing code is kept BESIDE the node, never as its artifact: the last
  // round's for the failure panel, and the best try that at least executed,
  // which a person may export flagged. Whatever the attribution: a threaded
  // stud whose only failure was a gate running out of time is code-invalid,
  // and it was the one part worth keeping.
  const last = failures.at(-1)!;
  own();
  store.applyOp((g) => {
    const n = g.nodes[nodeIdValue]!;
    n.lastFailed = { code: lastRound!.code, hash: hashValue(lastRound!.code), stage: last.stage, report: last.report.slice(0, 2000) };
    if (best?.executed) {
      n.candidate = { code: best.code, hash: hashValue(best.code), stage: best.failure.stage, report: best.failure.report.slice(0, 2000) };
    } else delete n.candidate;
  });
  store.emit({ type: "node:updated", projectId, node: store.node(nodeIdValue) });
  const detail = {
    stage: last.stage,
    message: last.report.slice(0, 2000),
    attribution,
  };
  setStatus(attribution === "contract-infeasible" ? "error_contract" : "error_code", detail);
  throw new Error(`${nodeIdValue}: ${attribution} after ${failures.length} attempts (${last.stage})`);
}
