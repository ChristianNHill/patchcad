import { describe, expect, it } from "vitest";
import type { RepairCtx } from "@patchcad/engine";
import { generatePrompt, repairPrompt } from "./prompts.js";
import type { CadContractPayload } from "./index.js";

/**
 * The repair prompt is the only channel a gate measurement has to the model.
 * cad-acceptance.ts phase 3 asserts the same thing end-to-end against a live
 * kernel; this covers it without spending an LLM call.
 */

const pose = { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] };

function ctx(over: Partial<RepairCtx<CadContractPayload>> = {}): RepairCtx<CadContractPayload> {
  return {
    brief: { goal: "a clamp", constraints: [], clarifications: [] },
    node: {
      id: "base-plate",
      kind: "part",
      title: "Base Plate",
      spec: "a flat plate",
      contract: {
        name: "Base Plate",
        summary: "",
        params: [],
        provides: [],
        requires: [],
        hash: "",
        payload: {
          units: "mm",
          process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
          ports: [],
          envelope: { volumes: [{ kind: "box", pose, dims: [40, 40, 5] }], clearance: 0.4 },
        },
      },
      params: {},
      thread: [],
    },
    upstream: [],
    downstream: [],
    failedCode: "def build(p): ...",
    failure: { stage: "G3", report: 'port "mount_hole" (BORE): expected Ø4.5, measured Ø6.00' },
    attempt: 2,
    maxAttempts: 5,
    priorFailures: [],
    ...over,
  } as RepairCtx<CadContractPayload>;
}

const lastUser = (ctxIn: RepairCtx<CadContractPayload>) => {
  const msgs = repairPrompt(ctxIn).messages;
  return msgs[msgs.length - 1]!.content;
};

describe("generatePrompt exemplars", () => {
  const exemplar = {
    title: "Fan Mount Plate",
    kind: "part",
    code: "def build(p):\n    return Box(60, 60, 5)",
    contract: {
      name: "Fan Mount Plate",
      summary: "",
      hash: "elsewhere",
      provides: [],
      requires: [],
      params: [{ type: "number" as const, name: "width", description: "plate width", default: 60 }],
      payload: {
        units: "mm",
        process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
        ports: [{ name: "seat", type: "FLAT_FACE", pose, params: { size: 8 } }],
        envelope: { volumes: [{ kind: "box", pose, dims: [60, 60, 5] }], clearance: 0.4 },
      },
    },
  };

  const withExemplars = (exemplars: unknown[]) =>
    generatePrompt({ ...ctx(), exemplars } as unknown as Parameters<typeof generatePrompt>[0]);

  it("adds nothing at all when there are none", () => {
    const bare = generatePrompt(ctx());
    expect(bare.messages[0]!.content).not.toContain("VERIFIED EXAMPLES");
    expect(withExemplars([]).messages[0]!.content).not.toContain("VERIFIED EXAMPLES");
  });

  it("shows the contract that was asked for and the code that satisfied it", () => {
    const user = withExemplars([exemplar]).messages[0]!.content;
    expect(user).toContain("VERIFIED EXAMPLES");
    expect(user).toContain("Fan Mount Plate");
    expect(user).toContain("p.width");
    expect(user).toContain("seat (FLAT_FACE)");
    expect(user).toContain("return Box(60, 60, 5)");
  });

  it("warns against copying dimensions, which is the obvious failure mode", () => {
    expect(withExemplars([exemplar]).messages[0]!.content).toContain("never the dimensions");
  });

  it("keeps an imported node's start expression out of the system block", () => {
    const imported = (id: string) => {
      const c = ctx();
      return generatePrompt({ ...c, node: { ...c.node, id, kind: "imported", params: { scale: 1 } } } as unknown as Parameters<typeof generatePrompt>[0]);
    };
    const [a, b] = [imported("piece-0"), imported("piece-1")];
    // One system block for every mesh node in the wave, so it stays cached.
    expect(a.system).toBe(b.system);
    expect(a.system).toContain("WRAPS AN IMPORTED MESH");
    expect(a.system).not.toContain("piece-0");
    expect(a.messages[0]!.content).toContain('part = load_import("piece-0.ply"');
    expect(b.messages[0]!.content).toContain('part = load_import("piece-1.ply"');
    expect(a.system).toContain("You write ONE part as build123d");
  });

  it("keeps the system block identical, so it stays prefix-cacheable", () => {
    // Exemplars are per-node; putting them in `system` would give every node
    // in a parallel wave a different prefix.
    expect(withExemplars([exemplar]).system).toBe(generatePrompt(ctx()).system);
  });

  it("carries them into repair rounds too", () => {
    const repair = repairPrompt({ ...ctx(), exemplars: [exemplar] } as never);
    expect(repair.messages[0]!.content).toContain("VERIFIED EXAMPLES");
  });
});

