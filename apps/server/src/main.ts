import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import chokidar, { type FSWatcher } from "chokidar";
import { z } from "zod";
import os from "node:os";
import { Contract, GraphDoc, hashValue, isCooking, ParamValue, type LedgerBucket, type NodeCost } from "@patchcad/shared";
import {
  applyCheck,
  classifyReprompt,
  computeDirtySet,
  contractHash,
  cookNodes,
  GraphStore,
  cookOne,
  diffContract,
  EventBus,
  planGraph,
  reexpandGraph,
  renegotiateContract,
  type CookDeps,
  type DomainBackend,
  type LlmProvider,
  type LlmUsage,
  type Workspace,
} from "@patchcad/engine";
import { CodeBackend, writeNodeModule } from "@patchcad/backend-code";
import { boundDependents, CadBackend, CadJoint, importJoints, isMeshNode, jointErrors, jointVar, oversizeMeshSplit, planPreview, resolveParamBindings, resolvePose, staleJoints, useLearnedPitfalls, type CadContractPayload, type ImportResult } from "@patchcad/backend-cad";
import { codeExt, codeFile, loadProject, type LoadedProject } from "./project.js";
import { registerBomRoutes } from "./bom-routes.js";
import { FileLibrary } from "./library.js";
import { NO_PROVIDER_HELP, readMaxUsd, readMeshGen, resolveProvider } from "./providers.js";
import { createMeshGen, meshPrompt, meshSourceFor } from "./meshgen/index.js";
import { addCost, addUsage, budgeted, metered } from "./spend.js";
import { LatestWinsQueue } from "./t0-queue.js";
import { prepReferences, refLoader, saveThreadRef, UploadedImage, writeRefs, type PendingRef } from "./refs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const API_PORT = Number(process.env.PATCHCAD_PORT ?? 4100);
/** Fastify binds every address `localhost` resolves to — both 127.0.0.1 and
 * ::1. Binding v4-only strands Windows, where localhost usually resolves to
 * ::1 first: the server looks healthy in the log and every browser fetch dies
 * as a bare "Failed to fetch". */
const API_HOST = process.env.PATCHCAD_HOST ?? "localhost";
const PREVIEW_PORT = Number(process.env.PATCHCAD_PREVIEW_PORT ?? 5174);
/** Only an explicit env override boots into a project; the default is none —
 * the studio shows the welcome screen until a plan or import creates one. */
const initialProjectDir = process.env.PATCHCAD_PROJECT
  ? path.resolve(process.env.PATCHCAD_PROJECT)
  : null;
const projectsRoot = path.join(repoRoot, "projects");

interface UndoCheckpoint {
  label: string;
  at: number;
  doc: GraphDoc;
}

interface ActiveProject extends LoadedProject {
  workspace: Workspace;
  watcher: FSWatcher;
  backend: DomainBackend<unknown>;
  /** Pre-mutation snapshots, newest last. Per project; dies with the switch. */
  undo: UndoCheckpoint[];
}

const UNDO_CAP = 30;

