import { describe, expect, it } from "vitest";
import { GraphDoc, hashValue, type NodeRecord } from "@patchcad/shared";
import {
  CadBackend,
  CadContractPayload,
  G4C_SCORE,
  UNVERIFIED_PN,
  bomCsv,
  buildBom,
  cadSourcingLint,
  dfmIssues,
  isFdmPart,
  kernelProcess,
  markCncSetups,
  processLines,
  sourcingOf,
  type KernelClient,
  type KernelResult,
} from "./index.js";
import { generatePrompt } from "./prompts.js";

/** Fabricate sourcing, process DFM wiring and the BOM. Pure: no kernel, no LLM. */

const pose = { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] };
const at = (x: number) => ({ origin: [x, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] });

function node(
  id: string,
  kind: string,
  opts: {
    ports?: { name: string; type: string; pose?: typeof pose; params?: Record<string, unknown> }[];
    sourcing?: Record<string, unknown>;
    processKind?: string;
    params?: Record<string, unknown>;
    code?: string | null;
    volume?: number;
    status?: string;
  } = {},
) {
  return {
    id,
    kind,
    title: id,
    spec: "",
    contract: {
      name: id,
      summary: "",
      params: [],
      provides: [],
      requires: [],
      payload: {
        units: "mm",
        process: { kind: opts.processKind ?? "FDM", minWall: 1.2, nozzle: 0.4 },
        ports: (opts.ports ?? []).map((p) => ({ pose, params: {}, ...p })),
        envelope: { volumes: [{ kind: "box", pose, dims: [10, 10, 10] }], clearance: 0.4 },
        ...(opts.sourcing ? { sourcing: opts.sourcing } : {}),
      },
      hash: "",
    },
    params: opts.params ?? {},
    artifact: opts.code === null ? null : { code: opts.code ?? "def build(p): ...", hash: "h" },
    measurements: opts.volume === undefined ? null : { version: 1, paramsHash: "", data: { volume_mm3: opts.volume } },
    thread: [],
    status: opts.status ?? "ready",
    version: 1,
    history: [],
    cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
  };
}

function graph(nodes: ReturnType<typeof node>[], edges: { from: string; fromPort: string; to: string; toPort: string }[] = []) {
  return GraphDoc.parse({
    schemaVersion: 1,
    id: "fab",
    backend: "cad",
    brief: { goal: "", constraints: [], clarifications: [] },
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: edges.map((e, i) => ({ id: `e${i}`, ...e })),
    assembly: { entryNodeId: nodes[0]!.id },
    rev: 0,
  });
}

const cnc = { class: "fabricate", process: "cnc", material: "6061-T6 aluminium" };

describe("sourcing defaults", () => {
  it("catalog kinds are bought, everything else prints FDM", () => {
    expect(sourcingOf(node("screw", "fastener"))).toEqual({ class: "buy" });
    expect(sourcingOf(node("plate", "part"))).toEqual({ class: "print", process: "fdm" });
    expect(sourcingOf(node("plate", "part", { sourcing: { class: "print" } }))).toEqual({ class: "print", process: "fdm" });
    expect(isFdmPart(node("plate", "part"))).toBe(true);
  });

  it("process.kind CNC reads as a machined part, and fabricate is never FDM", () => {
    expect(sourcingOf(node("shaft", "part", { processKind: "CNC" }))).toEqual({ class: "fabricate", process: "cnc" });
    expect(isFdmPart(node("shaft", "part", { sourcing: cnc, processKind: "CNC" }))).toBe(false);
  });

  it("an absent sourcing leaves the payload, and so the contract hash, unchanged", () => {
    const raw = node("plate", "part").contract.payload;
    const parsed = CadContractPayload.parse(raw);
    expect("sourcing" in parsed).toBe(false);
    expect(hashValue(parsed)).toBe(hashValue(CadContractPayload.parse(structuredClone(raw))));
    expect(CadContractPayload.parse({ ...raw, sourcing: cnc }).sourcing).toEqual(cnc);
  });
});

