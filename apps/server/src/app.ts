import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import type { GraphDoc } from "@patchcad/shared";
import { registerCadRoutes } from "./cad-routes.js";
import { registerCookRoutes } from "./cook-routes.js";
import { registerImportSplit } from "./import-split.js";
import { registerPlanRoutes } from "./plan-routes.js";
import { NO_PROVIDER_HELP, paidRoutes } from "./providers.js";
import type { Session } from "./session.js";
import { createT0, registerT0Routes } from "./t0.js";
import { registerTierRoutes } from "./tier-routes.js";

const OpenBody = z.object({ dir: z.string().min(1) });

/** Every route over one session. Not listening yet: main.ts adds the static
 *  studio and binds; tests drive it with `app.inject`. */
export async function buildApp(s: Session): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 * 1024 });
  // Exposed so the studio's cross-origin export fetch can read the filename.
  await app.register(cors, { origin: true, exposedHeaders: ["content-disposition", "x-patchcad-warning"] });
  await app.register(websocket);

  app.get("/api/health", async () => ({ ok: true }));

  /** What the studio cannot know on its own: whether anything can plan, how
   *  spend is billed, and whether the geometry kernel is up yet (its first boot
   *  pays the OCP import, and until then the viewport is an empty grid). */
  app.get("/api/status", async () => ({
    provider: s.resolved
      ? { id: s.resolved.provider.id, source: s.resolved.source, paid: paidRoutes(s.resolved.provider) }
      : null,
    providerHelp: s.resolved ? "" : NO_PROVIDER_HELP,
    maxUsd: s.maxUsd ?? null,
    budgetError: s.budgetError,
    unbilled: s.unbilled,
    kernel: s.active.backend.id === "cad" ? { ok: (await s.cadBackend.kernel.health()).ok } : null,
  }));

  // Uncaught errors inside the preview iframe land here so they show in the
  // server log and the studio log instead of a silent blank pane.
  app.post("/api/preview-error", async (req) => {
    const message = String((req.body as { message?: string })?.message ?? "").slice(0, 1500);
    console.log(`[patchcad] PREVIEW CRASH: ${message}`);
    s.bus.emit({ type: "job:log", projectId: s.active.store.doc.id, nodeId: "preview", line: `crash: ${message.slice(0, 200)}` });
    return { ok: true };
  });

  app.get("/api/project", async () => ({
    graph: s.active.store.doc,
    previewUrl: s.previewUrl(s.active),
    backend: s.active.store.doc.backend,
    dir: s.active.dir,
    undo: {
      depth: s.active.undo.length,
      label: s.active.undo[s.active.undo.length - 1]?.label ?? "",
    },
  }));

  const t0 = createT0(s);
  registerT0Routes(app, s, t0);
  registerCadRoutes(app, s);
  registerPlanRoutes(app, s);
  registerImportSplit(app, s);
  registerTierRoutes(app, s, t0);
  registerCookRoutes(app, s);

  // ---------- Project switcher ----------

  app.get("/api/projects", async () => {
    const roots = [s.examplesRoot, s.projectsRoot];
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
            example: root === s.examplesRoot,
          });
        } catch {
          // not a patchcad project — skip
        }
      }
    }
    // Most recently touched first: the project you were just in is the one
    // you most likely want back.
    projects.sort((a, b) => b.mtime - a.mtime);
    return { projects, active: s.active.dir };
  });

  /** Back to the front door: no active project, welcome screen. The closed
   * project stays on disk and in the picker. */
  app.post("/api/project/close", async () => {
    await s.close();
    return { ok: true };
  });

  app.post("/api/project/open", async (req, reply) => {
    const body = OpenBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const dir = path.resolve(body.data.dir);
    const allowed = [s.examplesRoot, s.projectsRoot].some((root) => dir.startsWith(root + path.sep));
    if (!allowed) return reply.code(400).send({ error: "dir must be under examples/ or projects/" });
    try {
      await readFile(path.join(dir, "patchcad.json"), "utf8");
    } catch {
      return reply.code(404).send({ error: "not a patchcad project (no patchcad.json)" });
    }
    if (dir !== s.active.dir) {
      const project = await s.activate(dir);
      void s.runGlobalCheck(project);
    }
    return { ok: true, dir };
  });

  app.get("/ws", { websocket: true }, (socket) => {
    const unsubscribe = s.bus.subscribe((event) => {
      socket.send(JSON.stringify(event));
    });
    socket.on("close", unsubscribe);
    // Initial snapshot so a late-joining client has the full graph.
    socket.send(
      JSON.stringify({
        type: "graph:replaced",
        projectId: s.active.store.doc.id,
        graph: s.active.store.doc,
      }),
    );
  });

  return app;
}
