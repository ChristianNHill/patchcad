import { describe, expect, it } from "vitest";
import { z } from "zod";
import { planGraph } from "./architect.js";
import { criticFindings, criticProblems, type CriticOutput } from "./plan-critic.js";
import { LlmCallError, type DomainBackend, type LlmProvider, type LlmRequest } from "./index.js";

const BRIEF = "a toy car whose four wheels spin on 2.2mm axle nails";

describe("criticFindings keeps only what the brief says", () => {
  const out: CriticOutput = {
    missing: [
      { what: "axle nails", quote: "spin on 2.2mm  Axle nails", why: "none planned", severity: "missing" },
      { what: "a spoiler", quote: "with a rear spoiler", why: "invented", severity: "missing" },
      { what: "wheels", quote: "four wheels", why: "present", severity: "ok" },
    ],
    quantities: [
      { item: "wheel", quote: "four wheels", briefSays: 4, planHas: 4 },
      { item: "axle nail", quote: "axle nails", briefSays: 4, planHas: 0 },
    ],
  };

  it("drops unquoted findings, ok items and matching counts", () => {
    const f = criticFindings({ ...out, quantities: [out.quantities[0]!] }, BRIEF);
    expect(f.missing.map((m) => m.what)).toEqual(["axle nails"]);
    expect(f.quantities).toEqual([]);
    expect(criticProblems(f)).toEqual([
      'The brief asks for axle nails ("spin on 2.2mm  Axle nails"): the plan has none. none planned',
    ]);
  });

  it("lets a count replace the missing finding that quotes the same words", () => {
    const f = criticFindings(out, BRIEF);
    expect(f.missing).toEqual([]);
    expect(criticProblems(f)).toEqual(['The brief asks for 4 × axle nail ("axle nails"): the plan has 0.']);
  });

  it("keeps an unquoted finding only when the brief is partly a picture", () => {
    const blank = { missing: [{ what: "a fin", quote: "", why: "in image 1", severity: "missing" as const }], quantities: [] };
    expect(criticFindings(blank, BRIEF).missing).toHaveLength(0);
    expect(criticFindings(blank, BRIEF, true).missing).toHaveLength(1);
  });
});

const node = (id: string, broken = false) => ({
  id, kind: "part", title: id, spec: "s",
  contract: { name: id, summary: "s", params: [], provides: [], requires: [], payload: { broken } },
});
const plan = (...nodes: ReturnType<typeof node>[]) => ({ rationale: "r", design: "", nodes, edges: [], entryNodeId: "body" });

const backend = (critic = true) =>
  ({
    id: "cad",
    planning: {
      nodeKinds: [{ kind: "part", description: "d", guidance: "g" }],
      payloadSchema: z.object({ broken: z.boolean() }),
      architectGuidance: "",
      graphLints: [
        {
          run: (g: { nodes: Record<string, { id: string; contract: { payload: unknown } }> }) =>
            Object.values(g.nodes)
              .filter((n) => (n.contract.payload as { broken: boolean }).broken)
              .map((n) => `${n.id}: broken`),
        },
      ],
      ...(critic ? { critic: { summarize: (g: { nodes: object }) => `parts: ${Object.keys(g.nodes).join(", ")}`, repairHint: "HINT" } } : {}),
    },
  }) as unknown as DomainBackend<unknown>;

/** The critic flags a missing axle until the summary it reads has one. */
const axleCritic = (req: LlmRequest<unknown>) => {
  const has = /parts: .*axle/.test(req.messages[0]!.content);
  return {
    missing: has ? [] : [{ what: "axle nails", quote: "axle nails", why: "no axle part", severity: "missing" }],
    quantities: [],
  };
};

/** Architect calls answer from `architect` in order; classifier calls from `critic`. */
function scripted(architect: unknown[], critic: (req: LlmRequest<unknown>) => unknown = axleCritic) {
  const calls: { role: string; label: string; text: string }[] = [];
  let i = 0;
  const provider = {
    id: "s",
    complete: async <T>(req: LlmRequest<T>) => {
      calls.push({ role: req.role, label: req.label, text: req.messages.at(-1)!.content });
      const usage = { inputTokens: 1, outputTokens: 1, usd: req.role === "classifier" ? 0.01 : 0.1 };
      if (req.role === "classifier") return { data: critic(req as LlmRequest<unknown>) as T, usage };
      const data = architect[i++];
      if (data instanceof Error) throw data;
      return { data: data as T, usage };
    },
  } as unknown as LlmProvider;
  return { provider, calls };
}

