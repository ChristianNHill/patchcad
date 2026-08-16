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

describe("CadBackend.classifyFailure", () => {
  it("defaults to a wider budget than the engine", () => {
    expect(new CadBackend().maxAttempts).toBe(5);
    expect(new CadBackend({ maxAttempts: 3 }).maxAttempts).toBe(3);
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
