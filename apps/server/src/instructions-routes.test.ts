import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { CadBackend } from "@patchcad/backend-cad";
import { registerInstructionRoutes } from "./instructions-routes.js";

const doc = GraphDoc.parse(JSON.parse(readFileSync(new URL("../../../examples/cad-rotor/patchcad.json", import.meta.url), "utf8")));

/** A CadBackend whose kernel is down: the sequence still comes back, with the reason. */
function app(backend: string) {
  const a = Fastify();
  const cad = new CadBackend();
  Object.assign(cad.kernel, {
    insertions: async () => ({ ok: false, error: "kernel down" }),
    instructions: async () => ({ ok: false, error: "kernel down" }),
  });
  registerInstructionRoutes(a, () => ({ dir: "/somewhere/projects/rotor", backend: { id: backend }, store: { doc } }), cad);
  return a;
}

describe("instructions route", () => {
  it("refuses a project that is not CAD", async () => {
    expect((await app("web-code").inject("/api/project/instructions")).statusCode).toBe(409);
  });

  it("returns the sequence as JSON and says why there are no pages", async () => {
    const res = await app("cad").inject("/api/project/instructions");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.steps.map((s: { action: string }) => s.action)).toEqual(["press", "insert", "slide", "slide"]);
    expect(body.pages).toEqual([]);
    expect(body.error).toBe("kernel down");
    expect(body.sequenceProblems.some((p: string) => p.includes("insertion check did not run"))).toBe(true);
  });

  it("answers 502 for a PDF the kernel could not draw", async () => {
    const res = await app("cad").inject("/api/project/instructions?format=pdf");
    expect(res.statusCode).toBe(502);
  });
});
