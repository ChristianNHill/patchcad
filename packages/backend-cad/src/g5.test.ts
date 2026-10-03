import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { CadBackend, cadPlanGeometryLint, fitFindings, hardwareAllowances, type ClashResult, type KernelClient } from "./index.js";
import { threadAllowances } from "./g5.js";
import { threadEngagementVolume } from "./grounding.js";

/** G5 attribution and the plan-time geometry lint. The kernel is stubbed: what
 *  is tested here is what the backend SENDS (copies, allowances, contacts) and
 *  how it attributes what comes back. The geometry itself is smoke.py's. */

type Vec = [number, number, number];
const UP: Vec = [0, 0, 1];
const DOWN: Vec = [0, 0, -1];
const pose = (origin: Vec, zAxis: Vec = UP) => ({ origin, zAxis, xAxis: [1, 0, 0] });

interface Spec {
  id: string;
  kind?: string;
  ports: { name: string; type: string; at: Vec; z?: Vec; params?: Record<string, number | string> }[];
  volumes?: unknown[];
  params?: { name: string; default: string | number }[];
  measured?: { key: string; measured_diameter: number }[];
}

const box = (dims: Vec, at: Vec = [0, 0, 0]) => ({ kind: "box", pose: pose(at), dims });
const cyl = (d: number, h: number, at: Vec = [0, 0, 0]) => ({ kind: "cylinder", pose: pose(at), d, h });

function node(s: Spec) {
  return {
    id: s.id,
    kind: s.kind ?? "part",
    title: s.id,
    spec: "",
    contract: {
      name: s.id,
      summary: "",
      params: (s.params ?? []).map((p) => ({ ...p, type: typeof p.default === "number" ? "number" : "string", description: "" })),
      provides: [],
      requires: [],
      payload: {
        units: "mm",
        process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
        ports: s.ports.map((p) => ({ name: p.name, type: p.type, pose: pose(p.at, p.z ?? UP), params: p.params ?? {} })),
        envelope: { volumes: s.volumes ?? [box([10, 10, 10])], clearance: 0.4 },
      },
      hash: "",
    },
    params: {},
    artifact: { code: `# ${s.id}`, testCode: "", hash: s.id },
    measurements: s.measured ? { version: 1, paramsHash: "", data: { ports: s.measured } } : null,
    status: "ready",
    version: 1,
  };
}

function graph(nodes: Spec[], edges: [string, string, string, string][]) {
  return GraphDoc.parse({
    schemaVersion: 1,
    id: "g5",
    backend: "cad",
    brief: { goal: "", constraints: [], clarifications: [] },
    nodes: Object.fromEntries(nodes.map((n) => [n.id, node(n)])),
    edges: edges.map(([from, fromPort, to, toPort], i) => ({ id: `e${i}`, from, fromPort, to, toPort })),
    assembly: { entryNodeId: nodes[0]!.id },
    rev: 0,
  });
}

/** 40×40×4 plate centred on the origin, three ports on its top face. */
const plate: Spec = {
  id: "plate",
  volumes: [box([40, 40, 4])],
  ports: [
    { name: "top", type: "FLAT_FACE", at: [0, 0, 2] },
    { name: "top2", type: "FLAT_FACE", at: [15, 0, 2] },
    { name: "near", type: "FLAT_FACE", at: [6, 0, 2] },
  ],
};
/** 10mm cube whose seat is its bottom face. */
const cube = (id: string): Spec => ({ id, ports: [{ name: "seat", type: "FLAT_FACE", at: [0, 0, -5], z: DOWN }] });

function stubKernel(clash: NonNullable<ClashResult["clash"]>, ok = true) {
  const calls: { parts: { key: string; matrix: number[] }[]; opts: Record<string, unknown> }[] = [];
  const kernel = {
    clash: async (parts: { key: string; matrix: number[] }[], opts: Record<string, unknown>) => {
      calls.push({ parts, opts });
      return ok ? { ok: true, clash } : { ok: false, error: "kernel said no" };
    },
  } as unknown as KernelClient;
  return { kernel, calls };
}

