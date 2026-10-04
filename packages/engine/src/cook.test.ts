import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GraphDoc, hashValue } from "@patchcad/shared";
import { ASSEMBLY_STAGE, applyCheck, checkStatus, cookNodes, cookOne, type CookDeps } from "./cook.js";
import { EventBus } from "./events.js";
import { GraphStore } from "./graph/store.js";
import type { DomainBackend, GenerateCtx, RepairCtx } from "./backend.js";
import { LlmCallError, type LlmImage, type LlmProvider } from "./llm.js";
import type { LibraryEntry, LibraryListing, NodeLibrary } from "./library.js";

/** The library fast path must never reach the generator; capture must run on
 * a fresh generate; specialized nodes (non-empty thread) opt out of both. */

function makeGraph(thread: { role: "user"; content: string; at: number }[] = []) {
  return GraphDoc.parse({
    schemaVersion: 1,
    id: "test",
    backend: "mock",
    brief: { goal: "test", constraints: [], clarifications: [] },
    nodes: {
      widget: {
        id: "widget",
        kind: "component",
        title: "Widget",
        spec: "a widget",
        contract: {
          name: "Widget",
          summary: "a widget",
          params: [],
          provides: [{ key: "Widget", type: "component", description: "" }],
          requires: [],
          payload: {},
          hash: "",
        },
        params: {},
        artifact: null,
        thread,
        status: "planned",
        version: 0,
        history: [],
        cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
      },
    },
    edges: [],
    assembly: { entryNodeId: "widget" },
    rev: 0,
  });
}

const mockBackend: DomainBackend<unknown> = {
  id: "mock",
  planning: {
    nodeKinds: [],
    payloadSchema: z.unknown(),
    graphLints: [],
    architectGuidance: "",
  },
  buildGeneratePrompt: () => ({
    system: "",
    messages: [{ role: "user", content: "go" }],
    schema: z.object({ code: z.string(), testCode: z.string().optional() }),
    role: "generator",
  }),
  buildRepairPrompt: () => {
    throw new Error("repair not expected in these tests");
  },
  execute: async () => ({ ok: true, stage: "execute", report: "" }),
  verify: async () => ({ ok: true, stage: "verify", report: "" }),
  classifyFailure: () => "code-invalid",
  assemble: async () => {},
  previewAdapter: {
    start: async () => ({ url: "" }),
    hotSwap: async () => {},
    stop: async () => {},
  },
  globalCheck: async () => ({ ok: true, problems: [] }),
};

class MemoryLibrary implements NodeLibrary {
  entries = new Map<string, LibraryEntry>();
  captures = 0;
  async lookup(backendId: string, hash: string) {
    return this.entries.get(`${backendId}/${hash}`) ?? null;
  }
  async capture(backendId: string, hash: string, entry: LibraryEntry) {
    this.captures += 1;
    this.entries.set(`${backendId}/${hash}`, entry);
  }
}

const trapProvider: LlmProvider = {
  id: "trap",
  complete: () => {
    throw new Error("generator LLM called — library fast path failed");
  },
};

function makeDeps(
  graph: GraphDoc,
  provider: LlmProvider,
  library: NodeLibrary,
  backend: DomainBackend<unknown> = mockBackend,
): CookDeps {
  const store = new GraphStore(graph, new EventBus(), async () => {});
  return { store, backend, provider, workspace: { root: "/tmp/x" }, library };
}

/** A backend whose execute fails `failTimes` times before passing, recording
 *  every repair context and the evidence it is finally judged on. */
function makeRepairBackend(opts: { failTimes: number; maxAttempts?: number }) {
  const repairs: RepairCtx<unknown>[] = [];
  let evidence: { failures: { stage: string; report: string }[]; attempts: number } | null = null;
  let executes = 0;
  const backend: DomainBackend<unknown> = {
    ...mockBackend,
    maxAttempts: opts.maxAttempts,
    buildRepairPrompt: (ctx) => {
      repairs.push(ctx);
      return { ...mockBackend.buildGeneratePrompt(ctx), role: "repair" };
    },
    execute: async () => {
      executes += 1;
      return executes <= opts.failTimes
        ? { ok: false, stage: "G2", report: `boom ${executes}` }
        : { ok: true, stage: "execute", report: "" };
    },
    classifyFailure: (e) => {
      evidence = { failures: e.failures, attempts: e.attempts };
      return "code-invalid";
    },
  };
  return {
    backend,
    repairs,
    get evidence() {
      return evidence;
    },
    get executes() {
      return executes;
    },
  };
}

const stubProvider: LlmProvider = {
  id: "stub",
  complete: async () =>
    ({ data: { code: "x" }, usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "stub" }) as never,
};

/** A provider that returns a completion with no code — the failure CLAUDE.md
 *  records as "reasoning models can spend the whole max_tokens budget thinking". */
const emptyProvider = (code: string): LlmProvider => ({
  id: "empty",
  complete: async () =>
    ({ data: { code }, usage: { inputTokens: 1, outputTokens: 9999, usd: 0 }, model: "empty" }) as never,
});

describe("cookOne empty-completion guard", () => {
  it("spends ONE round on an empty completion, not the whole budget", async () => {
    const h = makeRepairBackend({ failTimes: 0, maxAttempts: 5 });
    const deps = makeDeps(makeGraph(), emptyProvider(""), new MemoryLibrary(), h.backend);

    await expect(cookOne(deps, "widget")).rejects.toThrow(/empty completion/);
    // The gates never ran: an empty artifact is a provider problem, and the
    // kernel round trip it used to buy only produced a confusing G0 report.
    expect(h.executes).toBe(0);
    expect(h.repairs).toHaveLength(0);
  });

  it("treats whitespace-only code as empty", async () => {
    const h = makeRepairBackend({ failTimes: 0, maxAttempts: 5 });
    const deps = makeDeps(makeGraph(), emptyProvider("\n  \n"), new MemoryLibrary(), h.backend);
    await expect(cookOne(deps, "widget")).rejects.toThrow(/empty completion/);
    expect(h.executes).toBe(0);
  });

  it("lands the node resumable, and still bills the call that happened", async () => {
    const h = makeRepairBackend({ failTimes: 0, maxAttempts: 5 });
    const deps = makeDeps(makeGraph(), emptyProvider(""), new MemoryLibrary(), h.backend);

    await expect(cookOne(deps, "widget")).rejects.toThrow();
    const node = deps.store.node("widget");
    // error_code is what cook-dirty picks back up.
    expect(node.status).toBe("error_code");
    expect(node.cost.calls).toBe(1);
    expect(node.cost.outputTokens).toBe(9999);
  });

  it("bills a failed call that carries its usage, even when every candidate fails", async () => {
    const h = makeRepairBackend({ failTimes: 0, maxAttempts: 5 });
    const failing: LlmProvider = {
      id: "failing",
      complete: async () => {
        throw new LlmCallError("error_max_turns", { inputTokens: 10, outputTokens: 20, usd: 0.1 });
      },
    };
    const deps = makeDeps(makeGraph(), failing, new MemoryLibrary(), h.backend);
    await expect(cookOne(deps, "widget")).rejects.toThrow(/error_max_turns/);
    const node = deps.store.node("widget");
    expect(node.status).toBe("error_code");
    expect(node.cost.calls).toBe(1);
    expect(node.cost.usd).toBeCloseTo(0.1);
  });
});

