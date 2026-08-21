# evals

A prompt ladder scored on measured geometry, not on whether a cook finished.

```sh
cd apps/server
pnpm exec tsx src/eval.ts --self-test              # 12 scorer checks, 0 LLM calls
pnpm exec tsx src/eval.ts --dry-run               # what each case asserts, 0 LLM calls
pnpm exec tsx src/eval.ts --case single-plate --max-usd 0.50
pnpm exec tsx src/eval.ts --max-usd 2.00          # the whole ladder
```

`--max-usd` is required and is a hard stop. A ladder left running against a real
provider is the one way this harness costs more than it is worth.

## Why it is scored this way

The claim PatchCAD makes is that it measures geometry while everything else
generates and hopes. An audit found that true about the machinery and false
about the coverage: `projects/a-pen-cup-holder-with-hexagonal-msw95gq7` is a
finished four-node project, every node `ready`, and every port on it typed
`GROOVE` or `SLOT` when neither had a probe. A solid `Box(75, 75, 95)` passed.
Nothing verified the hexagonal cutouts the prompt asked for.

So the load-bearing assertion here is `noSkippedPorts`, and it defaults to on. A
port the kernel cannot probe reports `skipped` and passes, and a case that
tolerates one is measuring nothing.

`skipped` is only the visible half. A port declared and never probed is
absent from the list, and a part declaring no port has nothing to skip. Both
passed the first version of this scorer, so it certified the brick it exists to
catch. `noSkippedPorts` now also requires that every port a ready
node declares appears in its probe list. A ready node with declared ports must
have measurements at all, and those measurements must match the node's current
version. Bookkeeping still cannot reach a part that declares nothing, which is
what `volumeFraction` is for: a solid box fills 100% of its bounding box and the
real pen cup fills 8.8%.

## Score what is already on disk

```sh
pnpm exec tsx src/eval.ts --score-projects       # every project, 0 LLM calls
```

Asks one question of every `ready` node in `projects/`: does anything
measure the geometry it declares. It costs nothing and it is the sharpest tool
here. Every hole review found in this scorer was an **absence** instead of a
wrong value, and a self-test built from synthetic defects cannot model a graph
that carries nothing. One read of a real payload found what nineteen
fixtures could not.

Current answer: **6 of 10 projects on disk carry a ready node whose declared
geometry nothing measured.** Two unprobed port types are in live use, and the
plan had assumed neither existed: `LIP` (6 ports, two projects) and `SHAFT` (14
ports, both staff imports, the pegs whose sockets alone get measured).

It reports `nothing to judge` rather than `verified` for a graph that declares no
geometry, because three of the four projects that first came back clean were
web-code graphs with zero ports. A pass over a graph the scorer cannot judge is
the same defect one level up, so the verdict has to name which one it is.

## A case must be able to detect its own premise

The hardest part is not the assertions, it is whether any gate can see the thing
the prompt is about. A first attempt at the fourth case asked for bolt holes
clearing a boss on an adjoining leg. Nothing measures that: `_probe_boss`
tolerates one lost ring point by design, `_probe_hole` only looks at its own
pose, G4 ignores holes, and G5 never runs on a single part. A hole bored straight
through the boss wall passes every gate, so the case would have reported PASS on
a part violating its headline requirement.

That is the pen-cup brick one rung up, and worse, because a green result looks
like evidence. Before writing a case, name the gate that produces the failure.
If there isn't one, the case is measuring something else.

## Writing a case

Cases are JSON in `cases/`. They assert **structurally, never by node id**,
because ids come from the architect and change between runs. "Somewhere in this
graph there is one CLEARANCE_HOLE measuring 6mm" survives a rename that
`nodes["plate"].ports[0]` does not.

