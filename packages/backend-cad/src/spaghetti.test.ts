import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { CadBackend, cadBoreShaftLint, cadEntryOnceLint, cadRoundFaceLint, cadThreadPartnerLint, threadAllowances } from "./index.js";

/** design-spaghetti-shelf (2026-10-05): 6 parts placed of 26, a foot stud and
 *  six face ports on a round rod. Each failure now has a check of its own. */
const g = GraphDoc.parse(JSON.parse(readFileSync(new URL("./fixtures/design-spaghetti-shelf-graph.json", import.meta.url), "utf8")));

describe("the spaghetti shelf's failures, caught", () => {
  it("copies carry what hangs on them: a rod under every bracket, a foot under every rod", () => {
    const { instances } = new CadBackend().solveScene(g);
    expect([instances.bracket, instances.rod, instances.foot].map((m) => m!.length)).toEqual([2, 4, 4]);
  });

  it("face ports on the rod's curved side are refused at plan time", () => {
    expect(cadRoundFaceLint.run(g).map((m) => m.split('"')[1])).toEqual(["level_1", "level_2", "level_3", "level_4", "level_5", "level_6"]);
  });

  it("tapped holes nothing threads into are refused at plan time", () => {
    expect(cadThreadPartnerLint.run(g).map((m) => m.split('"')[1])).toEqual(["thumb_screw_front", "thumb_screw_back", "foot_thread"]);
  });

  it("the foot, given a THREADED_STUD mated to the hole, shares its thread with the rod", () => {
    const fixed = structuredClone(g);
    const foot = fixed.nodes.foot!.contract.payload as { ports: unknown[] };
    foot.ports.push({ name: "stud", type: "THREADED_STUD", pose: { origin: [0, 0, 12], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, params: { thread: "M8", length: 20 } });
    fixed.edges.push({ id: "e-stud", from: "rod", fromPort: "foot_thread", to: "foot", toPort: "stud" } as never);
    expect(cadThreadPartnerLint.run(fixed).filter((m) => m.includes("foot_thread"))).toEqual([]);
    expect(threadAllowances(fixed).find((x) => x.a === "foot" && x.b === "rod")?.volume_mm3).toBeGreaterThan(132);
  });

  it("its bore and entry were fine, and stay unflagged", () => {
    expect(cadBoreShaftLint.run(g)).toEqual([]);
    expect(cadEntryOnceLint.run(g)).toEqual([]);
  });
});
