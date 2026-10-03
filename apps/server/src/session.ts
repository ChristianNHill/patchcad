import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import { Contract, GraphDoc, hashValue, isCooking, type LedgerBucket, type NodeCost } from "@patchcad/shared";
import {
  applyCheck,
  checkStatus,
  EventBus,
  GraphStore,
  type CookDeps,
  type DomainBackend,
  type LlmProvider,
  type LlmUsage,
  type NodeLibrary,
  type Workspace,
} from "@patchcad/engine";
import { writeNodeModule } from "@patchcad/backend-code";
import type { CadBackend } from "@patchcad/backend-cad";
import { loadProject, type LoadedProject } from "./project.js";
import { NO_PROVIDER_HELP } from "./providers.js";
import type { MeshGenProvider } from "./meshgen/index.js";
import { addCost, addUsage, Budget, budgeted } from "./spend.js";
import { refLoader } from "./refs.js";

export interface UndoCheckpoint {
  label: string;
  at: number;
  doc: GraphDoc;
}

export interface ActiveProject extends LoadedProject {
  workspace: Workspace;
  watcher: FSWatcher;
  backend: DomainBackend<unknown>;
  /** Pre-mutation snapshots, newest last. Per project; dies with the switch. */
  undo: UndoCheckpoint[];
}

/** A T3 proposal awaiting user approval. */
export interface Proposal {
  contract: Contract;
  spec: string;
  rationale: string;
  constraintsApplied: string[];
  message: string;
  dirtied: string[];
  notes: string[];
}

export interface SessionOptions {
  bus: EventBus;
  /** GraphDoc.backend routes each project to its domain backend. */
  backends: Record<string, DomainBackend<unknown>>;
  /** The ephemeral graph's backend, and the fallback for an unknown id. */
  codeBackend: DomainBackend<unknown>;
  cadBackend: CadBackend;
  library: NodeLibrary;
  resolved: { provider: LlmProvider; source: string } | null;
  maxUsd?: number;
  /** Set when maxUsd is configured but unreadable: nothing spends until it is fixed. */
  budgetError?: string | null;
  meshGen?: MeshGenProvider | null;
  projectsRoot: string;
  examplesRoot: string;
}

const UNDO_CAP = 30;

/**
 * Everything the routes share: the active project, live cooks, budgets and
 * proposals. Helpers take the project they act on explicitly — a request that
 * awaits must keep writing to the project it started on, never whatever
 * `active` has become since.
 */
export class Session {
  readonly bus: EventBus;
  readonly backends: Record<string, DomainBackend<unknown>>;
  readonly codeBackend: DomainBackend<unknown>;
  readonly cadBackend: CadBackend;
  readonly library: NodeLibrary;
  readonly resolved: SessionOptions["resolved"];
  readonly maxUsd?: number;
  readonly budgetError: string | null;
  readonly meshGen: MeshGenProvider | null;
  readonly projectsRoot: string;
  readonly examplesRoot: string;

  active!: ActiveProject;

  /** Dirs with a cook in flight IN THIS PROCESS: their in-flight statuses are
   * real, not restart orphans — activation must not normalize them. */
  readonly liveCooks = new Map<string, number>();
  /** Projects switched away from mid-cook. Reopening one reuses it: a second
   *  GraphStore on the same patchcad.json would fight the live one's writes. */
  private retained = new Map<string, ActiveProject>();
  /**
   * One abort controller per project, where a wave is everything in flight for
   * that project — cancelling stops the lot and nothing else. An aborted signal
   * stays aborted, so the next cook for that project mints a fresh controller.
   */
  readonly cookAborts = new Map<string, AbortController>();
  /** The newest wave's budget per project dir, for its mesh generation. */
  private cookBudgets = new Map<string, Budget>();
  /** Planning has its own: the architect call belongs to no project yet, and
   *  stopping a plan must not stop a cook (or the other way round). */
  planAbort: AbortController | null = null;
  /** T3 proposals awaiting user approval, keyed by nodeId. Ephemeral —
   * cleared whenever the active project changes. */
  readonly pendingProposals = new Map<string, Proposal>();
  /** Spend no project owns: plans that failed, were stopped, discarded or
   *  superseded, and their mesh drafts. Real money all the same. */
  readonly unbilled: NodeCost = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
  /** Runs when a project's last live cook settles while it is active. */
  onCooksSettled: (project: ActiveProject) => void = () => {};