const empty = { parts: 0, pairs_tested: 0, clashes: [], contacts: [], errors: [] };
const ws = { root: "/tmp/patchcad-g5-test" };

describe("G5 globalCheck: instances, contacts, allowances, attribution", () => {
  // One arm node seated on two plate ports through the SAME arm port: a copy.
  const g = graph([plate, cube("arm")], [
    ["plate", "top", "arm", "seat"],
    ["plate", "top2", "arm", "seat"],
  ]);

  it("sends every placed copy, keyed node#i, and a contact query per mate", async () => {
    const { kernel, calls } = stubKernel(empty);
    await new CadBackend({ kernel }).globalCheck(g, ws);
    expect(calls[0]!.parts.map((p) => p.key)).toEqual(["plate", "arm", "arm#1"]);
    const contacts = calls[0]!.opts.contacts as { edge: string; at: number[] }[];
    expect(contacts.map((c) => [c.edge, c.at])).toEqual([
      ["e0", [0, 0, 2]],
      ["e1", [15, 0, 2]],
    ]);
  });

  it("attributes a clash on a copy to its node, and blocks with a structured finding", async () => {
    const { kernel } = stubKernel({
      ...empty,
      clashes: [{ a: "plate", b: "arm#1", volume_mm3: 40, at: [15, 0, 2] }],
    });
    const res = await new CadBackend({ kernel }).globalCheck(g, ws);
    expect(res.ok).toBe(false);
    expect(res.findings).toEqual([
      expect.objectContaining({ nodeA: "plate", nodeB: "arm", kind: "clash", measured: 40, expected: 0 }),
    ]);
    expect(res.problems.some((p) => p.includes("arm#1"))).toBe(true);
  });

  it("reports a floating mate as a gap on that edge's two nodes", async () => {
    const { kernel } = stubKernel({
      ...empty,
      contacts: [
        { edge: "e0", a: "plate", b: "arm", gap_mm: 3, at: [0, 0, 2] },
        { edge: "e1", a: "plate", b: "arm", gap_mm: 0.05, at: [15, 0, 2] },
      ],
    });
    const res = await new CadBackend({ kernel }).globalCheck(g, ws);
    expect(res.findings).toEqual([expect.objectContaining({ nodeA: "plate", nodeB: "arm", kind: "gap", measured: 3 })]);
    expect(res.findings![0]!.message).toContain("plate.top → arm.seat");
  });

  it("does not call a peg's designed slip clearance a gap", async () => {
    const pegged = graph(
      [
        { id: "base", ports: [{ name: "socket", type: "BORE", at: [0, 0, 5], params: { diameter: 5.3 } }] },
        { id: "peg", ports: [{ name: "pin", type: "SHAFT", at: [0, 0, -5], z: DOWN, params: { diameter: 5 } }] },
      ],
      [["base", "socket", "peg", "pin"]],
    );
    const { kernel } = stubKernel({ ...empty, contacts: [{ edge: "e0", a: "base", b: "peg", gap_mm: 0.15, at: [0, 0, 5] }] });
    expect((await new CadBackend({ kernel }).globalCheck(pegged, ws)).findings).toEqual([]);
  });

  it("asks the kernel to allow a screw's thread inside its nut, matched by kind", async () => {
    const bolted = graph(
      [
        plate,
        { id: "screw", kind: "fastener", ports: [{ name: "head_seat", type: "FLAT_FACE", at: [0, 0, 0], z: DOWN }], params: [{ name: "thread", default: "M4" }, { name: "length", default: 12 }] },
        { id: "nut", kind: "nut", ports: [{ name: "seat", type: "FLAT_FACE", at: [0, 0, 0], z: DOWN }], params: [{ name: "thread", default: "M4" }] },
      ],
      [
        ["plate", "top", "screw", "head_seat"],
        ["plate", "top2", "nut", "seat"],
      ],
    );
    const { kernel, calls } = stubKernel(empty);
    await new CadBackend({ kernel }).globalCheck(bolted, ws);
    const allow = calls[0]!.opts.allow as { a: string; b: string; volume_mm3: number }[];
    expect(allow).toHaveLength(1);
    expect(allow[0]).toMatchObject({ a: "screw", b: "nut" });
    expect(allow[0]!.volume_mm3).toBeCloseTo(12.8 * 1.5, 0);
  });

  it("engages a short insert by its own length, and scopes joint hardware to its joint", () => {
    const hw = (id: string, kind: string, sku: string): Spec => ({ id, kind, ports: [], params: [{ name: "sku", default: sku }] });
    const g = graph(
      [plate, hw("j1_screw", "fastener", "ISO4762-M4x12"), hw("j1_insert", "insert", "HEATSET-S-M4"), hw("j2_nut", "nut", "ISO4032-M4")],
      [],
    );
    (g as { joints?: unknown }).joints = [{ id: "j1" }, { id: "j2" }];
    // Only its own joint's insert: j2's nut is unrelated, so it stays clash-checked.
    const allow = threadAllowances(g);
    expect(allow.map((x) => [x.a, x.b])).toEqual([["j1_screw", "j1_insert"]]);
    // heatset_short M4 is 4mm long, not the standard 8.1.
    expect(allow[0]!.volume_mm3).toBeCloseTo(threadEngagementVolume("M4", 4) * 1.5, 6);
  });

  it("says the gate did not run when the kernel refuses, rather than passing", async () => {
    const { kernel } = stubKernel(empty, false);
    const res = await new CadBackend({ kernel }).globalCheck(g, ws);
    expect(res.ok).toBe(false);
    expect(res.problems[0]).toMatch(/clash check did not run: kernel said no/);
  });
});

