import { z } from "zod";
import type { GenerateCtx, PromptSpec, RepairCtx } from "@patchcad/engine";
import type { CadContractPayload } from "./index.js";
import type { GraphDoc, NodeRecord, ParamValue } from "@patchcad/shared";
import { importedPartExpr } from "./segment-joints.js";
import { resolveDim, resolvePose, type Dim } from "./bindings.js";
import { matchPitfalls } from "./pitfalls.js";
import { fitCut } from "./grounding.js";
import { sourcingOf } from "./sourcing.js";
import { processLines } from "./dfm.js";

/**
 * Generator prompts for CAD nodes. The pinned build123d cheat sheet is the
 * main hallucination defense (risk #1 in the design doc): models restate
 * these exact call shapes instead of inventing CadQuery-isms. Contracts are
 * ground truth — code never restates port poses; it must PRODUCE geometry
 * that satisfies them, and the kernel probes verify that externally.
 */

const CHEAT_SHEET = `build123d ALGEBRA MODE — the only API you may use (plus \`math\`):
  from build123d import *
  Box(length, width, height)                # centered at origin
  Cylinder(radius, height)                  # centered, axis +Z
  Cone(bottom_radius, top_radius, height)
  Sphere(radius)
  Pos(x, y, z) * shape                      # translate
  Rot(x_deg, y_deg, z_deg) * shape          # rotate about origin
  shape + other                             # union
  shape - other                             # cut
  shape & other                             # intersect
  fillet(shape.edges().filter_by(Axis.Z), radius)
  chamfer(shape.edges().group_by(Axis.Z)[-1], length)
  shape.edges() / .faces() / .solids()      # selectors
  .filter_by(Axis.Z) / .group_by(Axis.Z)[-1] / .sort_by(Axis.Z)[-1]
CURVED AND SWEPT SOLIDS — reach for these when the part is organic (a fuselage,
a fairing, a grip, a blade). Primitives plus fillet only ever make a boxy part:
  Plane.XY / Plane.XZ / Plane.YZ            # sketch planes
  Plane.XY.offset(z)                        # a parallel plane z above
  Circle(r) / Ellipse(x_r, y_r) / Rectangle(w, h) / RegularPolygon(r, n)
  loft([sec_a, sec_b, sec_c])               # blend sketches into a smooth body
  sweep(section, path)                      # drag a section along a wire
  revolve(profile, Axis.Z, angle)           # turn a profile about an axis
  extrude(section, amount, taper=deg)
  Spline([(x, y), ...]) / Polyline(...) / Line(p1, p2) / RadiusArc(p1, p2, r)
  make_face(closed_wire) / mirror(shape, Plane.YZ)
  The cheapest smooth body is a loft through offset circles:
    loft([Plane.XY.offset(z) * Circle(r) for z, r in ((0, 8), (20, 14), (45, 6))])
  Sections must be sketches on planes, listed in order along the blend; a loft
  through two identical circles is just a cylinder, so vary the radii.
RULES:
  - def build(p): ... return <shape>   (exactly this entrypoint; p.name reads a param)
  - millimeters everywhere; NO topological string selectors; NO other imports.
  - loops/math are fine: for sx in (-1, 1): plate = plate - Pos(sx*dx, 0, 0) * Cylinder(r, t)
  - SELECTORS COME BACK EMPTY: shape.edges().group_by(Axis.Z)[-1] raises
    IndexError on an empty group, failing the node with a Python error instead
    of a geometry one — and a fillet/chamfer whose edges you cannot be certain
    of is exactly where that happens. If you are not sure the edge set exists,
    leave the edge sharp. Cosmetic rounding is never worth losing the node.
  - BUILD BUDGET: the kernel KILLS a build at 20 SECONDS and the node is lost —
    a timeout is not a slow pass, it is a failure with nothing to measure.
    Filleting every edge is what usually blows it: fillet(shape.edges(), r) on a
    lofted or already-booleaned body can run for minutes. Narrow the selector
    (.filter_by(Axis.Z), .group_by(Axis.Z)[-1]), round BEFORE cutting rather
    than after, keep loft sections in single digits, and leave cosmetic edges
    sharp. A measured helicopter fuselage burned all five attempts on exactly
    this, every one at 20s.
  - CHAMFERS: use chamfer()/fillet() on the real edges. Do NOT fake one by
    subtracting a rotated Box — Rot(45,0,0) * Box(w, leg*2, leg*2) spans
    leg*1.414 in BOTH rotated axes, not leg, so a "small" lead-in sized against
    a wall thickness cuts the entire wall away and the slot probe then reports
    "the channel is open".`;

