import { describe, expect, it } from "vitest";
import { GraphDoc, type NodeRecord } from "@patchcad/shared";
import { CadBackend } from "./index.js";

/**
 * Failure attribution decides whether a stuck node goes back to the generator
 * (code-invalid) or to the architect (contract-infeasible). It is judged on
 * repeated failures, so the counts it treats as "persistent" have to move with
 * the repair budget — see CadBackend.maxAttempts.
 */

// classifyFailure reads `failures` and `attempts` here; the node carries no
// envelope, so the escape-proportion rule cannot fire and these exercise the
// round-counting heuristic on its own.
const node = { id: "part", kind: "part" } as unknown as NodeRecord;
const emptyGraph = { nodes: {} } as unknown as GraphDoc;

function classify(
  failures: { stage: string; report: string }[],
  attempts: number,
  backend = new CadBackend(),
) {
  return backend.classifyFailure({ graph: emptyGraph, node, failures, attempts });
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

describe("a large G4 escape is the architect's on the first failure", () => {
  /** A one-node graph whose envelope dims are T1 EXPRESSIONS, which is what real
   *  contracts contain. An earlier version of this suite hardcoded numbers, so it
   *  passed while the feature did nothing on every project on disk. */
  const sphereGraph = (diameter: number, vol?: unknown) =>
    ({
      nodes: {
        ball: {
          id: "ball",
          kind: "part",
          params: { diameter },
          contract: {
            params: [{ type: "number", name: "diameter", default: diameter, description: "" }],
            payload: {
              envelope: {
                volumes: [
                  vol ?? { kind: "cylinder", d: "param(ball.diameter)", h: "param(ball.diameter)" },
                ],
              },
            },
          },
        },
      },
    }) as unknown as GraphDoc;

  const ball = (g: GraphDoc) => (g as unknown as { nodes: Record<string, NodeRecord> }).nodes.ball!;

  const g4at = (worst: number) => [{
    stage: "G4",
    report: `240 mesh vertices escape the declared envelope (worst ${worst.toFixed(2)} mm past the 0.5 mm tolerance, near [0.0, 0.0, 2.5])`,
  }];

  const verdict = (worst: number, diameter = 5, vol?: unknown) => {
    const g = sphereGraph(diameter, vol);
    return new CadBackend().classifyFailure({ graph: g, node: ball(g), failures: g4at(worst), attempts: 5 });
  };

  it("escalates on ONE failure through a T1 expression, which is the real shape", () => {
    // 5mm-sphere/ball: a Ø5 envelope for a sphere its spec says is centred on
    // the origin, so 2.5mm is outside by construction. It spent five calls and
    // died `cancelled` proving that.
    expect(verdict(2.5)).toBe("contract-infeasible");
  });

  it("leaves a small escape to the generator", () => {
    expect(verdict(0.4)).toBe("code-invalid");
  });

  it("scales with the envelope rather than a fixed millimetre count", () => {
    expect(verdict(3, 5), "3mm out of a 5mm box").toBe("contract-infeasible");
    expect(verdict(3, 200), "3mm out of a 200mm box").toBe("code-invalid");
  });

  it("falls back to round-counting when no dim resolves", () => {
    const broken = { kind: "cylinder", d: "param(nope.missing)", h: "param(nope.missing)" };
    expect(verdict(2.5, 5, broken)).toBe("code-invalid");
  });
});