describe("G5 declared fits", () => {
  const fit = (bore: number, shaft: number) =>
    graph(
      [
        { id: "base", ports: [{ name: "socket", type: "BORE", at: [0, 0, 5], params: { diameter: 5.3 } }], measured: [{ key: "socket", measured_diameter: bore }] },
        { id: "peg", ports: [{ name: "pin", type: "SHAFT", at: [0, 0, -5], z: DOWN, params: { diameter: 5 } }], measured: [{ key: "pin", measured_diameter: shaft }] },
      ],
      [["base", "socket", "peg", "pin"]],
    );

  it("passes a peg 0.3mm under its socket (the FDM slip fit)", () => {
    expect(fitFindings(fit(5.3, 5.0))).toEqual([]);
  });

  it("fails a press fit with measured against expected radial clearance", () => {
    expect(fitFindings(fit(5.0, 5.0))).toEqual([
      expect.objectContaining({ nodeA: "base", nodeB: "peg", kind: "fit", measured: 0, expected: 0.15 }),
    ]);
  });

  it("checks a screw against the registry clearance for its thread", () => {
    const g = graph(
      [
        { id: "plate", ports: [{ name: "hole", type: "CLEARANCE_HOLE", at: [0, 0, 2], params: { diameter: 4.0 } }] },
        { id: "screw", kind: "fastener", ports: [{ name: "head_seat", type: "FLAT_FACE", at: [0, 0, 0], z: DOWN }], params: [{ name: "thread", default: "M4" }] },
      ],
      [["plate", "hole", "screw", "head_seat"]],
    );
    const [f] = fitFindings(g);
    expect(f).toMatchObject({ kind: "fit", measured: 0, expected: 0.25 });
    expect(f!.message).toContain("Too tight");
  });

  it("reads a joint-minted screw's thread from its sku", () => {
    const g = graph(
      [
        { id: "plate", ports: [{ name: "hole", type: "CLEARANCE_HOLE", at: [0, 0, 2], params: { diameter: 4.0 } }] },
        { id: "screw", kind: "fastener", ports: [{ name: "head_seat", type: "FLAT_FACE", at: [0, 0, 0], z: DOWN }], params: [{ name: "sku", default: "ISO7380-M4" }] },
      ],
      [["plate", "hole", "screw", "head_seat"]],
    );
    expect(fitFindings(g)).toEqual([expect.objectContaining({ kind: "fit", measured: 0, expected: 0.25 })]);
  });
});

