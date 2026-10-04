import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { CadBackend } from "./index.js";
import { buildBom } from "./bom.js";
import { buildSequence, feasibleSequence, insertionQueries, instructionsDocument, type InsertionCheck } from "./instructions.js";

/** An example as the server loads it: the graph plus each node's code. */
function example(name: string) {
  const root = new URL(`../../../examples/${name}/`, import.meta.url);
  const g = GraphDoc.parse(JSON.parse(readFileSync(new URL("patchcad.json", root), "utf8")));
  for (const n of Object.values(g.nodes)) {
    const f = new URL(`nodes/${n.id}/v1.code.py`, root);
    if (existsSync(f)) n.artifact = { ...n.artifact!, code: readFileSync(f, "utf8") };
  }
  return { g, scene: new CadBackend().solveScene(g) };
}

/** Index of the first step that places `node` (part or hardware). */
const stepOf = (seq: ReturnType<typeof buildSequence>, node: string) =>
  seq.steps.findIndex((s) => s.parts.some((p) => p.nodeId === node) || s.hardware.some((h) => h.nodes.includes(node)));

describe("buildSequence", () => {
  it("cad-joints: inserts first, on their own, then the lid with its screws", () => {
    const { g, scene } = example("cad-joints");
    const seq = buildSequence(g, scene);
    expect(seq.base).toBe("enclosure");
    expect(seq.steps.map((s) => s.action)).toEqual(["press", "screw"]);
    expect(seq.steps[0]).toMatchObject({ parts: [], hardware: [{ sku: "HEATSET-M3", qty: 4, tool: "soldering iron with a heat-set tip" }] });
    expect(seq.steps[0]!.title).toBe("Press 4× M3 heat-set inserts into the Enclosure");
    expect(seq.steps[1]).toMatchObject({ parts: [{ nodeId: "lid", qty: 1 }], hardware: [{ sku: "ISO7380-M3x10", qty: 4, tool: "2 mm hex key" }] });
    // The screws go in after the lid is down: drawn as a second stage.
    expect(seq.steps[1]!.moving.filter((m) => m.stage === 1)).toHaveLength(4);
    expect(seq.sequenceProblems).toEqual([]);
  });

  it("cad-rotor: bearings, then the shaft through them, then collars, then the rotor", () => {
    const { g, scene } = example("cad-rotor");
    const seq = buildSequence(g, scene);
    const order = ["j1_bearing_a", "j1_shaft", "j1_collar", "rotor"].map((n) => stepOf(seq, n));
    expect(order).toEqual([0, 1, 2, 3]);
    expect(stepOf(seq, "j1_bearing_b")).toBe(0);
    expect(seq.steps[0]!.hardware).toEqual([expect.objectContaining({ sku: "BRG-625", qty: 2 })]);
    // The shaft comes up from below, through both bearings.
    expect(seq.steps[1]).toMatchObject({ action: "insert", direction: [0, 0, 1] });
    expect(seq.steps[1]!.title).toBe("Insert the Ø5×34 D-shaft through 2× 625 ball bearings");
    expect(seq.steps[2]!.title).toBe("Slide 2× Ø5 shaft collars onto the Ø5×34 D-shaft");
    expect(seq.steps[3]!.notes).toContain("Turn it by hand: it should spin freely.");
    expect(seq.sequenceProblems).toEqual([]);
  });

  it("cad-belt-drive: the motor and its pulley are a sub-assembly; the belt waits for both pulleys", () => {
    const { g, scene } = example("cad-belt-drive");
    const seq = buildSequence(g, scene);
    expect(seq.subassemblies).toEqual([expect.objectContaining({ id: "A", root: "j1_motor", nodes: ["j1_motor", "j1_motor_pulley"] })]);
    const bench = seq.steps.findIndex((s) => s.holds === "j1_motor");
    const attach = seq.steps.findIndex((s) => s.action === "attach");
    expect(bench).toBeGreaterThan(-1);
    expect(attach).toBe(bench + 1);
    // On the bench, only the motor is in the picture.
    expect(seq.steps[bench]!.context).toEqual(["j1_motor"]);
    expect(seq.steps[attach]!.moving.map((m) => m.key).sort()).toEqual(["j1_motor", "j1_motor_pulley"]);
    expect(stepOf(seq, "j1_bearing_a")).toBeLessThan(stepOf(seq, "j1_shaft"));
    for (const n of ["j1_collar", "j1_spacer", "j1_driven_pulley"]) expect(stepOf(seq, n)).toBeGreaterThan(stepOf(seq, "j1_shaft"));
    expect(stepOf(seq, "j1_belt")).toBeGreaterThan(Math.max(stepOf(seq, "j1_driven_pulley"), stepOf(seq, "j1_motor_pulley")));
    expect(seq.sequenceProblems).toEqual([]);
  });

  it.each(["cad-joints", "cad-rotor", "cad-belt-drive", "cad-clamp"])("%s: every copy once, BOM totals match", (name) => {
    const { g, scene } = example(name);
    const seq = buildSequence(g, scene);
    const bom = buildBom(g);
    const used = new Map<string, number>();
    for (const s of seq.steps) for (const h of s.hardware) used.set(h.sku, (used.get(h.sku) ?? 0) + h.qty);
    expect(Object.fromEntries(used)).toEqual(Object.fromEntries(bom.buy.map((r) => [r.sku, r.qty])));
    expect(seq.sequenceProblems).toEqual([]);
    expect(seq.steps.map((s) => s.n)).toEqual(seq.steps.map((_, i) => i + 1));
  });

  it("reports a part nothing mates", () => {
    const { g, scene } = example("cad-clamp");
    g.edges = g.edges.filter((e) => e.to !== "l-bracket");
    const seq = buildSequence(g, { ...scene, instances: { ...scene.instances, "l-bracket": [] } });
    expect(seq.sequenceProblems.some((p) => p.startsWith("l-bracket is not joined"))).toBe(true);
  });
});

