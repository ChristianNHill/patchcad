import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { reexpandGraph } from "@patchcad/engine";
import { CadBackend } from "./index.js";
import { jointInput } from "./expand.js";
import { assemblyFindings, cadAssemblyPlanLint } from "./feasibility.js";
import type { AssemblySequence } from "./instructions.js";
import { selectJoint, type JointDecision, type JointInput } from "./joints.js";

const stand = () => GraphDoc.parse(JSON.parse(readFileSync(new URL("fixtures/real-folding-phone-stand.json", import.meta.url), "utf8")));

const pivot: JointInput = {
  intent: "removable", motion: "revolute", load: "light", access: "both_sides", wallA: 10, wallB: 10, processA: "FDM", processB: "FDM", allowPrinted: true,
};
const pick = (i: Partial<JointInput>) => selectJoint({ ...pivot, ...i }) as JointDecision;

describe("an integral pin only where b can get onto it", () => {
  it("the phone stand's front plate sits between the back plate's knuckles", () => {
    const g = stand();
    expect(jointInput(g, g.joints![0] as never)).toMatchObject({ trappedB: true });
  });

  it("a trapped b gets a separate pin: filament stock for a Ø1.75 hint", () => {
    expect(pick({}).rule).toBe("M2p");
    expect(pick({ trappedB: true }).rule).not.toBe("M2p");
    expect(pick({ trappedB: true, shaftHint: 1.75 })).toMatchObject({ rule: "M2d", parts: [{ role: "pin", family: "filament_pin", key: "1.75" }] });
  });

  it("print in place keeps the integral pin, captive with clearance and no clip", () => {
    const d = pick({ trappedB: true, printInPlace: true, shaftHint: 3 });
    expect(d).toMatchObject({ rule: "M2p", parts: [], dims: { d: 3, bore: 3.6 } });
    expect(selectJoint({ ...pivot, motion: "fixed", printInPlace: true })).toMatchObject({ error: expect.stringMatching(/revolute/) });
  });

  it("re-expanding the phone stand swaps the e-clip for a filament pin drilled through the back plate", () => {
    const g = reexpandGraph(stand(), new CadBackend() as never)!.graph;
    expect(g.nodes.hinge_pin_clip).toBeUndefined();
    expect(g.nodes.hinge_pin?.kind).toBe("pin");
    const hole = (g.nodes["back-plate"]!.contract.payload as { ports: { name: string; params: Record<string, unknown> }[] }).ports.find((p) => p.name === "hinge_pin_a");
    // Through the knuckle (wallA), so the pin goes in once the front plate is there.
    expect(hole?.params.depth).toBeCloseTo(10.68, 2);
  });
});

describe("assemblyFindings", () => {
  const block = (part: string, by: string, volume = 50): NonNullable<AssemblySequence["blocked"]>[number] =>
    ({ step: 1, part, by, direction: [-1, 0, 0], at: [0, 0, 0], travel_mm: 5, volume_mm3: volume });
  const seq = (blocked: NonNullable<AssemblySequence["blocked"]>): AssemblySequence => ({ base: "back-plate", steps: [], subassemblies: [], sequenceProblems: [], blocked });

  it("an integral pin is the contract's to fix, one finding per blocked part", () => {
    const g = stand();
    const out = assemblyFindings(g, seq([block("front-plate", "hinge_pin_clip", 900), block("front-plate", "back-plate")]), {});
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "assembly", nodeA: "front-plate", nodeB: "back-plate" });
    expect(out[0]!.repair).toBeUndefined();
    expect(out[0]!.message).toMatch(/printInPlace: true/);
  });

  it("a print-in-place pair is never a finding", () => {
    const g = stand();
    g.joints = g.joints!.map((j) => ({ ...j, printInPlace: true }));
    expect(assemblyFindings(g, seq([block("front-plate", "back-plate")]), {})).toEqual([]);
  });

  it("a block inside both envelopes is the contracts'; between catalog parts it blames their seats", () => {
    const g = stand();
    (g.joints![0] as { expanded?: string }).expanded = "M2d|pin=filament_pin:1.75";
    const [made] = assemblyFindings(g, seq([block("front-plate", "back-plate")]), {});
    expect(made).toMatchObject({ kind: "assembly", blame: ["front-plate", "back-plate"] });
    expect(made!.repair).toBeUndefined();
    const [hw] = assemblyFindings(g, seq([block("hinge_pin_clip", "hinge_pin_clip#1")]), {});
    expect(hw!.blame).toEqual(["back-plate"]);
  });
});

describe("cadAssemblyPlanLint", () => {
  const defects = JSON.parse(readFileSync(new URL("fixtures/assembly-defects.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const example = (name: string) => GraphDoc.parse(JSON.parse(readFileSync(new URL(`../../../examples/${name}/patchcad.json`, import.meta.url), "utf8")));

  it("a magnet posed on its pocket's face, not in it", () => {
    const problems = cadAssemblyPlanLint.run(GraphDoc.parse(defects["asm-magnetic-lid"]));
    expect(problems).toHaveLength(8);
    expect(problems[0]).toMatch(/^magnet: mated to box's MAGNET_POCKET "magnet_fl" but posed ON its face/);
  });

  it("a gear on a shaft's axis but past its end", () => {
    const problems = cadAssemblyPlanLint.run(GraphDoc.parse(defects["asm-hand-winch"]));
    expect(problems).toEqual([
      expect.stringMatching(/^drum-gear: sits 8mm past the end of j-drum_shaft \(94mm long\)/),
      expect.stringMatching(/^pinion: sits 70mm past the end of j-crank_shaft/),
    ]);
  });

  it.each(["cad-rotor", "cad-joints", "cad-belt-drive", "cad-clamp"])("%s is clean", (name) => {
    expect(cadAssemblyPlanLint.run(example(name))).toEqual([]);
  });
});