  constructor(opts: SessionOptions) {
    this.bus = opts.bus;
    this.backends = opts.backends;
    this.codeBackend = opts.codeBackend;
    this.cadBackend = opts.cadBackend;
    this.library = opts.library;
    this.resolved = opts.resolved;
    this.maxUsd = opts.maxUsd;
    this.budgetError = opts.budgetError ?? null;
    this.meshGen = opts.meshGen ?? null;
    this.projectsRoot = opts.projectsRoot;
    this.examplesRoot = opts.examplesRoot;

    this.bus.subscribe((event) => {
      // A background project's commit belongs to a store that is no longer active.
      if (event.type === "node:committed" && event.projectId === this.active?.store.doc.id) {
        this.emitNodeUpdated(this.active, event.nodeId);
      }
    });
  }

  /** Why nothing may spend right now, or null. */
  spendBlocked(): string | null {
    if (!this.resolved) return NO_PROVIDER_HELP;
    return this.budgetError;
  }

  trackCook<T>(project: ActiveProject, run: Promise<T>): Promise<T> {
    const { dir } = project;
    this.liveCooks.set(dir, (this.liveCooks.get(dir) ?? 0) + 1);
    return run.finally(() => {
      const n = (this.liveCooks.get(dir) ?? 1) - 1;
      if (n > 0) return void this.liveCooks.set(dir, n);
      this.liveCooks.delete(dir);
      this.cookBudgets.delete(path.resolve(dir));
      this.retained.delete(dir);
      if (this.active === project) this.onCooksSettled(project);
    });
  }

  cookSignal(projectId: string): AbortSignal {
    let ctl = this.cookAborts.get(projectId);
    if (!ctl || ctl.signal.aborted) {
      ctl = new AbortController();
      this.cookAborts.set(projectId, ctl);
    }
    return ctl.signal;
  }

  /** The active project, or one switched away from that is still cooking. */
  projectById(id: string): ActiveProject | undefined {
    if (this.active.store.doc.id === id) return this.active;
    return [...this.retained.values()].find((p) => p.store.doc.id === id);
  }

  /** Should a cook look at what it made? Cheap relative to the cook, and for
   *  cad the only thing that catches "measurably correct, wrong object". One
   *  definition so every entry point agrees. */
  defaultInspect(project: ActiveProject): boolean {
    return project.store.doc.backend === "cad";
  }

  /** The one place cook dependencies are assembled. */
  cookDeps(project: ActiveProject, provider: LlmProvider, opts: { inspect?: boolean } = {}): CookDeps {
    // One budget per wave, shared with the wave's mesh generation (budgetFor).
    const budget = this.maxUsd ? new Budget(this.maxUsd) : undefined;
    if (budget) this.cookBudgets.set(path.resolve(project.dir), budget);
    return {
      store: project.store,
      backend: project.backend,
      provider: budget ? budgeted(provider, budget) : provider,
      workspace: project.workspace,
      library: this.library,
      signal: this.cookSignal(project.store.doc.id),
      inspect: opts.inspect,
      loadRef: refLoader(project.dir),
      // `concurrency` is deliberately unset: nothing measured is slow at the
      // engine's 4. Set it from a wave that is, not from the kernel pool's 8.
    };
  }

  budgetFor(projectDir: string): Budget | undefined {
    return this.cookBudgets.get(path.resolve(projectDir));
  }

  /** Close the active project's watcher, keeping it reachable if it still cooks. */
  private async leave(): Promise<void> {
    const prev = this.active;
    this.pendingProposals.clear();
    if (!prev) return;
    await prev.watcher.close();
    if (this.liveCooks.has(prev.dir)) this.retained.set(prev.dir, prev);
  }

