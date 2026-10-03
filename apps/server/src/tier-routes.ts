import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Contract, hashValue, isCooking } from "@patchcad/shared";
import {
  classifyReprompt,
  computeDirtySet,
  contractHash,
  cookNodes,
  cookOne,
  diffContract,
  renegotiateContract,
} from "@patchcad/engine";
import { writeNodeModule } from "@patchcad/backend-code";
import { codeExt, codeFile } from "./project.js";
import { saveThreadRef, UploadedImage } from "./refs.js";
import { addCost, metered } from "./spend.js";
import type { ActiveProject, Session } from "./session.js";
import type { T0 } from "./t0.js";

const HiddenBody = z.object({ hidden: z.boolean() });
const RepromptBody = z.object({
  message: z.string().min(2),
  /** User override for the predicted tier ("escalate to architect" / "keep it local"). */
  tier: z.enum(["T2", "T3"]).optional(),
  /** Pictures for this node only: the generator (T2) or the architect (T3) sees them. */
  images: z.array(UploadedImage).max(4).default([]),
});
const ContractBody = z.object({ contract: Contract });
const RevertBody = z.object({ version: z.number().int().min(0) });

/** Per-node edits: visibility, removal, T2/T3 reprompts, contract edits,
 *  revert, and undo of all of them. */
