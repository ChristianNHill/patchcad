/** Eval harness: a prompt ladder scored on measured geometry, not on whether a
 *  cook finished.
 *
 *    pnpm exec tsx src/eval.ts --dry-run           # validate cases, zero LLM calls
 *    pnpm exec tsx src/eval.ts --case single-plate --max-usd 0.50
 *    pnpm exec tsx src/eval.ts --max-usd 2.00      # the whole ladder
 *
 *  Cases live in evals/cases/*.json. They assert STRUCTURALLY, never by node id,
 *  because ids come from the architect and change between runs: "somewhere in
 *  this graph there is one CLEARANCE_HOLE measuring 6mm" survives a rename that
 *  `nodes["plate"].ports[0]` does not.
 *
 *  The assertion that matters most is noSkippedPorts. A port type the kernel
 *  cannot probe reports `skipped` and passes, which is how a solid box shipped
 *  as a pen cup holder with hexagonal cutouts. A case that tolerates a skipped
 *  port is measuring nothing, so this defaults to on.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cookNodes, EventBus, GraphStore, planGraph } from "@patchcad/engine";
import { CadBackend } from "@patchcad/backend-cad";
import { GraphDoc } from "@patchcad/shared";
import { resolveProvider } from "./providers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const casesDir = path.join(repoRoot, "evals", "cases");
const resultsDir = path.join(repoRoot, "evals", "results");

type PortExpect = {
  type: string;
  count?: number;
  minCount?: number;
  diameter?: number;
  width?: number;
  tol?: number;
};
type CaseExpect = {
  nodes?: { min?: number; max?: number };
  allReady?: boolean;
  noSkippedPorts?: boolean;
  ports?: PortExpect[];
  bboxSize?: { value: number[]; tol: number; axes?: number[] };
  /** measured volume / bbox volume. The only thing that distinguishes a hollow
   *  or cut part from the solid block of the same size, and a contract declaring
   *  no ports gives the port checks nothing to bite on. */
  volumeFraction?: { max?: number; min?: number };
  zeroLlmKinds?: string[];
  assemblyProblems?: number;
};
type EvalCase = { id: string; prompt: string; why?: string; expect: CaseExpect };

type Probe = Record<string, unknown> & { key?: string; type?: string; skipped?: string };
type Measured = {
  bbox?: { size?: number[] };
  ports?: Probe[];
  volume_mm3?: number;
};

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** A failed expectation, phrased so the line alone says what went wrong. */
type Miss = string;

function checkPorts(probes: Probe[], want: PortExpect): Miss[] {
  const misses: Miss[] = [];
  const of = probes.filter((p) => p.type === want.type);
  if (want.count != null && of.length !== want.count)
    misses.push(`expected ${want.count} ${want.type} port(s), graph has ${of.length}`);
  if (want.minCount != null && of.length < want.minCount)
    misses.push(`expected at least ${want.minCount} ${want.type} port(s), graph has ${of.length}`);
  for (const [key, want_v] of [["measured_diameter", want.diameter], ["measured_width", want.width]] as const) {
    if (want_v == null) continue;
    const tol = want.tol ?? 0.2;
    // ANY port of this type may satisfy it: the architect picks which node
    // carries which hole, and the case must not care.
    const got = of.map((p) => p[key]).filter((v): v is number => typeof v === "number");
    if (!got.length) misses.push(`no ${want.type} reported ${key} (measured by nothing)`);
    else if (!got.some((v) => Math.abs(v - want_v) <= tol))
      misses.push(`no ${want.type} ${key} within ${tol} of ${want_v}; measured ${got.map((v) => v.toFixed(2)).join(", ")}`);
  }
  return misses;
}

