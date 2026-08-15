import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import chokidar, { type FSWatcher } from "chokidar";
import { z } from "zod";
import os from "node:os";
import { Contract, GraphDoc, hashValue, ParamValue } from "@patchcad/shared";
import {
  classifyReprompt,
  computeDirtySet,
  contractHash,
  cookNodes,
  GraphStore,
  cookOne,
  diffContract,
  EventBus,
  planGraph,
  renegotiateContract,
  type DomainBackend,
  type Workspace,
} from "@patchcad/engine";
import { CodeBackend, writeNodeModule } from "@patchcad/backend-code";
import { boundDependents, CadBackend, resolveParamBindings } from "@patchcad/backend-cad";
import { codeFile, loadProject, type LoadedProject } from "./project.js";
import { FileLibrary } from "./library.js";
import { NO_PROVIDER_HELP, resolveProvider } from "./providers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const API_PORT = Number(process.env.PATCHCAD_PORT ?? 4100);
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
const COOKING_STATUSES = ["queued", "generating", "building", "verifying", "repairing"];

async function main() {
  const bus = new EventBus();
  const codeBackend = new CodeBackend({ port: PREVIEW_PORT, fsAllow: [repoRoot] });
  const cadBackend = new CadBackend();
  // GraphDoc.backend routes each project to its domain backend.
  const backends: Record<string, DomainBackend<unknown>> = {
    [codeBackend.id]: codeBackend,
    [cadBackend.id]: cadBackend as DomainBackend<unknown>,
  };
  const library = new FileLibrary();

  let active!: ActiveProject;

  /** Dirs with a cook in flight IN THIS PROCESS: their in-flight statuses are
   * real, not restart orphans — activation must not normalize them. */
  const liveCooks = new Map<string, number>();
  function trackCook<T>(dir: string, run: Promise<T>): Promise<T> {
    liveCooks.set(dir, (liveCooks.get(dir) ?? 0) + 1);
    return run.finally(() => {
      const n = (liveCooks.get(dir) ?? 1) - 1;
      if (n <= 0) liveCooks.delete(dir);
      else liveCooks.set(dir, n);
    });
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
        if (COOKING_STATUSES.includes(n.status)) {
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
    const { url } = await backend.previewAdapter.start(project.store.doc, workspace);

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
      layout: {},
      rev: 0,
    });
    const store = new GraphStore(graph, bus, async () => {});
    const backend = codeBackend;
    const workspace: Workspace = { root: path.join(os.tmpdir(), "patchcad-untitled-preview") };
    await backend.assemble(graph, workspace);
    await backend.previewAdapter.start(graph, workspace);
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

  /** Web-code exposes a live Vite URL; CAD projects render in the studio's
   * viewport pane instead (no iframe). */
  function previewUrl(): string {
    const adapter = active.backend.previewAdapter as { url?: () => string };
    return adapter.url?.() ?? "";
  }

  async function runGlobalCheck() {
    const graph = active.store.doc;
    bus.emit({ type: "checker:status", projectId: graph.id, status: "checking", problems: [] });
    const check = await active.backend.globalCheck(graph, active.workspace);
    bus.emit({
      type: "checker:status",
      projectId: graph.id,
      status: check.ok ? "clean" : "failing",
      problems: check.problems,
    });
    if (!check.ok) console.log(`[patchcad] global check failing:\n  ${check.problems.join("\n  ")}`);
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

  // ---------- HTTP API ----------

  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 * 1024 });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.get("/api/health", async () => ({ ok: true }));

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

  const ParamsBody = z.object({ params: z.record(ParamValue) });
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
    if (active.backend.id === "cad") {
      const t1 = [nid, ...boundDependents(active.store.doc, nid)];
      void (async () => {
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
          const exec = await active.backend.execute(active.store.doc.nodes[id]!, active.workspace);
          bus.emit({
            type: "job:log",
            projectId: active.store.doc.id,
            nodeId: id,
            line: exec.ok
              ? `${id === nid ? "T0" : "T1"} re-executed (${exec.report}, 0 LLM calls)`
              : `${id === nid ? "T0" : "T1"} re-execute failed: ${exec.report.slice(0, 160)}`,
          });
        }
        bus.emit({ type: "preview:reload", projectId: active.store.doc.id });
      })();
    }
    return { ok: true };
  });

  // ---------- CAD scene (viewport data) ----------

  app.get("/api/project/cad-scene", async (_req, reply) => {
    if (active.backend.id !== "cad") return reply.code(409).send({ error: "active project is not a CAD graph" });
    const cad = active.backend as CadBackend;
    const { scene, problems } = cad.solveScene(active.store.doc);
    // Resolve each cooked node's mesh URL via the kernel's content-addressed
    // cache (instant for anything already executed this session).
    const meshes: Record<string, { glb: string; status: string; printability?: unknown }> = {};
    for (const node of Object.values(active.store.doc.nodes)) {
      if (!node.artifact?.code) continue;
      const params: Record<string, unknown> = {};
      for (const p of node.contract.params) params[p.name] = p.default;
      Object.assign(params, node.params);
      const result = await cad.kernel.execute(node.artifact.code, params, {
        importDir: path.join(active.dir, "imports"),
      });
      if (result.ok) {
        meshes[node.id] = {
          glb: cad.kernel.glbUrl(result.glb),
          status: node.status,
          printability: (result.measurements as { printability?: unknown }).printability,
        };
      }
    }
    return { scene, meshes, problems };
  });

  // ---------- Planning + cooking ----------

  let pendingPlan: { graph: GraphDoc; rationale: string; goal: string } | null = null;

  const PlanBody = z.object({
    goal: z.string().min(4),
    /** Which domain plans this goal: web app or printed parts. */
    backend: z.enum(["web-code", "cad"]).default("web-code"),
  });
  app.post("/api/project/plan", async (req, reply) => {
    if (!resolved) return reply.code(503).send({ error: NO_PROVIDER_HELP });
    const body = PlanBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    try {
      const slug = slugify(body.data.goal);
      const result = await planGraph({
        provider: resolved.provider,
        backend: backends[body.data.backend]!,
        projectId: slug,
        goal: body.data.goal,
      });
      pendingPlan = { graph: result.graph, rationale: result.rationale, goal: body.data.goal };
      return {
        plan: result.graph,
        rationale: result.rationale,
        usage: result.usage,
        repaired: result.repaired,
      };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.post("/api/project/plan/approve", async (_req, reply) => {
    if (!resolved) return reply.code(503).send({ error: NO_PROVIDER_HELP });
    if (!pendingPlan) return reply.code(409).send({ error: "no pending plan" });
    const approved = pendingPlan;
    pendingPlan = null;

    // Every approved plan gets its OWN project directory — the loaded project
    // is never clobbered.
    const dir = path.join(projectsRoot, approved.graph.id);
    await mkdir(path.join(dir, "nodes"), { recursive: true });
    await writeFile(path.join(dir, "patchcad.json"), JSON.stringify(approved.graph, null, 2), "utf8");
    active = await activateProject(dir);

    void trackCook(dir, cookNodes(
      { store: active.store, backend: active.backend, provider: resolved.provider, workspace: active.workspace, library },
      Object.keys(active.store.doc.nodes),
    )).then((summary) => {
      console.log(
        `[patchcad] cook done: ${summary.succeeded.length} ok, ${summary.failed.length} failed`,
      );
    });
    return { ok: true, dir };
  });

  app.delete("/api/project/plan", async () => {
    pendingPlan = null;
    return { ok: true };
  });

  // ---------- imported-piece node builder (shared by import + segment) ----------

  type ImportResultShape = {
    pieces: { index: number; file: string; volume_mm3: number; watertight: boolean; bbox: { min: number[]; max: number[] }; faces: number }[];
    interfaces: { piece_a: number; piece_b: number; origin: number[]; normal: number[]; holes: { center: number[]; diameter: number }[]; pegs?: { center: number[]; peg_diameter: number; socket_diameter: number; length: number }[]; face_size?: number }[];
  };

  /** Kernel pieces + interfaces → graph nodes and mate edges. Cut faces are
   * FLAT_FACE mating ports; holes/pegs get probed ports; every dimension
   * scale-tracks via T1 expressions; pieces share one scale via bindings. */
  function buildImportedNodes(
    result: ImportResultShape,
    displayName: string,
    idFor: (index: number) => string,
  ): { nodes: Record<string, unknown>; edges: { id: string; from: string; fromPort: string; to: string; toPort: string }[] } {
    const rootId = idFor(result.pieces[0]!.index);
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
            process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
            ports,
            envelope: {
              volumes: [
                {
                  kind: "box",
                  pose: {
                    origin: piece.bbox.min.map((v, i) => {
                      const c = (v + piece.bbox.max[i]!) / 2;
                      return c === 0 ? 0 : `expr: ${c} * param(${id}.scale)`;
                    }),
                    zAxis: [0, 0, 1],
                    xAxis: [1, 0, 0],
                  },
                  dims: piece.bbox.max.map(
                    (v, i) => `expr: ${Math.max(v - piece.bbox.min[i]!, 0.1)} * param(${id}.scale)`,
                  ),
                },
              ],
              clearance: 0.4,
            },
            paramBindings: id === rootId ? {} : { scale: `param:${rootId}.scale` },
          },
          hash: "",
        },
        pinned: false,
        params: {},
        deps: [],
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
    return { nodes, edges };
  }

  // ---------- CAD file import: STL/STEP/3MF → node graph ----------

  const ImportReq = z.object({
    name: z.string().min(1),
    dataB64: z.string().min(8),
    /** 0 = auto (cut at natural necks/bulges); 1 = keep whole; >1 = equal slabs. */
    pieces: z.number().int().min(0).max(8).default(0),
    /** Joint type at each cut: screw holes or clearance-fit alignment pegs. */
    joints: z.enum(["none", "holes", "pegs"]).default("none"),
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

    const built = buildImportedNodes(result as ImportResultShape, name, (i) => `piece-${i}`);
    for (const piece of result.pieces) {
      await copyFile(path.join(result.dir, piece.file), path.join(importsDir, `piece-${piece.index}.ply`));
    }
    const nodes = built.nodes;

    const graph = {
      schemaVersion: 1,
      id: path.basename(dir),
      backend: "cad",
      brief: { goal: `imported ${name}`, constraints: [], clarifications: [] },
      nodes,
      edges: built.edges,
      assembly: { entryNodeId: "piece-0" },
      layout: {},
      rev: 0,
    };
    await writeFile(path.join(dir, "patchcad.json"), JSON.stringify(graph, null, 2), "utf8");
    active = await activateProject(dir);

    // Pieces cook deterministically (mesh loader code, full gates, zero LLM).
    void trackCook(dir, cookNodes(
      { store: active.store, backend: active.backend, provider: resolved?.provider ?? nullProvider, workspace: active.workspace, library },
      Object.keys(active.store.doc.nodes),
    )).then((summary) => {
      console.log(`[patchcad] import cook: ${summary.succeeded.length} ok, ${summary.failed.length} failed`);
    });
    return { ok: true, dir, pieces: result.pieces.length, interfaces: result.interfaces.length };
  });

  // ---------- per-node smart segmentation ----------

  const SegmentReq = z.object({
    joints: z.enum(["none", "holes", "pegs"]).default("pegs"),
    thread: z.enum(["M3", "M4", "M5"]).default("M4"),
    /** 0 = natural necks/bulges; >1 = equal slabs. */
    pieces: z.number().int().min(0).max(8).default(0),
  });
  app.post("/api/project/nodes/:nodeId/segment", async (req, reply) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    const node = active.store.doc.nodes[nid];
    if (!node) return reply.code(404).send({ error: "unknown node" });
    if (node.kind !== "imported") {
      return reply.code(409).send({ error: "only imported mesh nodes can be split (for now)" });
    }
    // Splitting a jointed piece is allowed: its external mates are inherited —
    // each old port lands on whichever sub-piece geometrically contains it and
    // the edges rewire there (see below).
    const touchingEdges = active.store.doc.edges.filter((e) => e.from === nid || e.to === nid);
    const body = SegmentReq.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.message });

    const importsDir = path.join(active.dir, "imports");
    let meshB64: string;
    try {
      meshB64 = (await readFile(path.join(importsDir, `${nid}.ply`))).toString("base64");
    } catch {
      return reply.code(409).send({ error: "no stored mesh for this node" });
    }
    const result = await cadBackend.kernel.importFile(`${nid}.ply`, meshB64, {
      pieces: body.data.pieces,
      joints: body.data.joints,
      thread: body.data.thread,
    });
    if (!result.ok) return reply.code(422).send({ error: `${result.stage}: ${result.error}` });
    if (result.pieces.length <= 1) {
      return { ok: true, pieces: 1, message: "no natural pieces found — the shape has no convincing necks or bulges" };
    }

    checkpoint(`split of ${nid}`);
    const hashesBefore = new Map(Object.entries(active.store.doc.nodes).map(([id, n]) => [id, n.contract.hash]));
    const idFor = (i: number) => `${nid}-p${i + 1}`;
    const built = buildImportedNodes(result as ImportResultShape, node.title, idFor);
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
    const oldPayload = node.contract.payload as { ports?: PortShape[]; paramBindings?: Record<string, string> } | undefined;
    const oldProvides = new Set((node.contract.provides ?? []).map((prov) => prov.key));
    const neighborIds = touchingEdges.map((e) => (e.from === nid ? e.to : e.from));
    const externalPorts = (oldPayload?.ports ?? []).filter((port) =>
      neighborIds.some((other) => port.name === `joint_${other}` || port.name.startsWith(`joint_${other}_`)),
    );
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
      if (port.type === "FLAT_FACE") {
        edgeRewire.set(port.name, subId);
        (oldProvides.has(port.name) ? sub.contract.provides : sub.contract.requires).push({
          key: port.name,
          type: "FLAT_FACE",
          description: "cut interface (inherited)",
        });
      }
    }

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
        delete g.nodes[nid];
        Object.assign(g.nodes, built.nodes as never);
        g.edges.push(...(built.edges as unknown as typeof g.edges));
        for (const e of g.edges) {
          if (e.from === nid) e.from = edgeRewire.get(e.fromPort) ?? newIds[0]!;
          if (e.to === nid) e.to = edgeRewire.get(e.toPort) ?? newIds[0]!;
        }
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
    bus.emit({ type: "graph:replaced", projectId: active.store.doc.id, graph: active.store.doc });
    void trackCook(active.dir, cookNodes(
      { store: active.store, backend: active.backend, provider: resolved?.provider ?? nullProvider, workspace: active.workspace, library },
      [...newIds, ...rippled],
    )).then((summary) => {
      console.log(`[patchcad] split cook: ${summary.succeeded.length} ok, ${summary.failed.length} failed`);
    });
    return { ok: true, pieces: result.pieces.length, nodeIds: newIds };
  });

  // ---------- Project switcher ----------

  app.get("/api/projects", async () => {
    const roots = [path.join(repoRoot, "examples"), projectsRoot];
    const projects: Array<{ dir: string; name: string; goal: string; nodes: number }> = [];
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
          const raw = JSON.parse(await readFile(path.join(dir, "patchcad.json"), "utf8")) as GraphDoc;
          projects.push({
            dir,
            name: entry.name,
            goal: raw.brief?.goal ?? "",
            nodes: Object.keys(raw.nodes ?? {}).length,
          });
        } catch {
          // not a patchcad project — skip
        }
      }
    }
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
    const routed = body.data.tier
      ? { tier: body.data.tier, reason: "user override" }
      : await classifyReprompt(resolved.provider, node, body.data.message);

    if (routed.tier === "T3") {
      try {
        const result = await renegotiateContract({
          provider: resolved.provider,
          backend: active.backend,
          graph: active.store.doc,
          nodeId: nid,
          message: body.data.message,
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
    active.store.applyOp((g) => {
      g.nodes[nid]!.thread.push({ role: "user", content: body.data.message, at: Date.now() });
    });
    void trackCook(active.dir, cookOne(
      { store: active.store, backend: active.backend, provider: resolved.provider, workspace: active.workspace, library },
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
      { store: active.store, backend: active.backend, provider: resolved.provider, workspace: active.workspace, library },
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
      COOKING_STATUSES.includes(n.status),
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

  app.post("/api/project/cook-dirty", async (_req, reply) => {
    if (!resolved) return reply.code(503).send({ error: NO_PROVIDER_HELP });
    const stale = Object.values(active.store.doc.nodes)
      .filter((n) => ["planned", "dirty", "error_code", "error_contract"].includes(n.status))
      .map((n) => n.id);
    if (stale.length === 0) return { ok: true, cooking: [] };
    void trackCook(active.dir, cookNodes(
      { store: active.store, backend: active.backend, provider: resolved.provider, workspace: active.workspace, library },
      stale,
    )).then((summary) => {
      console.log(
        `[patchcad] dirty cook done: ${summary.succeeded.length} ok, ${summary.failed.length} failed`,
      );
    });
    return { ok: true, cooking: stale };
  });

  const RevertBody = z.object({ version: z.number().int().min(0) });
  app.post("/api/project/nodes/:nodeId/revert", async (req, reply) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    const body = RevertBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const node = active.store.doc.nodes[nid];
    if (!node) return reply.code(404).send({ error: "unknown node" });
    const file = codeFile(active.dir, nid, body.data.version);
    let code: string;
    try {
      code = await readFile(file, "utf8");
    } catch {
      return reply.code(404).send({ error: `no stored code for v${body.data.version}` });
    }
    checkpoint(`revert of ${nid} to v${body.data.version}`);
    active.store.applyOp(
      (g) => {
        const n = g.nodes[nid]!;
        n.artifact = { code, testCode: n.artifact?.testCode ?? "", hash: hashValue(code) };
        n.version = body.data.version;
      },
      { immediate: true },
    );
    // Contracts are pinned across versions, so a revert never dirties
    // descendants — it only swaps the artifact.
    if (active.store.doc.nodes[nid]!.status !== "ready") {
      active.store.setStatus(nid, "queued");
      active.store.setStatus(nid, "building");
      active.store.setStatus(nid, "verifying");
      active.store.setStatus(nid, "ready");
    }
    await writeNodeModule(active.workspace, nid, code);
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

  await app.listen({ port: API_PORT, host: "127.0.0.1" });
  console.log(`[patchcad] api: http://localhost:${API_PORT}`);
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