export function registerTierRoutes(app: FastifyInstance, s: Session, t0: T0): void {
  const { bus } = s;

  /** Apply a new contract to a node: recompute hash, diff, persist, dirty the
   * shape-affected descendants. Shared by the T2 editor and T3 accepts. */
  function applyContract(project: ActiveProject, nid: string, next: Contract, cause: string) {
    const { store } = project;
    const node = store.doc.nodes[nid]!;
    const after = { ...next, hash: "" };
    after.hash = contractHash(after);
    const diff = diffContract(node.contract, after, project.backend.planning.advisoryPayloadKeys);
    if (!diff.changed) {
      return { changed: false, shapeChanged: false, dirtied: [] as string[], notes: [] as string[] };
    }
    store.applyOp(
      (g) => {
        g.nodes[nid]!.contract = after;
      },
      { immediate: true },
    );
    // The edited node always re-cooks; descendants only along shape-changed ports.
    const dirtied = diff.shapeChanged
      ? [...computeDirtySet(store.doc, nid, diff.shapeChangedProvides)]
      : [];
    for (const id of [nid, ...dirtied]) {
      const n = store.doc.nodes[id]!;
      if (n.status === "ready") store.setStatus(id, "dirty");
    }
    bus.emit({
      type: "job:log",
      projectId: store.doc.id,
      nodeId: nid,
      line: `${cause} (${diff.notes.join("; ") || "value change"}) — ${1 + dirtied.length} node(s) dirty`,
    });
    return { changed: true, shapeChanged: diff.shapeChanged, dirtied, notes: diff.notes };
  }

  /** A finished reprompt or T3 wave re-judges the assembly, unless the user
   *  has moved to another project since. */
  const checkIfActive = (project: ActiveProject) => {
    if (s.active === project) void s.runGlobalCheck(project);
  };

  app.get("/api/project/nodes/:nodeId/code", async (req, reply) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    const node = s.active.store.doc.nodes[nid];
    if (!node) return reply.code(404).send({ error: "unknown node" });
    return { code: node.artifact?.code ?? "", version: node.version };
  });

  /**
   * Exclude a part from export and from the rendered scene without deleting it.
   * Deliberately NOT a contract change: no hash moves, nothing goes dirty, no
   * cook runs. The assembly solve still sees the node, so hiding a base plate
   * leaves everything mated to it exactly where it was.
   */
  app.post("/api/project/nodes/:nodeId/hidden", async (req, reply) => {
    const project = s.active;
    const { store } = project;
    const { nodeId: nid } = req.params as { nodeId: string };
    const body = HiddenBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    if (!store.doc.nodes[nid]) return reply.code(404).send({ error: "unknown node" });
    s.checkpoint(project, `${body.data.hidden ? "hide" : "show"} ${nid}`);
    store.applyOp((g) => {
      g.nodes[nid]!.hidden = body.data.hidden;
    });
    bus.emit({ type: "graph:replaced", projectId: store.doc.id, graph: store.doc });
    bus.emit({ type: "preview:reload", projectId: store.doc.id });
    return { ok: true, hidden: body.data.hidden };
  });

  /**
   * Remove a node. The same surgery the split path does, minus the pieces:
   * drop its edges, hand the entry role on if it held it, and mark every
   * downstream consumer stale — a node whose `requires` port lost its provider
   * cannot cook, and should say so through the normal re-cook flow rather than
   * failing mysteriously later.
   */
  app.delete("/api/project/nodes/:nodeId", async (req, reply) => {
    const project = s.active;
    const { store } = project;
    const { nodeId: nid } = req.params as { nodeId: string };
    const doc = store.doc;
    if (!doc.nodes[nid]) return reply.code(404).send({ error: "unknown node" });
    if (s.liveCooks.has(project.dir)) return reply.code(409).send({ error: "wait for the cook to finish" });

    // Everything downstream, before the edges go. Deleting a node invalidates
    // every port it provided, so the dirty set is the one computed from all of
    // its outgoing ports.
    const downstream = computeDirtySet(
      doc,
      nid,
      doc.edges.filter((e) => e.from === nid).map((e) => e.fromPort),
    );

    s.checkpoint(project, `delete ${nid}`);
    store.applyOp(
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
      const n = store.doc.nodes[id];
      if (n && n.status === "ready") store.setStatus(id, "dirty");
    }
    bus.emit({ type: "graph:replaced", projectId: store.doc.id, graph: store.doc });
    bus.emit({ type: "preview:reload", projectId: store.doc.id });
    bus.emit({
      type: "job:log",
      projectId: store.doc.id,
      nodeId: nid,
      line: `deleted — ${downstream.size} downstream node(s) now stale`,
    });
    return { ok: true };
  });

  app.post("/api/project/nodes/:nodeId/reprompt", async (req, reply) => {
    const blocked = s.spendBlocked();
    if (blocked || !s.resolved) return reply.code(503).send({ error: blocked });
    const { provider } = s.resolved;
    const project = s.active;
    const { store } = project;
    const { nodeId: nid } = req.params as { nodeId: string };
    const body = RepromptBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const node = store.doc.nodes[nid];
    if (!node) return reply.code(404).send({ error: "unknown node" });
    if (isCooking(node.status)) return reply.code(409).send({ error: `${nid} is already cooking — wait or cancel first` });

    // Tier routing: T2 = satisfiable within the pinned contract (regenerate
    // this node only), T3 = needs an interface change (architect renegotiates
    // the contract; nothing applies until the user accepts the proposal).
    const routed = body.data.tier
      ? { tier: body.data.tier, reason: "user override" }
      : await classifyReprompt(
          metered(provider, (usage) => s.billLedger(store, "classifier", usage)),
          node,
          body.data.message,
          project.backend.planning.tierHints,
        );
    if (s.active !== project) return reply.code(409).send({ error: "the project changed while the reprompt was routed" });

    if (routed.tier === "T3") {
      try {
        const result = await renegotiateContract({
          provider: metered(provider, (usage) => s.billLedger(store, "renegotiate", usage)),
          backend: project.backend,
          graph: store.doc,
          nodeId: nid,
          message: body.data.message,
          images: body.data.images.map((i) => ({ mediaType: i.mediaType, dataB64: i.dataB64 })),
        });
        if (s.active !== project) return reply.code(409).send({ error: "the project changed while the contract was renegotiated" });
        const preview = { ...result.contract, hash: "" };
        preview.hash = contractHash(preview);
        const diff = diffContract(node.contract, preview, project.backend.planning.advisoryPayloadKeys);
        if (diff.changed) {
          const dirtied = diff.shapeChanged
            ? [...computeDirtySet(store.doc, nid, diff.shapeChangedProvides)]
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
          s.pendingProposals.set(nid, proposal);
          bus.emit({
            type: "job:log",
            projectId: store.doc.id,
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
    const now = store.doc.nodes[nid];
    if (!now) return reply.code(404).send({ error: "unknown node" });
    if (isCooking(now.status)) return reply.code(409).send({ error: `${nid} is already cooking — wait or cancel first` });
    s.checkpoint(project, `reprompt of ${nid}`);
    const refNames = await Promise.all(body.data.images.map((i) => saveThreadRef(project.dir, i)));
    store.applyOp((g) => {
      g.nodes[nid]!.thread.push({
        role: "user",
        content: body.data.message,
        at: Date.now(),
        ...(refNames.length ? { refs: refNames } : {}),
      });
    });
    void s.trackCook(project, cookOne(
      s.cookDeps(project, provider),
      nid,
    ))
      .catch((err) => console.warn(`[patchcad] reprompt ${nid} failed: ${(err as Error).message}`))
      .finally(() => checkIfActive(project));
    return { ok: true, tier: "T2", reason: routed.reason };
  });

  // ---------- T3: proposal approval ----------

  app.post("/api/project/nodes/:nodeId/proposal/accept", async (req, reply) => {
    const blocked = s.spendBlocked();
    if (blocked || !s.resolved) return reply.code(503).send({ error: blocked });
    const project = s.active;
    const { store } = project;
    const { nodeId: nid } = req.params as { nodeId: string };
    const node = store.doc.nodes[nid];
    if (!node) return reply.code(404).send({ error: "unknown node" });
    const proposal = s.pendingProposals.get(nid);
    if (!proposal) return reply.code(409).send({ error: "no pending proposal for this node" });
    if (isCooking(node.status) || s.liveCooks.has(project.dir)) {
      return reply.code(409).send({ error: "wait for the cook to finish" });
    }
    s.pendingProposals.delete(nid);

    // The renegotiated spec + original ask travel with the node so the
    // generator re-cooks against the new interface with full intent.
    s.checkpoint(project, `T3 accept on ${nid}`);
    store.applyOp((g) => {
      const n = g.nodes[nid]!;
      n.spec = proposal.spec;
      n.thread.push({ role: "user", content: proposal.message, at: Date.now() });
    });
    const applied = applyContract(project, nid, proposal.contract, "T3 renegotiation accepted");
    const cooking = [nid, ...applied.dirtied];
    void s.trackCook(project, cookNodes(
      s.cookDeps(project, s.resolved.provider),
      cooking,
    ))
      .then((summary) => {
        console.log(
          `[patchcad] T3 cook done: ${summary.succeeded.length} ok, ${summary.failed.length} failed`,
        );
      })
      .finally(() => checkIfActive(project));
    return { ok: true, dirtied: applied.dirtied, cooking, notes: applied.notes };
  });

  app.delete("/api/project/nodes/:nodeId/proposal", async (req) => {
    const { nodeId: nid } = req.params as { nodeId: string };
    s.pendingProposals.delete(nid);
    return { ok: true };
  });

  // ---------- T2: contract editing → dirty propagation ----------

  app.put("/api/project/nodes/:nodeId/contract", async (req, reply) => {
    const project = s.active;
    const { nodeId: nid } = req.params as { nodeId: string };
    const node = project.store.doc.nodes[nid];
    if (!node) return reply.code(404).send({ error: "unknown node" });
    if (s.liveCooks.has(project.dir)) return reply.code(409).send({ error: "wait for the cook to finish" });
    const body = ContractBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const payloadCheck = project.backend.planning.payloadSchema.safeParse(body.data.contract.payload);
    if (!payloadCheck.success) {
      return reply.code(400).send({ error: `invalid ${project.backend.id} payload: ${payloadCheck.error.message}` });
    }

    s.checkpoint(project, `contract edit on ${nid}`);
    const applied = applyContract(project, nid, body.data.contract, "contract updated");
    if (!applied.changed) s.dropCheckpoint(project, `contract edit on ${nid}`);
    return { ok: true, ...applied };
  });

  // ---------- Undo (op-log of user-initiated mutations) ----------

  app.post("/api/project/undo", async (_req, reply) => {
    const project = s.active;
    const { store } = project;
    const cooking = s.liveCooks.has(project.dir) || Object.values(store.doc.nodes).some((n) => isCooking(n.status));
    if (cooking) {
      return reply.code(409).send({ error: "a cook is in progress — undo after it settles" });
    }
    // A queued re-apply would run old values against the restored graph.
    if (t0.busy(project)) {
      return reply.code(409).send({ error: "a param edit is still applying — undo after it settles" });
    }
    const top = project.undo.pop();
    if (!top) return reply.code(409).send({ error: "nothing to undo" });
    // A restored graph invalidates any proposal negotiated against the newer one.
    s.pendingProposals.clear();
    const restored = top.doc;
    // rev is a persistence stamp — keep it monotonic across the restore.
    restored.rev = Math.max(restored.rev, store.doc.rev);
    store.replace(restored);
    // Workspace modules follow the restored artifacts; Vite HMR swaps them.
    await project.backend.assemble(store.doc, project.workspace);
    s.emitUndoStack(project);
    void s.runGlobalCheck(project);
    bus.emit({
      type: "job:log",
      projectId: store.doc.id,
      nodeId: "",
      line: `undo: rolled back "${top.label}" (${project.undo.length} more)`,
    });
    return { ok: true, restored: top.label, depth: project.undo.length };
  });

  app.post("/api/project/nodes/:nodeId/revert", async (req, reply) => {
    const project = s.active;
    const { store, backend, workspace } = project;
    const { nodeId: nid } = req.params as { nodeId: string };
    const body = RevertBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const node = store.doc.nodes[nid];
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
    const file = codeFile(project.dir, nid, body.data.version, codeExt(store.doc.backend));
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
    const exec = await backend.execute(candidate, workspace, store.doc);
    if (!exec.ok) return reply.code(422).send({ error: `v${body.data.version} fails ${exec.stage}: ${exec.report.slice(0, 400)}` });
    const verify = await backend.verify(candidate, store.doc, workspace);
    if (!verify.ok) return reply.code(422).send({ error: `v${body.data.version} fails ${verify.stage}: ${verify.report.slice(0, 400)}` });
    // A switch, undo, cook or contract edit during the gauntlet makes its verdict moot.
    const now = store.doc.nodes[nid];
    if (s.active !== project || now !== node || isCooking(now.status) || now.contract.hash !== entry.contractHash) {
      return reply.code(409).send({ error: `${nid} changed while v${body.data.version} was being verified` });
    }
    s.checkpoint(project, `revert of ${nid} to v${body.data.version}`);
    store.applyOp(
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
    if (store.doc.nodes[nid]!.status !== "ready") {
      for (const status of ["queued", "building", "verifying", "ready"] as const) store.setStatus(nid, status);
    }
    if (backend.id === s.codeBackend.id) await writeNodeModule(workspace, nid, code);
    bus.emit({
      type: "node:committed",
      projectId: store.doc.id,
      nodeId: nid,
      version: body.data.version,
    });
    void s.runGlobalCheck(project);
    return { ok: true };
  });
}