describe("cookOne repair budget", () => {
  it("takes the engine default of 3 rounds when the backend states none", async () => {
    const h = makeRepairBackend({ failTimes: 99 });
    const deps = makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), h.backend);

    await expect(cookOne(deps, "widget")).rejects.toThrow(/after 3 attempts/);
    expect(h.executes).toBe(3);
    // 3 generation rounds is 1 generate + 2 repairs, not 3 repairs.
    expect(h.repairs).toHaveLength(2);
  });

  it("honours a backend that asks for more rounds", async () => {
    const h = makeRepairBackend({ failTimes: 99, maxAttempts: 5 });
    const deps = makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), h.backend);

    await expect(cookOne(deps, "widget")).rejects.toThrow(/after 5 attempts/);
    expect(h.executes).toBe(5);
    expect(h.repairs).toHaveLength(4);
  });

  it("recovers within the widened budget where the default would have failed", async () => {
    // 4 failures then success: unreachable at 3 rounds, fine at 5.
    const h = makeRepairBackend({ failTimes: 4, maxAttempts: 5 });
    const deps = makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), h.backend);

    await cookOne(deps, "widget");
    const node = deps.store.node("widget");
    expect(node.status).toBe("ready");
    expect(node.history[0]?.cause).toBe("repair-5");
  });

  it("tells classifyFailure the resolved budget, not the engine constant", async () => {
    const h = makeRepairBackend({ failTimes: 99, maxAttempts: 5 });
    const deps = makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), h.backend);

    await expect(cookOne(deps, "widget")).rejects.toThrow();
    expect(h.evidence?.attempts).toBe(5);
    expect(h.evidence?.failures).toHaveLength(5);
  });

  it("gives each repair its attempt number, budget, and every earlier failure", async () => {
    const h = makeRepairBackend({ failTimes: 99, maxAttempts: 4 });
    const deps = makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), h.backend);

    await expect(cookOne(deps, "widget")).rejects.toThrow();
    expect(h.repairs.map((r) => r.attempt)).toEqual([2, 3, 4]);
    expect(h.repairs.every((r) => r.maxAttempts === 4)).toBe(true);
    // The latest failure rides `failure`; `priorFailures` holds the rest, so
    // the two together are every failure so far with none duplicated.
    expect(h.repairs[0]!.priorFailures).toEqual([]);
    expect(h.repairs[0]!.failure.report).toBe("boom 1");
    expect(h.repairs[2]!.priorFailures.map((f) => f.report)).toEqual(["boom 1", "boom 2"]);
    expect(h.repairs[2]!.failure.report).toBe("boom 3");
  });
});

describe("cookOne exemplar mining", () => {
  class ListLibrary extends MemoryLibrary {
    listing: LibraryListing[] = [];
    async list() {
      return this.listing;
    }
  }

  const seenExemplars: string[][] = [];
  const recordingBackend: DomainBackend<unknown> = {
    ...mockBackend,
    buildGeneratePrompt: (ctx) => {
      seenExemplars.push((ctx.exemplars ?? []).map((e) => e.title));
      return mockBackend.buildGeneratePrompt(ctx);
    },
  };

  it("hands verified library entries to the generator", async () => {
    seenExemplars.length = 0;
    const library = new ListLibrary();
    library.listing = [
      {
        contractHash: "elsewhere",
        // Over MIN_EXEMPLAR_CHARS: a one-liner is a deterministic stub, not an example.
        code: "export function Widget() {\n  return null;\n}\n".repeat(6),
        testCode: "",
        kind: "component",
        title: "Widget From Elsewhere",
        contract: { name: "W", summary: "", params: [], provides: [], requires: [], payload: {}, hash: "elsewhere" },
      },
    ];
    const deps = makeDeps(makeGraph(), stubProvider, library, recordingBackend);
    await cookOne(deps, "widget");
    expect(seenExemplars[0]).toEqual(["Widget From Elsewhere"]);
  });

  it("captures the contract alongside the code, so the entry can be an example later", async () => {
    const library = new MemoryLibrary();
    const deps = makeDeps(makeGraph(), stubProvider, library);
    await cookOne(deps, "widget");
    await new Promise((r) => setTimeout(r, 0));

    const stored = await library.lookup("mock", deps.store.node("widget").contract.hash);
    expect(stored?.contract).toMatchObject({ name: "Widget" });
  });

  it("mines nothing for a specialized node — it neither reuses nor captures", async () => {
    seenExemplars.length = 0;
    const library = new ListLibrary();
    library.listing = [
      {
        contractHash: "elsewhere",
        // Over MIN_EXEMPLAR_CHARS: a one-liner is a deterministic stub, not an example.
        code: "export function Widget() {\n  return null;\n}\n".repeat(6),
        testCode: "",
        kind: "component",
        title: "Should not appear",
        contract: { name: "W", summary: "", params: [], provides: [], requires: [], payload: {}, hash: "elsewhere" },
      },
    ];
    const graph = makeGraph([{ role: "user", content: "make it teal", at: 1 }]);
    await cookOne(makeDeps(graph, stubProvider, library, recordingBackend), "widget");
    expect(seenExemplars[0]).toEqual([]);
  });
});

describe("cookOne measurement capture", () => {
  const measuring = (measurements: unknown): DomainBackend<unknown> => ({
    ...mockBackend,
    verify: async () => ({ ok: true, stage: "verify", report: "", measurements }),
  });

  it("keeps what a passing verify measured, stamped with version and params", async () => {
    const graph = makeGraph();
    const deps = makeDeps(graph, stubProvider, new MemoryLibrary(), measuring({ volume_mm3: 42 }));
    await cookOne(deps, "widget");

    const node = deps.store.node("widget");
    // Stamped AFTER commit, so it names the version it actually describes.
    expect(node.measurements).toMatchObject({ version: 1, data: { volume_mm3: 42 } });
    expect(node.version).toBe(1);
    expect(node.measurements?.paramsHash).toBe(hashValue(node.params));
  });

  it("records nothing when the backend measures nothing", async () => {
    const deps = makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), measuring(undefined));
    await cookOne(deps, "widget");
    expect(deps.store.node("widget").measurements).toBeNull();
  });

  it("captures on the library fast path too, not only on a fresh generate", async () => {
    const graph = makeGraph();
    const library = new MemoryLibrary();
    // trapProvider proves this path never reaches the generator.
    const deps = makeDeps(graph, trapProvider, library, measuring({ volume_mm3: 7 }));
    const hash = deps.store.node("widget").contract.hash;
    library.entries.set(`mock/${hash}`, { code: "cached", testCode: "", kind: "component", title: "Widget" });

    await cookOne(deps, "widget");
    const node = deps.store.node("widget");
    expect(node.history[0]?.cause).toBe("library");
    expect(node.measurements).toMatchObject({ version: 1, data: { volume_mm3: 7 } });
  });

  it("leaves the contract hash alone", async () => {
    // Measurements are advisory display data: if they moved the hash they
    // would dirty the node they describe.
    const deps = makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), measuring({ volume_mm3: 1 }));
    const before = deps.store.node("widget").contract.hash;
    await cookOne(deps, "widget");
    expect(deps.store.node("widget").contract.hash).toBe(before);
  });
});

describe("cookOne library integration", () => {
  it("commits a library hit without any LLM call", async () => {
    const graph = makeGraph();
    const library = new MemoryLibrary();
    const deps = makeDeps(graph, trapProvider, library);
    const hash = deps.store.node("widget").contract.hash;
    library.entries.set(`mock/${hash}`, { code: "cached", testCode: "", kind: "component", title: "Widget" });

    await cookOne(deps, "widget");
    const node = deps.store.node("widget");
    expect(node.status).toBe("ready");
    expect(node.version).toBe(1);
    expect(node.artifact?.code).toBe("cached");
    expect(node.history[0]?.cause).toBe("library");
    expect(node.cost.calls).toBe(0);
  });

  it("captures freshly generated code into the library", async () => {
    const graph = makeGraph();
    const library = new MemoryLibrary();
    const generator: LlmProvider = {
      id: "stub",
      complete: async () =>
        ({ data: { code: "fresh" }, usage: { inputTokens: 10, outputTokens: 5, usd: 0 }, model: "stub" }) as never,
    };
    const deps = makeDeps(graph, generator, library);
    await cookOne(deps, "widget");

    const node = deps.store.node("widget");
    expect(node.history[0]?.cause).toBe("generate");
    // capture is fire-and-forget; give the microtask a beat
    await new Promise((r) => setTimeout(r, 0));
    expect(library.captures).toBe(1);
    expect(await library.lookup("mock", node.contract.hash)).toMatchObject({ code: "fresh" });
  });

  it("skips the library entirely for specialized nodes (non-empty thread)", async () => {
    const graph = makeGraph([{ role: "user", content: "make it teal", at: 1 }]);
    const library = new MemoryLibrary();
    let generatorCalled = false;
    const generator: LlmProvider = {
      id: "stub",
      complete: async () => {
        generatorCalled = true;
        return { data: { code: "custom" }, usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "stub" } as never;
      },
    };
    const deps = makeDeps(graph, generator, library);
    const hash = deps.store.node("widget").contract.hash;
    library.entries.set(`mock/${hash}`, { code: "cached", testCode: "", kind: "component", title: "Widget" });

    await cookOne(deps, "widget");
    await new Promise((r) => setTimeout(r, 0));
    expect(generatorCalled).toBe(true);
    expect(deps.store.node("widget").artifact?.code).toBe("custom");
    // ...and specialized results must not pollute the shared library.
    expect((await library.lookup("mock", hash))?.code).toBe("cached");
  });
});