describe("cad-sourcing lint", () => {
  const run = (...nodes: ReturnType<typeof node>[]) => cadSourcingLint.run(graph(nodes));

  it("passes defaults and a complete fabricate part", () => {
    expect(run(node("plate", "part"), node("screw", "fastener"), node("shaft", "part", { sourcing: cnc, processKind: "CNC" }))).toEqual([]);
    expect(run(node("bracket", "part", { sourcing: { class: "fabricate", process: "sheet_metal", material: "5052-H32" } }))).toEqual([]);
  });

  it("requires process and material on fabricate", () => {
    const [p] = run(node("bracket", "part", { sourcing: { class: "fabricate" } }));
    expect(p).toMatch(/bracket: .*needs process and material/);
    expect(run(node("bracket", "part", { sourcing: { class: "fabricate", process: "laser_cut" } }))[0]).toMatch(/needs material/);
  });

  it("keeps buy for catalog hardware", () => {
    expect(run(node("box", "part", { sourcing: { class: "buy" } }))[0]).toMatch(/only for catalog hardware/);
  });

  it("holds process.kind and sourcing.process together", () => {
    expect(run(node("shaft", "part", { sourcing: cnc }))[0]).toMatch(/process.kind "FDM" disagrees/);
    expect(run(node("shaft", "part", { processKind: "CNC" }))[0]).toMatch(/add payload.sourcing/);
  });
});

describe("process DFM wiring", () => {
  it("printed parts send fdm to the kernel's G4c, bought hardware sends nothing", () => {
    expect(kernelProcess(node("plate", "part"))).toEqual({ kind: "fdm" });
    expect(kernelProcess(node("plate", "part", { sourcing: { class: "print" } }))).toEqual({ kind: "fdm" });
    expect(kernelProcess(node("screw", "fastener", { params: { sku: "ISO4762-M3x12" } }))).toBeUndefined();
    expect(kernelProcess(node("shaft", "part", { sourcing: cnc, processKind: "CNC" }))).toEqual({ kind: "cnc", tool_radius: 1.5 });
    expect(
      kernelProcess(node("shaft", "part", { sourcing: { ...cnc, toolRadius: 3, allowUndercuts: true }, processKind: "CNC" })),
    ).toEqual({ kind: "cnc", tool_radius: 3, allow_undercuts: true });
    expect(kernelProcess(node("b", "part", { sourcing: { class: "fabricate", process: "laser_cut", material: "steel" } }))).toEqual({ kind: "laser_cut" });
  });

  it("puts process guidance in the user turn and leaves the system block byte-identical", () => {
    const ctx = (n: ReturnType<typeof node>) =>
      ({ node: n, brief: { goal: "g" }, upstream: [], downstream: [] }) as unknown as Parameters<typeof generatePrompt>[0];
    const printed = generatePrompt(ctx(node("plate", "part")));
    const milled = generatePrompt(ctx(node("plate", "part", { sourcing: cnc, processKind: "CNC" })));
    expect(milled.system).toBe(printed.system);
    expect(printed.messages[0]!.content).toContain("Process: FDM, min wall 1.2 mm.");
    expect(milled.messages[0]!.content).toContain("CNC MILLED");
    expect(milled.messages[0]!.content).toContain("6061-T6 aluminium");
    expect(processLines(node("b", "part", { sourcing: { class: "fabricate", process: "sheet_metal", material: "5052" } }))).toMatch(/INNER radius of at least the thickness/);
  });

  const g4c: KernelResult = {
    ok: false,
    stage: "G4c",
    error: 'process cnc "internal_corner": 4 internal vertical corner(s) tighter than the Ø3 end mill can cut; tightest radius 0.00 mm at [-10, -6, 3]',
    hint: "round each vertical inside corner",
    failures: [
      {
        stage: "G4c",
        error: 'process cnc "internal_corner": 4 internal vertical corner(s) tighter than the Ø3 end mill can cut; tightest radius 0.00 mm at [-10, -6, 3]',
        hint: "round each vertical inside corner",
        rule: "internal_corner",
        expected: 1.5,
        measured: 0,
        at: [-10, -6, 3],
        count: 4,
      },
    ],
  };

  it("maps a G4c failure to a repairable verdict scored just below a pass", async () => {
    const kernel = { execute: async () => g4c } as unknown as KernelClient;
    const backend = new CadBackend({ kernel });
    const shaft = node("shaft", "part", { sourcing: cnc, processKind: "CNC" }) as unknown as NodeRecord;
    const ws = { root: "/tmp/fab/nodes" } as never;
    const v = await backend.verify(shaft, graph([node("shaft", "part", { sourcing: cnc, processKind: "CNC" })]), ws);
    expect(v.ok).toBe(false);
    expect(v.stage).toBe("G4c");
    expect(v.score).toBe(G4C_SCORE);
    expect(v.score).toBeGreaterThan(4.75);
    expect(v.score).toBeLessThan(5);
    expect(v.report).toContain('"internal_corner"');
    const failures = Array.from({ length: 5 }, () => ({ stage: "G4c", report: v.report }));
    expect(backend.classifyFailure({ node: shaft, failures, attempts: 5 })).toBe("code-invalid");
    expect(dfmIssues(g4c.ok ? [] : g4c.failures)).toEqual([
      { process: "cnc", rule: "internal_corner", message: g4c.ok ? "" : g4c.error, expected: 1.5, measured: 0, at: [-10, -6, 3], count: 4 },
    ]);
  });
});

