import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { unverifiedCandidate, type CadBackend } from "@patchcad/backend-cad";
import { registerBomRoutes } from "./bom-routes.js";
import { effectiveParams } from "./project.js";
import type { Session } from "./session.js";

/**
 * Kernel artifacts (GLB, contact sheet) THROUGH the server, so the browser
 * never needs to reach :8621 — in a container it cannot. URLs are absolute
 * on the host the request came in on, which is :4100 in dev and wherever
 * the server is published in production.
 */
const kernelUrl = (req: { protocol: string; host: string }, kernelPath: string) =>
  `${req.protocol}://${req.host}/api/kernel${kernelPath}`;

const ExportParams = z.object({ format: z.enum(["stl", "3mf", "obj", "step"]) });
const ExportQuery = z.object({ node: z.string().optional(), includeUnverified: z.literal("1").optional() });

/** The viewport's data, renders, exports and the BOM. */
export function registerCadRoutes(app: FastifyInstance, s: Session): void {
  /**
   * A picture of one part, from six angles. The gates can prove a bore is
   * Ø4.5 and the part fits its envelope; they cannot see that it looks wrong.
   * For now a human closes that gap — this is what they look at.
   */
  app.get("/api/project/nodes/:nodeId/sheet", async (req, reply) => {
    const project = s.active;
    if (project.backend.id !== "cad") return reply.code(409).send({ error: "active project is not a CAD graph" });
    const { nodeId: nid } = req.params as { nodeId: string };
    const node = project.store.doc.nodes[nid];
    if (!node?.artifact?.code) return reply.code(404).send({ error: "node has no cooked code" });

    const cad = project.backend as CadBackend;
    const result = await cad.kernel.render(node.artifact.code, effectiveParams(node), {
      importDir: path.join(project.dir, "imports"),
    });
    if (!result.ok || !result.sheet) {
      return reply.code(422).send({ error: result.error ?? "render failed", stage: result.stage });
    }
    return { url: kernelUrl(req, result.sheet), ...result.render };
  });

  app.get("/api/kernel/artifact/:digest/:file", async (req, reply) => {
    const { digest, file } = req.params as { digest: string; file: string };
    if (!/^[0-9a-f]+$/.test(digest) || !/^[\w-]+\.\w+$/.test(file)) return reply.code(400).send({ error: "bad artifact path" });
    const res = await fetch(`${s.cadBackend.kernel.baseUrl}/artifact/${digest}/${file}`);
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
   * cannot reach :8621 at all. `includeUnverified=1` adds the unverified
   * candidates of nodes stuck on their contract, named in
   * `x-patchcad-unverified` and the warning; without it they are left out.
   */
  app.get("/api/project/export/:format", async (req, reply) => {
    const project = s.active;
    if (project.backend.id !== "cad") return reply.code(409).send({ error: "active project is not a CAD graph" });
    const p = ExportParams.safeParse(req.params);
    const q = ExportQuery.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: (p.error ?? q.error)!.message });
    const asked = q.data.node ? project.store.doc.nodes[q.data.node] : undefined;
    if (asked && unverifiedCandidate(asked) && !q.data.includeUnverified) {
      return reply.code(409).send({
        error: `${asked.id} has no verified part, only an unverified candidate that failed ${asked.candidate!.stage}`,
        hint: "pass includeUnverified=1 to export it anyway",
      });
    }
    const cad = project.backend as CadBackend;
    const result = await cad.exportGeometry(project.store.doc, project.workspace, {
      nodeId: q.data.node,
      format: p.data.format,
      includeUnverified: q.data.includeUnverified === "1",
    });
    if (!result.ok || !result.file) {
      return reply.code(422).send({ error: result.error ?? "export failed", hint: result.hint });
    }
    const res = await fetch(`${cad.kernel.baseUrl}${result.file}`);
    if (!res.ok) return reply.code(502).send({ error: `kernel served ${res.status} for the export` });
    const slug = path.basename(project.dir) || "patchcad";
    const unverified = q.data.includeUnverified
      ? Object.values(project.store.doc.nodes)
          .filter((n) => unverifiedCandidate(n) && !n.hidden && (!q.data.node || n.id === q.data.node))
          .map((n) => `${n.id} (failed ${n.candidate!.stage})`)
      : [];
    if (unverified.length > 0) reply.header("x-patchcad-unverified", unverified.join(", "));
    const name = `${q.data.node ? `${slug}-${q.data.node}` : slug}${unverified.length > 0 ? "-unverified" : ""}`;
    const warning = [
      unverified.length > 0 ? `UNVERIFIED, the gates rejected: ${unverified.join(", ")}` : "",
      result.export?.warning ?? "",
    ].filter(Boolean).join(" · ");
    if (warning) reply.header("x-patchcad-warning", warning);
    return reply
      .header("content-disposition", `attachment; filename="${name.replace(/[^\w.-]/g, "_")}.${p.data.format}"`)
      .type("application/octet-stream")
      .send(Buffer.from(await res.arrayBuffer()));
  });

  registerBomRoutes(app, () => s.active, s.cadBackend);

  app.get("/api/project/cad-scene", async (req, reply) => {
    const project = s.active;
    if (project.backend.id !== "cad") return reply.code(409).send({ error: "active project is not a CAD graph" });
    const cad = project.backend as CadBackend;
    const { scene, problems } = cad.solveScene(project.store.doc);
    // Resolve each cooked node's mesh URL via the kernel's content-addressed
    // cache (instant for anything already executed this session).
    const meshes: Record<string, { glb: string; status: string; printability?: unknown }> = {};
    for (const node of Object.values(project.store.doc.nodes)) {
      // Hidden: no mesh, so nothing renders. The scene's matrices above still
      // cover every node, so the parts that remain do not move.
      if (!node.artifact?.code || node.hidden) continue;
      const result = await cad.kernel.execute(node.artifact.code, effectiveParams(node), {
        importDir: path.join(project.dir, "imports"),
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
}
