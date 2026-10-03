import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isCooking } from "@patchcad/shared";
import { cookNodes } from "@patchcad/engine";
import type { Session } from "./session.js";

const CookDirtyBody = z.object({ inspect: z.boolean().optional() });
const CancelBody = z.object({ projectId: z.string().optional() });

export function registerCookRoutes(app: FastifyInstance, s: Session): void {
  app.post("/api/project/cook-dirty", async (req, reply) => {
    const blocked = s.spendBlocked();
    if (blocked || !s.resolved) return reply.code(503).send({ error: blocked });
    const project = s.active;
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
    const inspect = cookBody.data.inspect ?? s.defaultInspect(project);
    const stale = Object.values(project.store.doc.nodes)
      .filter((n) => ["planned", "dirty", "error_code", "error_contract", "cancelled"].includes(n.status))
      .map((n) => n.id);
    if (stale.length === 0) return { ok: true, cooking: [] };
    void s.trackCook(project, cookNodes(
      s.cookDeps(project, s.resolved.provider, { inspect }),
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
   * names another that is still cooking in the background. Until now the only
   * way to halt a cook that could not possibly succeed — a contract the
   * generator cannot satisfy, say — was to kill the server process.
   *
   * Aborting alone would strand nodes mid-status, so in-flight nodes are
   * settled to `cancelled`, which the status machine allows from every
   * in-flight state and which cook-dirty picks up as resumable work.
   *
   * Planning is not a cook and has its own stop: /plan/cancel.
   */
  app.post("/api/project/cook/cancel", async (req, reply) => {
    const body = CancelBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const projectId = body.data.projectId ?? s.active.store.doc.id;
    const ctl = s.cookAborts.get(projectId);
    const project = s.projectById(projectId);
    const inFlight = project ? Object.values(project.store.doc.nodes).filter((n) => isCooking(n.status)) : [];
    const live = project ? s.liveCooks.has(project.dir) : !!ctl && !ctl.signal.aborted;
    if (inFlight.length === 0 && !live) {
      return reply.code(409).send({ error: "nothing is cooking" });
    }
    ctl?.abort();
    const cancelled: string[] = [];
    for (const n of inFlight) {
      try {
        project!.store.setStatus(n.id, "cancelled");
        cancelled.push(n.id);
      } catch {
        // Raced with the cook's own write; the next status it sets is
        // illegal from `cancelled`, which ends that cookOne anyway.
      }
    }
    console.log(`[patchcad] cook cancelled on ${projectId}: ${cancelled.join(", ") || "(none in flight)"}`);
    return { ok: true, cancelled };
  });
}
