import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashValue, ParamValue } from "@patchcad/shared";
import { reexpandGraph } from "@patchcad/engine";
import { boundDependents, CadJoint, jointErrors, resolveParamBindings, staleJoints } from "@patchcad/backend-cad";
import { addCost } from "./spend.js";
import { LatestWinsQueue } from "./t0-queue.js";
import type { ActiveProject, Session } from "./session.js";

export type T0 = ReturnType<typeof createT0>;

/** T0/T1: param edits re-executed on cached code, and the joint re-expansion
 *  they can trigger. Deterministic, zero LLM calls. */
export function createT0(s: Session) {
  const { bus } = s;

  /** The T0/T1 re-apply after a param edit. Runs off a per-node queue, so it
   *  always reads the newest params: a drag's intermediate values never run.
   *  Switched away before or during it: the edit is persisted, and opening the
   *  project again re-solves it. */
  async function reapplyParams(project: ActiveProject, nid: string) {
    const switched = () => s.active !== project;
    if (switched()) return;
    const { store, backend, workspace } = project;
    const projectId = store.doc.id;
    const t1 = [nid, ...boundDependents(store.doc, nid)];
    const regressions: string[] = [];
    for (const id of t1) {
      const node = store.doc.nodes[id];
      if (!node?.artifact?.code) continue;
      if (id !== nid) {
        const { resolved: bound, problems } = resolveParamBindings(store.doc, id);
        if (problems.length > 0) {
          bus.emit({ type: "job:log", projectId, nodeId: id, line: `T1 bindings: ${problems.join("; ")}` });
          continue;
        }
        store.setParams(id, bound);
      }
      // Registry parts re-CODEGEN when a bound param changes their spec
      // (an M5 screw is different code, not an M4 with new params) —
      // still deterministic, still zero LLM calls.
      const regen = backend.deterministicArtifact?.(store.doc.nodes[id]!);
      if (regen && regen.code !== store.doc.nodes[id]!.artifact?.code) {
        store.applyOp((g) => {
          const n = g.nodes[id]!;
          n.artifact = { code: regen.code, testCode: "", hash: hashValue(regen.code) };
        });
        bus.emit({ type: "job:log", projectId, nodeId: id, line: "T1 registry re-resolve — new spec, new code, 0 LLM calls" });
      }
      // The studio already holds the edited node's params; a dependent's
      // were just rewritten here.
      if (id !== nid) s.emitNodeUpdated(project, id);
      const exec = await backend.execute(store.doc.nodes[id]!, workspace, store.doc);
      if (switched()) return;
      bus.emit({
        type: "job:log",
        projectId,
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
      const verify = await backend.verify(store.doc.nodes[id]!, store.doc, workspace);
      if (switched()) return;
      if (verify.ok) {
        store.applyOp((g) => {
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
    if (backend.id === "cad") {
      regressions.push(...jointErrors(store.doc).map((e) => `joint ${e}`));
      if (!s.liveCooks.has(project.dir) && staleJoints(store.doc).length > 0) applyReexpansion(project, `joint rules after ${nid}`);
    }
    bus.emit({ type: "preview:reload", projectId });
    // A param can move a pose, so the assembly is re-judged too: G5
    // blocks or releases parts on what the edit did.
    await s.runGlobalCheck(project, regressions);
  }

  /**
   * Re-run the domain's plan expansion on the live graph (joint rules, for
   * CAD) and apply what moved: new hardware is planned, removed hardware goes
   * (its cost to the ledger), every changed contract goes dirty with its
   * port-granular descendants, and bound params re-resolve. Zero LLM calls;
   * the dirty nodes wait for the next cook like any contract edit.
   */
  function applyReexpansion(project: ActiveProject, label: string) {
    const { store } = project;
    const r = reexpandGraph(store.doc, project.backend);
    if (!r) return null;
    const moved = r.added.length + r.removed.length + r.changed.length > 0;
    if (!moved && JSON.stringify(r.graph.joints) === JSON.stringify(store.doc.joints)) return r;
    s.checkpoint(project, label);
    for (const id of r.removed) addCost(r.graph.ledger.nodes, store.doc.nodes[id]!.cost);
    store.replace(r.graph);
    for (const id of r.dirty) if (store.doc.nodes[id]?.status === "ready") store.setStatus(id, "dirty");
    // Bound params follow the new hardware (a bigger bearing's seat), and a
    // ready part whose values moved re-executes on them through T1, exactly as
    // if the user had dragged the slider: its contract did not change.
    for (const n of Object.values(store.doc.nodes)) {
      const { resolved, problems } = resolveParamBindings(store.doc, n.id);
      const moved = Object.entries(resolved).filter(([k, v]) => (n.params[k] ?? n.contract.params.find((p) => p.name === k)?.default) !== v);
      if (problems.length > 0 || moved.length === 0) continue;
      store.setParams(n.id, resolved);
      if (n.status === "ready") push(project, n.id);
    }
    bus.emit({
      type: "job:log",
      projectId: store.doc.id,
      nodeId: "joints",
      line: `${label}: +${r.added.length} −${r.removed.length} hardware, ${r.dirty.length} node(s) dirty, 0 LLM calls`,
    });
    return r;
  }

  const queue = new LatestWinsQueue<{ project: ActiveProject; nid: string }>(
    (_key, job) => reapplyParams(job.project, job.nid),
    (key, err) => console.warn(`[patchcad] T0 re-apply ${key} failed: ${(err as Error).message}`),
  );
  const push = (project: ActiveProject, nid: string) => queue.push(`${project.store.doc.id}/${nid}`, { project, nid });
  /** A re-apply for this project is queued or running. */
  const busy = (project: ActiveProject) => queue.busy((key) => key.startsWith(`${project.store.doc.id}/`));

  return { reapplyParams, applyReexpansion, push, busy };
}

const ParamsBody = z.object({ params: z.record(ParamValue) });

export function registerT0Routes(app: FastifyInstance, s: Session, t0: T0): void {
  app.post("/api/project/nodes/:nodeId/params", async (req, reply) => {
    const project = s.active;
    const { nodeId: nid } = req.params as { nodeId: string };
    const body = ParamsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    if (!project.store.doc.nodes[nid]) return reply.code(404).send({ error: "unknown node" });
    // T0: persist only — the studio pushes live values into the preview
    // iframe directly via postMessage; no rebuild, no LLM.
    s.checkpoint(project, `param edit on ${nid}`);
    project.store.setParams(nid, body.data.params);

    // CAD T0/T1: re-execute the edited node's cached code with the new values,
    // then re-resolve any bound dependents — deterministic, zero LLM calls.
    if (project.backend.id === "cad") t0.push(project, nid);
    return { ok: true };
  });

  /**
   * Change what a joint must do (intent, load, motion, walls, count...). The
   * joint rules re-pick its hardware and the expansion re-runs: a different
   * decision dirties the parts whose host features moved. Never an LLM call.
   */
  app.post("/api/project/joints/:jointId", async (req, reply) => {
    const project = s.active;
    const { store } = project;
    if (project.backend.id !== "cad") return reply.code(409).send({ error: "active project is not a CAD graph" });
    if (s.liveCooks.has(project.dir)) return reply.code(409).send({ error: "wait for the cook to finish" });
    const { jointId } = req.params as { jointId: string };
    const i = store.doc.joints.findIndex((j) => j.id === jointId);
    if (i < 0) return reply.code(404).send({ error: "unknown joint" });
    const next = CadJoint.safeParse({ ...store.doc.joints[i], ...(req.body as object), id: jointId });
    if (!next.success) return reply.code(400).send({ error: next.error.message });
    // Refused, not half-applied: a joint no rule can make keeps its hardware.
    const trial = { ...store.doc, joints: store.doc.joints.map((j, k) => (k === i ? { ...j, ...next.data } : j)) };
    const errors = jointErrors(trial).filter((e) => e.startsWith(`${jointId}:`));
    if (errors.length > 0) return reply.code(422).send({ error: errors.join("; ") });
    s.checkpoint(project, `joint ${jointId}`);
    store.applyOp((g) => {
      g.joints[i] = { ...g.joints[i], ...next.data };
    });
    const r = t0.applyReexpansion(project, `joint ${jointId}`);
    return { ok: true, added: r?.added ?? [], removed: r?.removed ?? [], dirtied: r?.dirty ?? [] };
  });
}
