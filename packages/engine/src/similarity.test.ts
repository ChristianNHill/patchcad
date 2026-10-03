import { describe, expect, it } from "vitest";
import type { Contract, ParamDecl } from "@patchcad/shared";
import {
  contractSimilarity,
  featureTags,
  findReusable,
  nodeSimilarity,
  paramsCompatible,
  paramsInRange,
  titleSimilarity,
} from "./similarity.js";
import { codeDiff, failureSignature, minePitfalls, type RepairFix } from "./library.js";
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
    const got = await findReusable({ library, backendId: "cad", contract: target, kind: "part", title: "Base plate", exclude: new Set() });
    expect(got.map((c) => c.entry.title)).toEqual(["Near Plate"]);
  });

  it("skips the hash the exact path already tried", async () => {
    const library = new StubLibrary([
      entry({ contractHash: "already", contract: contract({ provides: [port("h", "CLEARANCE_HOLE")] }) }),
    ]);
    const got = await findReusable({
      library, backendId: "cad", contract: target, kind: "part", title: "Base plate", exclude: new Set(["already"]),
    });
    expect(got).toEqual([]);
  });

  it("will not offer a part with nothing in common", async () => {
    const library = new StubLibrary([
      entry({ contractHash: "other", contract: contract({ provides: [port("s", "SLOT")] }) }),
    ]);
    expect(
      await findReusable({ library, backendId: "cad", contract: target, kind: "part", title: "Base plate", exclude: new Set() }),
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
      await findReusable({ library, backendId: "cad", contract: target, kind: "part", title: "Base plate", exclude: new Set() }),
    ).toEqual([]);
  });

  it("is bounded — each candidate costs a real execute+verify", async () => {
    const library = new StubLibrary(
      Array.from({ length: 6 }, (_, i) =>
        entry({ contractHash: `h${i}`, contract: contract({ provides: [port("h", "CLEARANCE_HOLE")] }) }),
      ),
    );
    const got = await findReusable({ library, backendId: "cad", contract: target, kind: "part", title: "Base plate", exclude: new Set() });
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
        await findReusable({ library, backendId: "cad", contract: target, kind: "part", title: "Base plate", exclude: new Set() }),
      ).toEqual([]);
    }
  });
});

describe("nodeSimilarity ranks by what the part is, not its port multiset", () => {
  const holes = contract({ provides: [port("a", "CLEARANCE_HOLE"), port("b", "FLAT_FACE")] });
  const target = { contract: holes, title: "Fan bracket", spec: "a lofted bracket that holds a 40mm fan" };

  it("puts shared title words ahead of identical ports", () => {
    const sameWords = entry({ title: "Fan bracket", contract: contract() });
    const samePorts = entry({ title: "Drawer pull", contract: holes });
    expect(nodeSimilarity(target, sameWords)).toBeGreaterThan(nodeSimilarity(target, samePorts));
  });

  it("counts modelling techniques the code shares with the spec", () => {
    const lofted = entry({ title: "Fan bracket", code: "body = loft([a, b])" });
    const boxy = entry({ title: "Fan bracket", code: "body = Box(1, 1, 1)" });
    expect(nodeSimilarity(target, lofted)).toBeGreaterThan(nodeSimilarity(target, boxy));
    expect([...featureTags("fillet(shell(x)); revolve(p); sweep(s, path); IsoThread(...)")].sort()).toEqual(
      ["fillet", "revolve", "shell", "sweep", "threads"],
    );
  });

  it("breaks a tie toward code that passed first time", () => {
    const easy = entry({ title: "Fan bracket", attemptsToPass: 1 });
    const hard = entry({ title: "Fan bracket", attemptsToPass: 4 });
    expect(nodeSimilarity(target, easy)).toBeGreaterThan(nodeSimilarity(target, hard));
  });
});

describe("findReusable title threshold", () => {
  const target = contract({ provides: [port("hole", "CLEARANCE_HOLE")] });
  const same = contract({ provides: [port("h", "CLEARANCE_HOLE")] });

  it("will not offer a different part that happens to share ports", async () => {
    const library = new StubLibrary([entry({ contractHash: "lid", title: "Battery lid", contract: same })]);
    expect(
      await findReusable({ library, backendId: "cad", contract: target, kind: "part", title: "Fan bracket", exclude: new Set() }),
    ).toEqual([]);
  });

  it("offers one whose title reads as the same part", async () => {
    const library = new StubLibrary([entry({ contractHash: "b", title: "Bracket for fans", contract: same })]);
    const got = await findReusable({ library, backendId: "cad", contract: target, kind: "part", title: "Fan bracket", exclude: new Set() });
    expect(got.map((c) => c.entry.contractHash)).toEqual(["b"]);
    expect(titleSimilarity("Fan bracket", "Bracket for fans")).toBe(1);
  });
});

describe("pitfall mining", () => {
  const fix = (report: string, diff = "- Cylinder(d, h)\n+ Cylinder(d / 2, h)"): RepairFix => ({ stage: "G3", report, diff });

  it("blanks numbers and names so the same miss on different parts groups", () => {
    expect(failureSignature('port "bolt" (BORE): expected Ø4.5, measured Ø9.00\nhint: x')).toBe(
      failureSignature('port "mount" (BORE): expected Ø3, measured Ø6.00'),
    );
  });

  it("needs three occurrences, and the pattern matches the raw report", () => {
    const pairs = [
      fix('port "a" (BORE): expected Ø4.5, measured Ø9.00'),
      fix('port "b" (BORE): expected Ø3, measured Ø6.00'),
    ];
    expect(minePitfalls(pairs)).toEqual([]);
    const [mined] = minePitfalls([...pairs, fix('port "c" (BORE): expected Ø5, measured Ø10.00')]);
    expect(mined!.occurrences).toBe(3);
    expect(mined!.stage).toBe("G3");
    expect(new RegExp(mined!.pattern).test('port "z" (BORE): expected Ø8, measured Ø16.00')).toBe(true);
    expect(mined!.fix).toContain("+ Cylinder(d / 2, h)");
  });

  it("diffs only the lines a repair changed", () => {
    expect(codeDiff("a\nb\nc", "a\nB\nc")).toBe("- b\n+ B");
  });
});
