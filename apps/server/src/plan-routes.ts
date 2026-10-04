import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GraphDoc, NodeCost } from "@patchcad/shared";
import { cookNodes, planGraph } from "@patchcad/engine";
import { CadBackend, planPreview } from "@patchcad/backend-cad";
import { MeshGenError, meshPrompt } from "./meshgen/index.js";
import { slugify } from "./project.js";
import { prepReferences, UploadedImage, writeRefs, type PendingRef } from "./refs.js";
import { addUsage, Budget, metered } from "./spend.js";
import type { Session } from "./session.js";

const PlanBody = z.object({
  goal: z.string().min(4),
  /** Which domain plans this goal: printed parts or a web app. */
  backend: z.enum(["web-code", "cad"]).default("cad"),
  /** Reference images (CAD): part of the spec the architect plans from. */
  images: z.array(UploadedImage).max(4).default([]),
  /** Target overall height, mm. */
  sizeMm: z.number().positive().optional(),
  symmetric: z.boolean().optional(),
});

interface PendingPlan {
  graph: GraphDoc;
  rationale: string;
  goal: string;
  /** Every architect round and mesh draft. It lands in the project's ledger
   *  if the plan is approved, and in the session's unbilled ledger otherwise. */
  spend: NodeCost;
  refs: PendingRef[];
}

export function registerPlanRoutes(app: FastifyInstance, s: Session): void {
  let pendingPlan: PendingPlan | null = null;
  const dropPlan = (why: string) => {
    if (pendingPlan) s.recordUnbilled(pendingPlan.spend, why);
    pendingPlan = null;
  };

  app.post("/api/project/plan", async (req, reply) => {
    const blocked = s.spendBlocked();
    if (blocked || !s.resolved) return reply.code(503).send({ error: blocked });
    const body = PlanBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const ctl = (s.planAbort = new AbortController());
    const spend: NodeCost = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    try {
      const slug = slugify(body.data.goal);
      const planBackend = s.backends[body.data.backend]!;
      const refs =
        body.data.images.length > 0 && planBackend instanceof CadBackend
          ? await prepReferences(planBackend.kernel, body.data.images, (line) => console.log(`[patchcad] ${line}`))
          : [];
      const result = await planGraph({
        references: refs.map((r) => ({ image: r.image, view: r.ref.view, aspect: r.ref.aspect })),
        sizeMm: body.data.sizeMm,
        symmetric: body.data.symmetric,
        provider: metered(s.resolved.provider, (usage) => addUsage(spend, usage)),
        backend: planBackend,
        projectId: slug,
        goal: body.data.goal,
        onPhase: (phase, detail) =>
          s.bus.emit({
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
      dropPlan("plan superseded");
      pendingPlan = { graph: result.graph, rationale: result.rationale, goal: body.data.goal, spend, refs };
      return {
        plan: result.graph,
        rationale: result.rationale,
        usage: result.usage,
        repaired: result.repaired,
        // The coverage critic's leftovers: an LLM judgement, so shown, never blocking.
        warnings: result.critic?.warnings ?? [],
      };
    } catch (err) {
      s.recordUnbilled(spend, "plan failed");
      return reply.code(500).send({ error: (err as Error).message });
    } finally {
      if (s.planAbort === ctl) s.planAbort = null;
    }
  });

  app.post("/api/project/plan/cancel", async (_req, reply) => {
    if (!s.planAbort) return reply.code(409).send({ error: "nothing is being planned" });
    s.planAbort.abort();
    return { ok: true };
  });

  app.post("/api/project/plan/approve", async (_req, reply) => {
    const blocked = s.spendBlocked();
    if (blocked || !s.resolved) return reply.code(503).send({ error: blocked });
    if (!pendingPlan) return reply.code(409).send({ error: "no pending plan" });
    const approved = pendingPlan;
    pendingPlan = null;

    // Every approved plan gets its OWN project directory — the loaded project
    // is never clobbered.
    const dir = path.join(s.projectsRoot, approved.graph.id);
    approved.graph.ledger.planning = approved.spend;
    await mkdir(path.join(dir, "nodes"), { recursive: true });
    await writeRefs(dir, approved.refs);
    await writeFile(path.join(dir, "patchcad.json"), JSON.stringify(approved.graph, null, 2), "utf8");
    const project = await s.activate(dir);

    // The FIRST cook of a project is the one that forms the user's impression,
    // and it used to be the one cook that never looked at what it made.
    void s.trackCook(project, cookNodes(
      s.cookDeps(project, s.resolved.provider, { inspect: s.defaultInspect(project) }),
      Object.keys(project.store.doc.nodes),
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
    return { ...planPreview(pendingPlan.graph), meshGen: s.meshGen?.id ?? null };
  });

  /** A low-poly draft of one mesh node from the pending plan's references,
   *  so the user can see the surface before paying for the cook. Costs a
   *  provider call, billed to the plan's spend and capped by maxUsd with it. */
  app.post("/api/project/plan/preview-mesh", async (req, reply) => {
    const body = z.object({ nodeId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    if (!s.meshGen) return reply.code(503).send({ error: "mesh generation not configured" });
    if (s.budgetError) return reply.code(503).send({ error: s.budgetError });
    const plan = pendingPlan;
    const node = plan?.graph.nodes[body.data.nodeId];
    if (!plan || !node) return reply.code(409).send({ error: "no pending plan with that node" });
    try {
      if (s.maxUsd) new Budget(s.maxUsd, plan.spend.usd).check("plan");
    } catch (err) {
      return reply.code(402).send({ error: (err as Error).message });
    }
    // Discarded or approved while the draft ran: the money still counts.
    const bill = (usd: number) => {
      const usage = { inputTokens: 0, outputTokens: 0, usd };
      if (pendingPlan === plan) addUsage(plan.spend, usage);
      else s.recordUnbilled(addUsage({ calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 }, usage), "mesh draft for a closed plan");
    };
    try {
      const out = await s.meshGen.generate({
        images: plan.refs.map((r) => ({ pngB64: r.png.toString("base64"), view: r.ref.view })),
        prompt: meshPrompt(node),
        targetSizeMm: plan.graph.brief.sizeMm,
        symmetric: plan.graph.brief.symmetric,
        preview: true,
      });
      const usd = out.usage?.usd ?? 0;
      bill(usd);
      return { glbB64: out.glb.toString("base64"), usd };
    } catch (err) {
      if (err instanceof MeshGenError) bill(err.usd);
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.delete("/api/project/plan", async () => {
    dropPlan("plan discarded");
    return { ok: true };
  });
}
