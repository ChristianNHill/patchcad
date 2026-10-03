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

  it("sends a cnc undercut that persists to the architect: the setup count is the contract's", () => {
    const undercut = (n: number) =>
      Array.from({ length: n }, () => ({
        stage: "G4c",
        report: 'process cnc "undercut": 447.6 mm² of surface cannot be reached by a tool from +Z or -Z',
      }));
    expect(classify(undercut(4), 5)).toBe("contract-infeasible");
    expect(classify(undercut(2), 5)).toBe("code-invalid");
    const corner = Array.from({ length: 5 }, () => ({ stage: "G4c", report: 'process cnc "internal_corner": 4 corners' }));
    expect(classify(corner, 5)).toBe("code-invalid");
  });
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

  // The contract gates now report every failing port at once, so one report
  // names several. Only the first used to be read, hiding a persistent second.
  const combined = (n: number) =>
    Array.from({ length: n }, () => ({
      stage: "G3",
      report:
        "3 gate failures — fix all of them in this attempt:\n" +
        '1. [G3] port "a" (BORE): no hole found at the declared origin\n' +
        '2. [G3] port "b" (BORE): expected Ø4, measured Ø6.00\n' +
        "3. [G4] 12 mesh vertices escape the declared envelope",
    }));

  it("counts every port named in a combined report", () => {
    const shifting = [...combined(2), ...g3(2, "b")];
    expect(classify(shifting, 5)).toBe("contract-infeasible");
  });

  it("counts an envelope escape reported beside port failures as G4", () => {
    expect(classify([...combined(2), ...g4(2)], 5)).toBe("contract-infeasible");
    expect(classify(combined(2), 5)).toBe("code-invalid");
  });

  it("treats unrelated gate failures as the generator's problem", () => {
    const syntax = Array.from({ length: 5 }, () => ({ stage: "G1", report: "SyntaxError" }));
    expect(classify(syntax, 5)).toBe("code-invalid");
  });
});

describe("CadBackend.classifyFailure · G4b assertions", () => {
  const g4b = (n: number, label: string) =>
    Array.from({ length: n }, () => ({ stage: "G4b", report: `assertion "${label}": expected 4 holes, measured 3` }));

  it("a size the model cannot reach in most rounds is the contract's problem", () => {
    expect(classify(g4b(4, "bbox_axis x"), 5)).toBe("contract-infeasible");
    expect(classify(g4b(4, "volume_range"), 5)).toBe("contract-infeasible");
  });

  it("finds the assertion inside a combined report staged G3", () => {
    const combined = Array.from({ length: 4 }, (_, i) => ({
      stage: "G3",
      report: `2 gate failures:\n1. [G3] port "p${i}" (BORE): expected Ø4.5, measured Ø6.00\n2. [G4b] assertion "bbox_axis z": expected at most 6 mm along z, measured 9`,
    }));
    expect(classify(combined, 5)).toBe("contract-infeasible");
  });

  it("a hole count, symmetry or wall stays with the generator", () => {
    expect(classify(g4b(5, "hole_count"), 5)).toBe("code-invalid");
    expect(classify(g4b(5, "symmetry yz"), 5)).toBe("code-invalid");
    expect(classify(g4b(5, "min_wall"), 5)).toBe("code-invalid");
  });

  it("one bad round is not persistent", () => {
    expect(classify(g4b(1, "bbox_axis x"), 5)).toBe("code-invalid");
  });
});

describe("CadBackend.classifyFailure · assertions the architect miscounted", () => {
  const lineCount = (measured: number, stage = "G4b") => ({
    stage,
    report: `assertion "line_count": expected 2 material crossings from [-44.0, 0.0, 15.0] to [44.0, 0.0, 15.0], measured ${measured}`,
  });

  it("the same line_count twice on an otherwise passing part goes to the architect", () => {
    expect(classify([lineCount(4), lineCount(4)], 5)).toBe("contract-infeasible");
  });

  it("a count that moves, or one beside a port miss, stays with the generator", () => {
    expect(classify([lineCount(4), lineCount(3)], 5)).toBe("code-invalid");
    expect(classify([lineCount(4)], 5)).toBe("code-invalid");
    expect(classify([lineCount(4, "G3"), lineCount(4, "G3")], 5)).toBe("code-invalid");
  });
});

describe("CadBackend.classifyFailure · hardware host features", () => {
  const host = (od: number, envelope: number) =>
    ({
      id: "hub",
      kind: "part",
      contract: {
        payload: {
          ports: [{ name: "seat", type: "BEARING_SEAT", params: { od, width: 7, fit: "press" } }],
          envelope: { volumes: [{ kind: "box", dims: [envelope, envelope, 10] }] },
        },
      },
    }) as unknown as NodeRecord;
  const misses = (n: number) =>
    Array.from({ length: n }, () => ({ stage: "G3", report: 'port "seat" (BEARING_SEAT): expected Ø21.90..22.00, measured Ø22.30' }));

  it("a seat cut wrong every round is still the generator's to fix", () => {
    expect(new CadBackend().classifyFailure({ node: host(22, 40), failures: misses(5), attempts: 5 })).toBe("code-invalid");
  });

  it("a seat wider than the whole envelope is the contract's", () => {
    expect(new CadBackend().classifyFailure({ node: host(22, 20), failures: misses(4), attempts: 5 })).toBe("contract-infeasible");
  });

  it("an inert node never escalates a hardware miss", () => {
    expect(classify(misses(5), 5)).toBe("code-invalid");
  });

  // t5-002: the trap was right (8.60 on a 8.4..8.8 band) and the probe read a
  // drop slot as a flat, five rounds running.
  const trap = (range: string) => ({
    stage: "G3",
    report: `port "nut_pocket" (NUT_TRAP): across the flats measured ${range} along the flat normals, expected 8.4..8.8\nhint: cut the hex`,
  });

  it("a probe that reads the same numbers twice with its smallest on target is the contract's", () => {
    expect(classify([trap("8.60..11.93"), trap("8.60..11.93")], 5)).toBe("contract-infeasible");
  });

  it("a trap cut wrong, or cut differently each round, stays with the generator", () => {
    expect(classify([trap("9.70..9.70"), trap("9.70..9.70")], 5)).toBe("code-invalid");
    expect(classify([trap("8.60..11.93"), trap("8.60..11.20")], 5)).toBe("code-invalid");
  });
});

describe("CadBackend.classifyFailure · unreadable declarations", () => {
  it("sends a contract the kernel could not read to the architect after one round", () => {
    const report = 'assertion "hole_count" is malformed: KeyError: \'min\'';
    expect(classify([{ stage: "CONTRACT", report }], 5)).toBe("contract-infeasible");
    expect(classify([{ stage: "G3", report: `2 gate failures:\n1. [G3] port "a" (BORE): expected Ø4\n2. [CONTRACT] ${report}` }], 5))
      .toBe("contract-infeasible");
  });
});