describe("repairPrompt", () => {
  it("carries the gate measurement through verbatim", () => {
    // The exact string cad-acceptance greps for.
    expect(lastUser(ctx())).toMatch(/expected Ø4\.5, measured Ø6\.0?0?/);
  });

  it("replays the failed code so the model edits rather than restarts", () => {
    const msgs = repairPrompt(ctx()).messages;
    expect(msgs[msgs.length - 2]).toMatchObject({ role: "assistant" });
    expect(msgs[msgs.length - 2]!.content).toContain("def build(p)");
  });

  it("states where in the budget this attempt falls", () => {
    expect(lastUser(ctx())).toContain("attempt 2 of 5");
  });

  it("says nothing about earlier attempts on the first repair", () => {
    expect(lastUser(ctx())).not.toContain("Earlier attempts");
  });

  it("lists earlier failures so spent approaches are not retried", () => {
    const text = lastUser(
      ctx({
        attempt: 4,
        priorFailures: [
          { stage: "G1", report: "SyntaxError: unexpected indent\n  line 3" },
          { stage: "G2", report: "boolean produced an empty solid" },
        ],
      }),
    );
    expect(text).toContain("Earlier attempts");
    expect(text).toContain("G1: SyntaxError: unexpected indent");
    expect(text).toContain("G2: boolean produced an empty solid");
    // The measured lines under the headline are kept: they often name the fix.
    expect(text).toContain("line 3");
  });

  it("keeps a multi-line report but caps it, so a traceback cannot crowd out the failure", () => {
    const report = ["port \"bolt\": expected Ø4.5, measured Ø9.00", "hint: Cylinder takes a radius",
      ...Array.from({ length: 10 }, (_, i) => `frame ${i}`)].join("\n");
    const text = lastUser(ctx({ attempt: 3, priorFailures: [{ stage: "G3", report }] }));
    expect(text).toContain("measured Ø9.00");
    expect(text).toContain("hint: Cylinder takes a radius");
    expect(text).toContain("frame 3");
    expect(text).not.toContain("frame 4");
  });

  it("keeps the first user turn identical across rounds, so it stays cacheable", () => {
    const early = repairPrompt(ctx()).messages[0];
    const late = repairPrompt(
      ctx({ attempt: 4, priorFailures: [{ stage: "G1", report: "SyntaxError" }, { stage: "G2", report: "x" }] }),
    ).messages[0];
    expect(late).toEqual(early);
  });

  it("keeps the system block byte-identical whatever the failure", () => {
    const plain = generatePrompt(ctx()).system;
    const repaired = repairPrompt(
      ctx({
        failure: { stage: "TIMEOUT", report: "execution exceeded 20s and was killed" },
        priorFailures: [{ stage: "G1", report: "build(p) raised IndexError: list index out of range" }],
        basedOnAttempt: 1,
        attempt: 3,
      } as never),
    ).system;
    expect(repaired).toBe(plain);
  });

  it("puts known fixes for the failure in the repair turn", () => {
    const text = lastUser(ctx());
    expect(text).toContain("Known fixes");
    expect(text).toContain("Cylinder takes a RADIUS");
  });

  it("offers no fixes when nothing matches", () => {
    expect(lastUser(ctx({ failure: { stage: "G3", report: "something novel" } }))).not.toContain("Known fixes");
  });

  it("names the attempt being repaired when it is not the latest", () => {
    expect(lastUser(ctx({ attempt: 4, basedOnAttempt: 2 } as never))).toContain(
      "You are fixing attempt 2, the closest so far",
    );
    expect(lastUser(ctx({ attempt: 4 }))).not.toContain("You are fixing attempt");
    // attempt is the round about to run, so attempt 3 IS the latest
    expect(lastUser(ctx({ attempt: 4, basedOnAttempt: 3 } as never))).not.toContain("You are fixing attempt");
  });

  it("warns on the last round, and only then", () => {
    expect(lastUser(ctx({ attempt: 5, maxAttempts: 5 }))).toContain("FINAL attempt");
    expect(lastUser(ctx({ attempt: 4, maxAttempts: 5 }))).not.toContain("FINAL attempt");
  });

  it("keeps the generator prompt as its base, so the contract is still pinned", () => {
    const p = repairPrompt(ctx());
    expect(p.role).toBe("repair");
    expect(p.system).toContain("build123d ALGEBRA MODE");
    expect(p.messages[0]!.content).toContain("Base Plate");
  });
});