describe("plan-time geometry lint", () => {
  it("passes a cube seated on a plate", () => {
    expect(cadPlanGeometryLint.run(graph([plate, cube("arm")], [["plate", "top", "arm", "seat"]]))).toEqual([]);
  });

  it("flags two unmated parts the plan places inside each other", () => {
    const out = cadPlanGeometryLint.run(
      graph([plate, cube("arm"), cube("post")], [
        ["plate", "top", "arm", "seat"],
        ["plate", "near", "post", "seat"],
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^arm and post are not mated to each other.*overlap by up to 4\.0mm/);
  });

  it("does not flag the corner of a cylinder's bounding box", () => {
    // A Ø40 disc and a cube sitting just outside its rim but inside its box.
    const disc: Spec = { id: "disc", volumes: [cyl(40, 4)], ports: [{ name: "top", type: "FLAT_FACE", at: [0, 0, 2] }, { name: "rim", type: "FLAT_FACE", at: [17, 17, 2] }] };
    const out = cadPlanGeometryLint.run(
      graph([disc, cube("a"), cube("b")], [
        ["disc", "top", "a", "seat"],
        ["disc", "rim", "b", "seat"],
      ]),
    );
    expect(out.filter((p) => p.includes("not mated"))).toEqual([]);
  });

  it("leaves a part wholly inside another's envelope alone (a hollow enclosure)", () => {
    // board sits on a standoff on the shell's inner floor: never mated to the
    // shell, and wholly inside its (solid-box) envelope.
    const shell: Spec = { id: "shell", volumes: [box([60, 60, 60])], ports: [{ name: "floor", type: "FLAT_FACE", at: [0, 0, -20] }] };
    const standoff: Spec = { ...cube("standoff"), ports: [...cube("standoff").ports, { name: "top", type: "FLAT_FACE", at: [0, 0, 5] }] };
    const out = cadPlanGeometryLint.run(
      graph([shell, standoff, cube("board")], [
        ["shell", "floor", "standoff", "seat"],
        ["standoff", "top", "board", "seat"],
      ]),
    );
    expect(out.filter((p) => p.includes("not mated"))).toEqual([]);
  });

  it("flags a face port whose +z points into its own envelope", () => {
    const flipped: Spec = { ...plate, ports: [{ name: "top", type: "FLAT_FACE", at: [0, 0, 2], z: DOWN }] };
    const out = cadPlanGeometryLint.run(graph([flipped], []));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/plate: port "top" \(FLAT_FACE\) points INTO its own envelope/);
  });

  it("lets a SHAFT stand out along its own +z", () => {
    const peg: Spec = { id: "peg", volumes: [cyl(5, 10)], ports: [{ name: "pin", type: "SHAFT", at: [0, 0, -5] }] };
    expect(cadPlanGeometryLint.run(graph([peg], []))).toEqual([]);
  });

  it("reports a node the mates never place", () => {
    const out = cadPlanGeometryLint.run(graph([plate, cube("loose")], []));
    expect(out.some((p) => p.startsWith("plan assembly: loose is not positioned"))).toBe(true);
  });
});

describe("G5 hardware: designed overlap and fit bands", () => {
  const housing = (type: string, params: Record<string, number | string>): Spec => ({
    id: "housing",
    volumes: [box([40, 40, 20])],
    ports: [{ name: "host", type, at: [0, 0, 10], params }],
  });
  const part = (id: string, kind: string, params: Record<string, number | string>): Spec => ({
    id,
    kind,
    ports: [{ name: "seat", type: "FLAT_FACE", at: [0, 0, 0], z: DOWN }],
    params: Object.entries(params).map(([name, v]) => ({ name, default: v })),
  });
  const mated = (host: Spec, p: Spec) => graph([host, p], [["housing", "host", p.id, "seat"]]);
  const ring = (o: number, i: number, len: number) => (Math.PI / 4) * (o ** 2 - i ** 2) * len * 1.5;

  it("allows a press-fit bearing its interference ring, a slip one nothing", () => {
    const bearing = part("b608", "bearing", { od: 22, bore: 8, width: 7 });
    expect(hardwareAllowances(mated(housing("BEARING_SEAT", { od: 22, width: 7, fit: "press" }), bearing))).toEqual([
      { a: "housing", b: "b608", volume_mm3: expect.closeTo(ring(22, 21.9, 7), 6) },
    ]);
    expect(hardwareAllowances(mated(housing("BEARING_SEAT", { od: 22, width: 7, fit: "slip" }), bearing))).toEqual([]);
  });

  it("allows an insert's knurl, a press dowel and a nut in its trap", () => {
    const insert = mated(housing("INSERT_POCKET", { diameter: 4, depth: 5.8 }), part("ins", "insert", { thread: "M3" }));
    expect(hardwareAllowances(insert)[0]!.volume_mm3).toBeCloseTo(ring(4.6, 4, 5.8), 6);
    const dowel = mated(housing("DOWEL_HOLE", { diameter: 4, depth: 8, fit: "press" }), part("pin", "dowel", { diameter: 4 }));
    expect(hardwareAllowances(dowel)[0]!.volume_mm3).toBeCloseTo(ring(4, 3.9, 8), 6);
    expect(hardwareAllowances(mated(housing("DOWEL_HOLE", { diameter: 4, depth: 8, fit: "slip" }), part("pin", "dowel", {})))).toEqual([]);
    const nut = mated(housing("NUT_TRAP", { af: 5.5, depth: 2.4 }), part("n", "nut", { thread: "M3" }));
    expect(hardwareAllowances(nut)).toEqual([expect.objectContaining({ a: "housing", b: "n" })]);
  });

  it("reads a bearing's size from its SKU when it carries no dims of its own", () => {
    const g = graph(
      [housing("BEARING_SEAT", { od: 22, width: 7, fit: "slip" }), part("b608", "bearing", { sku: "BRG-608" }), part("axle", "shaft", { sku: "ROD-8" })],
      [["housing", "host", "b608", "seat"]],
    );
    expect(hardwareAllowances(g)).toEqual([{ a: "axle", b: "b608", volume_mm3: expect.closeTo(ring(8.1, 8, 7), 6) }]);
  });

  it("allows a shaft through a bearing's bore by kind, with no mate between them", () => {
    const g = graph(
      [housing("BEARING_SEAT", { od: 22, width: 7, fit: "slip" }), part("b608", "bearing", { od: 22, bore: 8, width: 7 }), part("axle", "shaft", { diameter: 8 })],
      [["housing", "host", "b608", "seat"]],
    );
    expect(hardwareAllowances(g)).toEqual([{ a: "axle", b: "b608", volume_mm3: expect.closeTo(ring(8.1, 8, 7), 6) }]);
  });

  it("allows a pressed bushing its ring, and a shaft through a bushing by kind", () => {
    // The toy car eval: every bushing clashed its body by 6.3mm³, the press ring.
    const g = graph(
      [housing("BUSHING_BORE", { od: 8, length: 5 }), part("bush", "bushing", { sku: "BUSH-5x8", length: 5 }), part("axle", "shaft", { sku: "DSHAFT-5" })],
      [["housing", "host", "bush", "seat"]],
    );
    expect(hardwareAllowances(g)).toEqual([
      { a: "housing", b: "bush", volume_mm3: expect.closeTo(ring(8, 7.9, 5), 6) },
      { a: "axle", b: "bush", volume_mm3: expect.closeTo(ring(5.1, 5, 5), 6) },
    ]);
  });

  it("allows a wheel pressed onto its axle, and nothing for a slip hub", () => {
    const hub = (fit?: string) => graph(
      [housing("HUB_BORE", { diameter: 5, depth: 10, ...(fit ? { fit } : {}) }), part("axle", "shaft", { sku: "DSHAFT-5" })],
      [["housing", "host", "axle", "seat"]],
    );
    expect(hardwareAllowances(hub("press"))).toEqual([{ a: "housing", b: "axle", volume_mm3: expect.closeTo(ring(5, 4.9, 10), 6) }]);
    expect(hardwareAllowances(hub())).toEqual([]);
  });

  it("allows any two gears of one module the mesh band, joint or not", () => {
    const gear = (id: string, module: number) => part(id, "gear", { module, teeth: 20, thickness: 6 });
    expect(hardwareAllowances(graph([gear("g20", 1), gear("g40", 1)], []))).toEqual([
      { a: "g20", b: "g40", volume_mm3: expect.closeTo(0.2 * 0.1 * 1 * 6 * 1.5, 6) },
    ]);
    expect(hardwareAllowances(graph([gear("g20", 1), gear("g40", 1.5)], []))).toEqual([]);
  });

  it("sends the hardware allowances to the kernel beside the thread ones", async () => {
    const { kernel, calls } = stubKernel(empty);
    const g = mated(housing("DOWEL_HOLE", { diameter: 4, depth: 8, fit: "press" }), part("pin", "dowel", { diameter: 4 }));
    await new CadBackend({ kernel }).globalCheck(g, ws);
    expect(calls[0]!.opts.allow).toEqual([expect.objectContaining({ a: "housing", b: "pin" })]);
  });

  it("checks a bearing's OD against its seat's measured fit band", () => {
    const seat = (fit: string, measured?: number): Spec => ({
      ...housing("BEARING_SEAT", { od: 22, width: 7, fit }),
      measured: measured === undefined ? undefined : [{ key: "host", measured_diameter: measured }],
    });
    const bearing = part("b608", "bearing", { od: 22, bore: 8, width: 7 });
    expect(fitFindings(mated(seat("press", 21.95), bearing))).toEqual([]);
    expect(fitFindings(mated(seat("slip", 22.15), bearing))).toEqual([]);
    expect(fitFindings(mated(seat("slip"), bearing))).toEqual([]);
    expect(fitFindings(mated(seat("press", 22.15), bearing))).toEqual([
      expect.objectContaining({ nodeA: "housing", nodeB: "b608", kind: "fit", measured: 0.075, expected: -0.025 }),
    ]);
  });

  it("holds a machined seat to the machined band", () => {
    const cnc = (fit: string, measured: number): Spec => ({
      ...housing("BEARING_SEAT", { od: 22, width: 7, fit }),
      measured: [{ key: "host", measured_diameter: measured }],
    });
    const bearing = part("b608", "bearing", { od: 22, bore: 8, width: 7 });
    const g = (fit: string, d: number) => {
      const doc = mated(cnc(fit, d), bearing);
      (doc.nodes.housing!.contract.payload as { process: { kind: string } }).process.kind = "CNC";
      return doc;
    };
    expect(fitFindings(g("slip", 22.02))).toEqual([]);
    expect(fitFindings(g("slip", 22.15))).toEqual([expect.objectContaining({ kind: "fit", expected: 0.0125 })]);
  });

  it("checks a shaft against the bearing bore it is mated into", () => {
    const shaft = (d: number): Spec => ({
      id: "axle",
      kind: "shaft",
      ports: [{ name: "pin", type: "SHAFT", at: [0, 0, 0], params: { diameter: d } }],
    });
    const bearing: Spec = { ...part("b608", "bearing", { od: 22, bore: 8, width: 7 }), ports: [{ name: "bore", type: "FLAT_FACE", at: [0, 0, 0] }] };
    const g = (d: number) => graph([bearing, shaft(d)], [["b608", "bore", "axle", "pin"]]);
    expect(fitFindings(g(8))).toEqual([]);
    expect(fitFindings(g(7.7))).toEqual([expect.objectContaining({ kind: "fit", measured: 0.15 })]);
  });
});
