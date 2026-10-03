import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphDoc, type NodeRecord } from "@patchcad/shared";
import { classifyReprompt, contractHash, type LlmProvider, type RepairCtx } from "@patchcad/engine";
import { CadBackend, CAD_TIER_HINTS, type CadContractPayload } from "./index.js";
import { generatePrompt, repairPrompt } from "./prompts.js";
import { matchPitfalls, useLearnedPitfalls } from "./pitfalls.js";
import { WORKED_PLAN } from "./worked-plan.js";

/** Phase 3: CAD reprompts edit the code in hand, route by CAD words, and the
 *  architect sees a worked plan. */

const pose = { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] };

function ctx(thread: string[], currentCode?: string): RepairCtx<CadContractPayload> {
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
      thread: thread.map((content, i) => ({ role: "user" as const, content, at: i })),
      currentCode,
    },
    upstream: [],
    downstream: [],
    failedCode: "def build(p): ...",
    failure: { stage: "G3", report: "x" },
    attempt: 2,
    maxAttempts: 5,
    priorFailures: [],
  } as unknown as RepairCtx<CadContractPayload>;
}

const userTurn = (c: RepairCtx<CadContractPayload>) => generatePrompt(c).messages[0]!.content;
const CODE = "def build(p):\n    return fillet(Box(40, 40, 5).edges(), 1)";

describe("generatePrompt · current code on a reprompt", () => {
  it("shows the node's own code when the user asked for a change", () => {
    const text = userTurn(ctx(["make the fillet bigger"], CODE));
    expect(text).toContain("Current code (modify, don't rewrite");
    expect(text).toContain(CODE);
  });

  it("adds nothing on a first cook, even when an artifact exists", () => {
    expect(userTurn(ctx([], CODE))).not.toContain("Current code");
  });

  it("adds nothing when there is no code yet", () => {
    expect(userTurn(ctx(["make it rounder"]))).not.toContain("Current code");
  });

  it("keeps the system block byte-identical either way", () => {
    expect(generatePrompt(ctx(["x"], CODE)).system).toBe(generatePrompt(ctx([])).system);
  });

  it("carries into the repair base unchanged across rounds", () => {
    const a = repairPrompt(ctx(["x"], CODE)).messages[0]!.content;
    const b = repairPrompt({ ...ctx(["x"], CODE), attempt: 3 }).messages[0]!.content;
    expect(a).toBe(b);
    expect(a).toContain(CODE);
  });
});

describe("CAD tier hints", () => {
  const bracket = {
    id: "bracket",
    kind: "part",
    title: "Bracket",
    contract: {
      name: "Bracket",
      summary: "",
      params: [{ type: "number", name: "wall_thickness", description: "", default: 3 }],
      provides: [{ key: "mount_hole", type: "CLEARANCE_HOLE", description: "" }],
      requires: [{ key: "rail_face", type: "FLAT_FACE", description: "" }],
      payload: { ports: [{ name: "mount_hole" }, { name: "rail_face" }] },
      hash: "x",
    },
  } as unknown as NodeRecord;

  const trap: LlmProvider = {
    id: "trap",
    complete: () => {
      throw new Error("classifier called on a rule-decided CAD message");
    },
  };

  const table: [message: string, tier: "T2" | "T3"][] = [
    ["make the mount hole 5mm", "T3"],
    ["make the mount hole bigger", "T3"],
    ["mount hole Ø6 please", "T3"],
    ["increase the wall thickness to 4mm", "T3"],
    ["make the rail face wider", "T3"],
    ["add a hole for the cable", "T3"],
    ["add another mounting hole", "T3"],
    ["drill two holes in the side", "T3"],
    ["add a mount for a second fan", "T3"],
    ["make it rounder", "T2"],
    ["add a fillet", "T2"],
    ["add a fillet around the mount hole", "T2"],
    ["smoother edges", "T2"],
    ["chamfer the rail face edges", "T2"],
  ];

  for (const [message, tier] of table) {
    it(`${tier}: "${message}"`, async () => {
      expect((await classifyReprompt(trap, bracket, message, CAD_TIER_HINTS)).tier).toBe(tier);
    });
  }

  it("is what the CAD backend hands the router", () => {
    expect(new CadBackend().planning.tierHints).toBe(CAD_TIER_HINTS);
  });
});

