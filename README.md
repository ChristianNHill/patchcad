# patchcad

> **⚠️ In development — very early version.** This is a working slice of a much
> larger vision. Expect rough edges, missing features, breaking changes without
> notice, and fast-moving internals. See [Status & limitations](#status--limitations)
> before trying it.

![the patchcad studio: a prompt-planned fan bracket as a node graph with live params, assembled in the viewport](docs/studio.png)

*"A bracket that mounts a 60mm cooling fan to 2020 extrusion" — the architect
planned seven nodes with pinned contracts (three printed parts, four registry
fasteners), every part generated and gate-verified, and the sliders are live:
thread and length re-derive from the parts they fasten, with zero LLM calls.*

Prompt-to-app on a TouchDesigner-style node canvas. Type a goal → an architect
model plans a **graph of nodes with pinned interface contracts** → parallel
generators write each node's code hermetically (they see neighbors'
*contracts*, never their code) → the assembled app runs in a live preview.
Break out any node and reprompt it individually; contract changes mark
downstream nodes dirty for re-cook.

## Status & limitations

Actively in development; nothing here is stable. Current known limits:

- **Planning is slow and silent** — the architect call takes ~1–2 minutes with
  no progress feedback yet. It has not hung; give it the time.
- **Bring your own models.** Generation quality depends on hosted frontier
  models (Anthropic or OpenRouter key). Local models via Ollama work for the
  plumbing, but small local models cannot reliably write valid build123d —
  every failure is caught, attributed, and surfaced, not fixed for free.
- **CAD planning only in the studio.** The web-app backend exists and runs
  existing projects, but the product focus is printed parts.
- **No export yet.** STEP/3MF/STL export, assembly clash checks (G5), and
  screws seating into their holes are on the roadmap, not in the build.
- **Smart segmentation is import-only.** Splitting a model into naturally
  separating, peg-jointed pieces works for imported meshes; generated parts
  can't split yet.
- **Printability is advisory.** The DfAM score (min-wall + overhang) flags
  risk; it never blocks a cook.
- **Local, single-user tool.** The server binds localhost with no auth. The
  undo stack lives in memory and clears on server restart.
- **Setup has two runtimes.** Node (pnpm) for the studio/server, Python via
  `uv` for the geometry kernel. Tested on macOS only.

## Run it

```sh
pnpm install
pnpm dev          # server on :4100, studio on :5173, preview on :5174
open http://localhost:5173
```

Switch projects from the welcome screen or the header's project button
(`examples/pomodoro` is a graph planned + cooked entirely by a local Ollama
model). Approving a plan creates a fresh project under `projects/<goal-slug>/`
and switches to it — the loaded project is never overwritten.

The studio opens on a single question — describe the part you want, or bring
an STL/STEP/3MF you already have. Either creates a project under
`projects/<slug>/`. Open `examples/shop` from the welcome screen for a
hand-built 6-node web patch: drag the param sliders on nodes — **T0 edits
never touch an LLM** (postMessage straight into the preview). Edit
`examples/shop/nodes/<id>/v0.code.tsx` on disk and watch that one module
hot-swap.

## Enable planning + generation

Give the server a model provider (checked in this order):

```sh
export ANTHROPIC_API_KEY=sk-ant-...          # simplest
```

or `~/.patchcad/config.json`:

```jsonc
{ "claude":     { "apiKey": "sk-ant-..." } }                                  // native
{ "openrouter": { "apiKey": "sk-or-..." } }                                   // any vendor via one key
{ "local":      { "baseUrl": "http://localhost:11434/v1", "model": "qwen3-coder" } }  // Ollama, free/offline
```

Then type a goal in the studio's prompt bar. Planning targets **cad**
(build123d parts, three.js viewport; requires the kernel:
`cd packages/backend-cad/kernel && uv sync && uv run patchcad-kernel`) — the
web-code backend still runs existing app projects. Review the proposed patch
(nodes, contracts, params) → **approve & cook**. Every node generates in
parallel; statuses stream onto the canvas. Select a node and use the
reprompt box — requests route by tier:

- **T2** (fits the pinned contract): only that node re-cooks; neighbors are
  untouchable by construction. Cosmetic asks route here instantly, no
  classifier call.
- **T3** (needs an interface change, e.g. "expose an onReset export in your
  contract"): the architect renegotiates that node's contract and you get an
  approval card — the rationale, what changed, and how many nodes the change
  re-cooks. Nothing applies until you accept.

The header's project button lists every project under `examples/` and
`projects/` and switches between them live. While a T3 proposal is pending,
the canvas shows its blast radius — the target and every node the change
would re-cook get a dashed amber tint.

Every user edit (params, contracts, reprompts, accepts, reverts) is a
checkpoint: **⌘Z** (or the header's undo button) rolls the whole graph back
one step, hot-swapping the restored modules into the preview.

Model routing (defaults): architect → `claude-opus-5`, generators →
`claude-sonnet-5`, classifier → `claude-haiku-4-5`.

**Mix providers per role** with a `routing` map — the recommended hybrid is a
hosted architect with free local generators:

```jsonc
{
  "routing": { "architect": "claude", "generator": "local" },
  "claude":  { "apiKey": "sk-ant-..." },
  "local":   { "baseUrl": "http://localhost:11434/v1", "model": "qwen3-coder" }
}
```

**Node library.** Every successfully cooked, unspecialized node is captured to
`~/.patchcad/library/` keyed by its contract hash. When a plan lands on an
identical contract — any project, any time — the node is reused with zero
generator calls (the cached code is still verified). Seed it from an existing
project with `pnpm --filter @patchcad/server exec tsx src/seed-library.ts <dir>`.

**Costs stay visible**: a Σ-token/dollar chip in the header, per-node token
chips on the canvas, and a call/token breakdown in the inspector.

## Layout

```
packages/shared            types + zod schemas + hashing (the persisted graph format)
packages/engine            domain-agnostic core: graph store, contract diffing,
                           port-granular dirty propagation, architect pass, cook scheduler,
                           DomainBackend + LlmProvider interfaces
packages/backend-code      web-app backend: prompts, esbuild execute, contract verify,
                           workspace assembler, Vite preview adapter (HMR = hot-swap)
packages/backend-cad       CAD backend: ports-in-SE(3) + envelope contract schema,
                           KernelClient, and kernel/ — the Python geometry service
                           (uv + FastAPI + build123d; isolated warm workers, G0–G2
                           gates, GLB out; see kernel/README.md)
packages/llm-claude        Anthropic adapter (structured outputs + client-side validation)
packages/llm-openai-compat OpenRouter / Ollama / LM Studio adapter
packages/preview-runtime   in-iframe runtime: live params, per-node error boundaries
apps/server                Fastify: project persistence, plan/cook/reprompt API, WS events
apps/studio                React Flow canvas, inspector, plan approval, live preview pane
examples/shop              hand-written 6-node sample project
```

## Project file format

```
<project>/patchcad.json               graph minus code bodies (git-friendly)
<project>/nodes/<id>/v<N>.code.tsx    one file per node version
<project>/.preview/                   regenerable Vite workspace (gitignored)
```

Full design doc: `~/.claude/plans/happy-beaming-tulip.md` (architecture,
tier routing T0–T3, CAD track, milestones).
