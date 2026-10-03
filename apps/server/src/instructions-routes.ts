import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GraphDoc } from "@patchcad/shared";
import { assemblyInstructions, type CadBackend } from "@patchcad/backend-cad";

/** What the route needs of the active project, read once per request. */
interface Active {
  dir: string;
  backend: { id: string };
  store: { doc: GraphDoc };
}

const Query = z.object({ format: z.enum(["json", "pdf", "html"]).default("json") });
const safe = (s: string) => s.replace(/[^\w.-]/g, "_");

/**
 * Assembly instructions from the graph: zero LLM calls. JSON is the sequence
 * (steps, sub-assemblies, `sequenceProblems`) plus page URLs through the
 * kernel proxy; pdf and html download the same pages.
 */
export function registerInstructionRoutes(app: FastifyInstance, active: () => Active, cad: CadBackend): void {
  app.get("/api/project/instructions", async (req, reply) => {
    const a = active();
    if (a.backend.id !== "cad") return reply.code(409).send({ error: "active project is not a CAD graph" });
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const doc = a.store.doc;
    const out = await assemblyInstructions(doc, cad.solveScene(doc), cad.kernel, { importDir: path.join(a.dir, "imports") });
    const proxied = (p: string) => `${req.protocol}://${req.host}/api/kernel${p}`;
    if (q.data.format === "json") {
      return {
        ...out.sequence,
        pages: out.pages.map(proxied),
        pdf: out.pdf && proxied(out.pdf),
        html: out.html && proxied(out.html),
        ...(out.error ? { error: out.error } : {}),
      };
    }
    const file = q.data.format === "pdf" ? out.pdf : out.html;
    if (!file) return reply.code(502).send({ error: out.error ?? "the kernel drew no pages", sequenceProblems: out.sequence.sequenceProblems });
    const res = await fetch(`${cad.kernel.baseUrl}${file}`);
    if (!res.ok) return reply.code(502).send({ error: `kernel served ${res.status} for the instructions` });
    const slug = path.basename(a.dir) || "patchcad";
    return reply
      .header("content-disposition", `attachment; filename="${safe(slug)}-instructions.${q.data.format}"`)
      .type(q.data.format === "pdf" ? "application/pdf" : "text/html; charset=utf-8")
      .send(Buffer.from(await res.arrayBuffer()));
  });
}