function score(c: EvalCase, store: GraphStore, problems: unknown[]): { misses: Miss[]; probes: Probe[] } {
  const nodes = Object.values(store.doc.nodes);
  const misses: Miss[] = [];
  const e = c.expect;

  if (e.nodes?.min != null && nodes.length < e.nodes.min)
    misses.push(`${nodes.length} nodes, expected at least ${e.nodes.min}`);
  if (e.nodes?.max != null && nodes.length > e.nodes.max)
    misses.push(`${nodes.length} nodes, expected at most ${e.nodes.max} (over-decomposed)`);

  if (e.allReady !== false) {
    const notReady = nodes.filter((n) => n.status !== "ready");
    if (notReady.length)
      misses.push(`not ready: ${notReady.map((n) => `${n.id}=${n.status}`).join(", ")}`);
  }

  const probes: Probe[] = [];
  for (const n of nodes) {
    const data = (n.measurements?.data ?? null) as Measured | null;
    for (const p of data?.ports ?? []) probes.push({ ...p, node: n.id } as Probe);
  }

  if (e.noSkippedPorts !== false) {
    const skipped = probes.filter((p) => p.skipped);
    if (skipped.length)
      misses.push(
        `${skipped.length} port(s) verified by NOTHING: ` +
          skipped.map((p) => `${p["node"]}.${p.key}(${p.type}): ${p.skipped}`).join("; "),
      );

    // A SKIPPED PORT IS ONLY THE VISIBLE HALF. `skipped` fires on a port that
    // reached the probe list and reported that no probe exists. A port declared
    // and never probed at all is simply absent, and a part that declares no
    // port has nothing to skip: both passed. That is how the pen-cup brick
    // scored green here, in the case written to catch it, which is the harness
    // reproducing the defect it exists to prevent. Verified means the contract
    // and the probes agree, so that is what this checks.
    for (const n of nodes) {
      // Only a READY node claims to be verified. A planned or dirty node has no
      // measurements by definition, and failing it here would report the queue
      // as a defect.
      if (n.status !== "ready") continue;
      const declared = ((n.contract.payload as { ports?: { name?: string; type?: string }[] } | null)?.ports) ?? [];
      const data = (n.measurements?.data ?? null) as Measured | null;
      const probed = new Set((data?.ports ?? []).map((p) => p.key));
      for (const d of declared)
        if (!probed.has(d.name)) misses.push(`${n.id}.${d.name}(${d.type}) declared but never probed`);
      // `ready` does not imply measurements exist. Three of the four ready
      // nodes in the pen-cup project have measurements: null, so four declared
      // ports were invisible and the catch survived on one node's two.
      if (declared.length && !n.measurements)
        misses.push(`${n.id} is ready with no measurements at all, so its ${declared.length} port(s) are unverified`);
      if (n.measurements && n.measurements.version !== n.version)
        misses.push(`${n.id} scored on v${n.measurements.version} measurements at v${n.version} (stale)`);
    }
  }

  for (const want of e.ports ?? []) misses.push(...checkPorts(probes, want));

  if (e.bboxSize) {
    // Largest node by volume stands in for "the part" on a single-part case;
    // on a multi-part case a size claim is about the assembly, not one piece,
    // so it is only checked when the case is single-node.
    const biggest = nodes
      .map((n) => (n.measurements?.data ?? null) as Measured | null)
      .filter((d): d is Measured => !!d?.bbox?.size)
      .sort((a, b) => (b.volume_mm3 ?? 0) - (a.volume_mm3 ?? 0))[0];
    const size = biggest?.bbox?.size;
    if (!size) misses.push("no bbox measured, so the size claim is unchecked");
    else {
      const axes = e.bboxSize.axes ?? e.bboxSize.value.map((_, i) => i);
      for (const i of axes) {
        const got = size[i] ?? NaN;
        const want_v = e.bboxSize.value[i]!;
        if (!(Math.abs(got - want_v) <= e.bboxSize.tol))
          misses.push(`bbox axis ${i} measured ${got.toFixed(1)}, expected ${want_v} +/- ${e.bboxSize.tol}`);
      }
    }
  }

  if (e.volumeFraction) {
    // A SOLID BOX PASSES EVERY BOOKKEEPING CHECK. Declared-vs-probed catches a
    // port nothing measured, but a part that declares no port at all has
    // nothing to compare, and that is the shape the pen-cup brick actually had.
    // Removed material is measurable, so a prompt asking for cutouts asserts it.
    const all = nodes
      .map((n) => (n.measurements?.data ?? null) as Measured | null)
      .filter((d): d is Measured => typeof d?.volume_mm3 === "number" && !!d.bbox?.size);
    if (!all.length) misses.push("no volume measured, so the material claim is unchecked");
    for (const d of all) {
      const size = d.bbox!.size!;
      const box = size.reduce((a, b) => a * b, 1);
      const frac = box > 0 ? d.volume_mm3! / box : 1;
      if (e.volumeFraction.max != null && frac > e.volumeFraction.max)
        misses.push(`solid: fills ${(frac * 100).toFixed(0)}% of its bounding box, expected at most ${(e.volumeFraction.max * 100).toFixed(0)}% (nothing was cut out)`);
      if (e.volumeFraction.min != null && frac < e.volumeFraction.min)
        misses.push(`too thin: fills only ${(frac * 100).toFixed(0)}% of its bounding box, expected at least ${(e.volumeFraction.min * 100).toFixed(0)}%`);
    }
  }

  for (const kind of e.zeroLlmKinds ?? []) {
    const paid = nodes.filter((n) => n.kind === kind && n.cost.calls > 0);
    if (paid.length)
      misses.push(`${kind} nodes called the model: ${paid.map((n) => `${n.id}(${n.cost.calls})`).join(", ")}`);
  }

  if (e.assemblyProblems != null && problems.length !== e.assemblyProblems)
    misses.push(`${problems.length} assembly problem(s), expected ${e.assemblyProblems}: ${JSON.stringify(problems).slice(0, 200)}`);

  return { misses, probes };
}