  /** Load a project dir and make it the live one: store, workspace, preview,
   * file watcher. Approving a plan switches projects this way. A dir still
   * cooking from before a switch comes back as the same project. */
  async activate(dir: string): Promise<ActiveProject> {
    await this.leave();
    const kept = this.liveCooks.has(dir) ? this.retained.get(dir) : undefined;
    this.retained.delete(dir);
    if (kept) kept.watcher = this.watch(kept);
    const next = kept ?? (await this.load(dir));
    await next.backend.assemble(next.store.doc, next.workspace);
    const { url } = (await next.backend.previewAdapter?.start(next.workspace)) ?? { url: "" };
    this.active = next;
    this.bus.emit({ type: "graph:replaced", projectId: next.store.doc.id, graph: next.store.doc });
    this.emitUndoStack(next);
    console.log(`[patchcad] project: ${dir}  preview: ${url}`);
    return next;
  }

  private async load(dir: string): Promise<ActiveProject> {
    const project = await loadProject(dir, this.bus);
    // Cooks never survive a process restart: settle any persisted in-flight
    // statuses to a resumable error state — but ONLY when no cook is live for
    // this dir in this process (switching projects must not brand a running
    // cook as interrupted).
    const orphaned = Object.values(project.store.doc.nodes).some((n) => isCooking(n.status));
    if (orphaned && !this.liveCooks.has(dir)) project.store.applyOp((g) => {
      for (const n of Object.values(g.nodes)) {
        if (isCooking(n.status)) {
          n.status = "error_code";
          n.statusDetail = {
            stage: "interrupted",
            message: "cook interrupted by a server restart — re-cook to resume",
            attribution: "unknown",
          };
        }
      }
    });
    const backend = this.backends[project.store.doc.backend] ?? this.codeBackend;
    const workspace: Workspace = { root: path.join(dir, ".preview") };
    const base = { ...project, workspace, backend, undo: [] };
    return { ...base, watcher: this.watch(base) };
  }

  /** Disk-edit hot-swap is a web-code affordance (Vite modules); CAD edits
   *  flow through reprompt/params + kernel re-execution instead. */
  private watch(project: Omit<ActiveProject, "watcher">): FSWatcher {
    const watcher = chokidar.watch(path.join(project.dir, "nodes"), { ignoreInitial: true });
    if (project.backend.id !== this.codeBackend.id) return watcher;
    const onFile = async (file: string) => {
      const match = /nodes[/\\]([\w-]+)[/\\]v(\d+)\.code\.tsx$/.exec(file);
      if (!match) return;
      const [, nid, versionStr] = match;
      const node = project.store.doc.nodes[nid!];
      if (!node || node.version !== Number(versionStr)) return;
      const code = await readFile(file, "utf8");
      if (node.artifact && hashValue(code) === node.artifact.hash) return;
      project.store.applyOp((g) => {
        const n = g.nodes[nid!]!;
        n.artifact = { code, testCode: n.artifact?.testCode ?? "", hash: hashValue(code) };
      });
      await writeNodeModule(project.workspace, nid!, code);
      this.bus.emit({
        type: "job:log",
        projectId: project.store.doc.id,
        nodeId: nid!,
        line: `hot-swapped ${nid} from disk edit`,
      });
    };
    watcher.on("change", (f) => void onFile(f));
    watcher.on("add", (f) => void onFile(f));
    return watcher;
  }

  /** No default project: boot state is an ephemeral empty graph that persists
   * nothing and appears in no listing. Planning or importing replaces it with
   * a real project dir. */
  async close(): Promise<ActiveProject> {
    await this.leave();
    const graph = GraphDoc.parse({
      schemaVersion: 1,
      id: "untitled",
      backend: "web-code",
      brief: { goal: "", constraints: [], clarifications: [] },
      nodes: {},
      edges: [],
      assembly: { entryNodeId: "" },
      rev: 0,
    });
    const store = new GraphStore(graph, this.bus, async () => {});
    const backend = this.codeBackend;
    const workspace: Workspace = { root: path.join(os.tmpdir(), "patchcad-untitled-preview") };
    await backend.assemble(graph, workspace);
    await backend.previewAdapter?.start(workspace);
    const watcher = chokidar.watch([], { ignoreInitial: true });
    this.active = { dir: "", store, workspace, watcher, backend, undo: [] };
    this.bus.emit({ type: "graph:replaced", projectId: graph.id, graph });
    this.emitUndoStack(this.active);
    console.log("[patchcad] no project open — waiting for a plan or import");
    return this.active;
  }

