import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GraphDoc, hashValue } from "@patchcad/shared";
import { cookOne, type CookDeps } from "./cook.js";
import { EventBus } from "./events.js";
import { GraphStore } from "./graph/store.js";
import type { DomainBackend, RepairCtx } from "./backend.js";
import type { LlmProvider } from "./llm.js";
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
        pinned: false,
        params: {},
        deps: [],
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
    layout: {},
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
    pushParams: async () => {},
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
