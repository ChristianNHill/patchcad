/**
 * The plan coverage critic against the real-product briefs.
 *
 *   pnpm exec tsx src/plan-critic-eval.ts --build          # stored plans → fixture, 0 LLM
 *   pnpm exec tsx src/plan-critic-eval.ts --plan <caseId>  # plan one case (critic off), store it
 *   pnpm exec tsx src/plan-critic-eval.ts --plan <caseId> --critic  # plan with the critic, report it
 *   pnpm exec tsx src/plan-critic-eval.ts [--only id,...]  # the critic, live, on every fixture case
 *
 * The fixture holds each case's brief and the summary the critic reads, built
 * from the newest stored plan: a cooked eval result's graph first, then a dry
 * run's plan.json, then a failed plan's last draft. `expect` names what the
 * critic MUST flag (regexes over its finding lines) and how many findings a
 * good plan may draw before it counts as noise.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { architectOutputToGraph, critiquePlan, planGraph, type ArchitectOutput } from "@patchcad/engine";
import { CadBackend, summarizeCadPlan } from "@patchcad/backend-cad";
import { GraphDoc } from "@patchcad/shared";
import { resolveProvider } from "./providers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const casesDir = path.join(repo, "evals/cases/real");
const results = path.join(repo, "evals/results");
const fixture = path.join(repo, "packages/backend-cad/src/fixtures/plan-critic-cases.json");

interface CriticCase {
  id: string;
  source: string;
  brief: string;
  summary: string;
  expect: { mustFlag: string[]; maxFindings?: number };
}

/** What a stored plan is known to miss, from reading it against its brief.
 *  Everything else may draw at most `maxFindings` lines. */
const EXPECT: Record<string, CriticCase["expect"]> = {
  "real-pinewood-car": { mustFlag: ["nail|axle"], maxFindings: 3 },
  "real-extruder-cw2": { mustFlag: ["gear"], maxFindings: 4 },
  "real-step-stool": { mustFlag: [], maxFindings: 1 },
  "real-round-stool": { mustFlag: [], maxFindings: 1 },
};

const { values: args } = parseArgs({
  options: { build: { type: "boolean" }, plan: { type: "string" }, critic: { type: "boolean" }, only: { type: "string" } },
});

const load = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

/** The newest stored plan per case, as a GraphDoc. */
function storedPlan(id: string): { graph: GraphDoc; source: string } | null {
  const cooked = fs
    .readdirSync(results)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
  for (const f of cooked) {
    let d: { results?: { id: string; graph?: unknown }[] };
    try {
      d = load(path.join(results, f));
    } catch {
      continue;
    }
    const r = d.results?.find((x) => x.id === id && x.graph);
    if (r) return { graph: GraphDoc.parse(r.graph), source: `evals/results/${f}` };
  }
  const work = path.join(results, ".work", id);
  if (fs.existsSync(path.join(work, "plan.json")))
    return { graph: GraphDoc.parse(load(path.join(work, "plan.json"))), source: `.work/${id}/plan.json` };
  if (fs.existsSync(path.join(work, "failed-plan.json"))) {
    const draft = load(path.join(work, "failed-plan.json")) as ArchitectOutput;
    return { graph: architectOutputToGraph(draft, id, "cad", ""), source: `.work/${id}/failed-plan.json (did not lint clean)` };
  }
  return null;
}

const caseFiles = fs.readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
const prompts = Object.fromEntries(caseFiles.map((f) => [load(path.join(casesDir, f)).id as string, load(path.join(casesDir, f)).prompt as string]));
const only = args.only?.split(",");

if (args.plan) {
  const id = args.plan;
  const resolved = await resolveProvider();
  if (!resolved) throw new Error("no LLM provider configured");
  const plan = await planGraph({
    provider: resolved.provider,
    backend: new CadBackend(),
    projectId: `eval-${id}`,
    goal: prompts[id]!,
    critic: !!args.critic,
    onPhase: (p, d) => console.log(`  ${p} ${d ?? ""}`),
  });
  const dir = path.join(results, ".work", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, args.critic ? "plan-critic.json" : "plan.json"), JSON.stringify(plan.graph, null, 1));
  console.log(`${id}: ${Object.keys(plan.graph.nodes).length} nodes, $${plan.usage.usd.toFixed(3)}`);
  if (plan.critic) console.log(JSON.stringify(plan.critic, null, 1), "\n", summarizeCadPlan(plan.graph));
} else if (args.build) {
  const cases: CriticCase[] = [];
  for (const id of Object.keys(prompts)) {
    const stored = storedPlan(id);
    if (!stored) {
      console.log(`${id}: no stored plan`);
      continue;
    }
    const brief = `Goal: ${prompts[id]}`;
    cases.push({ id, source: stored.source, brief, summary: summarizeCadPlan(stored.graph), expect: EXPECT[id] ?? { mustFlag: [] } });
    console.log(`${id}: ${stored.source}`);
  }
  fs.writeFileSync(fixture, JSON.stringify(cases, null, 1) + "\n");
} else {
  const resolved = await resolveProvider();
  if (!resolved) throw new Error("no LLM provider configured");
  console.log(`provider ${resolved.source}`);
  const cases = (load(fixture) as CriticCase[]).filter((c) => !only || only.includes(c.id));
  let usd = 0;
  const rows = await Promise.all(
    cases.map(async (c) => {
      const t0 = Date.now();
      const r = await critiquePlan({ provider: resolved.provider, brief: c.brief, summary: c.summary, label: `critic-eval:${c.id}` });
      usd += r.usage.usd;
      const missed = c.expect.mustFlag.filter((re) => !r.problems.some((p) => new RegExp(re, "i").test(p)));
      const noisy = c.expect.maxFindings != null && r.problems.length > c.expect.maxFindings;
      const dropped = r.raw.missing.filter((m) => m.severity !== "ok").length + r.raw.quantities.filter((q) => q.briefSays !== q.planHas).length - r.problems.length;
      return { c, r, ms: Date.now() - t0, missed, noisy, dropped };
    }),
  );
  for (const { c, r, ms, missed, noisy, dropped } of rows) {
    const verdict = missed.length ? `MISSED ${missed.join(", ")}` : noisy ? "NOISY" : "ok";
    console.log(`\n${c.id} — ${verdict} — ${r.problems.length} finding(s)${dropped ? `, ${dropped} unquoted dropped` : ""}, ${r.usage.inputTokens}/${r.usage.outputTokens} tok, $${r.usage.usd.toFixed(4)}, ${(ms / 1000).toFixed(1)}s`);
    for (const p of r.problems) console.log(`  - ${p}`);
  }
  console.log(`\ntotal $${usd.toFixed(4)}`);
}