describe("BOM", () => {
  const plate = node("plate", "part", {
    ports: [
      { name: "h1", type: "CLEARANCE_HOLE", pose: at(-10) },
      { name: "h2", type: "CLEARANCE_HOLE", pose: at(10) },
      { name: "h3", type: "CLEARANCE_HOLE", pose: at(20) },
    ],
    volume: 10000,
  });
  const screw = node("screw", "fastener", { ports: [{ name: "head_seat", type: "FLAT_FACE" }], params: { sku: "ISO4762-M3x12" } });
  const screw2 = node("screw2", "fastener", { ports: [{ name: "head_seat", type: "FLAT_FACE" }], params: { sku: "ISO4762-M3x12" } });
  const shaft = node("shaft", "part", { sourcing: { ...cnc, finish: "anodised" }, processKind: "CNC", volume: 5000 });
  const lid = node("lid", "part", { code: null, status: "error_code" });
  const g = graph(
    [plate, screw, screw2, shaft, lid],
    [
      { from: "plate", fromPort: "h1", to: "screw", toPort: "head_seat" },
      { from: "plate", fromPort: "h2", to: "screw", toPort: "head_seat" },
      { from: "plate", fromPort: "h3", to: "screw2", toPort: "head_seat" },
    ],
  );
  const bom = buildBom(g);

  it("groups bought parts by SKU across nodes and placed copies", () => {
    expect(bom.buy).toHaveLength(1);
    expect(bom.buy[0]).toMatchObject({ sku: "ISO4762-M3x12", qty: 3, nodes: ["screw", "screw2"], vendors: UNVERIFIED_PN });
    expect(bom.buy[0]!.standard).toMatch(/ISO 4762/);
  });

  it("prices printed parts by volume, mass and filament", () => {
    expect(bom.print).toEqual([
      { nodeId: "plate", title: "plate", qty: 1, process: "fdm", material: "PLA", volumeMm3: 10000, massG: 12.4, filamentM: 4.16 },
    ]);
  });

  it("lists fabricate parts with process, material and a vendor-package link", () => {
    expect(bom.fabricate).toEqual([
      {
        nodeId: "shaft", title: "shaft", qty: 1, process: "cnc", material: "6061-T6 aluminium", finish: "anodised",
        volumeMm3: 5000, massG: 13.5, ready: true, vendorPackage: "/api/project/parts/shaft/vendor-package",
      },
    ]);
  });

  it("shows a node without geometry as not generated, never as a row", () => {
    expect(bom.notGenerated).toEqual([{ nodeId: "lid", title: "lid", class: "print", status: "error_code" }]);
    expect(bom.print.map((r) => r.nodeId)).not.toContain("lid");
    const csv = bomCsv(bom);
    expect(csv.split("\n")[0]).toMatch(/^section,item,description/);
    expect(csv).toContain("lid,lid,,,,,,,,,,not generated (error_code)");
    expect(csv).toContain("custom — send to vendor");
  });

  it("keeps the length of joint-minted screws, which name a size and carry length as a param", () => {
    const minted = (id: string, length: number) =>
      node(id, "fastener", { ports: [{ name: "head_seat", type: "FLAT_FACE" }], params: { sku: "ISO7380-M3", length } });
    const b = buildBom(graph([minted("j1_screw", 12), minted("j2_screw", 12), minted("j3_screw", 16)]));
    expect(b.buy.map((r) => [r.sku, r.qty, r.description])).toEqual([
      ["ISO7380-M3x12", 2, "button M3×12"],
      ["ISO7380-M3x16", 1, "button M3×16"],
    ]);
  });

  it("withholds the vendor package until the gates pass", () => {
    const failed = buildBom(graph([{ ...shaft, status: "error_contract" }]));
    expect(failed.fabricate[0]).toMatchObject({ ready: false, vendorPackage: null });
  });

  it("lists a contract-stuck node's candidate as unverified, never as generated", () => {
    const candidate = { code: "def build(p): ...", hash: "c", stage: "G4b", report: "assertion failed" };
    const stuck = { ...plate, status: "error_contract", candidate };
    const b = buildBom(graph([stuck]));
    expect(b.print).toEqual([]);
    expect(b.unverified).toEqual([{ nodeId: "plate", title: "plate", class: "print", process: "fdm", failedStage: "G4b" }]);
    expect(bomCsv(b)).toContain("unverified candidate — failed G4b");
    expect(bomCsv(b)).not.toContain(",generated");
    // A node that recovered keeps no stale candidate in the BOM.
    expect(buildBom(graph([{ ...stuck, status: "ready" }])).print.map((r) => r.nodeId)).toEqual(["plate"]);
  });
});

