import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import type { Workspace } from "@patchcad/engine";
import { CadBackend } from "./index.js";
import { KernelClient, type KernelResult } from "./kernel.js";

/** Reach the private start/ready pair without exporting them. */
const spyOnStart = (k: KernelClient) => {
  const calls = { n: 0 };
  const inner = k as unknown as { start: () => Promise<void> };
  inner.start = async () => {
    calls.n += 1;
    await new Promise((r) => setTimeout(r, 20)); // a real spawn is not instant
  };
  return calls;
};
const ready = (k: KernelClient) =>
  (k as unknown as { ready: () => Promise<void> }).ready.call(k);

describe("KernelClient start memoization", () => {
  it("collapses concurrent callers onto one spawn", async () => {
    const k = new KernelClient();
    const calls = spyOnStart(k);
    // Four cook workers hitting a cold kernel. Each used to see
    // `kernelStarted === false` and run `uv run`, so three lost the port bind.
    await Promise.all([ready(k), ready(k), ready(k), ready(k)]);
    expect(calls.n).toBe(1);
  });

  it("does not spawn again once started", async () => {
    const k = new KernelClient();
    const calls = spyOnStart(k);
    await ready(k);
    await ready(k);
    await ready(k);
    expect(calls.n).toBe(1);
  });

  it("lets a failed start be retried", async () => {
    const k = new KernelClient();
    let attempts = 0;
    (k as unknown as { start: () => Promise<void> }).start = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("uv not found");
    };
    await expect(ready(k)).rejects.toThrow("uv not found");
    // A memoized rejection would poison the client for the process lifetime.
    await expect(ready(k)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("rejects the start, rather than crashing, when uv cannot be spawned", async () => {
    // No `uv` on PATH and nothing listening: the spawn's 'error' event had no
    // listener and took the whole server down.
    const path = process.env.PATH;
    const url = process.env.PATCHCAD_KERNEL_URL;
    process.env.PATH = "/nonexistent";
    delete process.env.PATCHCAD_KERNEL_URL;
    try {
      const k = new KernelClient(1);
      await expect(k.start(10_000)).rejects.toThrow(/could not start the cad kernel.*uv/);
    } finally {
      process.env.PATH = path;
      if (url !== undefined) process.env.PATCHCAD_KERNEL_URL = url;
    }
  });
});

/** A stub kernel: counts builds and answers with a canned result. */
function stubKernel(result: KernelResult) {
  const calls: { contract: unknown }[] = [];
  const kernel = new KernelClient();
  kernel.execute = async (_code, _params, contract) => {
    calls.push({ contract });
    return result;
  };
  return { kernel, calls };
}

const pose = { origin: [0, 0, 5], zAxis: [0, 0, 1], xAxis: [1, 0, 0] };
const graph = GraphDoc.parse({
  schemaVersion: 1,
  id: "one",
  backend: "cad",
  brief: { goal: "" },
  nodes: {
    plate: {
      id: "plate",
      kind: "part",
      title: "plate",
      spec: "",
      contract: {
        name: "plate",
        summary: "",
        params: [],
        provides: [],
        requires: [],
        payload: {
          units: "mm",
          process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
          ports: ["a", "b", "c", "d"].map((name) => ({ name, type: "BORE", pose, params: { diameter: 4 } })),
          envelope: { volumes: [{ kind: "box", pose, dims: [50, 50, 10] }], clearance: 0.4 },
        },
        hash: "",
      },
      params: {},
      artifact: { code: "def build(p): pass", testCode: "", hash: "h" },
      thread: [],
      status: "ready",
      version: 1,
      history: [],
      cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
    },
  },
  edges: [],
  assembly: { entryNodeId: "plate" },
  rev: 0,
});
const node = graph.nodes.plate!;
const ws = { root: "/tmp/patchcad-test/plate" } as Workspace;

const twoPortsAndEnvelope: KernelResult = {
  ok: false,
  stage: "G3",
  error: "3 contract failures",
  hint: "",
  failures: [
    { stage: "G3", port: "a", error: 'port "a" (BORE): expected Ø4, measured Ø6.00', hint: "resize a", expected: 4, measured: 6 },
    { stage: "G3", port: "b", error: 'port "b" (BORE): no hole found at the declared origin', hint: "cut b" },
    { stage: "G4", error: "12 mesh vertices escape the declared envelope", hint: "shrink", expected: 0, measured: 3.2 },
  ],
};

describe("CadBackend execute + verify", () => {
  it("builds once per attempt: verify reuses execute's kernel result", async () => {
    const { kernel, calls } = stubKernel(twoPortsAndEnvelope);
    const backend = new CadBackend({ kernel });
    const exec = await backend.execute(node, ws, graph);
    // G0–G2 passed, so execute passes; the contract verdict belongs to verify.
    expect(exec.ok).toBe(true);
    const verify = await backend.verify(node, graph, ws);
    expect(calls).toHaveLength(1);
    expect(verify.ok).toBe(false);
    expect(verify.stage).toBe("G3");
    // Two of four ports failed: 3 + 2/4.
    expect(verify.score).toBe(3.5);
    expect(verify.report).toContain("3 gate failures");
    expect(verify.report).toContain('[G3] port "a"');
    expect(verify.report).toContain('[G3] port "b"');
    expect(verify.report).toContain("[G4] 12 mesh vertices");
  });

  it("calls the kernel again when the code changed between execute and verify", async () => {
    const { kernel, calls } = stubKernel(twoPortsAndEnvelope);
    const backend = new CadBackend({ kernel });
    await backend.execute(node, ws, graph);
    const edited = { ...node, artifact: { ...node.artifact!, code: "def build(p): return 1" } };
    await backend.verify(edited, graph, ws);
    expect(calls).toHaveLength(2);
  });

  it("reports G0–G2 failures from execute, ranked by stage", async () => {
    const { kernel } = stubKernel({ ok: false, stage: "G1", error: "build(p) raised IndexError\nline 5: xs[3]", hint: "" });
    const exec = await new CadBackend({ kernel }).execute(node, ws, graph);
    expect(exec).toMatchObject({ ok: false, stage: "G1", score: 1 });
    expect(exec.report).toContain("line 5");
  });

  it("scores timeouts below a G1 and a pass at the top", async () => {
    const timeout = stubKernel({ ok: false, stage: "TIMEOUT", error: "killed", hint: "" });
    expect((await new CadBackend({ kernel: timeout.kernel }).execute(node, ws, graph)).score).toBe(0.5);
    const pass = stubKernel({
      ok: true,
      hash: "x",
      cached: false,
      glb: "/g",
      measurements: { volume_mm3: 1, area_mm2: 1, solids: 1, bbox: { min: [], max: [], size: [] } },
    });
    const backend = new CadBackend({ kernel: pass.kernel });
    await backend.execute(node, ws, graph);
    expect((await backend.verify(node, graph, ws)).score).toBe(5);
  });

  it("passes a G4c DFM failure through execute to verify, with its port measurements", async () => {
    // Not a contract stage, it came back from execute as a G0-G2 failure and
    // the port probes measured in the same build were dropped.
    const dfm: KernelResult = {
      ok: false,
      stage: "G4c",
      error: 'process cnc "internal_corner": tightest radius 0.00 mm',
      hint: "",
      failures: [{ stage: "G4c", error: 'process cnc "internal_corner": tightest radius 0.00 mm', hint: "" }],
      measurements: { volume_mm3: 1, area_mm2: 1, solids: 1, bbox: { min: [], max: [], size: [] }, ports: [{ key: "a", measured_diameter: 4 }] },
    } as unknown as KernelResult;
    const { kernel, calls } = stubKernel(dfm);
    const backend = new CadBackend({ kernel });
    expect((await backend.execute(node, ws, graph)).ok).toBe(true);
    const verify = await backend.verify(node, graph, ws);
    expect(calls).toHaveLength(1);
    expect(verify).toMatchObject({ ok: false, stage: "G4c" });
  });

  it("sends the contract with execute, envelope included for a generated part", async () => {
    const { kernel, calls } = stubKernel(twoPortsAndEnvelope);
    await new CadBackend({ kernel }).execute(node, ws, graph);
    const contract = calls[0]!.contract as { ports: unknown[]; envelope: unknown[] };
    expect(contract.ports).toHaveLength(4);
    expect(contract.envelope).toHaveLength(1);
  });
});

describe("CadBackend kernel request · assertions", () => {
  const withAssertions = (assertions: unknown[], solids?: number) => {
    const g = structuredClone(graph);
    Object.assign(g.nodes.plate!.contract.payload as object, { assertions, ...(solids ? { solids } : {}) });
    return g;
  };
  const sent = async (g: typeof graph) => {
    const { kernel, calls } = stubKernel({ ok: true, hash: "h", cached: false, glb: "", measurements: { volume_mm3: 1, area_mm2: 1, solids: 1, bbox: { min: [], max: [], size: [] } } });
    await new CadBackend({ kernel }).execute(g.nodes.plate!, ws, g);
    return calls[0]!.contract as { assertions: { kind: string }[]; solids?: number };
  };

  // G2 checks the count first, so an assertion of 2 left in the array would
  // fail G2 at the default of 1 and G4b would never run.
  it("a solids assertion becomes the G2 count and leaves the array", async () => {
    const c = await sent(withAssertions([{ kind: "solids", count: 2 }, { kind: "hole_count", min: 4 }]));
    expect(c.solids).toBe(2);
    expect(c.assertions.map((a) => a.kind)).toEqual(["hole_count"]);
  });

  it("an explicit payload.solids still wins, and no assertion means 1", async () => {
    expect((await sent(withAssertions([{ kind: "solids", count: 2 }], 3))).solids).toBe(3);
    expect((await sent(withAssertions([]))).solids).toBe(1);
  });
});