describe("cookOne cancellation", () => {
  /** Stopping a doomed cook used to mean killing the server process. The
   *  signal existed on CookDeps and nothing passed it. */
  it("stops before spending another generation round", async () => {
    const controller = new AbortController();
    let calls = 0;
    const counting: LlmProvider = {
      id: "counting",
      complete: async () => {
        calls += 1;
        controller.abort(); // caller cancels while the first call is in flight
        return { data: { code: "x" }, usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "stub" } as never;
      },
    };
    const failing: DomainBackend<unknown> = {
      ...mockBackend,
      maxAttempts: 5,
      buildRepairPrompt: (ctx) => ({ ...mockBackend.buildGeneratePrompt(ctx), role: "repair" }),
      execute: async () => ({ ok: false, stage: "G2", report: "boom" }),
    };
    const deps = { ...makeDeps(makeGraph(), counting, new MemoryLibrary(), failing), signal: controller.signal };

    await expect(cookOne(deps, "widget")).rejects.toThrow(/cancelled/);
    // Without the signal this backend would have burned all 5 rounds.
    expect(calls).toBe(1);
  });

  it("leaves a cancelled node in a state the machine can resume from", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = { ...makeDeps(makeGraph(), stubProvider, new MemoryLibrary()), signal: controller.signal };

    await expect(cookOne(deps, "widget")).rejects.toThrow(/cancelled/);
    // `cancelled` is legal from every in-flight status and leads back to
    // `queued`, which is what makes cook-dirty able to pick the node up again.
    expect(() => deps.store.setStatus("widget", "cancelled")).not.toThrow();
    expect(() => deps.store.setStatus("widget", "queued")).not.toThrow();
  });
});

describe("cookOne near-match reuse", () => {
  class ListLibrary extends MemoryLibrary {
    listing: LibraryListing[] = [];
    async list() {
      return this.listing;
    }
  }

  const near = (over: Partial<LibraryListing> = {}): LibraryListing => ({
    contractHash: "somewhere-else",
    code: "export const Widget = 1;",
    testCode: "",
    kind: "component",
    title: "A Similar Widget",
    // Same port type as the graph fixture's node, no params of its own.
    contract: {
      name: "W", summary: "", params: [], requires: [], payload: {}, hash: "somewhere-else",
      provides: [{ key: "Anything", type: "component", description: "" }],
    },
    ...over,
  });

  it("commits a near match without calling the generator", async () => {
    const library = new ListLibrary();
    library.listing = [near()];
    // trapProvider throws if the generator is reached at all.
    const deps = makeDeps(makeGraph(), trapProvider, library);
    await cookOne(deps, "widget");

    const node = deps.store.node("widget");
    expect(node.status).toBe("ready");
    expect(node.history[0]?.cause).toBe("library-near");
    expect(node.artifact?.code).toBe("export const Widget = 1;");
    expect(node.cost.calls).toBe(0);
  });

  it("falls through to the generator when the near match fails its gates", async () => {
    const library = new ListLibrary();
    library.listing = [near()];
    let generated = false;
    const provider: LlmProvider = {
      id: "stub",
      complete: async () => {
        generated = true;
        return { data: { code: "fresh" }, usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "stub" } as never;
      },
    };
    // A near match is a guess; the gates are what make guessing safe.
    let firstVerify = true;
    const picky: DomainBackend<unknown> = {
      ...mockBackend,
      verify: async () => {
        if (firstVerify) {
          firstVerify = false;
          return { ok: false, stage: "G3", report: "not this contract" };
        }
        return { ok: true, stage: "verify", report: "" };
      },
    };
    const deps = makeDeps(makeGraph(), provider, library, picky);
    await cookOne(deps, "widget");

    expect(generated).toBe(true);
    expect(deps.store.node("widget").artifact?.code).toBe("fresh");
    expect(deps.store.node("widget").history[0]?.cause).toBe("generate");
  });
});

describe("cookOne regate (dirty wave)", () => {
  /** A node cooked once, then dirtied by a neighbour's contract change. */
  async function cookedThenDirty(backend: DomainBackend<unknown> = mockBackend) {
    // No library: its exact hit would answer before the generator does.
    const deps = { ...makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), backend), library: undefined };
    await cookOne(deps, "widget");
    deps.store.setStatus("widget", "dirty");
    return deps;
  }

  it("commits the code it already has when it still passes, with no LLM call", async () => {
    const deps = await cookedThenDirty();
    await cookOne({ ...deps, provider: trapProvider }, "widget");
    const node = deps.store.node("widget");
    expect(node.status).toBe("ready");
    expect(node.history.map((h) => h.cause)).toEqual(["generate", "regate"]);
    expect(node.cost.calls).toBe(1);
  });

  it("regenerates when the existing code fails the current contract", async () => {
    let verifies = 0;
    const deps = await cookedThenDirty({
      ...mockBackend,
      // Passes the first cook, fails the regate, passes the regeneration.
      verify: async () => (++verifies === 2 ? { ok: false, stage: "G3", report: "port moved" } : { ok: true, stage: "verify", report: "" }),
    });
    await cookOne(deps, "widget");
    expect(deps.store.node("widget").history.map((h) => h.cause)).toEqual(["generate", "generate"]);
    expect(deps.store.node("widget").cost.calls).toBe(2);
  });

  it("never regates over a user's reprompt — they asked for new code", async () => {
    const deps = await cookedThenDirty();
    const after = deps.store.node("widget").history.at(-1)!.at + 1;
    deps.store.applyOp((g) => {
      g.nodes.widget!.thread.push({ role: "user", content: "make it rounder", at: after });
    });
    await cookOne(deps, "widget");
    expect(deps.store.node("widget").history.map((h) => h.cause)).toEqual(["generate", "generate"]);
  });

  it("regenerates when a person edited this node's own contract", async () => {
    const deps = await cookedThenDirty();
    deps.store.applyOp((g) => {
      g.nodes.widget!.contract = { ...g.nodes.widget!.contract, summary: "a bigger widget" };
    });
    deps.store.recomputeAllContractHashes();
    await cookOne(deps, "widget");
    expect(deps.store.node("widget").history.map((h) => h.cause)).toEqual(["generate", "generate"]);
  });

  it("still regates a contract that plan expansion rewrote, with no LLM call", async () => {
    const deps = await cookedThenDirty();
    deps.store.applyOp((g) => {
      g.nodes.widget!.contract = { ...g.nodes.widget!.contract, summary: "re-expanded" };
    });
    deps.store.recomputeAllContractHashes();
    deps.store.applyOp((g) => {
      g.nodes.widget!.expandedContractHash = g.nodes.widget!.contract.hash;
    });
    await cookOne({ ...deps, provider: trapProvider }, "widget");
    expect(deps.store.node("widget").history.map((h) => h.cause)).toEqual(["generate", "regate"]);
  });

  it("does not regate a failed draft that was never committed", async () => {
    const deps = makeDeps(makeGraph(), stubProvider, new MemoryLibrary());
    deps.store.applyOp((g) => {
      g.nodes.widget!.artifact = { code: "half-done", testCode: "", hash: hashValue("half-done") };
    });
    await cookOne(deps, "widget");
    expect(deps.store.node("widget").history.map((h) => h.cause)).toEqual(["generate"]);
  });
});

