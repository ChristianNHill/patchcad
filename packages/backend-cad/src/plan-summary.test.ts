import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { summarizeCadPlan } from "./plan-summary.js";

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("summarizeCadPlan: the plan as the coverage critic reads it", () => {
  const stand = GraphDoc.parse(fixture("real-folding-phone-stand.json"));
  const text = summarizeCadPlan(stand);

  it("names made parts, joints with motion and hardware, and the overall size", () => {
    expect(text).toContain('- back-plate "Back plate (rear leg)" ×1 [print fdm]');
    expect(text).toContain("dims: width=70 depth=66 thickness=6");
    expect(text).toContain("- hinge: back-plate ↔ front-plate, revolute (removable, travel -80..0°, shaft Ø1.75); hardware: pin_clip=eclip:1.2");
    expect(text).toContain("- hinge_pin_clip ×1: e-clip 1.2 (DIN 6799)");
    expect(text).toContain("largest first, axes unnamed): 70 × 66 × 12 mm");
  });

  it("carries no code and no expansion plumbing", () => {
    for (const n of Object.values(stand.nodes)) if (n.artifact?.code) expect(text).not.toContain(n.artifact.code.slice(0, 40));
    expect(text).not.toMatch(/def build|hinge_[a-z_]+=/);
  });

  it("says so when nothing moves", () => {
    const car = structuredClone(stand);
    car.joints = [];
    const t = summarizeCadPlan(car);
    expect(t).toContain("JOINTS (0):\n- none: no joint is declared");
  });

  const cases = fixture("plan-critic-cases.json") as { id: string; summary: string; expect: { mustFlag: string[] } }[];
  it("keeps the regression set's anchors: what the critic must catch", () => {
    const by = Object.fromEntries(cases.map((c) => [c.id, c]));
    expect(by["real-pinewood-car"]!.summary).toContain("JOINTS (0)");
    expect(by["real-pinewood-car"]!.expect.mustFlag).toEqual(["nail|axle"]);
    expect(by["real-extruder-cw2"]!.expect.mustFlag).toEqual(["gear"]);
    expect(cases).toHaveLength(15);
  });
});