describe("shared design intent", () => {
  const withDesign = (design: string) =>
    generatePrompt({
      ...ctx(),
      brief: { goal: "a clamp", constraints: [], clarifications: [], design },
    } as unknown as Parameters<typeof generatePrompt>[0]).messages[0]!.content;

  it("reaches the generator when the architect wrote one", () => {
    // The only channel by which hermetic parts can agree on anything the
    // contracts do not pin.
    expect(withDesign("Soft 1mm fillets throughout; chunky, workshop-tool proportions.")).toContain(
      "Soft 1mm fillets throughout",
    );
  });

  it("adds no empty scaffolding when there isn't one", () => {
    const bare = withDesign("");
    expect(bare).not.toContain("Shared design intent");
    // and the goal still gets through
    expect(bare).toContain("a clamp");
  });

  it("rides into repair rounds too, so a fix cannot drift off-style", () => {
    const repair = repairPrompt({
      ...ctx(),
      brief: { goal: "a clamp", constraints: [], clarifications: [], design: "Chamfered edges only." },
    } as never);
    expect(repair.messages[0]!.content).toContain("Chamfered edges only.");
  });
});

describe("vision in the repair loop", () => {
  const img = { mediaType: "image/png" as const, dataB64: "iVBORw0KGgo=" };

  it("attaches the render to the same turn as the failure", () => {
    // Read together or not at all: the number and the shape are one judgement.
    const msgs = repairPrompt({ ...ctx(), render: img } as never).messages;
    const last = msgs[msgs.length - 1]!;
    expect(last.images).toEqual([img]);
    expect(last.content).toMatch(/expected Ø4\.5, measured Ø6\.0?0?/);
  });

  it("tells the model what it is looking at, and what to do with it", () => {
    const msgs = repairPrompt({ ...ctx(), render: img } as never).messages;
    const text = msgs[msgs.length - 1]!.content;
    expect(text).toContain("what your code actually built");
    expect(text).toContain("if the SHAPE is wrong");
  });

  it("says nothing about an image when there is none", () => {
    const msgs = repairPrompt(ctx()).messages;
    const last = msgs[msgs.length - 1]!;
    expect(last.images).toBeUndefined();
    expect(last.content).not.toContain("The image shows");
  });
});

/**
 * B7's measurable half. The repair loop varied only by the prior-failure
 * ledger, so attempt 4 of 5 read exactly like attempt 2 while the model kept
 * refining an approach that had already failed twice.
 *
 * These assert the INSTRUCTION differs by round, which is provable with zero
 * model calls. They deliberately do not assert a pass-rate improvement: five
 * runs of rib-blocked-hole gave generator calls of 2, 2, 4, 1, 2 (mean 2.20, sd
 * 1.10), so detecting a half-call change needs roughly 74 runs per arm at about
 * $21 each. An unfalsifiable claim is worse than no claim.
 */
