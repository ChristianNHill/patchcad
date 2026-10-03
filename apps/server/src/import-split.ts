import path from "node:path";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { cookNodes, reexpandGraph, type LlmProvider } from "@patchcad/engine";
import { importJoints, isMeshNode, jointVar, oversizeMeshSplit, resolvePose, type CadContractPayload, type CadJoint, type ImportResult } from "@patchcad/backend-cad";
import { slugify } from "./project.js";
import { addCost } from "./spend.js";
import type { ActiveProject, Session } from "./session.js";

/** Import cooks are fully deterministic; if no LLM is configured they must
 * still run — this provider throws if anything ever reaches it. */
const nullProvider: LlmProvider = {
  id: "none",
  complete: () => {
    throw new Error("no LLM provider configured");
  },
};

type PieceProcess = { process: CadContractPayload["process"]; sourcing?: CadContractPayload["sourcing"] };
const FDM_PIECE: PieceProcess = { process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 } };

/** Kernel pieces + interfaces → graph nodes, mate edges and joints. Cut
 * faces are FLAT_FACE mating ports; holes/pegs get probed ports; in joint
 * mode "auto" each cut becomes a declared joint (importJoints) whose hardware
 * the expansion mints afterwards. Every dimension scale-tracks via T1
 * expressions; pieces share one scale via bindings. */
