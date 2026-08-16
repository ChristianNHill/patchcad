import { describe, expect, it } from "vitest";
import type { Contract, ParamDecl } from "@patchcad/shared";
import { contractSimilarity, findReusable, paramsCompatible, paramsInRange } from "./similarity.js";
import type { LibraryEntry, LibraryListing, NodeLibrary } from "./library.js";

const num = (name: string, def = 5, min?: number, max?: number): ParamDecl =>
  ({ type: "number", name, description: "", default: def, min, max }) as ParamDecl;

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

class StubLibrary implements NodeLibrary {
  constructor(private entries: LibraryListing[]) {}
  async lookup(): Promise<LibraryEntry | null> {
    return null;
  }
  async capture(): Promise<void> {}
  async list(_b: string, opts: { kind?: string } = {}) {
    return this.entries.filter((e) => !opts.kind || e.kind === opts.kind);
  }
}

const entry = (over: Partial<LibraryListing> = {}): LibraryListing => ({
  contractHash: "lib-1",
  code: "def build(p): return Box(1,1,1)",
  testCode: "",
  kind: "part",
  title: "Some Plate",
  contract: contract(),
  ...over,
});

describe("paramsCompatible", () => {
  it("rejects a candidate needing a param the target does not have", () => {
    // Node code reads params by name, so this is a guaranteed runtime miss —
    // not worth a kernel round trip to discover.
    const target = contract({ params: [num("width")] });
    const candidate = contract({ params: [num("width"), num("thickness")] });
    expect(paramsCompatible(target, candidate)).toBe(false);
  });

  it("allows the target to carry extra params the code ignores", () => {
    const target = contract({ params: [num("width"), num("fillet")] });
    const candidate = contract({ params: [num("width")] });
    expect(paramsCompatible(target, candidate)).toBe(true);
  });

  it("rejects a name match with a different type", () => {
    const target = contract({ params: [{ type: "string", name: "width", description: "", default: "x" } as ParamDecl] });
    expect(paramsCompatible(target, contract({ params: [num("width")] }))).toBe(false);
  });
});

describe("paramsInRange", () => {
  it("rejects reuse that would extrapolate far outside the tested range", () => {
    // A plate written for 2-10mm should not be reused at 50mm just because
    // the param names line up.
    const candidate = contract({ params: [num("thickness", 5, 2, 10)] });
    expect(paramsInRange(contract({ params: [num("thickness", 50)] }), candidate)).toBe(false);
    expect(paramsInRange(contract({ params: [num("thickness", 8)] }), candidate)).toBe(true);
  });

  it("ignores params with no declared range", () => {
    const candidate = contract({ params: [num("thickness")] });
    expect(paramsInRange(contract({ params: [num("thickness", 999)] }), candidate)).toBe(true);
  });
});

describe("contractSimilarity", () => {
  it("counts shared port types as a multiset", () => {
    const two = contract({ provides: [port("a", "BORE"), port("b", "BORE")] });
    const one = contract({ provides: [port("x", "BORE")] });
    expect(contractSimilarity(two, two)).toBeGreaterThan(contractSimilarity(two, one));
  });

  it("scores nothing in common at or below zero", () => {
    const a = contract({ provides: [port("a", "BORE")] });
    const b = contract({ provides: [port("x", "SLOT")] });
    expect(contractSimilarity(a, b)).toBeLessThanOrEqual(0);
  });
});

describe("findReusable", () => {
  const target = contract({
    params: [num("width", 60, 30, 120), num("thickness", 5, 2, 10)],
    provides: [port("hole", "CLEARANCE_HOLE")],
  });

  it("offers the nearest stored contract the exact hash would have missed", async () => {
    const library = new StubLibrary([
      entry({
        contractHash: "near",
        title: "Near Plate",
        contract: contract({ params: [num("width", 60, 30, 120)], provides: [port("h", "CLEARANCE_HOLE")] }),
      }),
    ]);
    const got = await findReusable({ library, backendId: "cad", contract: target, kind: "part", exclude: new Set() });
    expect(got.map((c) => c.entry.title)).toEqual(["Near Plate"]);
  });

  it("skips the hash the exact path already tried", async () => {
    const library = new StubLibrary([
      entry({ contractHash: "already", contract: contract({ provides: [port("h", "CLEARANCE_HOLE")] }) }),
    ]);
    const got = await findReusable({
      library, backendId: "cad", contract: target, kind: "part", exclude: new Set(["already"]),
    });
    expect(got).toEqual([]);
  });

  it("will not offer a part with nothing in common", async () => {
    const library = new StubLibrary([
      entry({ contractHash: "other", contract: contract({ provides: [port("s", "SLOT")] }) }),
    ]);
    expect(
      await findReusable({ library, backendId: "cad", contract: target, kind: "part", exclude: new Set() }),
    ).toEqual([]);
  });

  it("will not offer code that would fail on a missing param", async () => {
    const library = new StubLibrary([
      entry({
        contractHash: "needy",
        contract: contract({
          params: [num("width"), num("undeclared")],
          provides: [port("h", "CLEARANCE_HOLE")],
        }),
      }),
    ]);
    expect(
      await findReusable({ library, backendId: "cad", contract: target, kind: "part", exclude: new Set() }),
    ).toEqual([]);
  });

  it("is bounded — each candidate costs a real execute+verify", async () => {
    const library = new StubLibrary(
      Array.from({ length: 6 }, (_, i) =>
        entry({ contractHash: `h${i}`, contract: contract({ provides: [port("h", "CLEARANCE_HOLE")] }) }),
      ),
    );
    const got = await findReusable({ library, backendId: "cad", contract: target, kind: "part", exclude: new Set() });
    expect(got).toHaveLength(2);
  });

  it("degrades quietly when the library cannot enumerate or throws", async () => {
    const noList: NodeLibrary = { lookup: async () => null, capture: async () => {} };
    const broken: NodeLibrary = {
      lookup: async () => null,
      capture: async () => {},
      list: async () => {
        throw new Error("disk gone");
      },
    };
    for (const library of [noList, broken]) {
      expect(
        await findReusable({ library, backendId: "cad", contract: target, kind: "part", exclude: new Set() }),
      ).toEqual([]);
    }
  });
});