async function main() {
  const bus = new EventBus();
  const codeBackend = new CodeBackend({ port: PREVIEW_PORT, fsAllow: [repoRoot] });
  // Image-to-3D for mesh-source parts. Read before the backend exists: it
  // decides what the architect is told about mesh generation.
  const meshGenConfig = await readMeshGen();
  const meshGen = meshGenConfig ? createMeshGen(meshGenConfig) : null;
  console.log(`[patchcad] mesh generation: ${meshGen ? meshGen.id : "not configured (mesh parts plan parametric)"}`);
  const cadBackend = new CadBackend({ meshSource: meshGen ? meshSourceFor(meshGen) : undefined });
  // GraphDoc.backend routes each project to its domain backend.
  const backends: Record<string, DomainBackend<unknown>> = {
    [codeBackend.id]: codeBackend,
    [cadBackend.id]: cadBackend as DomainBackend<unknown>,
  };
  const library = new FileLibrary();
  // Fixes this install's repairs keep needing, merged behind the seeded table.
  useLearnedPitfalls(library.pitfallsFile(cadBackend.id));

  let active!: ActiveProject;

  /** Dirs with a cook in flight IN THIS PROCESS: their in-flight statuses are
   * real, not restart orphans — activation must not normalize them. */
  const liveCooks = new Map<string, number>();
  function trackCook<T>(dir: string, run: Promise<T>): Promise<T> {
    liveCooks.set(dir, (liveCooks.get(dir) ?? 0) + 1);
    return run.finally(() => {
      const n = (liveCooks.get(dir) ?? 1) - 1;
      if (n > 0) return void liveCooks.set(dir, n);
      liveCooks.delete(dir);
      // A wave that fitted an oversized generated mesh leaves it to split.
      if (active?.dir === dir) void splitOversizeMeshes();
    });
  }

  /**
   * One abort controller per project, where a wave is everything in flight for
   * that project — cancelling stops the lot and nothing else. A cook on a
   * project switched away from keeps running, so a single global controller
   * meant "stop" on one project killed another's cook too. An aborted signal
   * stays aborted, so the next cook for that project mints a fresh controller.
   */
  const cookAborts = new Map<string, AbortController>();
  const cookSignal = (projectId: string): AbortSignal => {
    let ctl = cookAborts.get(projectId);
    if (!ctl || ctl.signal.aborted) {
      ctl = new AbortController();
      cookAborts.set(projectId, ctl);
    }
    return ctl.signal;
  };

  /** Planning has its own: the architect call belongs to no project yet, and
   *  stopping a plan must not stop a cook (or the other way round). */
  let planAbort: AbortController | null = null;

  /** Should a cook look at what it made? Cheap relative to the cook (a cached
   *  render is ~2ms, a cold one ~440ms, and the verdict never fails a node), and
   *  for cad it is the only thing that catches "measurably correct, wrong
   *  object" while port types outnumber probes. One definition so every entry
   *  point agrees. */
  const defaultInspect = () => active.store.doc.backend === "cad";

  /** The one place cook dependencies are assembled. Six call sites used to
   *  spell this out identically, which is how `signal` came to be supported by
   *  the engine and passed by nobody. */
  function cookDeps(provider: LlmProvider, opts: { inspect?: boolean } = {}): CookDeps {
    return {
      store: active.store,
      backend: active.backend,
      // One budget per wave: every cookDeps call is one cook.
      provider: maxUsd ? budgeted(provider, maxUsd) : provider,
      workspace: active.workspace,
      library,
      signal: cookSignal(active.store.doc.id),
      inspect: opts.inspect,
      loadRef: refLoader(active.dir),
      // DELIBERATELY NOT SET, and the reasoning belongs here because the
      // temptation to set it recurs. CookDeps has carried `concurrency` from the
      // start with nobody passing it, which looks exactly like the dead-option
      // pattern this function's docstring warns about — so I passed 8, matching
      // the kernel pool.
      //
      // That was a speculative change dressed as a fix. The largest wave in the
      // eval ladder is four nodes, so 8 never engages on anything measured, and
      // the passing plate cooked in 26.4s with no sign that 4 was the limit. Its
      // first real exercise would be a large plan, which costs a dollar to
      // discover and would spend it proving a number nobody chose on evidence.
      //
      // It is also not free to get wrong: architect, generator and repair all
      // route to the direct `claude` provider on the user's own key, so eight
      // concurrent large-output calls is a tokens-per-minute question. A 429
      // attributes only half honestly — the ledger stays right now that a
      // thrown call carries its usage, but a provider throw lands each node in
      // error_code, so a scheduling problem would read as N node failures.
      //
      // Set it from a wave that is measurably slow at 4, not from the kernel
      // pool: they are unrelated resources that happen to share a number.
    };
  }

  /** T3 proposals awaiting user approval, keyed by nodeId. Ephemeral —
   * cleared whenever the active project changes. */
  const pendingProposals = new Map<
    string,
    {
      contract: Contract;
      spec: string;
      rationale: string;
      constraintsApplied: string[];
      message: string;
      dirtied: string[];
      notes: string[];
    }
  >();

  /** Load a project dir and make it the live one: store, workspace, preview,
   * file watcher, global check. Approving a plan switches projects this way. */
  async function activateProject(dir: string): Promise<ActiveProject> {
    if (active?.watcher) await active.watcher.close();
    pendingProposals.clear();

    const project = await loadProject(dir, bus);
    // Cooks never survive a process restart: settle any persisted in-flight
    // statuses to a resumable error state — but ONLY when no cook is live for
    // this dir in this process (switching projects must not brand a running
    // cook as interrupted).
    if (!liveCooks.has(dir)) project.store.applyOp((g) => {
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
    const backend = backends[project.store.doc.backend] ?? codeBackend;
    const workspace: Workspace = { root: path.join(dir, ".preview") };
    await backend.assemble(project.store.doc, workspace);
    const { url } = (await backend.previewAdapter?.start(workspace)) ?? { url: "" };

    const watcher = chokidar.watch(path.join(dir, "nodes"), { ignoreInitial: true });
    // Disk-edit hot-swap is a web-code affordance (Vite modules); CAD edits
    // flow through reprompt/params + kernel re-execution instead.
    if (backend.id === codeBackend.id) {
      const onFile = (file: string) => void onNodeFileChange(file);
      watcher.on("change", onFile);
      watcher.on("add", onFile);
    }

    async function onNodeFileChange(file: string) {
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
      await writeNodeModule(workspace, nid!, code);
      bus.emit({
        type: "job:log",
        projectId: project.store.doc.id,
        nodeId: nid!,
        line: `hot-swapped ${nid} from disk edit`,
      });
    }

    const next: ActiveProject = { ...project, workspace, watcher, backend, undo: [] };
    bus.emit({ type: "graph:replaced", projectId: project.store.doc.id, graph: project.store.doc });
    bus.emit({ type: "undo:stack", projectId: project.store.doc.id, depth: 0, label: "" });
    console.log(`[patchcad] project: ${dir}  preview: ${url}`);
    return next;
  }

  /** No default project: boot state is an ephemeral empty graph that persists
   * nothing and appears in no listing. Planning or importing replaces it with
   * a real project dir. */
  async function activateEphemeral(): Promise<ActiveProject> {
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
    const store = new GraphStore(graph, bus, async () => {});
    const backend = codeBackend;
    const workspace: Workspace = { root: path.join(os.tmpdir(), "patchcad-untitled-preview") };
    await backend.assemble(graph, workspace);
    await backend.previewAdapter?.start(workspace);
    const watcher = chokidar.watch([], { ignoreInitial: true });
    bus.emit({ type: "graph:replaced", projectId: graph.id, graph });
    bus.emit({ type: "undo:stack", projectId: graph.id, depth: 0, label: "" });
    console.log("[patchcad] no project open — waiting for a plan or import");
    return { dir: "", store, workspace, watcher, backend, undo: [] };
  }

  function emitUndoStack() {
    const top = active.undo[active.undo.length - 1];
    bus.emit({
      type: "undo:stack",
      projectId: active.store.doc.id,
      depth: active.undo.length,
      label: top?.label ?? "",
    });
  }

  /** Push a pre-mutation snapshot. Same-label checkpoints within 10s coalesce
   * so a slider gesture's debounced persist burst reads as one undo step. */
  function checkpoint(label: string) {
    const top = active.undo[active.undo.length - 1];
    if (top && top.label === label && Date.now() - top.at < 10_000) return;
    active.undo.push({ label, at: Date.now(), doc: structuredClone(active.store.doc) });
    if (active.undo.length > UNDO_CAP) active.undo.shift();
    emitUndoStack();
  }

  /** Retract the newest checkpoint when its mutation turned out to be a no-op. */
  function dropCheckpoint(label: string) {
    const top = active.undo[active.undo.length - 1];
    if (top && top.label === label) {
      active.undo.pop();
      emitUndoStack();
    }
  }

  active = initialProjectDir ? await activateProject(initialProjectDir) : await activateEphemeral();

  /** Push a node's whole record to the studio. Store writes through applyOp
   *  emit nothing, so without this a commit's version/history/measurements and
   *  a T1 binding's rewritten params never left the server. */
  function emitNodeUpdated(id: string) {
    const node = active.store.doc.nodes[id];
    if (node) bus.emit({ type: "node:updated", projectId: active.store.doc.id, node });
  }

  bus.subscribe((event) => {
    // A background project's commit belongs to a store that is no longer active.
    if (event.type === "node:committed" && event.projectId === active.store.doc.id) emitNodeUpdated(event.nodeId);
  });

  /** Web-code exposes a live Vite URL; CAD projects render in the studio's
   * viewport pane instead (no iframe). */
  function previewUrl(): string {
    const adapter = active.backend.previewAdapter as { url?: () => string } | undefined;
    return adapter?.url?.() ?? "";
  }

  /** `extra` carries problems found outside the check itself — a T0 edit that
   *  broke a part's own probes — so one status line reports both. */
  async function runGlobalCheck(extra: string[] = []) {
    const { store, backend, workspace } = active;
    const graph = store.doc;
    bus.emit({ type: "checker:status", projectId: graph.id, status: "checking", problems: [] });
    const check = await backend.globalCheck(graph, workspace);
    applyCheck(store, check);
    const problems = [...extra, ...check.problems];
    bus.emit({
      type: "checker:status",
      projectId: graph.id,
      status: problems.length === 0 ? "clean" : "failing",
      problems,
      findings: check.findings ?? [],
    });
    if (problems.length > 0) console.log(`[patchcad] global check failing:\n  ${problems.join("\n  ")}`);
    return check;
  }
  void runGlobalCheck();

  /** Import cooks are fully deterministic; if no LLM is configured they must
   * still run — this provider throws if anything ever reaches it. */
  const nullProvider = {
    id: "none",
    complete: () => {
      throw new Error("no LLM provider configured");
    },
  };
  const resolved = await resolveProvider();
  if (resolved) console.log(`[patchcad] llm provider: ${resolved.provider.id} (${resolved.source})`);
  else console.log(`[patchcad] no llm provider — planning disabled. ${NO_PROVIDER_HELP}`);
  const maxUsd = await readMaxUsd();
  if (maxUsd) console.log(`[patchcad] cook budget: $${maxUsd.toFixed(2)} per cook`);

  /** Bill project-level spend to the store it was incurred for — captured when
   *  the request started, so a project switch mid-call cannot misfile it. */
  function billLedger(store: GraphStore, bucket: LedgerBucket, usage: LlmUsage) {
    store.applyOp((g) => {
      addUsage(g.ledger[bucket], usage);
    });
    bus.emit({
      type: "cost:update",
      projectId: store.doc.id,
      bucket,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usd: usage.usd,
    });
  }

  // ---------- HTTP API ----------

  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 * 1024 });
  // Exposed so the studio's cross-origin export fetch can read the filename.
  await app.register(cors, { origin: true, exposedHeaders: ["content-disposition", "x-patchcad-warning"] });
  await app.register(websocket);

  // The kernel this server spawned dies with it (an orphaned one kept :8621).
  app.addHook("onClose", () => cadBackend.kernel.stop());
  process.once("exit", () => void cadBackend.kernel.stop());
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      setTimeout(() => process.exit(1), 10_000).unref();
      void app.close().finally(() => process.exit(0));
    });
  }

  app.get("/api/health", async () => ({ ok: true }));

  /** What the studio cannot know on its own: whether anything can plan, how
   *  spend is billed, and whether the geometry kernel is up yet (its first boot
   *  pays the OCP import, and until then the viewport is an empty grid). */
  app.get("/api/status", async () => ({
    provider: resolved ? { id: resolved.provider.id, source: resolved.source } : null,
    providerHelp: resolved ? "" : NO_PROVIDER_HELP,
    maxUsd: maxUsd ?? null,
    kernel: active.backend.id === "cad" ? { ok: (await cadBackend.kernel.health()).ok } : null,
  }));

  // Uncaught errors inside the preview iframe land here so they show in the
  // server log and the studio log instead of a silent blank pane.
  app.post("/api/preview-error", async (req) => {
    const message = String((req.body as { message?: string })?.message ?? "").slice(0, 1500);
    console.log(`[patchcad] PREVIEW CRASH: ${message}`);
    bus.emit({ type: "job:log", projectId: active.store.doc.id, nodeId: "preview", line: `crash: ${message.slice(0, 200)}` });
    return { ok: true };
  });

  app.get("/api/project", async () => ({
    graph: active.store.doc,
    previewUrl: previewUrl(),
    backend: active.store.doc.backend,
    dir: active.dir,
    undo: {
      depth: active.undo.length,
      label: active.undo[active.undo.length - 1]?.label ?? "",
    },
  }));

  app.get("/api/project/nodes/:nodeId/code", async (req, reply) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    const node = active.store.doc.nodes[nid];
    if (!node) return reply.code(404).send({ error: "unknown node" });
    return { code: node.artifact?.code ?? "", version: node.version };
  });

  /** The T0/T1 re-apply after a param edit. Runs off a per-node queue, so it
   *  always reads the newest params: a drag's intermediate values never run. */
  async function reapplyParams(project: ActiveProject, nid: string) {
    // Switched away while this waited: the edit is persisted, and opening the
    // project again re-solves it.
    if (project !== active) return;
    const t1 = [nid, ...boundDependents(active.store.doc, nid)];
    const regressions: string[] = [];
    for (const id of t1) {
      const node = active.store.doc.nodes[id];
      if (!node?.artifact?.code) continue;
      if (id !== nid) {
        const { resolved: bound, problems } = resolveParamBindings(active.store.doc, id);
        if (problems.length > 0) {
          bus.emit({ type: "job:log", projectId: active.store.doc.id, nodeId: id, line: `T1 bindings: ${problems.join("; ")}` });
          continue;
        }
        active.store.setParams(id, bound);
      }
      // Registry parts re-CODEGEN when a bound param changes their spec
      // (an M5 screw is different code, not an M4 with new params) —
      // still deterministic, still zero LLM calls.
      const regen = active.backend.deterministicArtifact?.(active.store.doc.nodes[id]!);
      if (regen && regen.code !== active.store.doc.nodes[id]!.artifact?.code) {
        active.store.applyOp((g) => {
          const n = g.nodes[id]!;
          n.artifact = { code: regen.code, testCode: "", hash: hashValue(regen.code) };
        });
        bus.emit({ type: "job:log", projectId: active.store.doc.id, nodeId: id, line: "T1 registry re-resolve — new spec, new code, 0 LLM calls" });
      }
      // The studio already holds the edited node's params; a dependent's
      // were just rewritten here.
      if (id !== nid) emitNodeUpdated(id);
      const exec = await active.backend.execute(active.store.doc.nodes[id]!, active.workspace, active.store.doc);
      bus.emit({
        type: "job:log",
        projectId: active.store.doc.id,
        nodeId: id,
        line: exec.ok
          ? `${id === nid ? "T0" : "T1"} re-executed (${exec.report}, 0 LLM calls)`
          : `${id === nid ? "T0" : "T1"} re-execute failed: ${exec.report.slice(0, 160)}`,
      });
      if (!exec.ok) {
        regressions.push(`${id}: the new values break ${exec.stage} — ${exec.report.slice(0, 200)}`);
        continue;
      }
      // RE-PROBE. A part that built is not a part that still meets its
      // contract: a slider can drag a hole off its declared pose or a wall
      // through the envelope, and only G3/G4 can see that. The execute
      // above already ran them against the graph and cached the verdict,
      // so this costs a lookup. The code is not touched — the values are
      // the user's, and the problem says which ones broke what.
      const verify = await active.backend.verify(active.store.doc.nodes[id]!, active.store.doc, active.workspace);
      if (verify.ok) {
        active.store.applyOp((g) => {
          const n = g.nodes[id];
          if (n && verify.measurements != null)
            n.measurements = { version: n.version, paramsHash: hashValue(n.params), data: verify.measurements };
        });
      } else {
        regressions.push(`${id}: the new values fail ${verify.stage} — ${verify.report.slice(0, 200)}`);
      }
    }
    // A wall can outgrow or undercut its joint's rule (an insert no longer
    // fits): re-pick the hardware. A length alone is T1's and already done.
    if (active.backend.id === "cad") {
      regressions.push(...jointErrors(active.store.doc).map((e) => `joint ${e}`));
      if (liveCooks.size === 0 && staleJoints(active.store.doc).length > 0) applyReexpansion(`joint rules after ${nid}`);
    }
    bus.emit({ type: "preview:reload", projectId: active.store.doc.id });
    // A param can move a pose, so the assembly is re-judged too: G5
    // blocks or releases parts on what the edit did.
    await runGlobalCheck(regressions);
  }

  /**
   * Re-run the domain's plan expansion on the live graph (joint rules, for
   * CAD) and apply what moved: new hardware is planned, removed hardware goes
   * (its cost to the ledger), every changed contract goes dirty with its
   * port-granular descendants, and bound params re-resolve. Zero LLM calls;
   * the dirty nodes wait for the next cook like any contract edit.
   */
  function applyReexpansion(label: string) {
    const r = reexpandGraph(active.store.doc, active.backend);
    if (!r) return null;
    const moved = r.added.length + r.removed.length + r.changed.length > 0;
    if (!moved && JSON.stringify(r.graph.joints) === JSON.stringify(active.store.doc.joints)) return r;
    checkpoint(label);
    for (const id of r.removed) addCost(r.graph.ledger.nodes, active.store.doc.nodes[id]!.cost);
    active.store.replace(r.graph);
    for (const id of r.dirty) if (active.store.doc.nodes[id]?.status === "ready") active.store.setStatus(id, "dirty");
    // Bound params follow the new hardware (a bigger bearing's seat), and a
    // ready part whose values moved re-executes on them through T1, exactly as
    // if the user had dragged the slider: its contract did not change.
    for (const n of Object.values(active.store.doc.nodes)) {
      const { resolved, problems } = resolveParamBindings(active.store.doc, n.id);
      const moved = Object.entries(resolved).filter(([k, v]) => (n.params[k] ?? n.contract.params.find((p) => p.name === k)?.default) !== v);
      if (problems.length > 0 || moved.length === 0) continue;
      active.store.setParams(n.id, resolved);
      if (n.status === "ready") t0Queue.push(`${active.store.doc.id}/${n.id}`, { project: active, nid: n.id });
    }
    bus.emit({
      type: "job:log",
      projectId: active.store.doc.id,
      nodeId: "joints",
      line: `${label}: +${r.added.length} −${r.removed.length} hardware, ${r.dirty.length} node(s) dirty, 0 LLM calls`,
    });
    return r;
  }

  const t0Queue = new LatestWinsQueue<{ project: ActiveProject; nid: string }>(
    (_key, job) => reapplyParams(job.project, job.nid),
    (key, err) => console.warn(`[patchcad] T0 re-apply ${key} failed: ${(err as Error).message}`),
  );

  const ParamsBody = z.object({ params: z.record(ParamValue) });
  const HiddenBody = z.object({ hidden: z.boolean() });

  /**
   * Exclude a part from export and from the rendered scene without deleting it.
   * Deliberately NOT a contract change: no hash moves, nothing goes dirty, no
   * cook runs. The assembly solve still sees the node, so hiding a base plate
   * leaves everything mated to it exactly where it was.
   */
  app.post("/api/project/nodes/:nodeId/hidden", async (req, reply) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    const body = HiddenBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    if (!active.store.doc.nodes[nid]) return reply.code(404).send({ error: "unknown node" });
    checkpoint(`${body.data.hidden ? "hide" : "show"} ${nid}`);
    active.store.applyOp((g) => {
      g.nodes[nid]!.hidden = body.data.hidden;
    });
    bus.emit({ type: "graph:replaced", projectId: active.store.doc.id, graph: active.store.doc });
    bus.emit({ type: "preview:reload", projectId: active.store.doc.id });
    return { ok: true, hidden: body.data.hidden };
  });

  /**
   * Remove a node. The same surgery the split path does, minus the pieces:
   * drop its edges, hand the entry role on if it held it, and mark every
   * downstream consumer stale — a node whose `requires` port lost its provider
   * cannot cook, and should say so through the normal re-cook flow rather than
   * failing mysteriously later.
   */
  /**
   * Change what a joint must do (intent, load, motion, walls, count...). The
   * joint rules re-pick its hardware and the expansion re-runs: a different
   * decision dirties the parts whose host features moved. Never an LLM call.
   */
  app.post("/api/project/joints/:jointId", async (req, reply) => {
    if (active.backend.id !== "cad") return reply.code(409).send({ error: "active project is not a CAD graph" });
    if (liveCooks.size > 0) return reply.code(409).send({ error: "wait for the cook to finish" });
    const { jointId } = req.params as { jointId: string };
    const i = active.store.doc.joints.findIndex((j) => j.id === jointId);
    if (i < 0) return reply.code(404).send({ error: "unknown joint" });
    const next = CadJoint.safeParse({ ...active.store.doc.joints[i], ...(req.body as object), id: jointId });
    if (!next.success) return reply.code(400).send({ error: next.error.message });
    // Refused, not half-applied: a joint no rule can make keeps its hardware.
    const trial = { ...active.store.doc, joints: active.store.doc.joints.map((j, k) => (k === i ? { ...j, ...next.data } : j)) };
    const errors = jointErrors(trial).filter((e) => e.startsWith(`${jointId}:`));
    if (errors.length > 0) return reply.code(422).send({ error: errors.join("; ") });
    checkpoint(`joint ${jointId}`);
    active.store.applyOp((g) => {
      g.joints[i] = { ...g.joints[i], ...next.data };
    });
    const r = applyReexpansion(`joint ${jointId}`);
    return { ok: true, added: r?.added ?? [], removed: r?.removed ?? [], dirtied: r?.dirty ?? [] };
  });

  app.delete("/api/project/nodes/:nodeId", async (req, reply) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    const doc = active.store.doc;
    if (!doc.nodes[nid]) return reply.code(404).send({ error: "unknown node" });
    if (liveCooks.size > 0) return reply.code(409).send({ error: "wait for the cook to finish" });

    // Everything downstream, before the edges go. Deleting a node invalidates
    // every port it provided, so the dirty set is the one computed from all of
    // its outgoing ports.
    const downstream = computeDirtySet(
      doc,
      nid,
      doc.edges.filter((e) => e.from === nid).map((e) => e.fromPort),
    );

    checkpoint(`delete ${nid}`);
    active.store.applyOp(
      (g) => {
        addCost(g.ledger.nodes, g.nodes[nid]!.cost);
        delete g.nodes[nid];
        g.edges = g.edges.filter((e) => e.from !== nid && e.to !== nid);
        if (g.assembly.entryNodeId === nid) {
          g.assembly.entryNodeId = Object.keys(g.nodes)[0] ?? "";
        }
      },
      { immediate: true },
    );
    for (const id of downstream) {
      const n = active.store.doc.nodes[id];
      if (n && n.status === "ready") active.store.setStatus(id, "dirty");
    }
    bus.emit({ type: "graph:replaced", projectId: active.store.doc.id, graph: active.store.doc });
    bus.emit({ type: "preview:reload", projectId: active.store.doc.id });
    bus.emit({
      type: "job:log",
      projectId: active.store.doc.id,
      nodeId: nid,
      line: `deleted — ${downstream.size} downstream node(s) now stale`,
    });
    return { ok: true };
  });

  app.post("/api/project/nodes/:nodeId/params", async (req, reply) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    const body = ParamsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    if (!active.store.doc.nodes[nid]) return reply.code(404).send({ error: "unknown node" });
    // T0: persist only — the studio pushes live values into the preview
    // iframe directly via postMessage; no rebuild, no LLM.
    checkpoint(`param edit on ${nid}`);
    active.store.setParams(nid, body.data.params);

    // CAD T0/T1: re-execute the edited node's cached code with the new values,
    // then re-resolve any bound dependents — deterministic, zero LLM calls.
    if (active.backend.id === "cad") t0Queue.push(`${active.store.doc.id}/${nid}`, { project: active, nid });
    return { ok: true };
  });

  // ---------- CAD scene (viewport data) ----------

  /**
   * A picture of one part, from six angles. The gates can prove a bore is
   * Ø4.5 and the part fits its envelope; they cannot see that it looks wrong.
   * For now a human closes that gap — this is what they look at.
   */
  app.get("/api/project/nodes/:nodeId/sheet", async (req, reply) => {
    if (active.backend.id !== "cad") return reply.code(409).send({ error: "active project is not a CAD graph" });
    const { nodeId: nid } = req.params as { nodeId: string };
    const node = active.store.doc.nodes[nid];
    if (!node?.artifact?.code) return reply.code(404).send({ error: "node has no cooked code" });

    const cad = active.backend as CadBackend;
    const params: Record<string, unknown> = {};
    for (const p of node.contract.params) params[p.name] = p.default;
    Object.assign(params, node.params);

    const result = await cad.kernel.render(node.artifact.code, params, {
      importDir: path.join(active.dir, "imports"),
    });
    if (!result.ok || !result.sheet) {
      return reply.code(422).send({ error: result.error ?? "render failed", stage: result.stage });
    }
    return { url: kernelUrl(req, result.sheet), ...result.render };
  });

  /**
   * Kernel artifacts (GLB, contact sheet) THROUGH the server, so the browser
   * never needs to reach :8621 — in a container it cannot. URLs are absolute
   * on the host the request came in on, which is :4100 in dev and wherever
   * the server is published in production.
   */
  const kernelUrl = (req: { protocol: string; host: string }, kernelPath: string) =>
    `${req.protocol}://${req.host}/api/kernel${kernelPath}`;
  app.get("/api/kernel/artifact/:digest/:file", async (req, reply) => {
    const { digest, file } = req.params as { digest: string; file: string };
    if (!/^[0-9a-f]+$/.test(digest) || !/^[\w-]+\.\w+$/.test(file)) return reply.code(400).send({ error: "bad artifact path" });
    const res = await fetch(`${cadBackend.kernel.baseUrl}/artifact/${digest}/${file}`);
    if (!res.ok || !res.body) return reply.code(res.status).send({ error: `kernel: ${res.status}` });
    return reply
      .type(res.headers.get("content-type") ?? "application/octet-stream")
      .send(Buffer.from(await res.arrayBuffer()));
  });

  /**
   * Geometry out, as a download. `node` exports that part in its own frame —
   * what you slice, since parts print flat and separately. Omit it for the
   * posed assembly. Streamed through here rather than linked to the kernel:
   * a cross-origin `a.download` ignores its filename, and a remote browser
   * cannot reach :8621 at all.
   */
  const ExportParams = z.object({ format: z.enum(["stl", "3mf", "obj", "step"]) });
  const ExportQuery = z.object({ node: z.string().optional() });
  app.get("/api/project/export/:format", async (req, reply) => {
    if (active.backend.id !== "cad") return reply.code(409).send({ error: "active project is not a CAD graph" });
    const p = ExportParams.safeParse(req.params);
    const q = ExportQuery.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: (p.error ?? q.error)!.message });
    const cad = active.backend as CadBackend;
    const result = await cad.exportGeometry(active.store.doc, active.workspace, {
      nodeId: q.data.node,
      format: p.data.format,
    });
    if (!result.ok || !result.file) {
      return reply.code(422).send({ error: result.error ?? "export failed", hint: result.hint });
    }
    const res = await fetch(`${cad.kernel.baseUrl}${result.file}`);
    if (!res.ok) return reply.code(502).send({ error: `kernel served ${res.status} for the export` });
    const slug = active.dir.split("/").pop() ?? "patchcad";
    const name = q.data.node ? `${slug}-${q.data.node}` : slug;
    if (result.export?.warning) reply.header("x-patchcad-warning", result.export.warning);
    return reply
      .header("content-disposition", `attachment; filename="${name.replace(/[^\w.-]/g, "_")}.${p.data.format}"`)
      .type("application/octet-stream")
      .send(Buffer.from(await res.arrayBuffer()));
  });

  registerBomRoutes(app, () => active, cadBackend);

  app.get("/api/project/cad-scene", async (req, reply) => {
    if (active.backend.id !== "cad") return reply.code(409).send({ error: "active project is not a CAD graph" });
    const cad = active.backend as CadBackend;
    const { scene, problems } = cad.solveScene(active.store.doc);
    // Resolve each cooked node's mesh URL via the kernel's content-addressed
    // cache (instant for anything already executed this session).
    const meshes: Record<string, { glb: string; status: string; printability?: unknown }> = {};
    for (const node of Object.values(active.store.doc.nodes)) {
      // Hidden: no mesh, so nothing renders. The scene's matrices above still
      // cover every node, so the parts that remain do not move.
      if (!node.artifact?.code || node.hidden) continue;
      const params: Record<string, unknown> = {};
      for (const p of node.contract.params) params[p.name] = p.default;
      Object.assign(params, node.params);
      const result = await cad.kernel.execute(node.artifact.code, params, {
        importDir: path.join(active.dir, "imports"),
      });
      if (result.ok) {
        meshes[node.id] = {
          glb: kernelUrl(req, result.glb),
          status: node.status,
          printability: (result.measurements as { printability?: unknown }).printability,
        };
      }
    }
    return { scene, meshes, problems };
  });

  // ---------- Planning + cooking ----------

  let pendingPlan: { graph: GraphDoc; rationale: string; goal: string; spend: NodeCost; refs: PendingRef[] } | null = null;

  const PlanBody = z.object({
    goal: z.string().min(4),
    /** Which domain plans this goal: web app or printed parts. */
    backend: z.enum(["web-code", "cad"]).default("web-code"),
    /** Reference images (CAD): part of the spec the architect plans from. */
    images: z.array(UploadedImage).max(4).default([]),
    /** Target overall height, mm. */
    sizeMm: z.number().positive().optional(),
    symmetric: z.boolean().optional(),
  });
  app.post("/api/project/plan", async (req, reply) => {
    if (!resolved) return reply.code(503).send({ error: NO_PROVIDER_HELP });
    const body = PlanBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const ctl = (planAbort = new AbortController());
    // Every architect round, repairs included; it lands in the project's
    // ledger only if the plan is approved and a project exists to own it.
    const spend: NodeCost = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    try {
      const slug = slugify(body.data.goal);
      const planBackend = backends[body.data.backend]!;
      const refs =
        body.data.images.length > 0 && planBackend instanceof CadBackend
          ? await prepReferences(planBackend.kernel, body.data.images, (line) => console.log(`[patchcad] ${line}`))
          : [];
      const result = await planGraph({
        references: refs.map((r) => ({ image: r.image, view: r.ref.view, aspect: r.ref.aspect })),
        sizeMm: body.data.sizeMm,
        symmetric: body.data.symmetric,
        provider: metered(resolved.provider, (usage) => addUsage(spend, usage)),
        backend: backends[body.data.backend]!,
        projectId: slug,
        goal: body.data.goal,
        onPhase: (phase, detail) =>
          bus.emit({
            type: "plan:phase",
            projectId: slug,
            phase,
            detail: detail ?? "",
          }),
        // The architect is the longest single call in the system; the studio's
        // stop reaches it through /plan/cancel.
        signal: ctl.signal,
      });
      result.graph.brief.refs = refs.map((r) => r.ref);
      if (body.data.sizeMm) result.graph.brief.sizeMm = body.data.sizeMm;
      if (body.data.symmetric) result.graph.brief.symmetric = true;
      pendingPlan = { graph: result.graph, rationale: result.rationale, goal: body.data.goal, spend, refs };
      return {
        plan: result.graph,
        rationale: result.rationale,
        usage: result.usage,
        repaired: result.repaired,
      };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    } finally {
      if (planAbort === ctl) planAbort = null;
    }
  });

  app.post("/api/project/plan/cancel", async (_req, reply) => {
    if (!planAbort) return reply.code(409).send({ error: "nothing is being planned" });
    planAbort.abort();
    return { ok: true };
  });

  app.post("/api/project/plan/approve", async (_req, reply) => {
    if (!resolved) return reply.code(503).send({ error: NO_PROVIDER_HELP });
    if (!pendingPlan) return reply.code(409).send({ error: "no pending plan" });
    const approved = pendingPlan;
    pendingPlan = null;

    // Every approved plan gets its OWN project directory — the loaded project
    // is never clobbered.
    const dir = path.join(projectsRoot, approved.graph.id);
    approved.graph.ledger.planning = approved.spend;
    await mkdir(path.join(dir, "nodes"), { recursive: true });
    await writeRefs(dir, approved.refs);
    await writeFile(path.join(dir, "patchcad.json"), JSON.stringify(approved.graph, null, 2), "utf8");
    active = await activateProject(dir);

    // The FIRST cook of a project is the one that forms the user's impression,
    // and it used to be the one cook that never looked at what it made.
    const inspect = defaultInspect();
    void trackCook(dir, cookNodes(
      cookDeps(resolved.provider, { inspect }),
      Object.keys(active.store.doc.nodes),
    )).then((summary) => {
      console.log(
        `[patchcad] cook done: ${summary.succeeded.length} ok, ${summary.failed.length} failed`,
      );
    });
    return { ok: true, dir };
  });

  /** The pending plan's envelopes, posed by its mates — the approval
   *  preview. Zero LLM, zero kernel. */
  app.post("/api/project/plan/preview", async (_req, reply) => {
    if (!pendingPlan) return reply.code(409).send({ error: "no pending plan" });
    if (pendingPlan.graph.backend !== "cad") return reply.code(409).send({ error: "only cad plans have a preview" });
    return { ...planPreview(pendingPlan.graph), meshGen: meshGen?.id ?? null };
  });

  /** A low-poly draft of one mesh node from the pending plan's references,
   *  so the user can see the surface before paying for the cook. Costs a
   *  provider call, billed to the plan's spend. */
  app.post("/api/project/plan/preview-mesh", async (req, reply) => {
    const body = z.object({ nodeId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    if (!meshGen) return reply.code(503).send({ error: "mesh generation not configured" });
    const plan = pendingPlan;
    const node = plan?.graph.nodes[body.data.nodeId];
    if (!plan || !node) return reply.code(409).send({ error: "no pending plan with that node" });
    try {
      const out = await meshGen.generate({
        images: plan.refs.map((r) => ({ pngB64: r.png.toString("base64"), view: r.ref.view })),
        prompt: meshPrompt(node),
        targetSizeMm: plan.graph.brief.sizeMm,
        symmetric: plan.graph.brief.symmetric,
        preview: true,
      });
      const usd = out.usage?.usd ?? 0;
      addUsage(plan.spend, { inputTokens: 0, outputTokens: 0, usd });
      return { glbB64: out.glb.toString("base64"), usd };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.delete("/api/project/plan", async () => {
    pendingPlan = null;
    return { ok: true };
  });

  // ---------- imported-piece node builder (shared by import + segment) ----------

  type PieceProcess = { process: CadContractPayload["process"]; sourcing?: CadContractPayload["sourcing"] };
  const FDM_PIECE: PieceProcess = { process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 } };

  /** Kernel pieces + interfaces → graph nodes, mate edges and joints. Cut
   * faces are FLAT_FACE mating ports; holes/pegs get probed ports; in joint
   * mode "auto" each cut becomes a declared joint (importJoints) whose hardware
   * the expansion mints afterwards. Every dimension scale-tracks via T1
   * expressions; pieces share one scale via bindings. */
  function buildImportedNodes(
    result: ImportResult,
    displayName: string,
    idFor: (index: number) => string,
    opts: PieceProcess & { thread: string; taken: string[]; scale?: number },
  ): { nodes: Record<string, unknown>; edges: { id: string; from: string; fromPort: string; to: string; toPort: string }[]; joints: CadJoint[]; notes: string[] } {
    const rootId = idFor(result.pieces[0]!.index);
    const planned = importJoints(result.interfaces, {
      idFor,
      process: opts.process.kind,
      minWall: opts.process.minWall,
      thread: opts.thread,
      taken: opts.taken,
      scale: opts.scale,
    });
    const nodes: Record<string, unknown> = {};
    for (const piece of result.pieces) {
      const id = idFor(piece.index);
      const ports: unknown[] = [];
      const provides: unknown[] = [];
      const requires: unknown[] = [];
      const scaled = (v: number) => (v === 0 ? 0 : `expr: ${v} * param(${id}.scale)`);
      for (const itf of result.interfaces) {
        const isA = itf.piece_a === piece.index;
        const isB = itf.piece_b === piece.index;
        if (!isA && !isB) continue;
        const other = idFor(isA ? itf.piece_b : itf.piece_a);
        const zAxis = isA ? itf.normal : itf.normal.map((v) => -v);
        const xAxis = Math.abs(itf.normal[2] ?? 0) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        const jointName = `joint_${other}`;
        ports.push({
          name: jointName,
          type: "FLAT_FACE",
          pose: { origin: itf.origin.map(scaled), zAxis, xAxis },
          params: { size: itf.face_size ?? 3 },
        });
        (isA ? provides : requires).push({ key: jointName, type: "FLAT_FACE", description: "cut interface" });
        itf.holes.forEach((hole, k) => {
          ports.push({
            name: `${jointName}_hole_${k}`,
            type: "CLEARANCE_HOLE",
            pose: { origin: hole.center.map(scaled), zAxis, xAxis },
            params: { diameter: `expr: ${hole.diameter} * param(${id}.scale)` },
          });
        });
        (itf.pegs ?? []).forEach((peg, k) => {
          ports.push(
            isA
              ? {
                  name: `${jointName}_peg_${k}`,
                  type: "SHAFT",
                  pose: { origin: peg.center.map(scaled), zAxis, xAxis },
                  params: { diameter: `expr: ${peg.peg_diameter} * param(${id}.scale)`, length: peg.length },
                }
              : {
                  name: `${jointName}_socket_${k}`,
                  type: "BORE",
                  pose: { origin: peg.center.map(scaled), zAxis, xAxis },
                  params: { diameter: `expr: ${peg.socket_diameter} * param(${id}.scale)` },
                },
          );
        });
      }
      ports.push(...(planned.ports[id] ?? []));
      // A printed peg stands out of its face: the envelope reaches its tip.
      const min = [...piece.bbox.min];
      const max = [...piece.bbox.max];
      for (const pt of planned.reach[id] ?? []) {
        pt.forEach((v, i) => {
          min[i] = Math.min(min[i]!, v);
          max[i] = Math.max(max[i]!, v);
        });
      }
      nodes[id] = {
        id,
        kind: "imported",
        title: result.pieces.length > 1 ? `${displayName} · piece ${piece.index + 1}` : displayName,
        spec: `Imported from ${displayName}${result.pieces.length > 1 ? `, piece ${piece.index + 1} of ${result.pieces.length}` : ""}. Geometry loads from imports/${id}.ply.`,
        contract: {
          name: id,
          summary: `Imported piece (${piece.volume_mm3.toFixed(0)} mm³${piece.watertight ? "" : ", NOT watertight"}); cut faces are its mating contracts. Scale is live; reprompt to modify the mesh.`,
          params: [
            { type: "number", name: "scale", description: "uniform size multiplier", default: 1, min: 0.25, max: 3, step: 0.05 },
          ],
          provides,
          requires,
          payload: {
            units: "mm",
            process: opts.process,
            ...(opts.sourcing ? { sourcing: opts.sourcing } : {}),
            ports,
            envelope: {
              volumes: [
                {
                  kind: "box",
                  pose: {
                    origin: min.map((v, i) => {
                      const c = (v + max[i]!) / 2;
                      return c === 0 ? 0 : `expr: ${c} * param(${id}.scale)`;
                    }),
                    zAxis: [0, 0, 1],
                    xAxis: [1, 0, 0],
                  },
                  dims: max.map((v, i) => `expr: ${Math.max(v - min[i]!, 0.1)} * param(${id}.scale)`),
                },
              ],
              clearance: 0.4,
            },
            paramBindings: id === rootId ? {} : { scale: `param:${rootId}.scale` },
          },
          hash: "",
        },
        params: {},
        artifact: null,
        thread: [],
        status: "planned",
        version: 0,
        history: [],
        cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
      };
    }
    const edges = result.interfaces.map((itf, i) => ({
      id: `cut-${idFor(itf.piece_a)}-${i}`,
      from: idFor(itf.piece_a),
      fromPort: `joint_${idFor(itf.piece_b)}`,
      to: idFor(itf.piece_b),
      toPort: `joint_${idFor(itf.piece_a)}`,
    }));
    return { nodes, edges, joints: planned.joints, notes: planned.notes };
  }

  /** Mint the hardware of joints just written into the live graph (import,
   * split): the expansion a joint edit runs, under the caller's undo step.
   * Returns every node that now needs a cook. */
  function expandImportJoints(notes: string[]): string[] {
    for (const line of notes) bus.emit({ type: "job:log", projectId: active.store.doc.id, nodeId: "joints", line });
    const r = reexpandGraph(active.store.doc, active.backend);
    if (!r) return [];
    active.store.replace(r.graph);
    for (const id of r.dirty) if (active.store.doc.nodes[id]?.status === "ready") active.store.setStatus(id, "dirty");
    return [...r.added, ...r.dirty];
  }

  // ---------- CAD file import: STL/STEP/3MF → node graph ----------

  const JointMode = z.enum(["auto", "none", "holes", "pegs"]);
  const ImportReq = z.object({
    name: z.string().min(1),
    dataB64: z.string().min(8),
    /** 0 = auto (cut at natural necks/bulges); 1 = keep whole; >1 = equal slabs. */
    pieces: z.number().int().min(0).max(8).default(0),
    /** At each cut: real hardware the joint rules pick (auto), screw holes, or
     *  clearance-fit alignment pegs. */
    joints: JointMode.default("auto"),
    thread: z.enum(["M3", "M4", "M5"]).default("M4"),
  });
  app.post("/api/project/import", async (req, reply) => {
    const body = ImportReq.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const { name, dataB64, pieces, joints, thread } = body.data;

    const result = await cadBackend.kernel.importFile(name, dataB64, { pieces, joints, thread });
    if (!result.ok) return reply.code(422).send({ error: `${result.stage}: ${result.error}` });

    // A new project per import, like plan approval — never clobbers the open one.
    const dir = path.join(projectsRoot, slugify(`import ${name.replace(/\.[^.]+$/, "")}`));
    const importsDir = path.join(dir, "imports");
    await mkdir(importsDir, { recursive: true });

    const built = buildImportedNodes(result, name, (i) => `piece-${i}`, { ...FDM_PIECE, thread, taken: [] });
    for (const piece of result.pieces) {
      await copyFile(path.join(result.dir, piece.file), path.join(importsDir, `piece-${piece.index}.ply`));
    }

    const graph = {
      schemaVersion: 1,
      id: path.basename(dir),
      backend: "cad",
      brief: { goal: `imported ${name}`, constraints: [], clarifications: [] },
      nodes: built.nodes,
      edges: built.edges,
      joints: built.joints,
      assembly: { entryNodeId: "piece-0" },
      rev: 0,
    };
    await writeFile(path.join(dir, "patchcad.json"), JSON.stringify(graph, null, 2), "utf8");
    active = await activateProject(dir);
    expandImportJoints(built.notes);

    // Pieces cook deterministically (mesh loader + joint cuts, full gates) and
    // the joint hardware from the registry: zero LLM.
    void trackCook(dir, cookNodes(
      cookDeps(resolved?.provider ?? nullProvider),
      Object.keys(active.store.doc.nodes),
    )).then((summary) => {
      console.log(`[patchcad] import cook: ${summary.succeeded.length} ok, ${summary.failed.length} failed`);
    });
    return { ok: true, dir, pieces: result.pieces.length, interfaces: result.interfaces.length, joints: built.joints.length, notes: built.notes };
  });

  // ---------- per-node smart segmentation ----------

  const SegmentReq = z.object({
    joints: JointMode.default("auto"),
    thread: z.enum(["M3", "M4", "M5"]).default("M4"),
    /** 0 = natural necks/bulges; >1 = equal slabs. */
    pieces: z.number().int().min(0).max(8).default(0),
  });
  app.post("/api/project/nodes/:nodeId/segment", async (req, reply) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    const body = SegmentReq.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const r = await splitNode(nid, body.data);
    return "code" in r ? reply.code(r.code).send({ error: r.error }) : r;
  });

  /**
   * Split one mesh node (imported, or a generated mesh) into pieces, in place:
   * the sub-pieces inherit its external mates and joints, the cuts become
   * joints of their own, and the expansion mints their hardware. One undo step.
   */
  async function splitNode(
    nid: string,
    opts: z.infer<typeof SegmentReq>,
  ): Promise<{ code: number; error: string } | { ok: true; pieces: number; nodeIds?: string[]; message?: string; notes?: string[] }> {
    const node = active.store.doc.nodes[nid];
    if (!node) return { code: 404, error: "unknown node" };
    if (node.kind !== "imported" && !isMeshNode(node)) {
      return { code: 409, error: "only imported or generated mesh nodes can be split (for now)" };
    }
    // Splitting a jointed piece is allowed: its external mates are inherited —
    // each old port lands on whichever sub-piece geometrically contains it and
    // the edges rewire there (see below).
    const touchingEdges = active.store.doc.edges.filter((e) => e.from === nid || e.to === nid);

    const importsDir = path.join(active.dir, "imports");
    let meshB64: string;
    try {
      meshB64 = (await readFile(path.join(importsDir, `${nid}.ply`))).toString("base64");
    } catch {
      return { code: 409, error: "no stored mesh for this node" };
    }
    // Features the piece already carries, in its unscaled mesh frame: new
    // joint sites keep their bores and access columns clear of them.
    const scaleNow = typeof node.params.scale === "number" ? node.params.scale : 1;
    const avoid = ((node.contract.payload as CadContractPayload).ports ?? [])
      .filter((p) => p.type !== "FLAT_FACE")
      .flatMap((p) => {
        try {
          return [resolvePose(active.store.doc, p.pose).origin.map((v) => v / scaleNow)];
        } catch {
          return [];
        }
      });
    const result = await cadBackend.kernel.importFile(`${nid}.ply`, meshB64, {
      pieces: opts.pieces,
      joints: opts.joints,
      thread: opts.thread,
      avoid,
    });
    if (!result.ok) return { code: 422, error: `${result.stage}: ${result.error}` };
    if (result.pieces.length <= 1) {
      return { ok: true, pieces: 1, message: "no natural pieces found — the shape has no convincing necks or bulges" };
    }

    checkpoint(`split of ${nid}`);
    const hashesBefore = new Map(Object.entries(active.store.doc.nodes).map(([id, n]) => [id, n.contract.hash]));
    const idFor = (i: number) => `${nid}-p${i + 1}`;
    const oldPayload = node.contract.payload as CadContractPayload & { paramBindings?: Record<string, string> };
    const built = buildImportedNodes(result, node.title, idFor, {
      process: oldPayload.process,
      sourcing: oldPayload.sourcing,
      thread: opts.thread,
      taken: active.store.doc.joints.map((j) => j.id),
      scale: scaleNow,
    });
    for (const piece of result.pieces) {
      await copyFile(path.join(result.dir, piece.file), path.join(importsDir, `${idFor(piece.index)}.ply`));
    }
    const newIds = result.pieces.map((piece) => idFor(piece.index));

    // ---- inherit external joints ----
    // Port origins and piece bboxes are both in the unscaled mesh frame, so a
    // port belongs to the sub-piece whose bbox it falls in (nearest on ties).
    type PortShape = {
      name: string;
      type: string;
      pose: { origin: (number | string)[]; zAxis: number[]; xAxis: number[] };
      params?: Record<string, unknown>;
    };
    const numeric = (v: number | string): number =>
      typeof v === "number" ? v : Number(/-?\d+(?:\.\d+)?/.exec(v)?.[0] ?? Number.NaN);
    const bboxOf = (id: string) => result.pieces.find((piece) => idFor(piece.index) === id)!.bbox;
    const subFor = (origin: (number | string)[]): string => {
      const pt = origin.map(numeric);
      let best = newIds[0]!;
      let bestD = Number.POSITIVE_INFINITY;
      for (const piece of result.pieces) {
        let d = 0;
        for (let i = 0; i < 3; i++) {
          const lo = piece.bbox.min[i]! - 1e-3;
          const hi = piece.bbox.max[i]! + 1e-3;
          d += Math.max(lo - pt[i]!, 0, pt[i]! - hi) ** 2;
        }
        if (d < bestD) {
          bestD = d;
          best = idFor(piece.index);
        }
      }
      return best;
    };
    // Joints through this node keep their END ports (the faces they sit on);
    // everything they minted on it is re-minted on the sub-piece by the
    // expansion below, so it is left behind.
    const touchingJoints = active.store.doc.joints.filter((j) => j.a.node === nid || j.b.node === nid);
    const minted = touchingJoints.map((j) => `${jointVar(j.id)}_`);
    const endPorts = new Set(touchingJoints.flatMap((j) => [j.a, j.b].filter((e) => e.node === nid).map((e) => e.port)));
    const edgePorts = new Set(touchingEdges.map((e) => (e.from === nid ? e.fromPort : e.toPort)));
    const neighborIds = touchingEdges.map((e) => (e.from === nid ? e.to : e.from));
    const externalPorts = (oldPayload?.ports ?? []).filter((port) =>
      !minted.some((m) => port.name.startsWith(m)) &&
      (edgePorts.has(port.name) || endPorts.has(port.name) || neighborIds.some((other) => port.name.startsWith(`joint_${other}_`))),
    ) as PortShape[];
    const edgeRewire = new Map<string, string>();
    for (const port of externalPorts) {
      const subId = subFor(port.pose.origin);
      const retarget = (v: unknown): unknown =>
        typeof v === "string" ? v.replaceAll(`param(${nid}.scale)`, `param(${subId}.scale)`) : v;
      const carried = {
        ...port,
        pose: { ...port.pose, origin: port.pose.origin.map(retarget) as (number | string)[] },
        params: Object.fromEntries(Object.entries(port.params ?? {}).map(([k, v]) => [k, retarget(v)])),
      };
      const sub = built.nodes[subId] as {
        contract: { provides: unknown[]; requires: unknown[]; payload: { ports: unknown[] } };
      };
      sub.contract.payload.ports.push(carried);
      edgeRewire.set(port.name, subId);
      for (const side of ["provides", "requires"] as const) {
        const decl = node.contract[side].find((d) => d.key === port.name);
        if (decl) sub.contract[side].push(decl);
      }
    }
    // A joint's walls were measured on the whole node; a sub-piece can be
    // shallower along the joint axis, so the wall is clamped to its bbox.
    const retargetJoint = (j: CadJoint): CadJoint => {
      const next = structuredClone(j);
      for (const [end, wall] of [["a", "wallA"], ["b", "wallB"]] as const) {
        if (j[end].node !== nid) continue;
        const port = externalPorts.find((p) => p.name === j[end].port);
        if (!port) continue;
        const subId = edgeRewire.get(port.name)!;
        next[end] = { ...j[end], node: subId };
        const k = port.pose.zAxis.map(Math.abs).indexOf(Math.max(...port.pose.zAxis.map(Math.abs)));
        const o = numeric(port.pose.origin[k]!);
        const box = bboxOf(subId);
        const depth = port.pose.zAxis[k]! > 0 ? o - box.min[k]! : box.max[k]! - o;
        const was = typeof j[wall] === "number" ? (j[wall] as number) : numeric(j[wall]);
        const w = Math.round(Math.min(was, depth) * 10) / 10;
        next[wall] = `expr: ${w} * param(${subId}.scale)`;
      }
      return next;
    };

    // ---- keep the one-slider scale web intact ----
    const oldBinding = oldPayload?.paramBindings?.scale;
    if (oldBinding) {
      // non-root piece: every sub-piece joins the existing global scale web
      for (const id of newIds) {
        (built.nodes[id] as { contract: { payload: { paramBindings: Record<string, string> } } }).contract.payload.paramBindings.scale = oldBinding;
      }
    }

    active.store.applyOp(
      (g) => {
        addCost(g.ledger.nodes, g.nodes[nid]!.cost);
        delete g.nodes[nid];
        Object.assign(g.nodes, built.nodes as never);
        g.edges.push(...(built.edges as unknown as typeof g.edges));
        for (const e of g.edges) {
          if (e.from === nid) e.from = edgeRewire.get(e.fromPort) ?? newIds[0]!;
          if (e.to === nid) e.to = edgeRewire.get(e.toPort) ?? newIds[0]!;
        }
        g.joints = [
          ...g.joints.map((j) => (j.a.node === nid || j.b.node === nid ? (retargetJoint(j as CadJoint) as typeof j) : j)),
          ...(built.joints as typeof g.joints),
        ];
        if (!oldBinding) {
          // nid WAS the scale root: the first sub-piece takes over — rewrite
          // every reference across the graph and carry the user's scale value.
          const newRoot = newIds[0]!;
          for (const [id, n] of Object.entries(g.nodes)) {
            if (id === newRoot) continue;
            const json = JSON.stringify(n.contract);
            if (json.includes(`${nid}.scale`)) {
              n.contract = JSON.parse(
                json
                  .replaceAll(`param(${nid}.scale)`, `param(${newRoot}.scale)`)
                  .replaceAll(`param:${nid}.scale`, `param:${newRoot}.scale`),
              ) as typeof n.contract;
            }
          }
          if (typeof node.params.scale === "number") g.nodes[newRoot]!.params.scale = node.params.scale;
        }
        if (g.assembly.entryNodeId === nid) g.assembly.entryNodeId = newIds[0]!;
      },
      { immediate: true },
    );
    active.store.recomputeAllContractHashes();
    // A root rewrite ripples other nodes' contracts (scale refs) — any node
    // whose hash moved must re-cook, or a cook in flight for it is superseded
    // and would strand mid-status.
    const rippled = Object.entries(active.store.doc.nodes)
      .filter(([id, n]) => !newIds.includes(id) && hashesBefore.has(id) && hashesBefore.get(id) !== n.contract.hash)
      .map(([id]) => id);
    const expanded = expandImportJoints(built.notes);
    bus.emit({ type: "graph:replaced", projectId: active.store.doc.id, graph: active.store.doc });
    void trackCook(active.dir, cookNodes(
      cookDeps(resolved?.provider ?? nullProvider),
      [...new Set([...newIds, ...rippled, ...expanded])].filter((id) => active.store.doc.nodes[id]),
    )).then((summary) => {
      console.log(`[patchcad] split cook: ${summary.succeeded.length} ok, ${summary.failed.length} failed`);
    });
    return { ok: true, pieces: result.pieces.length, nodeIds: newIds, notes: built.notes };
  }

  /** A generated mesh bigger than its printer's build volume becomes several
   * imported pieces joined by real hardware: the split a user can ask for on
   * any mesh node, run once the wave that fitted it has settled (graph surgery
   * never runs under a live cook). */
  async function splitOversizeMeshes() {
    if (active.backend.id !== "cad") return;
    for (const node of Object.values(active.store.doc.nodes)) {
      const pieces = await oversizeMeshSplit(active.dir, node);
      if (!pieces || liveCooks.size > 0) continue;
      const r = await splitNode(node.id, { joints: "auto", thread: "M4", pieces });
      const line = "code" in r ? `build-volume split of ${node.id} failed: ${r.error}` : `${node.id} exceeds the build volume: split into ${r.pieces} jointed pieces`;
      bus.emit({ type: "job:log", projectId: active.store.doc.id, nodeId: node.id, line });
    }
  }

  // ---------- Project switcher ----------

  app.get("/api/projects", async () => {
    const examplesRoot = path.join(repoRoot, "examples");
    const roots = [examplesRoot, projectsRoot];
    const projects: Array<{ dir: string; name: string; goal: string; nodes: number; mtime: number; example: boolean }> = [];
    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        try {
          const file = path.join(dir, "patchcad.json");
          const raw = JSON.parse(await readFile(file, "utf8")) as GraphDoc;
          projects.push({
            dir,
            name: entry.name,
            goal: raw.brief?.goal ?? "",
            nodes: Object.keys(raw.nodes ?? {}).length,
            mtime: (await stat(file)).mtimeMs,
            example: root === examplesRoot,
          });
        } catch {
          // not a patchcad project — skip
        }
      }
    }
    // Most recently touched first: the project you were just in is the one
    // you most likely want back.
    projects.sort((a, b) => b.mtime - a.mtime);
    return { projects, active: active.dir };
  });

  const OpenBody = z.object({ dir: z.string().min(1) });
  /** Back to the front door: no active project, welcome screen. The closed
   * project stays on disk and in the picker. */
  app.post("/api/project/close", async () => {
    active = await activateEphemeral();
    return { ok: true };
  });

  app.post("/api/project/open", async (req, reply) => {
    const body = OpenBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const dir = path.resolve(body.data.dir);
    const allowed = [path.join(repoRoot, "examples"), projectsRoot].some((root) =>
      dir.startsWith(root + path.sep),
    );
    if (!allowed) return reply.code(400).send({ error: "dir must be under examples/ or projects/" });
    try {
      await readFile(path.join(dir, "patchcad.json"), "utf8");
    } catch {
      return reply.code(404).send({ error: "not a patchcad project (no patchcad.json)" });
    }
    if (dir !== active.dir) {
      active = await activateProject(dir);
      void runGlobalCheck();
    }
    return { ok: true, dir };
  });

  /** Apply a new contract to a node: recompute hash, diff, persist, dirty the
   * shape-affected descendants. Shared by the T2 editor and T3 accepts. */
  function applyContract(nid: string, next: Contract, cause: string) {
    const node = active.store.doc.nodes[nid]!;
    const after = { ...next, hash: "" };
    after.hash = contractHash(after);
    const diff = diffContract(node.contract, after);
    if (!diff.changed) {
      return { changed: false, shapeChanged: false, dirtied: [] as string[], notes: [] as string[] };
    }
    active.store.applyOp(
      (g) => {
        g.nodes[nid]!.contract = after;
      },
      { immediate: true },
    );
    // The edited node always re-cooks; descendants only along shape-changed ports.
    const dirtied = diff.shapeChanged
      ? [...computeDirtySet(active.store.doc, nid, diff.shapeChangedProvides)]
      : [];
    for (const id of [nid, ...dirtied]) {
      const n = active.store.doc.nodes[id]!;
      if (n.status === "ready") active.store.setStatus(id, "dirty");
    }
    bus.emit({
      type: "job:log",
      projectId: active.store.doc.id,
      nodeId: nid,
      line: `${cause} (${diff.notes.join("; ") || "value change"}) — ${1 + dirtied.length} node(s) dirty`,
    });
    return { changed: true, shapeChanged: diff.shapeChanged, dirtied, notes: diff.notes };
  }

  const RepromptBody = z.object({
    message: z.string().min(2),
    /** User override for the predicted tier ("escalate to architect" / "keep it local"). */
    tier: z.enum(["T2", "T3"]).optional(),
    /** Pictures for this node only: the generator (T2) or the architect (T3) sees them. */
    images: z.array(UploadedImage).max(4).default([]),
  });
  app.post("/api/project/nodes/:nodeId/reprompt", async (req, reply) => {
    if (!resolved) return reply.code(503).send({ error: NO_PROVIDER_HELP });
    const { nodeId: nid } = req.params as { nodeId: string };
    const body = RepromptBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const node = active.store.doc.nodes[nid];
    if (!node) return reply.code(404).send({ error: "unknown node" });

    // Tier routing: T2 = satisfiable within the pinned contract (regenerate
    // this node only), T3 = needs an interface change (architect renegotiates
    // the contract; nothing applies until the user accepts the proposal).
    const store = active.store;
    const routed = body.data.tier
      ? { tier: body.data.tier, reason: "user override" }
      : await classifyReprompt(
          metered(resolved.provider, (usage) => billLedger(store, "classifier", usage)),
          node,
          body.data.message,
          active.backend.planning.tierHints,
        );

    if (routed.tier === "T3") {
      try {
        const result = await renegotiateContract({
          provider: metered(resolved.provider, (usage) => billLedger(store, "renegotiate", usage)),
          backend: active.backend,
          graph: active.store.doc,
          nodeId: nid,
          message: body.data.message,
          images: body.data.images.map((i) => ({ mediaType: i.mediaType, dataB64: i.dataB64 })),
        });
        const preview = { ...result.contract, hash: "" };
        preview.hash = contractHash(preview);
        const diff = diffContract(node.contract, preview);
        if (diff.changed) {
          const dirtied = diff.shapeChanged
            ? [...computeDirtySet(active.store.doc, nid, diff.shapeChangedProvides)]
            : [];
          const proposal = {
            contract: result.contract,
            spec: result.spec,
            rationale: result.rationale,
            constraintsApplied: result.constraintsApplied,
            message: body.data.message,
            dirtied,
            notes: diff.notes,
          };
          pendingProposals.set(nid, proposal);
          bus.emit({
            type: "job:log",
            projectId: active.store.doc.id,
            nodeId: nid,
            line: `T3 proposal: ${result.rationale} — would dirty ${1 + dirtied.length} node(s), awaiting approval`,
          });
          return { ok: true, tier: "T3", reason: routed.reason, proposal: { nodeId: nid, ...proposal } };
        }
        // Architect concluded the pinned interface already supports the ask —
        // degrade to a plain T2 regeneration below.
      } catch (err) {
        console.warn(`[patchcad] renegotiation ${nid} failed, degrading to T2: ${(err as Error).message}`);
      }
    }

    // T2 — the breakout gesture: the message joins this node's local thread,
    // and ONLY this node re-cooks; its contract stays pinned, so neighbors
    // are untouchable by construction.
    checkpoint(`reprompt of ${nid}`);
    const refNames = await Promise.all(body.data.images.map((i) => saveThreadRef(active.dir, i)));
    active.store.applyOp((g) => {
      g.nodes[nid]!.thread.push({
        role: "user",
        content: body.data.message,
        at: Date.now(),
        ...(refNames.length ? { refs: refNames } : {}),
      });
    });
    void trackCook(active.dir, cookOne(
      cookDeps(resolved.provider),
      nid,
    ))
      .catch((err) => console.warn(`[patchcad] reprompt ${nid} failed: ${(err as Error).message}`))
      .finally(() => void runGlobalCheck());
    return { ok: true, tier: "T2", reason: routed.reason };
  });

  // ---------- T3: proposal approval ----------

  app.post("/api/project/nodes/:nodeId/proposal/accept", async (req, reply) => {
    if (!resolved) return reply.code(503).send({ error: NO_PROVIDER_HELP });
    const { nodeId: nid } = req.params as { nodeId: string };
    const node = active.store.doc.nodes[nid];
    if (!node) return reply.code(404).send({ error: "unknown node" });
    const proposal = pendingProposals.get(nid);
    if (!proposal) return reply.code(409).send({ error: "no pending proposal for this node" });
    pendingProposals.delete(nid);

    // The renegotiated spec + original ask travel with the node so the
    // generator re-cooks against the new interface with full intent.
    checkpoint(`T3 accept on ${nid}`);
    active.store.applyOp((g) => {
      const n = g.nodes[nid]!;
      n.spec = proposal.spec;
      n.thread.push({ role: "user", content: proposal.message, at: Date.now() });
    });
    const applied = applyContract(nid, proposal.contract, "T3 renegotiation accepted");
    const cooking = [nid, ...applied.dirtied];
    void trackCook(active.dir, cookNodes(
      cookDeps(resolved.provider),
      cooking,
    ))
      .then((summary) => {
        console.log(
          `[patchcad] T3 cook done: ${summary.succeeded.length} ok, ${summary.failed.length} failed`,
        );
      })
      .finally(() => void runGlobalCheck());
    return { ok: true, dirtied: applied.dirtied, cooking, notes: applied.notes };
  });

  app.delete("/api/project/nodes/:nodeId/proposal", async (req) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    pendingProposals.delete(nid);
    return { ok: true };
  });

  // ---------- T2: contract editing → dirty propagation ----------

  const ContractBody = z.object({ contract: Contract });
  app.put("/api/project/nodes/:nodeId/contract", async (req, reply) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    const node = active.store.doc.nodes[nid];
    if (!node) return reply.code(404).send({ error: "unknown node" });
    const body = ContractBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const payloadCheck = active.backend.planning.payloadSchema.safeParse(body.data.contract.payload);
    if (!payloadCheck.success) {
      return reply.code(400).send({ error: `invalid ${active.backend.id} payload: ${payloadCheck.error.message}` });
    }

    checkpoint(`contract edit on ${nid}`);
    const applied = applyContract(nid, body.data.contract, "contract updated");
    if (!applied.changed) dropCheckpoint(`contract edit on ${nid}`);
    return { ok: true, ...applied };
  });

  // ---------- Undo (op-log of user-initiated mutations) ----------

  app.post("/api/project/undo", async (_req, reply) => {
    const cooking = Object.values(active.store.doc.nodes).some((n) =>
      isCooking(n.status),
    );
    if (cooking) {
      return reply.code(409).send({ error: "a cook is in progress — undo after it settles" });
    }
    const top = active.undo.pop();
    if (!top) return reply.code(409).send({ error: "nothing to undo" });
    // A restored graph invalidates any proposal negotiated against the newer one.
    pendingProposals.clear();
    const restored = top.doc;
    // rev is a persistence stamp — keep it monotonic across the restore.
    restored.rev = Math.max(restored.rev, active.store.doc.rev);
    active.store.replace(restored);
    // Workspace modules follow the restored artifacts; Vite HMR swaps them.
    await active.backend.assemble(active.store.doc, active.workspace);
    emitUndoStack();
    void runGlobalCheck();
    bus.emit({
      type: "job:log",
      projectId: active.store.doc.id,
      nodeId: "",
      line: `undo: rolled back "${top.label}" (${active.undo.length} more)`,
    });
    return { ok: true, restored: top.label, depth: active.undo.length };
  });

  const CookDirtyBody = z.object({ inspect: z.boolean().optional() });
  app.post("/api/project/cook-dirty", async (req, reply) => {
    if (!resolved) return reply.code(503).send({ error: NO_PROVIDER_HELP });
    // Whether to look at each part is the SERVER's call, not the caller's,
    // because the server knows the backend. It used to default false here and
    // (after the approve path gained it) true there, so the same cook inspected
    // or didn't depending on which endpoint reached it — and the studio's
    // cookDirty() sends no body, so every re-cook a user triggered got the
    // no-look path. An explicit `inspect` in the body still overrides, for
    // scripts that want to opt out of the cost.
    const cookBody = CookDirtyBody.safeParse(req.body ?? {});
    // A malformed body used to fall through to the default, silently discarding
    // an explicit opt-out — the same "invalid input becomes a default" shape as
    // the disagreement this endpoint just stopped having.
    if (!cookBody.success) return reply.code(400).send({ error: "inspect must be a boolean" });
    const inspect = cookBody.data.inspect ?? defaultInspect();
    const stale = Object.values(active.store.doc.nodes)
      .filter((n) => ["planned", "dirty", "error_code", "error_contract", "cancelled"].includes(n.status))
      .map((n) => n.id);
    if (stale.length === 0) return { ok: true, cooking: [] };
    void trackCook(active.dir, cookNodes(
      cookDeps(resolved.provider, { inspect }),
      stale,
    )).then((summary) => {
      console.log(
        `[patchcad] dirty cook done: ${summary.succeeded.length} ok, ${summary.failed.length} failed`,
      );
    });
    return { ok: true, cooking: stale };
  });

  /**
   * Stop everything cooking on one project — the open one unless `projectId`
   * names another. Until now the only way to halt a cook that could not
   * possibly succeed — a contract the generator cannot satisfy, say — was to
   * kill the server process, which also took the preview and the studio's
   * connection with it.
   *
   * Aborting alone would strand nodes mid-status, so in-flight nodes are
   * settled to `cancelled`, which the status machine allows from every
   * in-flight state and which cook-dirty now picks up as resumable work. A
   * background project's store is out of reach; its aborted calls land those
   * nodes in `error_code`, which cook-dirty resumes just the same.
   *
   * Planning is not a cook and has its own stop: /plan/cancel.
   */
  const CancelBody = z.object({ projectId: z.string().optional() });
  app.post("/api/project/cook/cancel", async (req, reply) => {
    const body = CancelBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const projectId = body.data.projectId ?? active.store.doc.id;
    const ctl = cookAborts.get(projectId);
    const isActive = projectId === active.store.doc.id;
    const inFlight = isActive ? Object.values(active.store.doc.nodes).filter((n) => isCooking(n.status)) : [];
    const live = isActive ? liveCooks.has(active.dir) : !!ctl && !ctl.signal.aborted;
    if (inFlight.length === 0 && !live) {
      return reply.code(409).send({ error: "nothing is cooking" });
    }
    ctl?.abort();
    const cancelled: string[] = [];
    for (const n of inFlight) {
      try {
        active.store.setStatus(n.id, "cancelled");
        cancelled.push(n.id);
      } catch {
        // Raced with the cook's own write; the next status it sets is
        // illegal from `cancelled`, which ends that cookOne anyway.
      }
    }
    console.log(`[patchcad] cook cancelled on ${projectId}: ${cancelled.join(", ") || "(none in flight)"}`);
    return { ok: true, cancelled };
  });

  const RevertBody = z.object({ version: z.number().int().min(0) });
  app.post("/api/project/nodes/:nodeId/revert", async (req, reply) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    const body = RevertBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const node = active.store.doc.nodes[nid];
    if (!node) return reply.code(404).send({ error: "unknown node" });
    if (isCooking(node.status)) return reply.code(409).send({ error: `${nid} is cooking — cancel it before reverting` });
    const entry = node.history.find((h) => h.version === body.data.version);
    if (!entry) return reply.code(404).send({ error: `${nid} has no v${body.data.version}` });
    // Neighbors were built against the current contract; old code written to
    // another one would break them without dirtying anything.
    if (entry.contractHash !== node.contract.hash) {
      return reply.code(409).send({
        error: `v${body.data.version} was built against a different contract — reprompt instead of reverting across a contract change`,
      });
    }
    const file = codeFile(active.dir, nid, body.data.version, codeExt(active.store.doc.backend));
    let code: string;
    try {
      code = await readFile(file, "utf8");
    } catch {
      return reply.code(404).send({ error: `no stored code for v${body.data.version}` });
    }
    // The old code runs the gauntlet against today's graph and params before
    // anything is written, so a failure leaves the node exactly as it was.
    const candidate = {
      ...node,
      artifact: { code, testCode: node.artifact?.testCode ?? "", hash: hashValue(code) },
      version: body.data.version,
    };
    const exec = await active.backend.execute(candidate, active.workspace, active.store.doc);
    if (!exec.ok) return reply.code(422).send({ error: `v${body.data.version} fails ${exec.stage}: ${exec.report.slice(0, 400)}` });
    const verify = await active.backend.verify(candidate, active.store.doc, active.workspace);
    if (!verify.ok) return reply.code(422).send({ error: `v${body.data.version} fails ${verify.stage}: ${verify.report.slice(0, 400)}` });
    // A switch, undo, cook or contract edit during the gauntlet makes its verdict moot.
    if (active.store.doc.nodes[nid] !== node || isCooking(node.status) || node.contract.hash !== entry.contractHash) {
      return reply.code(409).send({ error: `${nid} changed while v${body.data.version} was being verified` });
    }
    checkpoint(`revert of ${nid} to v${body.data.version}`);
    active.store.applyOp(
      (g) => {
        const n = g.nodes[nid]!;
        n.artifact = candidate.artifact;
        n.version = body.data.version;
        n.measurements =
          verify.measurements == null
            ? null
            : { version: n.version, paramsHash: hashValue(n.params), data: verify.measurements };
      },
      { immediate: true },
    );
    if (active.store.doc.nodes[nid]!.status !== "ready") {
      for (const status of ["queued", "building", "verifying", "ready"] as const) active.store.setStatus(nid, status);
    }
    if (active.backend.id === codeBackend.id) await writeNodeModule(active.workspace, nid, code);
    bus.emit({
      type: "node:committed",
      projectId: active.store.doc.id,
      nodeId: nid,
      version: body.data.version,
    });
    void runGlobalCheck();
    return { ok: true };
  });

  app.get("/ws", { websocket: true }, (socket) => {
    const unsubscribe = bus.subscribe((event) => {
      socket.send(JSON.stringify(event));
    });
    socket.on("close", unsubscribe);
    // Initial snapshot so a late-joining client has the full graph.
    socket.send(
      JSON.stringify({
        type: "graph:replaced",
        projectId: active.store.doc.id,
        graph: active.store.doc,
      }),
    );
  });

  // A production studio build (`pnpm --filter @patchcad/studio build`) is served
  // at `/` beside the API, so one port is the whole app. Dev uses Vite instead.
  const studioDist = path.join(repoRoot, "apps", "studio", "dist");
  if (existsSync(path.join(studioDist, "index.html"))) {
    await app.register(fastifyStatic, { root: studioDist });
    console.log(`[patchcad] studio: serving ${studioDist}`);
  }

  await app.listen({ port: API_PORT, host: API_HOST });
  console.log(`[patchcad] api: http://127.0.0.1:${API_PORT} (host ${API_HOST})`);
}

function slugify(goal: string): string {
  const base = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return `${base || "project"}-${Date.now().toString(36)}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