describe("markCncSetups", () => {
  const plan = (sourcing: Record<string, unknown>, zAxes: (number | string)[][], type = "CLEARANCE_HOLE") =>
    ({
      nodes: [{
        id: "bracket",
        contract: { payload: { sourcing: { ...sourcing }, ports: zAxes.map((z, i) => ({ name: `p${i}`, type, pose: { origin: [0, 0, 0], zAxis: z, xAxis: [1, 0, 0] } })) } },
      }],
      edges: [],
      joints: [],
    }) as never;
  const flag = (out: { nodes: { contract: { payload: { sourcing: { allowUndercuts?: boolean } } } }[] }) =>
    out.nodes[0]!.contract.payload.sourcing.allowUndercuts;
  const cnc = { class: "fabricate", process: "cnc", material: "6061" };

  it("plans a second setup for a cnc L-bracket with holes on both legs", () => {
    expect(flag(markCncSetups(plan(cnc, [[0, 0, -1], [0, 1, 0]])))).toBe(true);
  });
  it("leaves a part whose features all open along Z in one setup", () => {
    expect(flag(markCncSetups(plan(cnc, [[0, 0, 1], [0, 0, -1]])))).toBeUndefined();
  });
  it("ignores stock faces, other processes and the architect's explicit false", () => {
    expect(flag(markCncSetups(plan(cnc, [[1, 0, 0]], "FLAT_FACE")))).toBeUndefined();
    expect(flag(markCncSetups(plan({ ...cnc, process: "laser_cut" }, [[1, 0, 0]])))).toBeUndefined();
    expect(flag(markCncSetups(plan({ ...cnc, allowUndercuts: false }, [[1, 0, 0]])))).toBe(false);
  });
  it("runs as part of the backend's plan expansion", () => {
    const out = new CadBackend().planning.expandPlan(plan(cnc, [[0, 1, 0]]));
    expect(flag(out as never)).toBe(true);
  });
});
