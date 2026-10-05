import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import type { CadBackend } from "@patchcad/backend-cad";
import { registerBomRoutes } from "./bom-routes.js";

const payload = {
  units: "mm",
  process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
  ports: [],
  envelope: {
    volumes: [{ kind: "box", pose: { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims: [10, 10, 10] }],
    clearance: 0.4,
  },
};

const graph = (backend: string) =>
  GraphDoc.parse({
    schemaVersion: 1,
    id: "g",
    backend,
    brief: { goal: "", constraints: [], clarifications: [] },
    nodes: {
      plate: {
        id: "plate", kind: "part", title: "Plate", spec: "", status: "dirty",
        contract: { name: "plate", summary: "", params: [], provides: [], requires: [], payload, hash: "" },
      },
    },
    edges: [],
    assembly: { entryNodeId: "plate" },
  });

async function app(backend: string) {
  const a = Fastify();
  const doc = graph(backend);
  registerBomRoutes(a, () => ({ dir: "/somewhere/projects/my-bracket", backend: { id: backend }, store: { doc } }), {} as CadBackend);
  return a;
}

describe("bom routes", () => {
  it("refuses a project that is not CAD", async () => {
    const a = await app("web-code");
    expect((await a.inject("/api/project/bom")).statusCode).toBe(409);
    expect((await a.inject("/api/project/parts/plate/vendor-package")).statusCode).toBe(409);
  });

  it("serves the BOM as JSON, and as CSV named after the project dir", async () => {
    const a = await app("cad");
    const json = await a.inject("/api/project/bom");
    expect(json.statusCode).toBe(200);
    expect(Object.keys(json.json()).sort()).toEqual(["buy", "fabricate", "notGenerated", "print", "unverified"]);
    const csv = await a.inject("/api/project/bom?format=csv");
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="my-bracket-bom.csv"');
    expect(String(csv.headers["content-type"])).toMatch(/^text\/csv/);
    expect((await a.inject("/api/project/bom?format=xml")).statusCode).toBe(400);
  });

  it("labels a bought part with its designation and where to search for it, with no part number", async () => {
    const a = Fastify();
    const doc = graph("cad");
    doc.nodes.screw = {
      ...doc.nodes.plate!,
      id: "screw",
      kind: "fastener",
      title: "Screw",
      status: "ready",
      params: { sku: "ISO4762-M3x12" },
      artifact: { code: "def build(p): pass", hash: "h", testCode: "" },
    } as (typeof doc.nodes)[string];
    registerBomRoutes(a, () => ({ dir: "/somewhere/projects/my-bracket", backend: { id: "cad" }, store: { doc } }), {} as CadBackend);
    const json = (await a.inject("/api/project/bom")).json();
    expect(json.buy).toHaveLength(1);
    expect(json.buy[0]).toMatchObject({ designation: "ISO 4762 M3×12 socket head cap screw", qty: 1 });
    expect(json.buy[0].orderFrom[0]).toEqual({
      vendor: "McMaster-Carr", kind: "search", url: "https://www.mcmaster.com/ISO%204762%20M3x12%20socket%20head%20cap%20screw",
    });
    expect(json.buy[0].orderFrom.some((o: { pn?: string }) => o.pn)).toBe(false);
    const csv = (await a.inject("/api/project/bom?format=csv")).body.split("\n");
    expect(csv[0]).toContain("designation");
    expect(csv[0]).toContain("verified_pn,search_link");
    expect(csv.find((l) => l.startsWith("buy,"))).toContain("ISO 4762 M3×12 socket head cap screw");
    expect(csv.find((l) => l.startsWith("buy,"))).toContain("https://www.mcmaster.com/ISO%204762%20M3x12%20socket%20head%20cap%20screw");
  });

  it("has no vendor package for an unknown or uncooked part", async () => {
    const a = await app("cad");
    expect((await a.inject("/api/project/parts/nope/vendor-package")).statusCode).toBe(404);
    const dirty = await a.inject("/api/project/parts/plate/vendor-package");
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json().error).toMatch(/gates passed/);
  });
});