describe("the repair prompt changes tactics as rounds run out", () => {
  const round = (attempt: number, priors = 2, maxAttempts = 5) =>
    repairPrompt(
      ctx({
        attempt,
        maxAttempts,
        priorFailures: Array.from({ length: priors }, () => ({
          stage: "G3",
          report: "port \"bolt\": bottoms out at 2.80mm instead of passing through",
        })),
      }),
    ).messages.map((m) => m.content).join("\n");

  it("says nothing special on an early round", () => {
    const early = round(2);
    expect(early).not.toContain("SECOND TO LAST");
    expect(early).not.toContain("FINAL attempt");
  });

  it("tells the penultimate round to change tactics, not numbers", () => {
    const late = round(4);
    expect(late).toContain("SECOND TO LAST");
    expect(late).toContain("Change tactics rather than adjusting numbers");
    expect(late).toContain("One round remains");
    expect(late).not.toContain("FINAL attempt");
  });

  it("tells the final round to prefer something that certainly passes", () => {
    const last = round(5);
    expect(last).toContain("FINAL attempt");
    expect(last).not.toContain("SECOND TO LAST");
  });

  it("does not preach tactics with nothing spent yet", () => {
    // No prior failures means this approach has not been tried at all, so
    // "refining the same approach has failed more than once" would be a lie.
    expect(round(4, 0)).not.toContain("SECOND TO LAST");
  });

  it("needs TWO priors, because one failure is not 'more than once'", () => {
    expect(round(4, 1)).not.toContain("SECOND TO LAST");
    expect(round(4, 2)).toContain("SECOND TO LAST");
  });

  // web-code runs maxAttempts 3, where the penultimate round is round 2 and only
  // one failure can have happened. A 3-round budget has no room for a distinct
  // penultimate strategy, so it is skipped rather than asserted falsely.
  it("stays silent on a 3-round budget, where the claim cannot be true", () => {
    expect(round(2, 1, 3)).not.toContain("SECOND TO LAST");
    expect(round(3, 2, 3)).toContain("FINAL attempt");
  });

  it("still carries the gate measurement, which is the whole point of the prompt", () => {
    expect(round(4)).toContain("bottoms out at 2.80mm");
  });
});

describe("fresh starts", () => {
  it("lists approaches already tried when a generate carries prior failures", () => {
    const user = generatePrompt({
      ...ctx(),
      priorFailures: [{ stage: "G3", report: 'port "bolt": bottoms out at 2.80mm\nhint: cut deeper' }],
    } as never).messages[0]!.content;
    expect(user).toContain("Approaches already tried");
    expect(user).toContain("bottoms out at 2.80mm");
    expect(user).toContain("hint: cut deeper");
  });

  it("adds nothing on a plain first generate", () => {
    expect(generatePrompt(ctx()).messages[0]!.content).not.toContain("Approaches already tried");
  });
});

describe("generatePrompt · patterns and assertions", () => {
  const withPayload = (extra: Partial<CadContractPayload>) => {
    const c = ctx();
    c.node.contract.payload = { ...c.node.contract.payload, ...extra };
    return generatePrompt(c).messages[0]!.content;
  };

  it("lists the assertions the kernel will measure", () => {
    const user = withPayload({
      assertions: [
        { kind: "hole_count", min: 4, max: 4 },
        { kind: "bbox_axis", axis: "x", min: 79.5, max: 80.5 },
      ],
    });
    expect(user).toContain("Measured on the finished part");
    expect(user).toContain("hole_count min=4, max=4");
    expect(user).toContain("bbox_axis axis=x, min=79.5, max=80.5");
  });

  it("explains a pattern layout only when a pattern port exists", () => {
    const pattern = withPayload({
      ports: [{ name: "bolts", type: "HOLE_PATTERN", pose, params: { diameter: 4.5, count: 4, pcd: 50 } }] as never,
    });
    expect(pattern).toContain("circle of DIAMETER pcd");
    expect(generatePrompt(ctx()).messages[0]!.content).not.toContain("Pattern ports");
    expect(generatePrompt(ctx()).messages[0]!.content).not.toContain("Measured on the finished part");
  });
});