describe("cookOne library outcome stats", () => {
  class StatsLibrary extends MemoryLibrary {
    reuses: string[] = [];
    fixes: { stage: string; report: string }[] = [];
    async recordReuse(_b: string, hash: string) {
      this.reuses.push(hash);
    }
    async recordFix(_b: string, fix: { stage: string; report: string }) {
      this.fixes.push(fix);
    }
  }

  it("counts a reuse when a library hit commits", async () => {
    const graph = makeGraph();
    const library = new StatsLibrary();
    const deps = makeDeps(graph, trapProvider, library);
    const hash = deps.store.node("widget").contract.hash;
    library.entries.set(`mock/${hash}`, { code: "cached", testCode: "", kind: "component", title: "Widget" });
    await cookOne(deps, "widget");
    expect(library.reuses).toEqual([hash]);
  });

  it("records the rounds a captured entry took to pass", async () => {
    const h = makeRepairBackend({ failTimes: 1 });
    const library = new StatsLibrary();
    const deps = makeDeps(makeGraph(), stubProvider, library, h.backend);
    await cookOne(deps, "widget");
    expect([...library.entries.values()][0]?.attemptsToPass).toBe(2);
  });

  it("records the failure a repair cleared, and no code", async () => {
    let n = 0;
    const provider: LlmProvider = {
      id: "stub",
      complete: async () =>
        ({ data: { code: `line a\nline ${++n}` }, usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "stub" }) as never,
    };
    const h = makeRepairBackend({ failTimes: 1 });
    const library = new StatsLibrary();
    await cookOne(makeDeps(makeGraph(), provider, library, h.backend), "widget");
    expect(library.fixes).toEqual([{ stage: "G2", report: "boom 1" }]);
  });
});

describe("cookOne render-assisted repair", () => {
  const img = { mediaType: "image/png" as const, dataB64: "iVBORw0KGgo=" };

  function seeingBackend(opts: { render?: typeof img | null; throws?: boolean }) {
    const seen: (LlmImage | undefined)[] = [];
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      maxAttempts: 3,
      renderStages: ["G3", "G4"],
      renderArtifact: async () => {
        if (opts.throws) throw new Error("kernel down");
        return opts.render ?? null;
      },
      buildRepairPrompt: (ctx) => {
        seen.push(ctx.render);
        return { ...mockBackend.buildGeneratePrompt(ctx), role: "repair" };
      },
      execute: async () => ({ ok: false, stage: "G3", report: "wrong bore" }),
    };
    return { backend, seen };
  }

  it("shows the model what it built, on repairs only", async () => {
    const h = seeingBackend({ render: img });
    const deps = makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), h.backend);
    await expect(cookOne(deps, "widget")).rejects.toThrow();
    // Attempt 1 is a fresh generate — there is nothing built yet to look at.
    expect(h.seen).toEqual([img, img]);
  });

  it("repairs text-only when the artifact cannot be rendered", async () => {
    // A part that failed to execute has no shape to show; the round must
    // still happen.
    const h = seeingBackend({ render: null });
    const deps = makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), h.backend);
    await expect(cookOne(deps, "widget")).rejects.toThrow();
    expect(h.seen).toEqual([undefined, undefined]);
  });

  it("never lets a render failure cost the repair round", async () => {
    const h = seeingBackend({ throws: true });
    const deps = makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), h.backend);
    await expect(cookOne(deps, "widget")).rejects.toThrow(/after 3 attempts/);
    expect(h.seen).toHaveLength(2);
  });
});

describe("cookOne inspect step (write → render → inspect → rewrite)", () => {
  const img = { mediaType: "image/png" as const, dataB64: "iVBORw0KGgo=" };
  const yes = { answers: [{ question: "Is the opening on top?", answer: "yes", evidence: "top view" }] };
  const no = { answers: [{ question: "Is the opening on top?", answer: "no", evidence: "top view is solid" }] };

  /** The architect's yes/no questions, pinned in the contract payload. */
  const checked = (checks: string[] = ["Is the opening on top?"]) => {
    const g = makeGraph();
    g.nodes.widget!.contract.payload = { visualChecks: checks };
    return g;
  };

  /** Passes every gate; a vision call answers the visual checks. */
  function inspecting(verdicts: unknown[]) {
    let generated = 0;
    let renders = 0;
    const inspectRoles: string[] = [];
    const provider: LlmProvider = {
      id: "stub",
      complete: async (req) => {
        const zero = { inputTokens: 1, outputTokens: 1, usd: 0 };
        if (req.label.startsWith("inspect:")) {
          inspectRoles.push(req.role);
          const verdict = verdicts.shift() ?? yes;
          return { data: (req.schema as { parse: (v: unknown) => unknown }).parse(verdict), usage: zero, model: "stub" } as never;
        }
        generated += 1;
        return { data: { code: `code-${generated}` }, usage: zero, model: "stub" } as never;
      },
    };
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      maxAttempts: 3,
      renderArtifact: async () => {
        renders += 1;
        return img;
      },
      buildRepairPrompt: (ctx) => ({ ...mockBackend.buildGeneratePrompt(ctx), role: "repair" }),
    };
    return { provider, backend, generations: () => generated, renders: () => renders, inspectRoles };
  }

  it("commits straight away when every check answers yes", async () => {
    const h = inspecting([yes]);
    const deps = { ...makeDeps(checked(), h.provider, new MemoryLibrary(), h.backend), inspect: true };
    await cookOne(deps, "widget");
    expect(deps.store.node("widget").history[0]?.cause).toBe("generate");
    expect(h.generations()).toBe(1);
    // The judge is not the generator's model on any shipped default.
    expect(h.inspectRoles).toEqual(["classifier"]);
  });

  it("buys one rewrite when a check answers no", async () => {
    const h = inspecting([no, yes]);
    const deps = { ...makeDeps(checked(), h.provider, new MemoryLibrary(), h.backend), inspect: true };
    await cookOne(deps, "widget");
    const node = deps.store.node("widget");
    expect(node.status).toBe("ready");
    expect(node.history[0]?.cause).toBe("repair-2");
    expect(node.artifact?.code).toBe("code-2");
  });

  it("takes the gate-passing code when the rewrite also looks wrong", async () => {
    // Appearance NEVER fails a node. One opinion, one round, then ship what
    // passes the gates.
    const h = inspecting([no, no]);
    const deps = { ...makeDeps(checked(), h.provider, new MemoryLibrary(), h.backend), inspect: true };
    await cookOne(deps, "widget");
    expect(deps.store.node("widget").status).toBe("ready");
    expect(deps.store.node("widget").history[0]?.cause).toBe("repair-2");
  });

  it("never rewrites on unsure", async () => {
    const h = inspecting([{ answers: [{ question: "Is the opening on top?", answer: "unsure", evidence: "hidden" }] }]);
    const deps = { ...makeDeps(checked(), h.provider, new MemoryLibrary(), h.backend), inspect: true };
    await cookOne(deps, "widget");
    expect(h.generations()).toBe(1);
  });

  it("skips the render and the call when the contract asks no questions", async () => {
    const h = inspecting([no]);
    const deps = { ...makeDeps(makeGraph(), h.provider, new MemoryLibrary(), h.backend), inspect: true };
    await cookOne(deps, "widget");
    expect(h.generations()).toBe(1);
    expect(h.renders()).toBe(0);
    expect(h.inspectRoles).toEqual([]);
  });

  it("always looks at a library near-match, and regenerates when it looks wrong", async () => {
    const h = inspecting([no, yes]);
    const library = new (class extends MemoryLibrary {
      async list() {
        return [{
          contractHash: "elsewhere", code: "borrowed", testCode: "", kind: "component", title: "Widget",
          contract: { name: "W", summary: "", params: [], requires: [], payload: {}, hash: "elsewhere",
            provides: [{ key: "Any", type: "component", description: "" }] },
        }];
      }
    })();
    const deps = { ...makeDeps(checked(), h.provider, library, h.backend), inspect: true };
    await cookOne(deps, "widget");
    expect(h.generations()).toBe(1);
    expect(deps.store.node("widget").history[0]?.cause).toBe("generate");
  });

  it("looks at the next passing candidate before spending a round", async () => {
    const h = inspecting([no, yes]);
    const backend = { ...h.backend, generation: { firstRoundCandidates: 2 } };
    const deps = { ...makeDeps(checked(), h.provider, new MemoryLibrary(), backend), inspect: true };
    await cookOne(deps, "widget");
    const node = deps.store.node("widget");
    expect(h.generations()).toBe(2); // the two round-1 candidates, no rewrite
    expect(node.history.map((x) => x.cause)).toEqual(["generate"]);
    expect(node.artifact?.code).toBe("code-2");
  });

  it("bills a judge call that failed but still spent tokens", async () => {
    const h = inspecting([]);
    const provider: LlmProvider = {
      id: "stub",
      complete: async (req) => {
        if (req.label.startsWith("inspect:")) throw new LlmCallError("refused", { inputTokens: 7, outputTokens: 3, usd: 0.5 });
        return h.provider.complete(req);
      },
    };
    const deps = { ...makeDeps(checked(), provider, new MemoryLibrary(), h.backend), inspect: true };
    await cookOne(deps, "widget");
    const node = deps.store.node("widget");
    expect(node.status).toBe("ready");
    expect(node.cost.usd).toBeCloseTo(0.5);
    expect(node.cost.calls).toBe(2);
  });

  it("does nothing at all unless asked", async () => {
    const h = inspecting([no]);
    // No `inspect: true` — the default cook must be byte-identical to before.
    const deps = makeDeps(checked(), h.provider, new MemoryLibrary(), h.backend);
    await cookOne(deps, "widget");
    expect(h.generations()).toBe(1);
    expect(deps.store.node("widget").history[0]?.cause).toBe("generate");
  });
});

