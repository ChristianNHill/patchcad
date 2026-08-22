import { describe, expect, it } from "vitest";
import type { NodeRecord } from "@patchcad/shared";
import { CadBackend } from "./index.js";

/**
 * Failure attribution decides whether a stuck node goes back to the generator
 * (code-invalid) or to the architect (contract-infeasible). It is judged on
 * repeated failures, so the counts it treats as "persistent" have to move with
 * the repair budget — see CadBackend.maxAttempts.
 */

// classifyFailure reads only `failures` and `attempts`; the node is inert here.
const node = { id: "part", kind: "part" } as unknown as NodeRecord;

function classify(
  failures: { stage: string; report: string }[],
  attempts: number,
  backend = new CadBackend(),
) {
  return backend.classifyFailure({ node, failures, attempts });
}

const g4 = (n: number) =>
  Array.from({ length: n }, () => ({ stage: "G4", report: "3 mesh vertices escape the declared envelope" }));
const g3 = (n: number, port: string) =>
  Array.from({ length: n }, () => ({
    stage: "G3",
    report: `port "${port}" (BORE): expected Ø4.5, measured Ø6.00`,
  }));
/** The over-cut variant: material missing where a wall should be. */
const g3open = (n: number, port: string) =>
  Array.from({ length: n }, () => ({
    stage: "G3",
    report: `port "${port}" (SLOT): no wall within 63.8mm at 0.6mm depth — the channel is open, not a 20.6mm gap`,
  }));

describe("CadBackend.classifyFailure", () => {
  it("defaults to a wider budget than the engine", () => {
    expect(new CadBackend().maxAttempts).toBe(5);
    expect(new CadBackend({ maxAttempts: 3 }).maxAttempts).toBe(3);
  });

  // A desk-edge cable clip burned all 5 rounds and $0.51 landing in
  // error_contract, telling the user to re-plan a part that was perfectly
  // buildable. The generator had faked a mouth chamfer with a Box rotated 45°,
  // which spans leg*√2 per rotated axis and ate the whole 2.4mm jaw wall. Same
  // port, every round, so the persistence rule blamed the architect.
  it("does not blame the architect when a channel reads as over-cut", () => {
    expect(classify(g3open(4, "desk_slot"), 5)).toBe("code-invalid");
    expect(classify(g3open(5, "desk_slot"), 5)).toBe("code-invalid");
  });

  it("still blames the architect for a persistent dimension MISMATCH", () => {
    expect(classify(g3(4, "desk_slot"), 5)).toBe("contract-infeasible");
  });

  it("an over-cut channel does not mask a real mismatch on the same port", () => {
    expect(classify([...g3open(2, "seat"), ...g3(4, "seat")], 5)).toBe("contract-infeasible");
  });

  it("keeps the historical 2-of-3 behaviour at the old budget", () => {
    expect(classify(g4(2), 3)).toBe("contract-infeasible");
    expect(classify(g3(2, "mount_hole"), 3)).toBe("contract-infeasible");
  });

  it("does not call 2-of-5 persistent", () => {
    // The whole point of buying more rounds: a part that escaped its envelope
    // twice out of five was still converging, not proven unbuildable.
    expect(classify(g4(2), 5)).toBe("code-invalid");
    expect(classify(g3(2, "mount_hole"), 5)).toBe("code-invalid");
  });

  it("still escalates once a clear majority of a wider budget fails the same way", () => {
    expect(classify(g4(4), 5)).toBe("contract-infeasible");
    expect(classify(g3(4, "mount_hole"), 5)).toBe("contract-infeasible");
  });

  it("judges G3 on the worst single port, not on every failure agreeing", () => {
    // One unrelated port miss used to clear the real culprit entirely.
    const mixed = [...g3(4, "mount_hole"), ...g3(1, "pilot")];
    expect(classify(mixed, 5)).toBe("contract-infeasible");
  });

  it("does not escalate when no single port repeats enough", () => {
    const scattered = [...g3(2, "a"), ...g3(1, "b"), ...g3(1, "c"), ...g3(1, "d")];
    expect(classify(scattered, 5)).toBe("code-invalid");
  });

  it("treats unrelated gate failures as the generator's problem", () => {
    const syntax = Array.from({ length: 5 }, () => ({ stage: "G1", report: "SyntaxError" }));
    expect(classify(syntax, 5)).toBe("code-invalid");
  });
});