| Key | Checks |
|---|---|
| `nodes` | `{min, max}` node count. `max` catches over-decomposition, which is a real regression: `5mm-sphere-mswcd11k` answered a one-part prompt with 3 nodes and 14 calls. |
| `allReady` | every node reached `ready`. Default on. |
| `noSkippedPorts` | no port reports `skipped`. Default on. See above. |
| `ports[]` | `{type \| anyType, count \| minCount, tol}` plus one claim, matched against any node's probes. The claim is `diameter`, `width`, `pilot`, `through`, or the generic `measure: {field, value, tol}` naming the probe's own key. Use `measure` for anything else a probe emits: `probed_size` on a face, `measured_depth` on a hole or channel, `measured_length` on a shaft. |
| | A boss reports `measured_pilot` and never `measured_diameter`, so asserting `diameter` on one fails as "measured by nothing" — a defect in the case, not the part. Check what the probe emits before asserting on it. |
| `bboxSize` | `{value, tol, axes?}` against the largest node by volume. `axes` limits it when only some dimensions are pinned by the prompt. |
| `requireProbedPorts` | every port a ready node declares appears in its probe list, with measurements present and current. Default on. Separate from `noSkippedPorts` on purpose: one flag disabling both let a case drop this by turning off skipped-port reporting. |
| `volumeFraction` | `{max, min}` on measured volume over bounding-box volume, judged on the largest node. Separates a hollow or cut part from the solid block of the same size. Scale-free, but it reads an axis-aligned box, so a diagonal or organic part fills little of its box while being solid. |
| `volume` | `{max, min}` on absolute mm3 summed over the graph. Fails differently from the ratio, and covers the diagonal case the ratio cannot. A `Box(75,75,95)` is 534,375 mm3; the real pen cup measured 47,232. |
| `zeroLlmKinds` | these kinds must cost 0 model calls. Registry hardware that touches a model is a defect. |
| `assemblyProblems` | expected count from `solveScene`. |

## What it reports

Per case: pass/fail with every missed expectation named, node count, how many
were deterministic, first-try rate over the nodes that used a model, dead nodes,
calls, ports probed, ports skipped, dollars, and plan/cook wall clock.

Dollars include the architect's own call, which belongs to no node. Summing node
costs alone understates every case by the largest single output in the system.

Baseline to beat, from the audit: **6/11 first-try, 3 nodes needing 4+ rounds, 2
never converging.**

## Measured, 2026-08-21

All three cases pass. $0.70 for the ladder, four of four model nodes first-try,
zero dead, zero repair rounds.

| case | nodes | first-try | calls | cost | cook |
|---|---|---|---|---|---|
| single-plate | 1 | 1/1 | 4 | $0.198 | 26.4s |
| two-plate-bolted | 4 (2 registry) | 2/2 | 4 | $0.304 | 3.7s |
| pen-cup-hexagonal | 1 | 1/1 | 2 | $0.194 | 88.1s |

Each of those numbers is a second or third attempt, and the ladder earned its
cost in what the first attempts found rather than in the green line:

- **single-plate**, twice, $0.82. The architect declared a `BORE` and a
  `FLAT_FACE` at the same origin, which no geometry satisfies. Run one spent 5
  calls and died `error_contract`, correctly attributed. Run two spent 4 and
  "succeeded" by bridging the bore with a 0.35mm web, reporting a hole that does
  not pass through. `cadFaceHoleConflictLint` came out of that.
- **two-plate-bolted**, twice, $1.03 then a failed plan. A clearance hole coaxial
  with a mating face on the FAR side (the same defect one face over), and two
  edges naming ports that registry hardware did not declare. Fixing the second
  produced a lint that deadlocked against `cad-fastener-justified`, so for one
  commit no plan containing a fastener existed at all.
- **pen-cup-hexagonal**, twice, $0.19 wasted. The architect's reply failed to
  parse and the error carried nothing but a position, which is why the adapter
  now reports length, stop reason and a window.

The pen-cup case is the one that prompted this whole plan. `msw95gq7` shipped four
nodes green with two ports verified by nothing and a solid box would have passed.
It now cooks one node, one port probed, 38,820 mm³ in a 534,375 mm³ box, a
fraction of 0.073, with real hexagonal prisms subtracted around the
circumference.

What `volumeFraction` still cannot do: it proves material was **removed**, not
what was removed. This passed because the model built real hexagons, not
because the assertion can tell a hexagon from a bucket.

Results land in `results/` as timestamped JSON, which is gitignored: they are
run artifacts, not fixtures.

## Why cases do not live in `examples/`

`apps/server/src/main.ts:910` scans `examples/` for the project picker, so
anything there is offered to users as a project to open. That is why
`fixtures/shop` moved out. `evals/` is not scanned.

The runner itself lives at `apps/server/src/eval.ts` rather than here, because it
needs the engine, the CAD backend and `resolveProvider`, and `apps/server`
already has all three plus a tsconfig. It follows `cad-acceptance.ts` and
`verify-smoke.ts`, which are dev scripts in the same place.