describe("cookNodes orders the queue", () => {
  /** A graph of n nodes, ids reg-* (deterministic) and llm-* interleaved. */
  const graphOf = (ids: string[]) => {
    const base = makeGraph();
    const proto = base.nodes.widget!;
    const nodes = Object.fromEntries(ids.map((id) => [id, { ...proto, id, contract: { ...proto.contract } }]));
    return GraphDoc.parse({ ...base, nodes, assembly: { entryNodeId: ids[0]! }, edges: [] });
  };

  /** Records the order execute() is reached, and treats reg-* as registry. */
  const orderingBackend = () => {
    const order: string[] = [];
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      deterministicArtifact: (node) => (node.id.startsWith("reg-") ? { code: `# ${node.id}` } : null),
      execute: async (node) => {
        order.push(node.id);
        return { ok: true, stage: "execute", report: "" };
      },
    };
    return { backend, order };
  };

  it("cooks the nodes needing no model call before the ones that do", async () => {
    const { backend, order } = orderingBackend();
    // Emission order deliberately puts a registry part last: that is the case
    // that used to wait behind three LLM nodes for a slot it needs 0.2s of.
    const ids = ["llm-a", "reg-a", "llm-b", "llm-c", "reg-b"];
    const deps = { ...makeDeps(graphOf(ids), stubProvider, new MemoryLibrary(), backend), concurrency: 1 };
    await cookNodes(deps, ids);

    expect(order.slice(0, 2)).toEqual(["reg-a", "reg-b"]);
    expect(order).toHaveLength(5);
  });

  it("keeps emission order within each group", async () => {
    const { backend, order } = orderingBackend();
    const ids = ["llm-a", "reg-a", "llm-b", "reg-b"];
    const deps = { ...makeDeps(graphOf(ids), stubProvider, new MemoryLibrary(), backend), concurrency: 1 };
    await cookNodes(deps, ids);
    // The split is the only reordering; the architect's own sequence survives.
    expect(order).toEqual(["reg-a", "reg-b", "llm-a", "llm-b"]);
  });

  // The tests above pin concurrency 1, which is the one setting where queue
  // order is trivially the completion order. Production runs 4+, so this is the
  // case that decides whether the partition is worth anything: with the slow
  // nodes emitted FIRST and only 4 workers, an unpartitioned queue fills every
  // worker with slow work and the fast nodes wait for one to free up.
  it("finishes every no-model node before any slow one, at production concurrency", async () => {
    const done: string[] = [];
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      deterministicArtifact: (node) => (node.id.startsWith("reg-") ? { code: `# ${node.id}` } : null),
      execute: async (node) => {
        if (!node.id.startsWith("reg-")) {
          // stands in for a 60-90s generator call
          await new Promise((r) => setTimeout(r, 40));
        }
        done.push(node.id);
        return { ok: true, stage: "execute", report: "" };
      },
    };
    const ids = ["llm-a", "llm-b", "llm-c", "llm-d", "llm-e", "reg-a", "reg-b", "reg-c"];
    const deps = { ...makeDeps(graphOf(ids), stubProvider, new MemoryLibrary(), backend), concurrency: 4 };
    await cookNodes(deps, ids);

    const lastReg = Math.max(...done.map((id, i) => (id.startsWith("reg-") ? i : -1)));
    const firstLlm = done.findIndex((id) => !id.startsWith("reg-"));
    expect(done.filter((id) => id.startsWith("reg-"))).toHaveLength(3);
    expect(lastReg).toBeLessThan(firstLlm);
  });

  it("does not reorder a graph with no deterministic nodes", async () => {
    const { backend, order } = orderingBackend();
    const ids = ["llm-a", "llm-b", "llm-c"];
    const deps = { ...makeDeps(graphOf(ids), stubProvider, new MemoryLibrary(), backend), concurrency: 1 };
    await cookNodes(deps, ids);
    expect(order).toEqual(ids);
  });

  it("survives a backend that throws when asked whether a node is deterministic", async () => {
    const { order } = orderingBackend();
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      deterministicArtifact: () => {
        throw new Error("backend exploded");
      },
      execute: async (node) => {
        order.push(node.id);
        return { ok: true, stage: "execute", report: "" };
      },
    };
    const ids = ["a", "b"];
    const deps = { ...makeDeps(graphOf(ids), stubProvider, new MemoryLibrary(), backend), concurrency: 1 };
    // Sorting is an optimisation and must never be the thing that throws out of
    // cookNodes. The nodes still fail, because cookOne consults the same
    // backend hook without a guard — that is pre-existing and not this
    // ordering's business — but they fail as reported per-node failures rather
    // than taking the whole wave down before any node is even queued.
    const summary = await cookNodes(deps, ids);
    expect(summary.failed.map((f) => f.nodeId)).toEqual(ids);
    expect(summary.succeeded).toEqual([]);
  });
});

