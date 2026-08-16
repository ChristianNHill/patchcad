import { describe, expect, it } from "vitest";
import type { RepairCtx } from "@patchcad/engine";
import { repairPrompt } from "./prompts.js";
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