/** Feed the scorer synthetic graphs and assert every check fires.
 *
 *  This exists because a harness whose assertions never fire is worse than no
 *  harness: it reports PASS over unverified geometry, which is the exact defect
 *  the ladder is built to catch. Zero LLM calls, so it runs on every change.
 */
function selfTest(): void {
  const mk = (nodes: Record<string, unknown>) =>
    new GraphStore(
      GraphDoc.parse({
        schemaVersion: 1, id: "t", backend: "cad",
        brief: { goal: "t", constraints: [], clarifications: [] },
        nodes, edges: [],
        assembly: { entryNodeId: Object.keys(nodes)[0] ?? "" },
        layout: {}, rev: 0,
      }),
      new EventBus(),
      async () => {},
    );

  const node = (id: string, over: Record<string, unknown> = {}, data?: unknown) => ({
    id, title: id, spec: "", kind: "part", status: "ready", version: 1,
    thread: [], history: [], cost: { calls: 1, inputTokens: 1, outputTokens: 1, usd: 0.01 },
    contract: { name: id, summary: "", params: [], provides: [], requires: [], payload: {} },
    measurements: data === undefined ? null : { version: 1, paramsHash: "h", data },
    ...over,
  });

  let failures = 0;
  const expect = (name: string, misses: Miss[], want: "fire" | "quiet", needle?: string) => {
    const fired = misses.length > 0;
    const ok = want === "fire" ? fired && (!needle || misses.some((m) => m.includes(needle))) : !fired;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` -> ${JSON.stringify(misses)}`}`);
    if (!ok) failures++;
  };

  const goodPlate = {
    volume_mm3: 17859, bbox: { size: [60, 60, 5] },
    ports: [{ key: "h", type: "CLEARANCE_HOLE", measured_diameter: 6.01, through: true }],
  };
  const casePlate: EvalCase = {
    id: "t", prompt: "p",
    expect: {
      nodes: { min: 1, max: 1 }, allReady: true, noSkippedPorts: true,
      ports: [{ type: "CLEARANCE_HOLE", count: 1, diameter: 6.0, tol: 0.3 }],
      bboxSize: { value: [60, 60, 5], tol: 1.0 },
    },
  };

  console.log("the scorer must stay quiet on a graph that genuinely passes");
  expect("good plate", score(casePlate, mk({ p: node("p", {}, goodPlate) }), []).misses, "quiet");

  console.log("and must fire on each defect, one at a time");
  // THE BRICK: a port type the kernel cannot probe reports skipped and passes.
  expect("a skipped port is not verification",
    score(casePlate, mk({ p: node("p", {}, {
      ...goodPlate, ports: [{ key: "g", type: "GROOVE", skipped: "no probe for this type yet" },
                            { key: "h", type: "CLEARANCE_HOLE", measured_diameter: 6.0 }] }) }), []).misses,
    "fire", "verified by NOTHING");
  expect("wrong hole diameter",
    score(casePlate, mk({ p: node("p", {}, {
      ...goodPlate, ports: [{ key: "h", type: "CLEARANCE_HOLE", measured_diameter: 12.0 }] }) }), []).misses,
    "fire", "within 0.3 of 6");
  expect("hole measured by nothing",
    score(casePlate, mk({ p: node("p", {}, {
      ...goodPlate, ports: [{ key: "h", type: "CLEARANCE_HOLE" }] }) }), []).misses,
    "fire", "measured by nothing");
  expect("missing hole entirely",
    score(casePlate, mk({ p: node("p", {}, { ...goodPlate, ports: [] }) }), []).misses,
    "fire", "expected 1 CLEARANCE_HOLE");
  expect("wrong size",
    score(casePlate, mk({ p: node("p", {}, { ...goodPlate, bbox: { size: [95, 95, 5] } }) }), []).misses,
    "fire", "bbox axis 0");
  expect("no measurements at all",
    score(casePlate, mk({ p: node("p") }), []).misses, "fire", "no bbox measured");
  expect("over-decomposed",
    score(casePlate, mk({ p: node("p", {}, goodPlate), q: node("q", {}, goodPlate) }), []).misses,
    "fire", "over-decomposed");
  expect("a node that never converged",
    score(casePlate, mk({ p: node("p", { status: "error_code" }, goodPlate) }), []).misses,
    "fire", "not ready");

  // ABSENCE-SHAPED DEFECTS, which the synthetic fixtures above were blind to.
  // Every hole review found in this scorer was an absence rather than a wrong
  // value, and a self-test built from graphs that carry a defect cannot model a
  // graph that carries nothing.
  const withPorts = (over: Record<string, unknown>, data?: unknown) =>
    node("p", {
      contract: { name: "p", summary: "", params: [], provides: [], requires: [],
                  payload: { ports: [{ name: "g", type: "GROOVE" }] } },
      ...over,
    }, data);

  console.log("and on a defect that is an absence rather than a wrong value");
  const bare: EvalCase = { id: "t", prompt: "p", expect: { nodes: { min: 1, max: 1 }, noSkippedPorts: true } };
  // THE BRICK, and the shape that passed before review: a solid box declaring
  // no port at all. Nothing to skip, so nothing fired.
  expect("a part declaring no ports passes the bookkeeping checks",
    score(bare, mk({ p: node("p", {}, { volume_mm3: 1, bbox: { size: [75, 75, 95] }, ports: [] }) }), []).misses,
    "quiet");
  // THE ACTUAL BRICK, and the reason volumeFraction exists: the shape review
  // found passing was a solid box declaring no ports, which no port check can
  // reach. Removed material is the only measurable difference.
  const cut: EvalCase = { id: "t", prompt: "p", expect: { volumeFraction: { max: 0.45 } } };
  expect("a SOLID BOX sold as a part with cutouts",
    score(cut, mk({ p: node("p", {}, { volume_mm3: 75 * 75 * 95, bbox: { size: [75, 75, 95] }, ports: [] }) }), []).misses,
    "fire", "nothing was cut out");
  expect("the real pen cup's measured geometry",
    score(cut, mk({ p: node("p", {}, { volume_mm3: 47231.67, bbox: { size: [75, 75, 95] }, ports: [] }) }), []).misses,
    "quiet");
  expect("a port declared and never probed",
    score(bare, mk({ p: withPorts({}, { volume_mm3: 1, bbox: { size: [1, 1, 1] }, ports: [] }) }), []).misses,
    "fire", "declared but never probed");
  expect("ready with no measurements at all",
    score(bare, mk({ p: withPorts({}) }), []).misses,
    "fire", "ready with no measurements");
  expect("measurements from an older version",
    score(bare, mk({ p: withPorts({ version: 3 }, { volume_mm3: 1, bbox: { size: [1, 1, 1] },
                                                    ports: [{ key: "g", type: "GROOVE", measured_width: 3 }] }) }), []).misses,
    "fire", "stale");
  expect("a planned node is not a defect",
    score({ id: "t", prompt: "p", expect: { allReady: false, noSkippedPorts: true } },
      mk({ p: withPorts({ status: "planned" }) }), []).misses,
    "quiet");

  const caseBolt: EvalCase = {
    id: "b", prompt: "p",
    expect: { nodes: { min: 1 }, allReady: true, zeroLlmKinds: ["fastener"], assemblyProblems: 0 },
  };
  expect("a fastener that called the model",
    score(caseBolt, mk({ s: node("s", { kind: "fastener" }, goodPlate) }), []).misses,
    "fire", "called the model");
  expect("a registry fastener is free",
    score(caseBolt, mk({ s: node("s", { kind: "fastener", cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 } }, goodPlate) }), []).misses,
    "quiet");
  expect("an unsolved assembly",
    score(caseBolt, mk({ s: node("s", { kind: "part" }, goodPlate) }), ["bracket has no mate"]).misses,
    "fire", "assembly problem");

  console.log(failures ? `\n${failures} SCORER FAILURE(S)` : "\nscorer self-test passed");
  if (failures) process.exit(1);
}

/** Score every project already on disk, with zero model calls.
 *
 *  The scorer self-test is built from synthetic graphs, so it can only catch
 *  defects it models, and all of this harness's holes were ABSENCES rather than
 *  wrong values: a port declared and never probed, a ready node with no
 *  measurements, a stale version. A real payload found in one read what twelve
 *  synthetic fixtures could not. These cost nothing, so they run as fixtures.
 */
function scoreProjects(): void {
  const root = path.join(repoRoot, "projects");
  if (!fs.existsSync(root)) {
    console.log("no projects/ on disk, nothing to score");
    return;
  }
  const dirs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "patchcad.json")));
  // Asks only "is every ready node's declared geometry actually measured", which
  // is the claim the whole project rests on. No prompt-specific expectations.
  const generic: EvalCase = { id: "verified", prompt: "", expect: { allReady: false, noSkippedPorts: true } };
  let unverified = 0;
  for (const d of dirs) {
    const doc = JSON.parse(fs.readFileSync(path.join(root, d, "patchcad.json"), "utf8"));
    let store: GraphStore;
    try {
      store = new GraphStore(GraphDoc.parse(doc), new EventBus(), async () => {});
    } catch (err) {
      console.log(`  SKIP  ${d} (will not parse: ${String(err).slice(0, 80)})`);
      continue;
    }
    const nodes = Object.values(store.doc.nodes);
    const ready = nodes.filter((n) => n.status === "ready").length;
    const { misses } = score(generic, store, []);
    console.log(`  ${misses.length ? "UNVERIFIED" : "clean      "}  ${d}  (${ready}/${nodes.length} ready)`);
    for (const m of misses.slice(0, 6)) console.log(`      ${m}`);
    if (misses.length > 6) console.log(`      ...and ${misses.length - 6} more`);
    if (misses.length) unverified++;
  }
  console.log(`\n${unverified}/${dirs.length} project(s) carry a ready node whose declared geometry nothing measured.`);
}

async function runCase(c: EvalCase) {
  const backend = new CadBackend();
  const bus = new EventBus();
  const provider = (await resolveProvider())?.provider;
  if (!provider) throw new Error("no LLM provider configured");

  const t0 = Date.now();
  const plan = await planGraph({
    provider, backend, projectId: `eval-${c.id}`, goal: c.prompt,
  });
  const planMs = Date.now() - t0;

  const store = new GraphStore(plan.graph, bus, async () => {});
  const workspace = { root: path.join(repoRoot, "evals", "results", ".work", c.id) };
  fs.mkdirSync(workspace.root, { recursive: true });

  const t1 = Date.now();
  await cookNodes({ store, backend, provider, workspace }, Object.keys(store.doc.nodes));
  const cookMs = Date.now() - t1;

  let problems: unknown[] = [];
  try {
    problems = backend.solveScene(store.doc).problems as unknown[];
  } catch (err) {
    problems = [`solveScene threw: ${String(err)}`];
  }

  const nodes = Object.values(store.doc.nodes);
  // THE ARCHITECT'S CALL BELONGS TO NO NODE. Summing node costs alone
  // understates every case by the largest single output in the system, which is
  // the plan itself, and this harness exists to report real dollars.
  const arch = plan.usage;
  const usd = nodes.reduce((s, n) => s + n.cost.usd, arch.usd);
  // Not a hardcoded 1: a repaired plan is two or more, and a harness whose
  // point is real numbers must not round its own headline down.
  const calls = nodes.reduce((s, n) => s + n.cost.calls, plan.repaired ? 2 : 1);
  const outTok = nodes.reduce((s, n) => s + n.cost.outputTokens, arch.outputTokens);
  const inTok = nodes.reduce((s, n) => s + n.cost.inputTokens, arch.inputTokens);
  // A node that passed on its first generation. Deterministic nodes cost 0
  // calls and are not "first try" in the interesting sense, so they are counted
  // separately rather than inflating the rate.
  const modelNodes = nodes.filter((n) => n.cost.calls > 0);
  const firstTry = modelNodes.filter((n) => n.status === "ready" && n.cost.calls === 1);
  const dead = nodes.filter((n) => n.status.startsWith("error"));

  const { misses, probes } = score(c, store, problems);

  return {
    id: c.id, pass: misses.length === 0, misses,
    nodes: nodes.length, modelNodes: modelNodes.length,
    deterministic: nodes.length - modelNodes.length,
    firstTry: firstTry.length, dead: dead.length,
    calls, inTok, outTok, usd,
    architect: { usd: arch.usd, inTok: arch.inputTokens, outTok: arch.outputTokens, repaired: plan.repaired },
    planMs, cookMs, probes: probes.length,
    skipped: probes.filter((p) => p.skipped).length,
    perNode: nodes.map((n) => ({
      id: n.id, kind: n.kind, status: n.status, calls: n.cost.calls, usd: n.cost.usd,
    })),
  };
}

async function main() {
  if (flag("self-test")) return selfTest();
  if (flag("score-projects")) return scoreProjects();

  const files = fs.readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
  const only = opt("case");
  const cases: EvalCase[] = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(casesDir, f), "utf8")) as EvalCase)
    .filter((c) => !only || c.id === only);

  if (!cases.length) throw new Error(`no cases matched${only ? ` --case ${only}` : ""}`);

  // The cap is a HARD stop, not advice. A ladder left running against a real
  // provider is the one way this harness can cost more than it is worth.
  const maxUsd = Number(opt("max-usd") ?? "0");

  // An expectation that asserts nothing is worse than a missing one: it reads
  // like a check. A port expectation with neither diameter nor width only counts
  // probes, and an empty ports array runs a zero-iteration loop.
  const vacuous: string[] = [];
  for (const c of cases) {
    if (c.expect.ports && c.expect.ports.length === 0)
      vacuous.push(`${c.id}: "ports": [] asserts nothing, remove the key or fill it`);
    for (const pe of c.expect.ports ?? [])
      if (pe.diameter == null && pe.width == null)
        vacuous.push(`${c.id}: ${pe.type} expectation has no diameter or width, so it only counts probes`);
  }
  if (vacuous.length) {
    for (const v of vacuous) console.error(`INVALID CASE: ${v}`);
    process.exit(2);
  }

  if (flag("dry-run")) {
    console.log(`${cases.length} case(s), validated without calling a model:\n`);
    for (const c of cases) {
      const e = c.expect;
      const checks = [
        e.nodes && `nodes ${e.nodes.min ?? 0}..${e.nodes.max ?? "inf"}`,
        e.allReady !== false && "all nodes ready",
        e.noSkippedPorts !== false && "NO port verified by nothing",
        ...(e.ports ?? []).map((p) => `${p.type} ${p.diameter ?? p.width ?? ""}`.trim()),
        e.bboxSize && `bbox ${e.bboxSize.value.join("x")} +/-${e.bboxSize.tol}`,
        e.volumeFraction && `fills ${e.volumeFraction.min != null ? `>=${e.volumeFraction.min * 100}%` : ""}${e.volumeFraction.max != null ? `<=${e.volumeFraction.max * 100}%` : ""} of its bbox`,
        e.zeroLlmKinds && `zero LLM: ${e.zeroLlmKinds.join(",")}`,
        e.assemblyProblems != null && `assembly problems == ${e.assemblyProblems}`,
      ].filter(Boolean);
      console.log(`  ${c.id}`);
      console.log(`    prompt: ${c.prompt}`);
      for (const ch of checks) console.log(`      - ${ch}`);
    }
    console.log("\ndry run: no provider resolved, no tokens spent.");
    return;
  }

  if (!maxUsd) {
    console.error("refusing to run without --max-usd N (a ladder against a real provider spends money)");
    process.exit(2);
  }

  const results: unknown[] = [];
  let spent = 0;
  for (const c of cases) {
    if (spent >= maxUsd) {
      console.log(`\nSTOPPING: spent $${spent.toFixed(3)} of $${maxUsd.toFixed(2)}. Remaining cases not run: ${cases.slice(cases.indexOf(c)).map((x) => x.id).join(", ")}`);
      break;
    }
    console.log(`\n=== ${c.id} ===\n  ${c.prompt}`);
    const r = await runCase(c);
    spent += r.usd;
    results.push(r);
    console.log(
      `  ${r.pass ? "PASS" : "FAIL"}  ${r.nodes} nodes (${r.deterministic} deterministic), ` +
        `${r.firstTry}/${r.modelNodes} first-try, ${r.dead} dead, ${r.calls} calls, ` +
        `${r.probes} ports (${r.skipped} skipped), $${r.usd.toFixed(3)}, ` +
        `plan ${(r.planMs / 1000).toFixed(1)}s cook ${(r.cookMs / 1000).toFixed(1)}s`,
    );
    for (const m of r.misses) console.log(`    MISS: ${m}`);
  }

  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(resultsDir, `${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify({ spent, maxUsd, results }, null, 2));

  const passed = results.filter((r) => (r as { pass: boolean }).pass).length;
  console.log(`\n${passed}/${results.length} cases pass. $${spent.toFixed(3)} spent. ${out}`);
  if (passed !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