describe("generatePrompt ports and envelope", () => {
  const withGeometry = () => {
    const c = ctx();
    c.node.contract.params = [{ name: "thickness", type: "number", default: 5, description: "" }] as never;
    c.node.params = { thickness: 6 };
    c.node.contract.payload.ports = [
      {
        name: "mount_hole",
        type: "CLEARANCE_HOLE",
        pose: { origin: [10, 0, "param(base-plate.thickness) / 2"], zAxis: [0, 0, 1], xAxis: [0, 1, 0] },
        params: { diameter: 4.5 },
      },
      {
        name: "post",
        type: "FLAT_FACE",
        pose: { origin: [0, 0, "param(bracket.height) + 1"], zAxis: [0, 0, 1], xAxis: [1, 0, 0] },
        params: { size: 4 },
      },
    ] as never;
    c.node.contract.payload.envelope.volumes = [
      { kind: "cylinder", pose: { origin: [0, 0, 3], zAxis: [1, 0, 0], xAxis: [0, 1, 0] }, d: 8, h: "param(base-plate.thickness) * 4" },
      { kind: "box", pose: { ...pose, xAxis: [1, 1, 0] }, dims: [40, 40, 5] },
    ] as never;
    c.paramValues = { bracket: { height: 20 } };
    return generatePrompt(c).messages[0]!.content;
  };

  it("prints resolved numbers, the xAxis, and own-param origins as p formulas", () => {
    expect(withGeometry()).toContain(
      "mount_hole (CLEARANCE_HOLE) at origin [10, 0, 3] (z = p.thickness / 2), z-out [0, 0, 1], x [0, 1, 0]",
    );
  });

  it("resolves another node's param to a number but offers no p formula for it", () => {
    expect(withGeometry()).toContain("post (FLAT_FACE) at origin [0, 0, 21], z-out [0, 0, 1], x [1, 0, 0]");
  });

  it("prints each envelope volume's orientation", () => {
    const user = withGeometry();
    expect(user).toContain("cylinder Ø8×24 mm centered at [0, 0, 3], axis along [1, 0, 0]");
    expect(user).toContain("box 40×40×5 mm centered at [0, 0, 0], rotated: dims run along its own x [1, 1, 0]");
    expect(generatePrompt(ctx()).messages[0]!.content).toContain("box 40×40×5 mm centered at [0, 0, 0], axis-aligned");
  });
});

describe("fit cut targets on the generator's own ports", () => {
  const withPorts = (ports: unknown[]) => {
    const c = ctx();
    c.node.contract.payload.ports = ports as CadContractPayload["ports"];
    return c;
  };
  const dowel = { name: "pin_hole", type: "DOWEL_HOLE", pose, params: { diameter: 3, depth: 6, fit: "press" } };
  const seat = { name: "brg_seat", type: "BEARING_SEAT", pose, params: { od: 22, width: 7, fit: "slip" } };

  it("annotates each fitted port with the size to cut, from its nominal + fit", () => {
    const user = generatePrompt(withPorts([dowel, seat])).messages.at(-1)!.content;
    expect(user).toContain("pin_hole (DOWEL_HOLE)");
    expect(user).toContain("fdm: cut Ø 2.95 (diameter 3 − 0.05, press)");
    expect(user).toContain("fdm: cut Ø 22.15 (od 22 + 0.15, slip); pocket ≥ width deep on a shoulder lip ≥ 1 mm");
  });

  it("leaves the system block byte-identical", () => {
    expect(generatePrompt(withPorts([dowel, seat])).system).toBe(generatePrompt(ctx()).system);
  });

  it("aims a machined part at the machined band, not the printed one", () => {
    const c = withPorts([dowel, seat]);
    (c.node.contract.payload as { sourcing?: unknown }).sourcing = { class: "fabricate", process: "cnc", material: "6061" };
    const user = generatePrompt(c).messages.at(-1)!.content;
    expect(user).toContain("cnc: cut Ø 2.975 (diameter 3 − 0.025, press)");
    expect(user).toContain("cnc: cut Ø 22.025 (od 22 + 0.025, slip)");
    expect(user).not.toContain("fdm: cut");
  });

  it("adds nothing to ports with no fit", () => {
    const face = { name: "face", type: "FLAT_FACE", pose, params: {} };
    const user = generatePrompt(withPorts([face])).messages.at(-1)!.content;
    expect(user).not.toContain(": cut");
  });
});
