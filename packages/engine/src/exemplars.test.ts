import { describe, expect, it } from "vitest";
import type { Contract, GraphDoc, NodeRecord } from "@patchcad/shared";
import { selectExemplars } from "./exemplars.js";
import type { LibraryEntry, LibraryListing, NodeLibrary } from "./library.js";

/**
 * The load-bearing test here is the hermeticity one: exemplars are the only
 * path by which code from outside a node reaches its generator prompt, and a
 * node captured into the library can later be that node's neighbor.
 */

const contract = (over: Partial<Contract> = {}): Contract => ({
  name: "n",
  summary: "",
  params: [],
  provides: [],
  requires: [],
  payload: {},
  hash: "h",
  ...over,
});

const port = (key: string, type: string) => ({ key, type, description: "" });

function graphOf(nodes: { id: string; hash: string }[]): GraphDoc {
  return {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, { id: n.id, contract: contract({ hash: n.hash }) }])),
  } as unknown as GraphDoc;
}

const node = (hash: string, kind = "part", c: Partial<Contract> = {}): NodeRecord =>
  ({ id: "target", kind, contract: contract({ hash, ...c }) }) as NodeRecord;

class StubLibrary implements NodeLibrary {
  listCalls: { backendId: string; kind?: string }[] = [];
  constructor(private entries: LibraryListing[]) {}
  async lookup(): Promise<LibraryEntry | null> {
    return null;
  }
  async capture(): Promise<void> {}
  async list(backendId: string, opts: { kind?: string } = {}) {
    this.listCalls.push({ backendId, kind: opts.kind });
    return this.entries.filter((e) => !opts.kind || e.kind === opts.kind);
  }
}

const entry = (over: Partial<LibraryListing> = {}): LibraryListing => ({
  contractHash: "lib-1",
  // Long enough to clear MIN_EXEMPLAR_CHARS — a real worked example, not a stub.
  code: "def build(p):\n" + "    body = Box(20, 20, 5)\n".repeat(12) + "    return body\n",
  testCode: "",
  kind: "part",
  title: "Some Plate",
  contract: contract(),
  ...over,
});

describe("selectExemplars — hermeticity", () => {
  it("never returns an entry that is a node in the requesting graph", async () => {
    // The failure mode: this plate cooked, was captured under hash "neighbor",
    // and is now wired to the node being generated. Handing it back as an
    // "example" is handing over a neighbor's implementation.
    const library = new StubLibrary([
      entry({ contractHash: "neighbor", title: "Neighbor Plate" }),
      entry({ contractHash: "elsewhere", title: "Other Project Plate" }),
    ]);
    const got = await selectExemplars({
      library,
      backendId: "cad",
      node: node("target-hash"),
      graph: graphOf([
        { id: "target", hash: "target-hash" },
        { id: "bracket", hash: "neighbor" },
      ]),
    });
    expect(got.map((e) => e.title)).toEqual(["Other Project Plate"]);
  });

  it("never returns the node's own contract back to it", async () => {
    const library = new StubLibrary([entry({ contractHash: "target-hash", title: "Itself" })]);
    const got = await selectExemplars({
      library,
      backendId: "cad",
      node: node("target-hash"),
      // Not even when the graph object does not list it.
      graph: graphOf([]),
    });
    expect(got).toEqual([]);
  });
});

describe("selectExemplars — selection", () => {
  it("asks the library for the same kind, and stops there when that succeeds", async () => {
    const library = new StubLibrary([entry({ kind: "fastener" })]);
    await selectExemplars({ library, backendId: "cad", node: node("t", "fastener"), graph: graphOf([]) });
    expect(library.listCalls).toEqual([{ backendId: "cad", kind: "fastener" }]);
  });

  it("falls back to any kind in the domain when the kind has no entries", async () => {
    // Early libraries hold one or two kinds; a different kind still shows
    // house style and the API.
    const library = new StubLibrary([entry({ contractHash: "e1", kind: "part", title: "A Part" })]);
    const got = await selectExemplars({ library, backendId: "cad", node: node("t", "assembly"), graph: graphOf([]) });
    expect(got.map((e) => e.title)).toEqual(["A Part"]);
    expect(library.listCalls).toEqual([
      { backendId: "cad", kind: "assembly" },
      { backendId: "cad", kind: undefined },
    ]);
  });

  it("skips entries with no contract — code alone is not a worked example", async () => {
    const library = new StubLibrary([entry({ contractHash: "old", contract: undefined })]);
    const got = await selectExemplars({ library, backendId: "cad", node: node("t"), graph: graphOf([]) });
    expect(got).toEqual([]);
  });

  it("skips deterministic one-line stubs, which the brevity tiebreak would favour", async () => {
    // An imported CAD piece is stored as `return load_import(...)`: it scores
    // well on shared port types AND on brevity, and teaches nothing.
    const library = new StubLibrary([
      entry({
        contractHash: "stub",
        title: "Object.stl piece 3",
        code: 'def build(p):\n    return load_import("piece-3.ply", scale=p.scale)\n',
      }),
      entry({ contractHash: "real", title: "Real Part" }),
    ]);
    const got = await selectExemplars({ library, backendId: "cad", node: node("t"), graph: graphOf([]) });
    expect(got.map((e) => e.title)).toEqual(["Real Part"]);
  });

  it("skips entries too long to be worth their tokens", async () => {
    const library = new StubLibrary([
      entry({ contractHash: "huge", title: "Huge", code: "x".repeat(5000) }),
      entry({ contractHash: "ok", title: "Ok" }),
    ]);
    const got = await selectExemplars({ library, backendId: "cad", node: node("t"), graph: graphOf([]) });
    expect(got.map((e) => e.title)).toEqual(["Ok"]);
  });

  it("prefers the entry whose ports look most like the target's", async () => {
    const target = node("t", "part", { provides: [port("a", "BORE"), port("b", "FLAT_FACE")] });
    const library = new StubLibrary([
      entry({ contractHash: "1", title: "No ports", contract: contract() }),
      entry({
        contractHash: "2",
        title: "Same ports",
        contract: contract({ provides: [port("x", "BORE"), port("y", "FLAT_FACE")] }),
      }),
    ]);
    const got = await selectExemplars({ library, backendId: "cad", node: target, graph: graphOf([]), limit: 1 });
    expect(got[0]!.title).toBe("Same ports");
  });

  it("caps the number returned, because each one roughly doubles the prompt", async () => {
    const library = new StubLibrary(
      Array.from({ length: 6 }, (_, i) => entry({ contractHash: `h${i}`, title: `E${i}` })),
    );
    const got = await selectExemplars({ library, backendId: "cad", node: node("t"), graph: graphOf([]) });
    expect(got).toHaveLength(2);
    expect(await selectExemplars({ library, backendId: "cad", node: node("t"), graph: graphOf([]), limit: 1 })).toHaveLength(1);
  });
});

describe("selectExemplars — degrades quietly", () => {
  it("returns nothing when the library cannot enumerate", async () => {
    const noList: NodeLibrary = { lookup: async () => null, capture: async () => {} };
    expect(await selectExemplars({ library: noList, backendId: "cad", node: node("t"), graph: graphOf([]) })).toEqual([]);
  });

  it("never fails a cook when the library throws", async () => {
    const broken: NodeLibrary = {
      lookup: async () => null,
      capture: async () => {},
      list: async () => {
        throw new Error("disk gone");
      },
    };
    expect(await selectExemplars({ library: broken, backendId: "cad", node: node("t"), graph: graphOf([]) })).toEqual([]);
  });
});
