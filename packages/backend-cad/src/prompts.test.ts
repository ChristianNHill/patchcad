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
    // First line only — a full multi-line report per entry would crowd out the
    // failure actually being repaired.
    expect(text).not.toContain("line 3");
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