describe("cookOne repair convergence", () => {
  type Outcome = { stage: string; score?: number };

  /** Hands out code-1, code-2, … in call order, and records every request. */
  function sequenceProvider() {
    const requests: { label: string; effort?: string; maxTokens?: number }[] = [];
    const provider: LlmProvider = {
      id: "seq",
      complete: async (req) => {
        requests.push({ label: req.label, effort: req.effort, maxTokens: req.maxTokens });
        return {
          data: { code: `code-${requests.length}` },
          usage: { inputTokens: 10, outputTokens: 5, usd: 0.01 },
          model: "stub",
        } as never;
      },
    };
    return { provider, requests };
  }

  /** Execute fails code listed in `fails` with that stage and score; anything
   *  else passes. Records every generate and repair context. */
  function scripted(fails: Record<string, Outcome>, over: Partial<DomainBackend<unknown>> = {}) {
    const generates: GenerateCtx<unknown>[] = [];
    const repairs: RepairCtx<unknown>[] = [];
    const renders: string[] = [];
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      maxAttempts: 5,
      buildGeneratePrompt: (ctx) => {
        generates.push(ctx);
        return mockBackend.buildGeneratePrompt(ctx);
      },
      buildRepairPrompt: (ctx) => {
        repairs.push(ctx);
        return { ...mockBackend.buildGeneratePrompt(ctx), role: "repair" };
      },
      execute: async (node) => {
        const f = fails[node.artifact!.code];
        return f
          ? { ok: false, stage: f.stage, report: `${node.artifact!.code} failed ${f.stage}`, score: f.score }
          : { ok: true, stage: "execute", report: "" };
      },
      renderStages: ["G3", "G4"],
      renderArtifact: async (node) => {
        renders.push(node.artifact!.code);
        return null;
      },
      ...over,
    };
    return { backend, generates, repairs, renders };
  }

  it("repairs from the best-scoring attempt, not a regression", async () => {
    const h = scripted({ "code-1": { stage: "G3", score: 3 }, "code-2": { stage: "G1", score: 1 } });
    const deps = makeDeps(makeGraph(), sequenceProvider().provider, new MemoryLibrary(), h.backend);
    await cookOne(deps, "widget");

    expect(h.repairs.map((r) => r.failedCode)).toEqual(["code-1", "code-1"]);
    const third = h.repairs[1]!;
    expect(third.basedOnAttempt).toBe(1);
    expect(third.failure.report).toBe("code-1 failed G3");
    // The regression is still in the ledger — only not repaired from.
    expect(third.priorFailures.map((f) => f.report)).toEqual(["code-2 failed G1"]);
    expect(deps.store.node("widget").artifact?.code).toBe("code-3");
  });

  it("starts fresh after two repairs that do not improve", async () => {
    const h = scripted({
      "code-1": { stage: "G3", score: 3 },
      "code-2": { stage: "G3", score: 2 },
      "code-3": { stage: "G3", score: 3 },
      "code-4": { stage: "G1", score: 1 },
    });
    const deps = makeDeps(makeGraph(), sequenceProvider().provider, new MemoryLibrary(), h.backend);
    await cookOne(deps, "widget");

    // Round 4 is a generate carrying every failure, with no failed code anywhere.
    expect(h.repairs.map((r) => r.attempt)).toEqual([2, 3, 5]);
    expect(h.generates).toHaveLength(2);
    expect(h.generates[0]!.priorFailures).toBeUndefined();
    expect(h.generates[1]!.priorFailures?.map((f) => f.report)).toEqual([
      "code-1 failed G3",
      "code-2 failed G3",
      "code-3 failed G3",
    ]);
    expect(h.generates[1]!.node.currentCode).toBeUndefined();
    // ...and round 5 goes back to the best base, which is still attempt 3.
    expect(h.repairs[2]!.basedOnAttempt).toBe(3);
  });

  it("never starts fresh for a backend that does not score", async () => {
    const h = scripted({ "code-1": { stage: "G3" }, "code-2": { stage: "G3" }, "code-3": { stage: "G3" } });
    const deps = makeDeps(makeGraph(), sequenceProvider().provider, new MemoryLibrary(), h.backend);
    await cookOne(deps, "widget");
    expect(h.generates).toHaveLength(1);
    expect(h.repairs.map((r) => r.failedCode)).toEqual(["code-1", "code-2", "code-3"]);
  });

  it("drafts N candidates on round 1 and commits the first that passes", async () => {
    const h = scripted(
      { "code-1": { stage: "G3", score: 2 }, "code-2": { stage: "G1", score: 1 } },
      { generation: { firstRoundCandidates: 3 } },
    );
    const seq = sequenceProvider();
    const deps = makeDeps(makeGraph(), seq.provider, new MemoryLibrary(), h.backend);
    await cookOne(deps, "widget");

    const node = deps.store.node("widget");
    expect(node.artifact?.code).toBe("code-3");
    expect(node.history[0]?.cause).toBe("generate");
    expect(h.repairs).toHaveLength(0);
    // Every draft is billed, not just the winner.
    expect(node.cost.calls).toBe(3);
    expect(node.cost.inputTokens).toBe(30);
    expect(seq.requests).toHaveLength(3);
  });

  it("gates round-1 candidates concurrently and still picks the first pass", async () => {
    // code-3 settles first; code-2 is still the winner because selection is
    // by index, not by finishing order.
    const delays: Record<string, number> = { "code-1": 120, "code-2": 150, "code-3": 30 };
    let inFlight = 0;
    let peak = 0;
    const h = scripted(
      {},
      {
        generation: { firstRoundCandidates: 3 },
        execute: async (node) => {
          const code = node.artifact!.code;
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, delays[code]));
          inFlight -= 1;
          return code === "code-1"
            ? { ok: false, stage: "G3", report: "code-1 failed G3", score: 2 }
            : { ok: true, stage: "execute", report: "" };
        },
      },
    );
    const deps = makeDeps(makeGraph(), sequenceProvider().provider, new MemoryLibrary(), h.backend);
    const t0 = Date.now();
    await cookOne(deps, "widget");
    const elapsed = Date.now() - t0;

    expect(peak).toBe(3);
    expect(elapsed).toBeLessThan(250); // ≈ max (150), not sum (300)
    const node = deps.store.node("widget");
    expect(node.artifact?.code).toBe("code-2");
    expect(node.history[0]?.cause).toBe("generate");
  });

  it("repairs from the best-scoring candidate when none passes", async () => {
    const h = scripted(
      {
        "code-1": { stage: "G1", score: 1 },
        "code-2": { stage: "G3", score: 5 },
        "code-3": { stage: "G3", score: 2 },
      },
      { generation: { firstRoundCandidates: 3 } },
    );
    const deps = makeDeps(makeGraph(), sequenceProvider().provider, new MemoryLibrary(), h.backend);
    await cookOne(deps, "widget");

    expect(h.repairs).toHaveLength(1);
    expect(h.repairs[0]!.failedCode).toBe("code-2");
    // One ledger entry per round, so classifyFailure still counts rounds.
    expect(h.repairs[0]!.priorFailures).toEqual([]);
    expect(deps.store.node("widget").cost.calls).toBe(4);
  });

  it("escalates generation settings from the configured round", async () => {
    const h = scripted(
      { "code-1": { stage: "G3", score: 1 }, "code-2": { stage: "G3", score: 2 } },
      { generation: { effort: "medium", maxTokens: 100, escalate: { fromAttempt: 3, effort: "high", maxTokens: 200 } } },
    );
    const seq = sequenceProvider();
    await cookOne(makeDeps(makeGraph(), seq.provider, new MemoryLibrary(), h.backend), "widget");
    expect(seq.requests.map((r) => [r.effort, r.maxTokens])).toEqual([
      ["medium", 100],
      ["medium", 100],
      ["high", 200],
    ]);
  });

  it("renders only failures that built a shape", async () => {
    const h = scripted({ "code-1": { stage: "G1", score: 1 }, "code-2": { stage: "G3", score: 2 } });
    const deps = makeDeps(makeGraph(), sequenceProvider().provider, new MemoryLibrary(), h.backend);
    await cookOne(deps, "widget");
    // Repair 2 follows a G1 failure: nothing to look at. Repair 3 follows G3.
    expect(h.renders).toEqual(["code-2"]);
  });

  it("commits the gate-passing code when a looks-wrong rewrite exhausts the budget", async () => {
    const img = { mediaType: "image/png" as const, dataB64: "iVBORw0KGgo=" };
    const h = scripted({ "code-2": { stage: "G1", score: 1 } }, { maxAttempts: 2, renderArtifact: async () => img });
    let generated = 0;
    const provider: LlmProvider = {
      id: "stub",
      complete: async (req) => {
        const zero = { inputTokens: 1, outputTokens: 1, usd: 0 };
        if (req.label.startsWith("inspect:")) {
          const verdict = { answers: [{ question: "Does it have a leg?", answer: "no", evidence: "iso: flat" }] };
          return { data: (req.schema as { parse: (v: unknown) => unknown }).parse(verdict), usage: zero, model: "stub" } as never;
        }
        generated += 1;
        return { data: { code: `code-${generated}` }, usage: zero, model: "stub" } as never;
      },
    };
    const graph = makeGraph();
    graph.nodes.widget!.contract.payload = { visualChecks: ["Does it have a leg?"] };
    const deps = { ...makeDeps(graph, provider, new MemoryLibrary(), h.backend), inspect: true };
    await cookOne(deps, "widget");

    const node = deps.store.node("widget");
    expect(node.status).toBe("ready");
    expect(node.artifact?.code).toBe("code-1");
    expect(node.history[0]?.cause).toBe("generate-inspect-fallback");
    // The rewrite built on the passing code, with the verdict as its failure.
    expect(h.repairs[0]!.failedCode).toBe("code-1");
    expect(h.repairs[0]!.failure.stage).toBe("LOOKS");
    expect(h.repairs[0]!.failure.report).toContain("Does it have a leg? — iso: flat");
  });

  /** code-1 dies in execute; every later draft executes and fails verify,
   *  code-2 scoring best. */
  const contractStuck = (attribution: "contract-infeasible" | "code-invalid") =>
    scripted(
      { "code-1": { stage: "G1", score: 1 } },
      {
        maxAttempts: 3,
        verify: async (node) => {
          const code = node.artifact!.code;
          return { ok: false, stage: "G4", report: `${code} failed G4`, score: code === "code-2" ? 4 : 3.5 };
        },
        classifyFailure: () => attribution,
      },
    );

  it("keeps the best executed attempt of a contract-infeasible node as an unverified candidate", async () => {
    const deps = makeDeps(makeGraph(), sequenceProvider().provider, new MemoryLibrary(), contractStuck("contract-infeasible").backend);
    await expect(cookOne(deps, "widget")).rejects.toThrow(/contract-infeasible/);
    const node = deps.store.node("widget");
    expect(node.status).toBe("error_contract");
    expect(node.candidate).toEqual({ code: "code-2", hash: hashValue("code-2"), stage: "G4", report: "code-2 failed G4" });
    // Never committed, never the artifact.
    expect(node.history).toEqual([]);
    expect(node.artifact).toBeNull();
    expect(node.lastFailed).toMatchObject({ code: "code-3", stage: "G4" });
  });

  it("keeps the best executed attempt of a code-invalid node too, but none whose best never executed", async () => {
    const invalid = makeDeps(makeGraph(), sequenceProvider().provider, new MemoryLibrary(), contractStuck("code-invalid").backend);
    await expect(cookOne(invalid, "widget")).rejects.toThrow(/code-invalid/);
    expect(invalid.store.node("widget").status).toBe("error_code");
    expect(invalid.store.node("widget").candidate).toMatchObject({ code: "code-2", stage: "G4" });

    const h = scripted({ "code-1": { stage: "G1", score: 1 }, "code-2": { stage: "G1", score: 1 }, "code-3": { stage: "G1", score: 1 } }, {
      maxAttempts: 3,
      classifyFailure: () => "contract-infeasible",
    });
    const never = makeDeps(makeGraph(), sequenceProvider().provider, new MemoryLibrary(), h.backend);
    await expect(cookOne(never, "widget")).rejects.toThrow();
    expect(never.store.node("widget").candidate).toBeUndefined();
  });

  it("stops after one round that fails a terminal stage, and attributes it on that round alone", async () => {
    const seen: number[] = [];
    const h = scripted({ "code-1": { stage: "CONTRACT", score: 3 } }, {
      terminalStages: ["CONTRACT"],
      classifyFailure: ({ attempts }) => {
        seen.push(attempts);
        return "contract-infeasible";
      },
    });
    const sp = sequenceProvider();
    const deps = makeDeps(makeGraph(), sp.provider, new MemoryLibrary(), h.backend);
    await expect(cookOne(deps, "widget")).rejects.toThrow(/contract-infeasible after 1 attempts/);
    expect(h.repairs).toEqual([]);
    expect(seen).toEqual([1]);
    expect(deps.store.node("widget").status).toBe("error_contract");
  });

  it("drops the candidate when the node commits", async () => {
    const graph = makeGraph();
    graph.nodes.widget!.candidate = { code: "old", hash: hashValue("old"), stage: "G4", report: "old failed G4" };
    const deps = makeDeps(graph, sequenceProvider().provider, new MemoryLibrary(), scripted({}).backend);
    await cookOne(deps, "widget");
    expect(deps.store.node("widget").status).toBe("ready");
    expect(deps.store.node("widget").candidate).toBeUndefined();
  });
});