  emitUndoStack(project: ActiveProject) {
    const top = project.undo[project.undo.length - 1];
    this.bus.emit({
      type: "undo:stack",
      projectId: project.store.doc.id,
      depth: project.undo.length,
      label: top?.label ?? "",
    });
  }

  /** Push a pre-mutation snapshot. Same-label checkpoints within 10s coalesce
   * so a slider gesture's debounced persist burst reads as one undo step. */
  checkpoint(project: ActiveProject, label: string) {
    const top = project.undo[project.undo.length - 1];
    if (top && top.label === label && Date.now() - top.at < 10_000) return;
    project.undo.push({ label, at: Date.now(), doc: structuredClone(project.store.doc) });
    if (project.undo.length > UNDO_CAP) project.undo.shift();
    this.emitUndoStack(project);
  }

  /** Retract the newest checkpoint when its mutation turned out to be a no-op. */
  dropCheckpoint(project: ActiveProject, label: string) {
    const top = project.undo[project.undo.length - 1];
    if (top && top.label === label) {
      project.undo.pop();
      this.emitUndoStack(project);
    }
  }

  /** Push a node's whole record to the studio. Store writes through applyOp
   *  emit nothing, so without this a commit's version/history/measurements and
   *  a T1 binding's rewritten params never left the server. */
  emitNodeUpdated(project: ActiveProject, id: string) {
    const node = project.store.doc.nodes[id];
    if (node) this.bus.emit({ type: "node:updated", projectId: project.store.doc.id, node });
  }

  /** Web-code exposes a live Vite URL; CAD projects render in the studio's
   * viewport pane instead (no iframe). */
  previewUrl(project: ActiveProject): string {
    const adapter = project.backend.previewAdapter as { url?: () => string } | undefined;
    return adapter?.url?.() ?? "";
  }

  /** `extra` carries problems found outside the check itself — a T0 edit that
   *  broke a part's own probes — so one status line reports both. */
  async runGlobalCheck(project: ActiveProject, extra: string[] = []) {
    const { store, backend, workspace } = project;
    const graph = store.doc;
    this.bus.emit({ type: "checker:status", projectId: graph.id, status: "checking", problems: [] });
    const check = await backend.globalCheck(graph, workspace);
    applyCheck(store, check);
    const problems = [...extra, ...check.problems];
    this.bus.emit({
      type: "checker:status",
      projectId: graph.id,
      status: checkStatus(check, extra),
      problems,
      findings: check.findings ?? [],
      advisories: check.advisories ?? [],
    });
    if (problems.length > 0) console.log(`[patchcad] global check failing:\n  ${problems.join("\n  ")}`);
    return check;
  }

  /** Bill project-level spend to the store it was incurred for — captured when
   *  the request started, so a project switch mid-call cannot misfile it. */
  billLedger(store: GraphStore, bucket: LedgerBucket, usage: LlmUsage) {
    store.applyOp((g) => {
      addUsage(g.ledger[bucket], usage);
    });
    this.bus.emit({
      type: "cost:update",
      projectId: store.doc.id,
      bucket,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usd: usage.usd,
    });
  }

  /** Spend that will never reach a project's ledger. */
  recordUnbilled(cost: NodeCost, why: string) {
    if (cost.calls === 0 && cost.usd === 0) return;
    addCost(this.unbilled, cost);
    console.log(`[patchcad] ${why}: $${cost.usd.toFixed(3)} spent outside any project ($${this.unbilled.usd.toFixed(3)} this session)`);
  }
}