describe("feasibleSequence", () => {
  /** Stands in for the kernel: `part` cannot get past `by` once `by` is placed. */
  const blocks = (pairs: [string, string][]): InsertionCheck => async (queries) =>
    queries.map((q) => ({
      id: q.id,
      blocked: pairs.filter(([part, by]) => q.moving.includes(part) && q.still.includes(by)).map(([part, by]) => ({ part, by })),
    }));

  it("moves a part ahead of what would block its way in", async () => {
    const { g, scene } = example("cad-belt-drive");
    const naive = buildSequence(g, scene);
    // The naive mate order puts the turntable on the shaft before the driven
    // pulley, which then cannot come down past it.
    expect(stepOf(naive, "turntable")).toBeLessThan(stepOf(naive, "j1_driven_pulley"));
    const seq = await feasibleSequence(g, scene, blocks([["j1_driven_pulley", "turntable"]]));
    expect(stepOf(seq, "j1_driven_pulley")).toBeLessThan(stepOf(seq, "turntable"));
    expect(seq.steps[stepOf(seq, "j1_driven_pulley")]!.notes).toContain("Fit this before the Turntable: it would block the way afterwards.");
    expect(seq.sequenceProblems).toEqual([]);
  });

  it("builds a blocked sub-assembly in place instead", async () => {
    const { g, scene } = example("cad-belt-drive");
    const seq = await feasibleSequence(g, scene, blocks([["j1_motor_pulley", "base"]]));
    expect(seq.subassemblies).toEqual([]);
    expect(seq.steps.some((s) => s.action === "attach")).toBe(false);
    // In place, the pulley goes on the motor after the motor is on the base;
    // the fake still says base blocks it, and no order can move the base.
    expect(seq.sequenceProblems.some((p) => /runs into base/.test(p))).toBe(true);
  });

  it("holds a shaft rider in place first when it cannot slide along the shaft", async () => {
    const { g, scene } = example("cad-rotor");
    // A rider walled in on its shaft (a drum between two frame walls): nothing
    // can go before the base, so it is held and the shaft goes through it.
    const seq = await feasibleSequence(g, scene, blocks([["rotor", "base"]]));
    const held = stepOf(seq, "rotor");
    expect(seq.steps[held]!.title).toBe("Hold the Rotor in place: the Ø5×34 D-shaft goes through it next");
    expect(seq.steps[held]!.moving).toEqual([expect.objectContaining({ key: "rotor", held: true })]);
    expect(held).toBeLessThan(stepOf(seq, "j1_shaft"));
    expect(stepOf(seq, "j1_bearing_a")).toBeLessThan(held);
    expect(seq.sequenceProblems).toEqual([]);
  });

  it("says when the sweep did not run, rather than passing", async () => {
    const { g, scene } = example("cad-rotor");
    const seq = await feasibleSequence(g, scene, async () => {
      throw new Error("kernel down");
    });
    expect(seq.sequenceProblems).toEqual([expect.stringContaining("insertion check did not run: kernel down")]);
  });

  it("sweeps each step's new copies past its context, one query per direction", () => {
    const { g, scene } = example("cad-rotor");
    const queries = insertionQueries(buildSequence(g, scene));
    const bearings = queries.filter((q) => q.id.startsWith("1:"));
    expect(bearings.map((q) => q.direction)).toEqual([[0, 0, -1], [0, 0, 1]]);
    expect(bearings.every((q) => q.still.includes("base"))).toBe(true);
  });
});

describe("instructionsDocument", () => {
  it("lists every bought part once with a 1:1 gauge for screws, and counts hardware callouts", () => {
    const { g, scene } = example("cad-joints");
    const { parts, document } = instructionsDocument(g, scene, buildSequence(g, scene));
    expect(parts.map((p) => p.key).sort()).toEqual(["enclosure", "j1_insert", "j1_insert#1", "j1_insert#2", "j1_insert#3", "j1_screw", "j1_screw#1", "j1_screw#2", "j1_screw#3", "lid"]);
    expect(document.items.map((i) => [i.id, i.qty, i.gauge_mm])).toEqual([["HEATSET-M3", 4, undefined], ["ISO7380-M3x10", 4, 10]]);
    expect(document.tools).toEqual(["soldering iron with a heat-set tip", "2 mm hex key"]);
    expect(document.steps[1]!.callouts).toEqual([{ keys: ["j1_screw", "j1_screw#1", "j1_screw#2", "j1_screw#3"], label: "4x" }]);
  });
});