describe("architect guidance", () => {
  const planning = new CadBackend().planning;

  it("carries the worked plan, code-free", () => {
    expect(planning.architectGuidance).toContain("WORKED PLAN");
    expect(planning.architectGuidance).toContain(JSON.stringify(WORKED_PLAN));
    expect(JSON.stringify(WORKED_PLAN)).not.toMatch(/def build|"code"/);
  });

  it("is the same string on every construction, so the prefix caches", () => {
    expect(new CadBackend().planning.architectGuidance).toBe(planning.architectGuidance);
  });

  it("replaces the web decomposition rules", () => {
    const rules = planning.architectRules!.join("\n");
    expect(rules).not.toMatch(/header|theme|colors/i);
    expect(rules).toMatch(/Fewest parts/);
  });

  it("the worked plan passes every CAD plan lint once its joint is expanded", () => {
    const plan = planning.expandPlan(structuredClone(WORKED_PLAN) as never);
    expect(plan.nodes.map((n) => n.id)).toEqual(["base-plate", "l-bracket", "bolt_screw", "bolt_insert"]);
    const graph = GraphDoc.parse({
      schemaVersion: 1,
      id: "worked",
      backend: "cad",
      brief: { goal: "", constraints: [], clarifications: [] },
      nodes: Object.fromEntries(
        plan.nodes.map((n) => {
          const contract = { ...n.contract, hash: "" };
          contract.hash = contractHash(contract as never);
          return [n.id, { ...n, contract }];
        }),
      ),
      edges: plan.edges.map((e, i) => ({ id: `e${i}`, ...e })),
      assembly: { entryNodeId: plan.entryNodeId },
      joints: plan.joints,
      rev: 0,
    });
    for (const n of Object.values(graph.nodes)) {
      expect(planning.payloadSchema.safeParse(n.contract.payload).success, n.id).toBe(true);
    }
    expect(planning.graphLints.flatMap((l) => l.run(graph))).toEqual([]);
  });
});

describe("learned pitfalls", () => {
  afterEach(() => useLearnedPitfalls(undefined));

  const write = (list: unknown) => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "pitfalls-")), "cad.pitfalls.json");
    writeFileSync(file, JSON.stringify(list));
    return file;
  };
  const learned = (over: Record<string, unknown> = {}) => ({
    id: "learned-G2-abc",
    stage: "G2",
    pattern: "volume is # widgets",
    fix: "learned fix",
    occurrences: 3,
    ...over,
  });

  it("merges a learned pitfall the seeds do not cover", () => {
    useLearnedPitfalls(write([learned()]));
    expect(matchPitfalls("G2", "volume is # widgets").map((p) => p.id)).toEqual(["learned-G2-abc"]);
  });

  it("ignores one seen fewer than three times", () => {
    useLearnedPitfalls(write([learned({ occurrences: 2 })]));
    expect(matchPitfalls("G2", "volume is # widgets")).toEqual([]);
  });

  it("ranks seeds first, so a learned fix only fills a free slot", () => {
    useLearnedPitfalls(write([learned({ pattern: "contains no solids" })]));
    expect(matchPitfalls("G2", "result contains no solids", 1).map((p) => p.id)).toEqual(["no-solids"]);
  });

  it("survives a missing or corrupt file", () => {
    useLearnedPitfalls("/nonexistent/cad.pitfalls.json");
    expect(matchPitfalls("G2", "result contains no solids").map((p) => p.id)).toEqual(["no-solids"]);
  });
});