/** Deterministic armor for weak-model code slop: markdown fences, modules
 * emitted as one line of literal \n escapes, and forgotten imports. */
export function normalizeCadCode(raw: string): string {
  let code = raw.trim();
  code = code.replace(/^```(?:python|py)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  if (!code.includes("\n") && code.includes("\\n")) {
    code = code.replace(/\\n/g, "\n").replace(/\\t/g, "    ");
  }
  if (!/(?:from\s+build123d\s+import|import\s+build123d)/.test(code)) {
    code = `from build123d import *\n\n${code}`;
  }
  return code;
}

export const CadArtifactSchema = z.object({
  code: z
    .string()
    .describe("complete Python module: imports + def build(p)")
    .transform(normalizeCadCode),
});

/** Contract values only, never code: the node's own params, its neighbours'
 *  contract params, and every node's current values when the cook passes
 *  them. Enough for resolvePose to turn T1 expressions into numbers. */
function paramGraph(ctx: GenerateCtx<CadContractPayload>): GraphDoc {
  const nodes: Record<string, { params: Record<string, ParamValue>; contract: { params: unknown[] } }> = {};
  for (const v of [...ctx.upstream, ...ctx.downstream]) nodes[v.nodeId] = { params: {}, contract: v.contract };
  for (const [id, params] of Object.entries(ctx.paramValues ?? {})) {
    nodes[id] = { params, contract: nodes[id]?.contract ?? { params: [] } };
  }
  nodes[ctx.node.id] = { params: ctx.node.params, contract: ctx.node.contract };
  return { nodes } as unknown as GraphDoc;
}

type RawPose = { origin: Dim[]; zAxis: Dim[]; xAxis: Dim[] };

function tryResolve(graph: GraphDoc | undefined, pose: RawPose): RawPose {
  if (!graph) return pose;
  try {
    return resolvePose(graph, pose);
  } catch {
    return pose; // unresolvable: the expression itself is the most honest thing to show
  }
}

function tryDim(graph: GraphDoc | undefined, d: Dim): Dim {
  if (!graph) return d;
  try {
    return resolveDim(graph, d);
  } catch {
    return d;
  }
}

const vec = (v: Dim[]) => `[${v.map((d) => (typeof d === "number" ? String(Number(d.toFixed(3))) : d)).join(", ")}]`;

/** A pose component written over this node's OWN params, rewritten the way
 *  code reading `p` computes it, so geometry built from the formula follows
 *  T0 edits where the printed number would not. Null for a constant, or for
 *  an expression reading another node, which `p` cannot see. */
function ownFormula(d: Dim, nodeId: string): string | null {
  if (typeof d === "number") return null;
  const src = (d.startsWith("expr:") ? d.slice("expr:".length) : d).trim();
  let foreign = false;
  const out = src.replace(/param\(\s*([^.)]+)\.([^)]+?)\s*\)/g, (_m, id: string, name: string) => {
    if (id.trim() !== nodeId) foreign = true;
    return `p.${name.trim()}`;
  });
  return foreign || out === src ? null : out;
}

/** Processes whose G3 fit bands are the machined ones; every other process
 *  prints to the FDM bands. */
const MACHINED = new Set(["cnc", "sheet_metal", "laser_cut"]);

/** `cutProcess`: annotate fitted ports with the cut size for that process (own ports only). */
function portLines(payload: CadContractPayload, graph?: GraphDoc, nodeId?: string, cutProcess?: string): string {
  return payload.ports
    .map((p) => {
      const params = Object.entries(p.params).map(([k, v]) => `${k}=${v}`).join(", ");
      const pose = tryResolve(graph, p.pose);
      const formulas = nodeId
        ? p.pose.origin.flatMap((d, i) => {
            const f = ownFormula(d, nodeId);
            return f ? [`${"xyz"[i]} = ${f}`] : [];
          })
        : [];
      const origin = `${vec(pose.origin)}${formulas.length ? ` (${formulas.join(", ")})` : ""}`;
      // Ports declare a bought part's NOMINAL size and G3 owns the fit band, so
      // the node that cuts the feature is told the cut size, aimed mid-band for
      // its process: machined bands are a tenth of the printed ones.
      const cut = cutProcess
        ? fitCut(
            p,
            (v) => {
              const d = tryDim(graph, v);
              return typeof d === "number" ? d : undefined;
            },
            MACHINED.has(cutProcess),
          )
        : null;
      return `  - ${p.name} (${p.type}) at origin ${origin}, z-out ${vec(pose.zAxis)}, x ${vec(pose.xAxis)}${params ? ` — ${params}` : ""}${cut ? `; ${cutProcess}: ${cut}` : ""}`;
    })
    .join("\n");
}

function envelopeLines(payload: CadContractPayload, graph?: GraphDoc): string {
  return payload.envelope.volumes
    .map((v) => {
      const pose = tryResolve(graph, v.pose);
      if (v.kind === "cylinder") {
        return `  - cylinder Ø${tryDim(graph, v.d)}×${tryDim(graph, v.h)} mm centered at ${vec(pose.origin)}, axis along ${vec(pose.zAxis)}`;
      }
      const aligned = vec(pose.zAxis) === "[0, 0, 1]" && vec(pose.xAxis) === "[1, 0, 0]";
      const orientation = aligned
        ? "axis-aligned"
        : `rotated: dims run along its own x ${vec(pose.xAxis)}, y = z × x, z ${vec(pose.zAxis)}`;
      return `  - box ${v.dims.map((d) => tryDim(graph, d)).join("×")} mm centered at ${vec(pose.origin)}, ${orientation}`;
    })
    .join("\n");
}

/** Pattern layout and G4b assertions, spelled out because their params are
 *  terse and the kernel measures both literally. Empty for a part using neither. */
function checkLines(payload: CadContractPayload): string {
  const lines: string[] = [];
  if (payload.ports.some((p) => p.type === "HOLE_PATTERN" || p.type === "BOSS_PATTERN")) {
    lines.push(
      "Pattern ports place one feature per member in the port frame, x along its xAxis:",
      "  polar: count features on a circle of DIAMETER pcd, first at start_angle° from xAxis (default 0)",
      "  grid: nx × ny features at pitch_x / pitch_y, centred on the port origin",
    );
  }
  const assertions = payload.assertions ?? [];
  if (assertions.length > 0) {
    lines.push("Measured on the finished part (its own frame):");
    for (const a of assertions) {
      const { kind, ...rest } = a;
      lines.push(`  - ${kind} ${Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

function paramLines(contract: { params: { name: string; type: string; default: unknown; description: string }[] }): string {
  return contract.params
    .map((p) => `  - p.${p.name} (${p.type}, default ${JSON.stringify(p.default)}): ${p.description}`)
    .join("\n");
}

/**
 * Worked examples mined from the node library — verified code paired with the
 * contract it was written against. The cheat sheet can only list call shapes;
 * these show the shapes composed into a whole part that passed every gate, in
 * this project's own style. They ride the USER turn rather than the system
 * turn deliberately: the system block stays byte-identical across every node
 * in a parallel cook wave, so it remains prefix-cacheable.
 */
function exemplarBlock(ctx: GenerateCtx<CadContractPayload>): string {
  if (!ctx.exemplars || ctx.exemplars.length === 0) return "";
  const blocks = ctx.exemplars.map((ex, i) => {
    const p = ex.contract.payload as CadContractPayload | undefined;
    return [
      `--- worked example ${i + 1}: ${ex.title} ---`,
      "Its contract asked for:",
      paramLines(ex.contract) || "  (no params)",
      p?.ports?.length ? `Ports:\n${portLines(p)}` : "  (no ports)",
      "Code that satisfied it and passed every gate:",
      "```python",
      ex.code.trim(),
      "```",
    ].join("\n");
  });
  return [
    "",
    "VERIFIED EXAMPLES from this workshop — match their style and structure.",
    "They are DIFFERENT parts: copy the approach, never the dimensions.",
    ...blocks,
    "",
  ].join("\n");
}

const LEDGER_LINES = 6;

/** A failure as the ledger shows it: the measured lines, not just the first.
 *  "port \"bolt\" (BORE): expected Ø4.5, measured Ø6.00" is the headline,
 *  but the hint and the lines under it are often what names the fix. Capped so
 *  a long traceback cannot crowd out the failure actually being repaired. */
function ledgerEntry(f: { stage: string; report: string }): string {
  const lines = f.report.split("\n").filter((l) => l.trim());
  const kept = lines.slice(0, LEDGER_LINES).map((l) => (l.length > 240 ? `${l.slice(0, 240)}…` : l));
  if (lines.length > LEDGER_LINES) kept.push("…");
  return `  - ${f.stage}: ${kept.join("\n      ")}`;
}

export function generatePrompt(ctx: GenerateCtx<CadContractPayload>): PromptSpec {
  const payload = ctx.node.contract.payload;
  const params = paramLines(ctx.node.contract);
  const graph = paramGraph(ctx);

  // A generated mesh (geometrySource "mesh") is edited the same way; its
  // fitted surface is already at size, so it has no scale param.
  const meshSource = payload.geometrySource === "mesh";
  const importedGuidance =
    ctx.node.kind === "imported" || meshSource
      ? [
          "",
          "THIS NODE WRAPS AN IMPORTED MESH. Do NOT re-model it. Start from",
          meshSource ? `  part = load_import("${ctx.node.id}.ply")` : `  part = ${importedPartExpr(ctx.node as unknown as NodeRecord)}`,
          "and MODIFY it with boolean operators against build123d primitives:",
          "  part - Pos(x, y, z) * Cylinder(r, depth)     # cut a hole",
          "  part + Pos(x, y, z) * Box(a, b, c)           # add material",
          "  part & shape                                 # intersect/trim",
          "Coordinates are the imported model's own frame (see the envelope for",
          "its bounds). Keep every declared port's geometry intact.",
        ].join("\n")
      : "";

  const system = [
    "You write ONE printed part as build123d python for a patch-graph CAD tool.",
    "The part's interface contract is pinned: your geometry must physically",
    "realize every declared port at its exact pose and dimensions — external",
    "probes measure the result and reject mismatches. Stay inside the envelope.",
    "",
    CHEAT_SHEET,
    importedGuidance,
  ].join("\n");

  const user = [
    `Part: ${ctx.node.title} — ${ctx.node.spec}`,
    // The architect's reading of THIS part's region of the user's reference
    // image. The image itself stays with the architect; this is the part's
    // own description, so hermeticity holds.
    payload.visualRef ? `In the reference image: ${payload.visualRef}` : "",
    `Design brief: ${ctx.brief.goal}`,
    // The only channel through which parts can agree on anything the contracts
    // do not pin. Hermeticity is what makes it necessary, not optional.
    ctx.brief.design ? `Shared design intent (every part follows this): ${ctx.brief.design}` : "",
    "",
    `Parameters (read via p.<name>):`,
    params || "  (none)",
    `Ports your geometry MUST realize (local frame, +z points out of material):`,
    portLines(payload, graph, ctx.node.id, sourcingOf(ctx.node).process) || "  (none)",
    `Envelope (all geometry must fit inside, ${payload.envelope.clearance} mm clearance):`,
    envelopeLines(payload, graph),
    checkLines(payload),
    // A fabricate part's process block (dfm.ts) rides the user turn, so the
    // system block stays byte-identical across the wave.
    processLines(ctx.node),
    ctx.node.thread.length > 0
      ? `User refinements:\n${ctx.node.thread.map((m) => `  ${m.role}: ${m.content}`).join("\n")}`
      : "",
    // A reprompt edits the part the user is looking at. Without its code,
    // "make the fillet bigger" regenerated the whole part from scratch. This
    // is the node's OWN code, never a neighbour's, so hermeticity holds.
    ctx.node.thread.length > 0 && ctx.node.currentCode
      ? [
          "",
          "Current code (modify, don't rewrite — change only what the refinements ask for):",
          "```python",
          ctx.node.currentCode,
          "```",
        ].join("\n")
      : "",
    exemplarBlock(ctx),
    // A fresh start after chained repairs stalled: the code is gone on
    // purpose, but what it failed on is not, or the new attempt walks straight
    // back into the same wall.
    ctx.priorFailures?.length
      ? [
          "",
          "Approaches already tried for this part failed like this — do not repeat them:",
          ...ctx.priorFailures.map(ledgerEntry),
        ].join("\n")
      : "",
    "",
    "Emit the complete module.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    system,
    // Images the user attached to this node's own reprompts: their spec.
    messages: [{ role: "user", content: user, ...(ctx.refImages?.length ? { images: ctx.refImages } : {}) }],
    schema: CadArtifactSchema as unknown as PromptSpec["schema"],
    role: "generator",
  };
}

export function repairPrompt(ctx: RepairCtx<CadContractPayload>): PromptSpec {
  // The ledger goes in the repair turn below, not the first user turn, so
  // that turn stays identical across repair rounds and remains cacheable.
  const base = generatePrompt({ ...ctx, priorFailures: [] });
  // Only the newest failure comes with its code, so the earlier ones are
  // listed as a "already tried, still wrong" ledger: without it the model
  // re-proposes a fix it has already spent a round on.
  const spent =
    ctx.priorFailures.length > 0
      ? [
          "",
          "Earlier attempts in this cook already failed like this — do not repeat them:",
          ...ctx.priorFailures.map(ledgerEntry),
        ].join("\n")
      : "";

  // Known fixes for this failure's signature. User turn only: the system
  // block must stay byte-identical across the wave to stay prefix-cached.
  const pitfalls = matchPitfalls(ctx.failure.stage, ctx.failure.report);
  const known =
    pitfalls.length > 0
      ? ["", "Known fixes for failures like this one:", ...pitfalls.map((p) => `  - ${p.fix}`)].join("\n")
      : "";

  // The code replayed below is the closest attempt so far, which need not be
  // the latest: a later round can regress, and repairing the regression
  // throws away the better start. `attempt` is the round about to run, so the
  // latest failed round is attempt - 1 and needs no remark.
  const basis =
    ctx.basedOnAttempt !== undefined && ctx.basedOnAttempt < ctx.attempt - 1
      ? `You are fixing attempt ${ctx.basedOnAttempt}, the closest so far — later attempts did worse, so build on this one.`
      : "";

  // THREE DIFFERENT ROUNDS, not one instruction repeated. The loop previously
  // varied only by the ledger above, so attempt 4 of 5 read exactly like
  // attempt 2 and the model kept refining an approach that had already failed
  // twice. The penultimate round is where changing tactics still has a round
  // left to land in; on the final one there is no room to experiment.
  //
  // TWO priors, not one. On maxAttempts 5 this fires at round 4 either way, but
  // web-code runs maxAttempts 3, where one prior makes it fire at round 2 and
  // "refining the same approach has failed more than once" is then false. A
  // 3-round budget has no room for a distinct penultimate strategy anyway, so
  // skipping it there is the honest outcome.
  //
  // Measured rather than assumed to help: it is NOT claimed to improve the
  // pass rate. rib-blocked-hole's generator calls across five runs were
  // 2, 2, 4, 1, 2 — mean 2.20, sd 1.10 — so detecting a half-call change needs
  // about 74 runs per arm, roughly $21 each at measured rates. What IS provable
  // is that the instruction differs by round, which is what the tests assert.
  const lastRound =
    ctx.attempt >= ctx.maxAttempts
      ? "\nThis is the FINAL attempt: prefer a simpler geometry that certainly passes over a clever one that might."
      : ctx.attempt >= ctx.maxAttempts - 1 && ctx.priorFailures.length >= 2
        ? "\nThis is the SECOND TO LAST attempt, and refining the same approach has now failed more than once. Change tactics rather than adjusting numbers: build the failing feature separately and combine it, or replace it with a simpler shape that satisfies the same contract. One round remains after this one."
        : "";

  // A gate report is a number; a picture is the shape. Attached to the same
  // turn as the failure so the model reads them together — this is the only
  // input that can catch geometry which measures correctly and still looks
  // nothing like the part that was asked for.
  const seeing = ctx.render
    ? "\nThe image shows what your code actually built, from four angles. Check it against the part described above before you change anything: if the SHAPE is wrong, fixing the measurement alone will not help."
    : "";

  return {
    ...base,
    role: "repair",
    messages: [
      ...base.messages,
      { role: "assistant", content: JSON.stringify({ code: ctx.failedCode }) },
      {
        role: "user",
        ...(ctx.render ? { images: [ctx.render] } : {}),
        content: [
          `That code failed gate ${ctx.failure.stage}. This is attempt ${ctx.attempt} of ${ctx.maxAttempts}:`,
          ctx.failure.report,
          basis,
          known,
          spent,
          "",
          `Fix exactly this problem and emit the corrected complete module.${seeing}${lastRound}`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  };
}