describe("cookOne concurrency (one node, two cooks)", () => {
  it("lets the newer cook win and discards the older one's work", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    const provider: LlmProvider = {
      id: "stub",
      complete: async () => {
        const mine = ++calls;
        if (mine === 1) await held; // the older cook is mid-generation
        return { data: { code: `cook-${mine}` }, usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "stub" } as never;
      },
    };
    const deps = { ...makeDeps(makeGraph(), provider, new MemoryLibrary()), library: undefined };
    const older = cookOne(deps, "widget");
    await Promise.resolve();
    const newer = cookOne(deps, "widget");
    await newer;
    release();
    await expect(older).rejects.toThrow(/superseded/);

    const node = deps.store.node("widget");
    expect(node.status).toBe("ready");
    expect(node.version).toBe(1);
    expect(node.artifact?.code).toBe("cook-2");
    // Both calls happened, so both are billed.
    expect(node.cost.calls).toBe(2);
  });

  it("a superseded cook mid-gate never strands the node", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let executes = 0;
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      execute: async () => {
        if (++executes === 1) await held;
        return { ok: true, stage: "execute", report: "" };
      },
    };
    const deps = { ...makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), backend), library: undefined };
    const older = cookOne(deps, "widget");
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await cookOne(deps, "widget");
    release();
    await expect(older).rejects.toThrow(/superseded/);
    expect(deps.store.node("widget").status).toBe("ready");
    expect(deps.store.node("widget").version).toBe(1);
  });
});

describe("cookOne backend throws (kernel unreachable)", () => {
  const down = new Error("ECONNREFUSED 127.0.0.1:8621");

  it("treats an execute throw as an execute failure, not a stuck node", async () => {
    const backend: DomainBackend<unknown> = { ...mockBackend, maxAttempts: 1, execute: async () => { throw down; } };
    const deps = { ...makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), backend), library: undefined };
    await expect(cookOne(deps, "widget")).rejects.toThrow();
    const node = deps.store.node("widget");
    expect(node.status).toBe("error_code");
    expect(node.statusDetail?.stage).toBe("execute");
    expect(node.statusDetail?.message).toMatch(/ECONNREFUSED/);
  });

  it("treats a verify throw the same way", async () => {
    const backend: DomainBackend<unknown> = { ...mockBackend, maxAttempts: 1, verify: async () => { throw down; } };
    const deps = { ...makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), backend), library: undefined };
    await expect(cookOne(deps, "widget")).rejects.toThrow();
    expect(deps.store.node("widget").status).toBe("error_code");
    expect(deps.store.node("widget").statusDetail?.stage).toBe("execute");
  });

  it("fails the node when deterministicArtifact throws", async () => {
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      deterministicArtifact: () => {
        throw new Error("no such SKU");
      },
    };
    const deps = makeDeps(makeGraph(), trapProvider, new MemoryLibrary(), backend);
    await expect(cookOne(deps, "widget")).rejects.toThrow(/no such SKU/);
    expect(deps.store.node("widget").status).toBe("error_code");
    expect(deps.store.node("widget").statusDetail?.stage).toBe("registry");
  });

  it("fails a registry-only node with no deterministic artifact closed, with no model call", async () => {
    const backend: DomainBackend<unknown> = { ...mockBackend, deterministicArtifact: () => null, deterministicOnly: () => true };
    const deps = makeDeps(makeGraph(), trapProvider, new MemoryLibrary(), backend);
    await expect(cookOne(deps, "widget")).rejects.toThrow(/registry-only/);
    const n = deps.store.node("widget");
    expect([n.status, n.statusDetail?.stage, n.cost.calls]).toEqual(["error_code", "registry", 0]);
  });

  it("settles a registry part whose kernel is down instead of leaving it building", async () => {
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      deterministicArtifact: () => ({ code: "screw" }),
      execute: async () => {
        throw down;
      },
    };
    const deps = makeDeps(makeGraph(), trapProvider, new MemoryLibrary(), backend);
    await expect(cookOne(deps, "widget")).rejects.toThrow(/ECONNREFUSED/);
    expect(deps.store.node("widget").status).toBe("error_code");
  });

  it("settles a node whose prepareArtifact throws synchronously", async () => {
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      prepareArtifact: () => {
        throw new Error("mesh source offline");
      },
    };
    const deps = makeDeps(makeGraph(), trapProvider, new MemoryLibrary(), backend);
    await expect(cookOne(deps, "widget")).rejects.toThrow(/mesh source offline/);
    expect(deps.store.node("widget").status).toBe("error_code");
    expect(deps.store.node("widget").statusDetail?.stage).toBe("prepare");
  });

  it("bills a prepare spend without counting a model call", async () => {
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      prepareArtifact: async () => ({ usd: 0.25 }),
      deterministicArtifact: () => ({ code: "mesh" }),
    };
    const deps = makeDeps(makeGraph(), trapProvider, new MemoryLibrary(), backend);
    await cookOne(deps, "widget");
    expect(deps.store.node("widget").cost).toMatchObject({ calls: 0, usd: 0.25 });
  });
});

