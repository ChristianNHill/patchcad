import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { Contract, GraphDoc, type EngineEvent } from "@patchcad/shared";
import { contractHash, EventBus, type DomainBackend, type LlmProvider, type NodeLibrary } from "@patchcad/engine";
import type { CadBackend } from "@patchcad/backend-cad";
import { buildApp } from "./app.js";
import { Session } from "./session.js";

/** Holds execute until released, and counts what ran. */
function fakeBackend(id: string) {
  const calls = { execute: 0, verify: 0, check: 0 };
  let hold: Promise<void> | null = null;
  let release = () => {};
  const backend: DomainBackend<unknown> = {
    id,
    planning: { nodeKinds: [], payloadSchema: z.unknown(), graphLints: [], architectGuidance: "" },
    buildGeneratePrompt: () => ({
      system: "",
      messages: [{ role: "user", content: "go" }],
      schema: z.object({ code: z.string() }),
      role: "generator",
    }),
    buildRepairPrompt: () => {
      throw new Error("no repair in these tests");
    },
    execute: async () => {
      calls.execute += 1;
      await hold;
      return { ok: true, stage: "execute", report: "" };
    },
    verify: async () => {
      calls.verify += 1;
      return { ok: true, stage: "verify", report: "", measurements: { probed: true } };
    },
    classifyFailure: () => "code-invalid",
    assemble: async () => {},
    globalCheck: async () => {
      calls.check += 1;
      return { ok: true, problems: [] };
    },
  };
  return {
    backend,
    calls,
    /** Every execute from now on waits for the returned release. */
    gate() {
      hold = new Promise((r) => (release = r));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

/** Never answers; rejects when the cook is cancelled. */
const hangingProvider: LlmProvider = {
  id: "hang",
  complete: (req) =>
    new Promise((_, reject) => {
      req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
};

const noLibrary: NodeLibrary = { lookup: async () => null, capture: async () => {} };

function graph(id: string) {
  const contract = Contract.parse({
    name: "part",
    summary: "a part",
    params: [{ type: "number", name: "w", description: "width", default: 10 }],
    provides: [],
    requires: [],
    payload: {},
    hash: "",
  });
  contract.hash = contractHash(contract);
  const meta = (version: number, contractHashValue = contract.hash) => ({
    version,
    contractHash: contractHashValue,
    artifactHash: `a${version}`,
    cause: "generated",
    at: 0,
  });
  const node = (nid: string, status: string, history: unknown[]) => ({
    id: nid,
    kind: "part",
    title: nid,
    spec: "",
    contract,
    status,
    version: history.length ? 2 : 0,
    history,
  });
  return GraphDoc.parse({
    schemaVersion: 1,
    id,
    backend: "cad",
    brief: { goal: id, constraints: [], clarifications: [] },
    nodes: {
      part: node("part", "ready", [meta(0), meta(1, "another-contract"), meta(2)]),
      fresh: node("fresh", "planned", []),
    },
    edges: [],
    assembly: { entryNodeId: "part" },
    rev: 0,
  });
}

async function writeProject(root: string, id: string): Promise<string> {
  const dir = path.join(root, id);
  for (const v of [0, 1, 2]) {
    await mkdir(path.join(dir, "nodes", "part"), { recursive: true });
    await writeFile(path.join(dir, "nodes", "part", `v${v}.code.py`), `def build(p):  # v${v}\n    pass\n`);
  }
  await writeFile(path.join(dir, "patchcad.json"), JSON.stringify(graph(id)), "utf8");
  return dir;
}

interface Harness {
  s: Session;
  app: FastifyInstance;
  cad: ReturnType<typeof fakeBackend>;
  events: EngineEvent[];
  dirA: string;
  dirB: string;
}

let open: Harness | null = null;

async function setup(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "patchcad-app-"));
  const projectsRoot = path.join(root, "projects");
  const dirA = await writeProject(projectsRoot, "a");
  const dirB = await writeProject(projectsRoot, "b");
  const bus = new EventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((e) => void events.push(e));
  const cad = fakeBackend("cad");
  const code = fakeBackend("web-code");
  const s = new Session({
    bus,
    backends: { cad: cad.backend, "web-code": code.backend },
    codeBackend: code.backend,
    cadBackend: { kernel: { health: async () => ({ ok: true }), baseUrl: "http://127.0.0.1:9" } } as unknown as CadBackend,
    library: noLibrary,
    resolved: { provider: hangingProvider, source: "test" },
    projectsRoot,
    examplesRoot: path.join(root, "examples"),
  });
  await s.close();
  const app = await buildApp(s);
  open = { s, app, cad, events, dirA, dirB };
  return open;
}

afterEach(async () => {
  if (!open) return;
  for (const ctl of open.s.cookAborts.values()) ctl.abort();
  await open.s.active.watcher.close();
  await open.app.close();
  open = null;
});

const post = (app: FastifyInstance, url: string, payload: unknown = {}) => app.inject({ method: "POST", url, payload: payload as object });
const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}
const status = (h: Harness, nid: string) => h.s.active.store.doc.nodes[nid]?.status;

describe("T0 re-apply", () => {
  it("stops writing to a project switched away from mid-execute", async () => {
    const h = await setup();
    await post(h.app, "/api/project/open", { dir: h.dirA });
    const projectA = h.s.active;
    const release = h.cad.gate();
    expect((await post(h.app, "/api/project/nodes/part/params", { params: { w: 12 } })).statusCode).toBe(200);
    await until(() => h.cad.calls.execute === 1, "the re-execute");

    await post(h.app, "/api/project/open", { dir: h.dirB });
    const checksBefore = h.events.filter((e) => e.type === "checker:status" && e.projectId === "a").length;
    release();
    await tick();

    expect(h.cad.calls.verify).toBe(0);
    expect(projectA.store.doc.nodes.part!.measurements).toBeNull();
    expect(h.events.filter((e) => e.type === "checker:status" && e.projectId === "a")).toHaveLength(checksBefore);
    // The edit itself was persisted before the switch.
    expect(projectA.store.doc.nodes.part!.params.w).toBe(12);
  });

  it("re-probes and re-checks when the project stays open", async () => {
    const h = await setup();
    await post(h.app, "/api/project/open", { dir: h.dirA });
    await post(h.app, "/api/project/nodes/part/params", { params: { w: 12 } });
    await until(() => h.cad.calls.verify === 1, "the re-probe");
    await until(() => h.s.active.store.doc.nodes.part!.measurements !== null, "measurements");
  });
});

describe("undo", () => {
  it("refuses while a T0 re-apply for the project is queued or running", async () => {
    const h = await setup();
    await post(h.app, "/api/project/open", { dir: h.dirA });
    const release = h.cad.gate();
    await post(h.app, "/api/project/nodes/part/params", { params: { w: 12 } });
    await until(() => h.cad.calls.execute === 1, "the re-execute");
    const refused = await post(h.app, "/api/project/undo");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/param edit/);

    release();
    let res = refused;
    for (let i = 0; i < 50 && res.statusCode === 409; i++) {
      await tick();
      res = await post(h.app, "/api/project/undo");
    }
    expect(res.statusCode).toBe(200);
    expect(h.s.active.store.doc.nodes.part!.params.w).toBeUndefined();
  });
});

describe("revert", () => {
  it("refuses a node that is cooking", async () => {
    const h = await setup();
    await post(h.app, "/api/project/open", { dir: h.dirA });
    h.s.active.store.setStatus("part", "dirty");
    h.s.active.store.setStatus("part", "queued");
    const res = await post(h.app, "/api/project/nodes/part/revert", { version: 0 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/cooking/);
  });

  it("refuses a version built against another contract", async () => {
    const h = await setup();
    await post(h.app, "/api/project/open", { dir: h.dirA });
    const res = await post(h.app, "/api/project/nodes/part/revert", { version: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/different contract/);
  });

  it("refuses when the project changes while the old code is verified", async () => {
    const h = await setup();
    await post(h.app, "/api/project/open", { dir: h.dirA });
    const release = h.cad.gate();
    const pending = post(h.app, "/api/project/nodes/part/revert", { version: 0 });
    await until(() => h.cad.calls.execute === 1, "the gauntlet");
    await post(h.app, "/api/project/open", { dir: h.dirB });
    release();
    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/changed while/);
  });

  it("reverts when nothing moved", async () => {
    const h = await setup();
    await post(h.app, "/api/project/open", { dir: h.dirA });
    const res = await post(h.app, "/api/project/nodes/part/revert", { version: 0 });
    expect(res.statusCode).toBe(200);
    expect(h.s.active.store.doc.nodes.part!.version).toBe(0);
    expect(h.s.active.store.doc.nodes.part!.artifact?.code).toContain("# v0");
  });
});

describe("cooks", () => {
  async function cooking(h: Harness) {
    await post(h.app, "/api/project/open", { dir: h.dirA });
    const res = await post(h.app, "/api/project/cook-dirty");
    expect(res.json().cooking).toEqual(["fresh"]);
    await until(() => status(h, "fresh") === "generating", "fresh to generate");
  }

  it("refuses a reprompt of a node that is already cooking", async () => {
    const h = await setup();
    await cooking(h);
    const res = await post(h.app, "/api/project/nodes/fresh/reprompt", { message: "make it wider", tier: "T2" });
    expect(res.statusCode).toBe(409);
  });

  it("refuses graph surgery while the project cooks", async () => {
    const h = await setup();
    await cooking(h);
    const contract = h.s.active.store.doc.nodes.part!.contract;
    const put = await h.app.inject({ method: "PUT", url: "/api/project/nodes/part/contract", payload: { contract: { ...contract, summary: "changed" } } });
    expect(put.statusCode).toBe(409);
    expect((await post(h.app, "/api/project/nodes/part/segment")).statusCode).toBe(409);
    expect((await h.app.inject({ method: "DELETE", url: "/api/project/nodes/part" })).statusCode).toBe(409);
  });

  it("cancels the active project's cook", async () => {
    const h = await setup();
    await cooking(h);
    const res = await post(h.app, "/api/project/cook/cancel");
    expect(res.json()).toEqual({ ok: true, cancelled: ["fresh"] });
    expect(status(h, "fresh")).toBe("cancelled");
    await until(() => h.s.liveCooks.size === 0, "the cook to settle");
    expect((await post(h.app, "/api/project/cook/cancel")).statusCode).toBe(409);
  });

  it("reopens a background project's live store instead of loading a second one", async () => {
    const h = await setup();
    await cooking(h);
    const projectA = h.s.active;
    await post(h.app, "/api/project/open", { dir: h.dirB });
    await post(h.app, "/api/project/open", { dir: h.dirA });
    expect(h.s.active).toBe(projectA);
    // Not normalized to "interrupted": the cook is still running.
    expect(status(h, "fresh")).toBe("generating");
  });

  it("cancels a background project's cook by id", async () => {
    const h = await setup();
    await cooking(h);
    const projectA = h.s.active;
    await post(h.app, "/api/project/open", { dir: h.dirB });
    const res = await post(h.app, "/api/project/cook/cancel", { projectId: "a" });
    expect(res.json()).toEqual({ ok: true, cancelled: ["fresh"] });
    expect(projectA.store.doc.nodes.fresh!.status).toBe("cancelled");
    await until(() => !h.s.liveCooks.has(h.dirA), "the background cook to settle");
    // B was never cooking.
    expect((await post(h.app, "/api/project/cook/cancel")).statusCode).toBe(409);
  });
});
