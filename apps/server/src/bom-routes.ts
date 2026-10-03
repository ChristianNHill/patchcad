import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GraphDoc } from "@patchcad/shared";
import {
  bomCsv,
  buildBom,
  dfmIssues,
  kernelPorts,
  kernelProcess,
  sourcingOf,
  type CadBackend,
  type CadContractPayload,
} from "@patchcad/backend-cad";
import { effectiveParams } from "./project.js";

/** What these routes need of the active project, read at request time. */
interface Active {
  dir: string;
  backend: { id: string };
  store: { doc: GraphDoc };
}

const BomQuery = z.object({ format: z.enum(["json", "csv"]).default("json") });
const safe = (s: string) => s.replace(/[^\w.-]/g, "_");

/**
 * The BOM (buy / print / fabricate, rows only for generated geometry) and the
 * per-part vendor package. Both read the graph as committed: a part whose
 * gates have not passed has no package, and the kernel re-runs G4c before it
 * writes one.
 */
export function registerBomRoutes(app: FastifyInstance, active: () => Active, cad: CadBackend): void {
  app.get("/api/project/bom", async (req, reply) => {
    const a = active();
    if (a.backend.id !== "cad") return reply.code(409).send({ error: "active project is not a CAD graph" });
    const q = BomQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const bom = buildBom(a.store.doc);
    if (q.data.format === "json") return bom;
    const slug = path.basename(a.dir) || "patchcad";
    return reply
      .header("content-disposition", `attachment; filename="${safe(slug)}-bom.csv"`)
      .type("text/csv; charset=utf-8")
      .send(bomCsv(bom));
  });

  app.get("/api/project/parts/:nodeId/vendor-package", async (req, reply) => {
    const a = active();
    if (a.backend.id !== "cad") return reply.code(409).send({ error: "active project is not a CAD graph" });
    const { nodeId } = req.params as { nodeId: string };
    const doc = a.store.doc;
    const node = doc.nodes[nodeId];
    if (!node) return reply.code(404).send({ error: `no node ${nodeId}` });
    const s = sourcingOf(node);
    if (s.class === "buy") return reply.code(409).send({ error: `${nodeId} is catalog hardware: order it by its SKU` });
    if (node.status !== "ready" || !node.artifact?.code) {
      return reply.code(409).send({ error: `${nodeId} is ${node.status}: a vendor package needs a part whose gates passed` });
    }
    const params = effectiveParams(node);
    const bom = buildBom(doc);
    const row = [...bom.fabricate, ...bom.print].find((r) => r.nodeId === nodeId);
    const result = await cad.kernel.vendorPackage({
      code: node.artifact.code,
      params,
      ports: kernelPorts(doc, node.contract.payload as CadContractPayload),
      measured: (node.measurements?.data as { ports?: unknown[] } | undefined)?.ports ?? [],
      process: kernelProcess(node),
      meta: {
        name: nodeId,
        title: node.title,
        process: s.process ?? "fdm",
        material: s.material ?? "",
        finish: s.finish ?? "",
        qty: row?.qty ?? 1,
        date: new Date().toISOString().slice(0, 10),
        notes: node.spec ? [`Design intent: ${node.spec}`] : [],
      },
      importDir: path.join(a.dir, "imports"),
    });
    if (!result.ok) {
      return reply.code(422).send({ error: result.error, stage: result.stage, hint: result.hint, issues: dfmIssues(result.failures) });
    }
    const res = await fetch(`${cad.kernel.baseUrl}${result.file}`);
    if (!res.ok) return reply.code(502).send({ error: `kernel served ${res.status} for the vendor package` });
    const slug = path.basename(a.dir) || "patchcad";
    return reply
      .header("content-disposition", `attachment; filename="${safe(`${slug}-${nodeId}`)}-vendor.zip"`)
      .header("x-patchcad-step-schema", result.vendor.step_schema)
      .type("application/zip")
      .send(Buffer.from(await res.arrayBuffer()));
  });
}
