import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GraphDoc } from "@patchcad/shared";
import { cookOne, type CookDeps } from "./cook.js";
import { EventBus } from "./events.js";
import { GraphStore } from "./graph/store.js";
import type { DomainBackend } from "./backend.js";
import type { LlmProvider } from "./llm.js";
import type { LibraryEntry, NodeLibrary } from "./library.js";

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

function makeDeps(graph: GraphDoc, provider: LlmProvider, library: NodeLibrary): CookDeps {
  const store = new GraphStore(graph, new EventBus(), async () => {});
  return { store, backend: mockBackend, provider, workspace: { root: "/tmp/x" }, library };
}

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