describe("planGraph runs the coverage critic after the lints", () => {
  it("feeds a finding to one repair and rechecks", async () => {
    const { provider, calls } = scripted([plan(node("body")), { nodes: [node("axle")] }]);
    const res = await planGraph({ provider, backend: backend(), projectId: "t", goal: BRIEF });
    expect(Object.keys(res.graph.nodes).sort()).toEqual(["axle", "body"]);
    expect(calls.map((c) => c.label.split(":")[0])).toEqual(["architect", "plan-critic", "architect-critic", "plan-critic-recheck"]);
    const repair = calls[2]!.text;
    expect(repair).toContain('The brief asks for axle nails ("axle nails"): the plan has none.');
    expect(repair).toContain("HINT");
    expect(res.critic).toMatchObject({ repaired: true, warnings: [], calls: 3, lintRounds: [] });
    expect(res.critic!.found).toHaveLength(1);
    // Billed to planning: two architect calls and two critic calls.
    expect(res.usage.usd).toBeCloseTo(0.22);
    expect(res.critic!.usd).toBeCloseTo(0.12);
    expect(res.repaired).toBe(true);
  });

  it("costs one call and changes nothing when the plan covers the brief", async () => {
    const { provider, calls } = scripted([plan(node("body"), node("axle"))]);
    const res = await planGraph({ provider, backend: backend(), projectId: "t", goal: BRIEF });
    expect(calls.map((c) => c.role)).toEqual(["architect", "classifier"]);
    expect(res.critic).toMatchObject({ found: [], warnings: [], repaired: false, calls: 1 });
    expect(res.repaired).toBe(false);
  });

  it("keeps the clean plan and warns when the repair will not lint", async () => {
    const broken = { nodes: [node("axle", true)] };
    const { provider, calls } = scripted([plan(node("body")), broken, broken, broken]);
    const res = await planGraph({ provider, backend: backend(), projectId: "t", goal: BRIEF });
    expect(Object.keys(res.graph.nodes)).toEqual(["body"]);
    expect(res.critic!.repaired).toBe(false);
    expect(res.critic!.warnings).toEqual(res.critic!.found);
    expect(res.critic!.warnings[0]).toContain("axle nails");
    // The critic repair, then two lint rounds on it, none of them kept.
    expect(calls.filter((c) => c.role === "architect")).toHaveLength(4);
    expect(res.lintRounds).toEqual([]);
    expect(res.critic!.lintRounds).toEqual([["axle: broken"], ["axle: broken"]]);
    expect(res.critic!.calls).toBe(4);
    expect(res.repaired).toBe(false);
  });

  it("warns with what the recheck still finds", async () => {
    const { provider } = scripted([plan(node("body")), { nodes: [node("wheel")] }]);
    const res = await planGraph({ provider, backend: backend(), projectId: "t", goal: BRIEF });
    expect(Object.keys(res.graph.nodes).sort()).toEqual(["body", "wheel"]);
    expect(res.critic!.repaired).toBe(true);
    expect(res.critic!.warnings).toHaveLength(1);
  });

  it("never fails a plan: a critic call that throws is billed and skipped", async () => {
    const { provider } = scripted([plan(node("body"))], () => {
      throw new LlmCallError("critic down", { inputTokens: 1, outputTokens: 1, usd: 0.05 });
    });
    const res = await planGraph({ provider, backend: backend(), projectId: "t", goal: BRIEF });
    expect(res.critic).toMatchObject({ found: [], warnings: [], calls: 1 });
    expect(res.usage.usd).toBeCloseTo(0.15);
  });

  it("does not run when the call opts out or the backend has no critic", async () => {
    for (const [b, opt] of [[backend(), false], [backend(false), undefined]] as const) {
      const { provider, calls } = scripted([plan(node("body"))]);
      const res = await planGraph({ provider, backend: b, projectId: "t", goal: BRIEF, critic: opt });
      expect(calls.map((c) => c.role)).toEqual(["architect"]);
      expect(res.critic).toBeNull();
    }
  });

  it("sees the brief and the summary, never code", async () => {
    const { provider, calls } = scripted([plan(node("body"), node("axle"))]);
    await planGraph({ provider, backend: backend(), projectId: "t", goal: BRIEF });
    expect(calls[1]!.text).toBe(`BRIEF:\nGoal: ${BRIEF}\n\nPLAN:\nparts: body, axle`);
  });
});