describe("cookOne cancellation", () => {
  it("refuses the commit when the cook is aborted mid-gate", async () => {
    const controller = new AbortController();
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      execute: async () => {
        controller.abort();
        return { ok: true, stage: "execute", report: "" };
      },
    };
    const deps = { ...makeDeps(makeGraph(), stubProvider, new MemoryLibrary(), backend), signal: controller.signal };
    await expect(cookOne(deps, "widget")).rejects.toThrow(/cancelled/);
    const node = deps.store.node("widget");
    expect(node.status).toBe("cancelled");
    expect(node.version).toBe(0);
    expect(node.history).toEqual([]);
  });

  it("refuses a registry commit aborted mid-execute", async () => {
    const controller = new AbortController();
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      deterministicArtifact: () => ({ code: "screw" }),
      execute: async () => {
        controller.abort();
        return { ok: true, stage: "execute", report: "" };
      },
    };
    const deps = { ...makeDeps(makeGraph(), trapProvider, new MemoryLibrary(), backend), signal: controller.signal };
    await expect(cookOne(deps, "widget")).rejects.toThrow(/cancelled/);
    expect(deps.store.node("widget").status).toBe("cancelled");
    expect(deps.store.node("widget").version).toBe(0);
  });

  it("cookNodes stops after an abort: unstarted nodes cancelled, no assembly check", async () => {
    const controller = new AbortController();
    controller.abort();
    let checks = 0;
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      globalCheck: async () => {
        checks += 1;
        return { ok: true, problems: [] };
      },
    };
    const deps = { ...makeDeps(makeGraph(), trapProvider, new MemoryLibrary(), backend), signal: controller.signal };
    await cookNodes(deps, ["widget"]);
    expect(deps.store.node("widget").status).toBe("cancelled");
    expect(checks).toBe(0);
  });
});

describe("cookOne fresh start keeps the user's code", () => {
  it("restores the artifact a failed library candidate replaced", async () => {
    const seen: (string | undefined)[] = [];
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      buildGeneratePrompt: (ctx) => {
        seen.push(ctx.node.currentCode);
        return mockBackend.buildGeneratePrompt(ctx);
      },
      verify: async (node) =>
        node.artifact?.code === "cached" ? { ok: false, stage: "G3", report: "stale" } : { ok: true, stage: "verify", report: "" },
    };
    const graph = makeGraph();
    graph.nodes.widget!.artifact = { code: "mine", testCode: "", hash: hashValue("mine") };
    const library = new MemoryLibrary();
    const deps = makeDeps(graph, stubProvider, library, backend);
    library.entries.set(`mock/${deps.store.node("widget").contract.hash}`, {
      code: "cached",
      testCode: "",
      kind: "component",
      title: "Widget",
    });
    await cookOne(deps, "widget");
    expect(seen).toEqual(["mine"]);
  });
});

describe("cookNodes: a clash pinned on one part's code", () => {
  /** widget clashes until its code is `fixed`; the check pins it on widget. */
  const setup = (opts: { maxAttempts?: number; fixes?: boolean; gatesPassRepair?: boolean } = {}) => {
    const repairs: RepairCtx<unknown>[] = [];
    let checks = 0;
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      maxAttempts: opts.maxAttempts ?? 3,
      buildRepairPrompt: (ctx) => {
        repairs.push(ctx);
        return { ...mockBackend.buildGeneratePrompt(ctx), role: "repair" };
      },
      execute: async (node) =>
        opts.gatesPassRepair === false && node.artifact?.code === "fixed"
          ? { ok: false, stage: "G3", report: "relief cut the port" }
          : { ok: true, stage: "execute", report: "" },
      globalCheck: async (g) => {
        checks += 1;
        if (g.nodes.widget!.artifact?.code === "fixed" && opts.fixes !== false) return { ok: true, problems: [], findings: [] };
        const message = "G5 clash: widget and other";
        return {
          ok: false,
          problems: [message],
          findings: [{ nodeA: "widget", nodeB: "widget", kind: "clash", measured: 7, expected: 0, message, repair: { nodeId: "widget", report: "leave clearance near [0, 14, 0]" } }],
        };
      },
    };
    let calls = 0;
    const provider: LlmProvider = {
      id: "stub",
      complete: async () => {
        calls += 1;
        return { data: { code: calls === 1 ? "first" : "fixed" }, usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "stub" } as never;
      },
    };
    const deps = makeDeps(makeGraph(), provider, new MemoryLibrary(), backend);
    return { deps, repairs, get checks() { return checks; } };
  };

  it("repairs that part against the clash and commits once the check clears", async () => {
    const t = setup();
    await cookNodes(t.deps, ["widget"]);
    const n = t.deps.store.node("widget");
    expect([n.status, n.artifact?.code, n.history.at(-1)?.cause]).toEqual(["ready", "fixed", "repair-assembly"]);
    expect(t.repairs).toHaveLength(1);
    expect(t.repairs[0]).toMatchObject({ failedCode: "first", failure: { stage: ASSEMBLY_STAGE, report: "leave clearance near [0, 14, 0]" } });
    expect(t.checks).toBe(2);
  });

  it("stops at the node's attempt budget and leaves the contract block", async () => {
    const t = setup({ maxAttempts: 2, fixes: false });
    await cookNodes(t.deps, ["widget"]);
    const n = t.deps.store.node("widget");
    expect(t.repairs).toHaveLength(2);
    expect(t.checks).toBe(3);
    expect([n.status, n.statusDetail?.stage, n.statusDetail?.attribution]).toEqual(["error_contract", ASSEMBLY_STAGE, "contract-infeasible"]);
  });

  // belt-turntable: a G5 repair pinned on the registry shaft called the model.
  it("never asks a model to repair a registry-only part", async () => {
    const message = "G5 clash: widget and other";
    const backend: DomainBackend<unknown> = {
      ...mockBackend,
      deterministicArtifact: () => ({ code: "screw" }),
      deterministicOnly: () => true,
      globalCheck: async () => ({
        ok: false,
        problems: [message],
        findings: [{ nodeA: "widget", nodeB: "widget", kind: "clash", measured: 7, expected: 0, message, repair: { nodeId: "widget", report: "cut a relief" } }],
      }),
    };
    const deps = makeDeps(makeGraph(), trapProvider, new MemoryLibrary(), backend);
    await cookNodes(deps, ["widget"]);
    const n = deps.store.node("widget");
    expect([n.status, n.statusDetail?.stage, n.artifact?.code, n.history.at(-1)?.cause]).toEqual(["error_contract", ASSEMBLY_STAGE, "screw", "registry"]);
    // And a seeded cook asked of it directly fails closed, still with no call.
    await expect(cookOne(deps, "widget", undefined, { stage: ASSEMBLY_STAGE, report: "cut a relief" })).rejects.toThrow(/registry-only/);
    expect([deps.store.node("widget").status, deps.store.node("widget").statusDetail?.stage]).toEqual(["error_code", "registry"]);
  });

  it("keeps the committed part when the repair misses its own gates", async () => {
    const t = setup({ maxAttempts: 1, gatesPassRepair: false });
    await cookNodes(t.deps, ["widget"]);
    const n = t.deps.store.node("widget");
    expect([n.status, n.artifact?.code, n.version]).toEqual(["error_contract", "first", 1]);
  });
});

describe("applyCheck", () => {
  const blocked = () => {
    const store = new GraphStore(makeGraph(), new EventBus(), async () => {});
    for (const st of ["queued", "generating", "building", "verifying", "ready"] as const) store.setStatus("widget", st);
    store.setStatus("widget", "error_contract", { stage: ASSEMBLY_STAGE, message: "clash", attribution: "contract-infeasible" });
    return store;
  };

  it("releases a block the check no longer reports", () => {
    const store = blocked();
    applyCheck(store, { ok: true, problems: [], findings: [] });
    expect(store.node("widget").status).toBe("ready");
  });

  it("blocks only the blamed nodes when a finding names them", () => {
    const store = blocked();
    store.setStatus("widget", "ready");
    applyCheck(store, { ok: false, problems: ["gap"], findings: [{ nodeA: "widget", nodeB: "widget", kind: "gap", measured: 0.5, expected: 0, message: "gap", blame: [] }] });
    expect(store.node("widget").status).toBe("ready");
  });

  it("keeps every block when the check did not fully run", () => {
    const store = blocked();
    applyCheck(store, { ok: false, problems: ["clash check did not run"], findings: [], incomplete: true });
    expect(store.node("widget").status).toBe("error_contract");
  });

  it("reads clean only for a complete, passing check with nothing extra", () => {
    expect(checkStatus({ ok: true, problems: [] })).toBe("clean");
    expect(checkStatus({ ok: true, problems: ["advisory"], advisories: [] })).toBe("clean");
    expect(checkStatus({ ok: true, problems: [], incomplete: true })).toBe("failing");
    expect(checkStatus({ ok: true, problems: [] }, ["T0 broke a probe"])).toBe("failing");
    expect(checkStatus({ ok: false, problems: ["clash"] })).toBe("failing");
  });
});
