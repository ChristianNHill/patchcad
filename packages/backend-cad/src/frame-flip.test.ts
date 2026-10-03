import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { architectOutputToGraph, type ArchitectOutput } from "@patchcad/engine";
import { CadBackend } from "./index.js";
import { fixFrameFlips } from "./frame-flip.js";
import { cadPlanGeometryLint } from "./plan-geometry.js";

/** The hinge-revolute eval's plan (2026-10-03 11:53, after its repairs), as
 *  the architect drafts it: no minted hardware. Turning leaf-b's knuckle face
 *  180° about z lays the leaves on top of each other, which is the overlap that
 *  cost that run two repair rounds and a later run all three. */
const draft = JSON.parse(readFileSync(new URL("./fixtures/hinge-revolute-draft.json", import.meta.url), "utf8")) as ArchitectOutput;
const planning = new CadBackend().planning;
const check = (d: ArchitectOutput) =>
  planning.graphLints.flatMap((l) => l.run(architectOutputToGraph(planning.expandPlan(structuredClone(d)), "t", "cad", "g", "mm")));
const knuckle = (d: ArchitectOutput) =>
  (d.nodes.find((n) => n.id === "leaf-b")!.contract.payload as { ports: { name: string; pose: { xAxis: unknown[] } }[] }).ports.find(
    (p) => p.name === "knuckle_face",
  )!;

describe("frame flips", () => {
  it("turns the moving leaf back so the overlap clears, and says so", () => {
    expect(check(draft)).toEqual([]);
    const broken = structuredClone(draft);
    knuckle(broken).pose.xAxis = [0, -1, 0];
    const problems = check(broken);
    expect(problems.some((p) => p.startsWith("leaf-a and leaf-b are mated"))).toBe(true);
    const fixed = fixFrameFlips(broken, problems, check)!;
    expect(fixed.notes).toEqual([expect.stringMatching(/^frame flip: leaf-b\.knuckle_face turned 180° about its z/)]);
    expect(knuckle(fixed.draft).pose.xAxis).toEqual([0, 1, 0]);
    expect(check(fixed.draft)).toEqual([]);
  }, 60_000);

  it("never turns an imported part, whose frames are measured", () => {
    const broken = structuredClone(draft);
    knuckle(broken).pose.xAxis = [0, -1, 0];
    broken.nodes.find((n) => n.id === "leaf-b")!.kind = "imported";
    let checks = 0;
    const problems = ["leaf-a and leaf-b are mated, but once placed about 2552mm³ of their envelopes coincide"];
    expect(fixFrameFlips(broken, problems, () => (checks++, problems))).toBeNull();
    expect(checks).toBe(0);
  });

  it("leaves every other problem to the architect without linting anything", () => {
    let checks = 0;
    expect(fixFrameFlips(draft, ['leaf-b: port "knuckle_face" (FLAT_FACE) points INTO its own envelope'], () => (checks++, []))).toBeNull();
    expect(checks).toBe(0);
  });
});

/** The other half of the hinge failures: a bearing pivot places leaf-b only
 *  through its shaft, so the leaves have no edge between them. */
describe("hinges on a bearing pivot", () => {
  const graphOf = (d: ArchitectOutput) => architectOutputToGraph(planning.expandPlan(structuredClone(d)), "t", "cad", "g", "mm");
  const bearingHinge = () => {
    const d = structuredClone(draft);
    d.joints[0]!.load = "medium"; // not casual: the rules pick two bearings
    for (const n of d.nodes) for (const p of n.contract.params) {
      if (p.name === "length") (p as { default: number }).default = 60;
      if (p.name === "knuckle_od") (p as { default: number }).default = 14;
    }
    d.edges = d.edges.filter((e) => !(e.from === "leaf-a" && e.to === "leaf-b"));
    return d;
  };

  it("judges jointed leaves as a mated pair: interleaved knuckles pass, a leaf on a leaf does not", () => {
    const d = bearingHinge();
    const g = graphOf(d);
    expect(g.joints[0]!.expanded).toMatch(/^M1\|/);
    expect(g.edges.some((e) => e.from === "leaf-a" && e.to === "leaf-b")).toBe(false);
    expect(cadPlanGeometryLint.run(g)).toEqual([]);
    knuckle(d).pose.xAxis = [0, -1, 0];
    expect(cadPlanGeometryLint.run(graphOf(d))).toEqual([expect.stringMatching(/^leaf-a and leaf-b are mated, but once placed/)]);
  }, 60_000);

  it("reports a wall longer than the knuckle instead of seating a bearing outside it", () => {
    const d = structuredClone(draft);
    Object.assign(d.joints[0]!, { load: "medium", wallA: "param(leaf-a.length)" });
    const problems = check(d);
    expect(problems.some((p) => /^joint hinge: .*M1 wallA 40\.0 runs past a: its envelope holds only 8\.0/.test(p))).toBe(true);
    expect(problems.some((p) => p.includes("hinge_seat_b"))).toBe(false);
  });

  it("reports a bearing too big for the knuckle", () => {
    const d = structuredClone(draft);
    d.joints[0]!.load = "medium";
    expect(check(d).some((p) => /M1 room around the axis in a Ø7\.0 < bearing OD 10\.0/.test(p))).toBe(true);
  });
});