export function buildImportedNodes(
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

const SegmentReq = z.object({
  joints: JointMode.default("auto"),
  thread: z.enum(["M3", "M4", "M5"]).default("M4"),
  /** 0 = natural necks/bulges; >1 = equal slabs. */
  pieces: z.number().int().min(0).max(8).default(0),
});

/** CAD file import (STL/STEP/3MF → node graph) and per-node segmentation. */
export function registerImportSplit(app: FastifyInstance, s: Session): void {
  /** Mint the hardware of joints just written into the live graph (import,
   * split): the expansion a joint edit runs, under the caller's undo step.
   * Returns every node that now needs a cook. */
  function expandImportJoints(project: ActiveProject, notes: string[]): string[] {
    const { store } = project;
    for (const line of notes) s.bus.emit({ type: "job:log", projectId: store.doc.id, nodeId: "joints", line });
    const r = reexpandGraph(store.doc, project.backend);
    if (!r) return [];
    store.replace(r.graph);
    for (const id of r.dirty) if (store.doc.nodes[id]?.status === "ready") store.setStatus(id, "dirty");
    return [...r.added, ...r.dirty];
  }


  app.post("/api/project/import", async (req, reply) => {
    const body = ImportReq.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const { name, dataB64, pieces, joints, thread } = body.data;

    const result = await s.cadBackend.kernel.importFile(name, dataB64, { pieces, joints, thread });
    if (!result.ok) return reply.code(422).send({ error: `${result.stage}: ${result.error}` });

    // A new project per import, like plan approval — never clobbers the open one.
    const dir = path.join(s.projectsRoot, slugify(`import ${name.replace(/\.[^.]+$/, "")}`));
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
    const project = await s.activate(dir);
    expandImportJoints(project, built.notes);

    // Pieces cook deterministically (mesh loader + joint cuts, full gates) and
    // the joint hardware from the registry: zero LLM.
    void s.trackCook(project, cookNodes(
      s.cookDeps(project, s.resolved?.provider ?? nullProvider),
      Object.keys(project.store.doc.nodes),
    )).then((summary) => {
      console.log(`[patchcad] import cook: ${summary.succeeded.length} ok, ${summary.failed.length} failed`);
    });
    return { ok: true, dir, pieces: result.pieces.length, interfaces: result.interfaces.length, joints: built.joints.length, notes: built.notes };
  });


  app.post("/api/project/nodes/:nodeId/segment", async (req, reply) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    const body = SegmentReq.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const project = s.active;
    if (s.liveCooks.has(project.dir)) return reply.code(409).send({ error: "wait for the cook to finish" });
    const r = await splitNode(project, nid, body.data);
    return "code" in r ? reply.code(r.code).send({ error: r.error }) : r;
  });

  /**
   * Split one mesh node (imported, or a generated mesh) into pieces, in place:
   * the sub-pieces inherit its external mates and joints, the cuts become
   * joints of their own, and the expansion mints their hardware. One undo step.
   */
  async function splitNode(
    project: ActiveProject,
    nid: string,
    opts: z.infer<typeof SegmentReq>,
  ): Promise<{ code: number; error: string } | { ok: true; pieces: number; nodeIds?: string[]; message?: string; notes?: string[] }> {
    const { store } = project;
    const node = store.doc.nodes[nid];
    if (!node) return { code: 404, error: "unknown node" };
    if (node.kind !== "imported" && !isMeshNode(node)) {
      return { code: 409, error: "only imported or generated mesh nodes can be split (for now)" };
    }
    // Splitting a jointed piece is allowed: its external mates are inherited —
    // each old port lands on whichever sub-piece geometrically contains it and
    // the edges rewire there (see below).
    const touchingEdges = store.doc.edges.filter((e) => e.from === nid || e.to === nid);

    const importsDir = path.join(project.dir, "imports");
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
          return [resolvePose(store.doc, p.pose).origin.map((v) => v / scaleNow)];
        } catch {
          return [];
        }
      });
    const result = await s.cadBackend.kernel.importFile(`${nid}.ply`, meshB64, {
      pieces: opts.pieces,
      joints: opts.joints,
      thread: opts.thread,
      avoid,
    });
    if (!result.ok) return { code: 422, error: `${result.stage}: ${result.error}` };
    if (result.pieces.length <= 1) {
      return { ok: true, pieces: 1, message: "no natural pieces found — the shape has no convincing necks or bulges" };
    }

    // The graph this split was computed against must still be the live one.
    if (s.active !== project || store.doc.nodes[nid] !== node || s.liveCooks.has(project.dir)) {
      return { code: 409, error: `${nid} changed while it was being split — try again` };
    }
    s.checkpoint(project, `split of ${nid}`);
    const hashesBefore = new Map(Object.entries(store.doc.nodes).map(([id, n]) => [id, n.contract.hash]));
    const idFor = (i: number) => `${nid}-p${i + 1}`;
    const oldPayload = node.contract.payload as CadContractPayload & { paramBindings?: Record<string, string> };
    const built = buildImportedNodes(result, node.title, idFor, {
      process: oldPayload.process,
      sourcing: oldPayload.sourcing,
      thread: opts.thread,
      taken: store.doc.joints.map((j) => j.id),
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
    const touchingJoints = store.doc.joints.filter((j) => j.a.node === nid || j.b.node === nid);
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

    store.applyOp(
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
    store.recomputeAllContractHashes();
    // A root rewrite ripples other nodes' contracts (scale refs) — any node
    // whose hash moved must re-cook, or a cook in flight for it is superseded
    // and would strand mid-status.
    const rippled = Object.entries(store.doc.nodes)
      .filter(([id, n]) => !newIds.includes(id) && hashesBefore.has(id) && hashesBefore.get(id) !== n.contract.hash)
      .map(([id]) => id);
    const expanded = expandImportJoints(project, built.notes);
    s.bus.emit({ type: "graph:replaced", projectId: store.doc.id, graph: store.doc });
    void s.trackCook(project, cookNodes(
      s.cookDeps(project, s.resolved?.provider ?? nullProvider),
      [...new Set([...newIds, ...rippled, ...expanded])].filter((id) => store.doc.nodes[id]),
    )).then((summary) => {
      console.log(`[patchcad] split cook: ${summary.succeeded.length} ok, ${summary.failed.length} failed`);
    });
    return { ok: true, pieces: result.pieces.length, nodeIds: newIds, notes: built.notes };
  }

  /** A generated mesh bigger than its printer's build volume becomes several
   * imported pieces joined by real hardware: the split a user can ask for on
   * any mesh node, run once the wave that fitted it has settled (graph surgery
   * never runs under a live cook). */
  async function splitOversizeMeshes(project: ActiveProject) {
    if (project.backend.id !== "cad") return;
    for (const node of Object.values(project.store.doc.nodes)) {
      const pieces = await oversizeMeshSplit(project.dir, node);
      if (!pieces || s.active !== project || s.liveCooks.has(project.dir)) continue;
      const r = await splitNode(project, node.id, { joints: "auto", thread: "M4", pieces });
      const line = "code" in r ? `build-volume split of ${node.id} failed: ${r.error}` : `${node.id} exceeds the build volume: split into ${r.pieces} jointed pieces`;
      s.bus.emit({ type: "job:log", projectId: project.store.doc.id, nodeId: node.id, line });
    }
  }

  // A wave that fitted an oversized generated mesh leaves it to split.
  s.onCooksSettled = (project) => void splitOversizeMeshes(project);
}
