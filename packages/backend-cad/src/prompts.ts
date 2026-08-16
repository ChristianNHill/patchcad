import { z } from "zod";
import type { GenerateCtx, PromptSpec, RepairCtx } from "@patchcad/engine";
import type { CadContractPayload } from "./index.js";

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
RULES:
  - def build(p): ... return <shape>   (exactly this entrypoint; p.name reads a param)
  - millimeters everywhere; NO topological string selectors; NO other imports.
  - loops/math are fine: for sx in (-1, 1): plate = plate - Pos(sx*dx, 0, 0) * Cylinder(r, t)`;

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
  notes: z.string().default(""),
});

function portLines(payload: CadContractPayload): string {
  return payload.ports
    .map((p) => {
      const params = Object.entries(p.params).map(([k, v]) => `${k}=${v}`).join(", ");
      return `  - ${p.name} (${p.type}) at origin [${p.pose.origin.join(", ")}], z-out [${p.pose.zAxis.join(", ")}]${params ? ` — ${params}` : ""}`;
    })
    .join("\n");
}

function envelopeLines(payload: CadContractPayload): string {
  return payload.envelope.volumes
    .map((v) =>
      v.kind === "box"
        ? `  - box ${v.dims.join("×")} mm centered at [${v.pose.origin.join(", ")}]`
        : `  - cylinder Ø${v.d}×${v.h} mm at [${v.pose.origin.join(", ")}]`,
    )
    .join("\n");
}

export function generatePrompt(ctx: GenerateCtx<CadContractPayload>): PromptSpec {
  const payload = ctx.node.contract.payload;
  const params = ctx.node.contract.params
    .map((p) => `  - p.${p.name} (${p.type}, default ${JSON.stringify(p.default)}): ${p.description}`)
    .join("\n");

  const importedGuidance =
    ctx.node.kind === "imported"
      ? [
          "",
          "THIS NODE WRAPS AN IMPORTED MESH. Do NOT re-model it. Start from",
          `  part = load_import("${ctx.node.id}.ply", scale=p.scale)`,
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
    `Design brief: ${ctx.brief.goal}`,
    "",
    `Parameters (read via p.<name>):`,
    params || "  (none)",
    `Ports your geometry MUST realize (local frame, +z points out of material):`,
    portLines(payload) || "  (none)",
    `Envelope (all geometry must fit inside, ${payload.envelope.clearance} mm clearance):`,
    envelopeLines(payload),
    `Process: FDM, min wall ${payload.process.minWall} mm.`,
    ctx.node.thread.length > 0
      ? `User refinements:\n${ctx.node.thread.map((m) => `  ${m.role}: ${m.content}`).join("\n")}`
      : "",
    "",
    "Emit the complete module.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    system,
    messages: [{ role: "user", content: user }],
    schema: CadArtifactSchema as unknown as PromptSpec["schema"],
    role: "generator",
  };
}

export function repairPrompt(ctx: RepairCtx<CadContractPayload>): PromptSpec {
  const base = generatePrompt(ctx);
  // Only the newest failure comes with its code, so the earlier ones are
  // listed as a "already tried, still wrong" ledger: without it the model
  // re-proposes a fix it has already spent a round on.
  const spent =
    ctx.priorFailures.length > 0
      ? [
          "",
          "Earlier attempts in this cook already failed like this — do not repeat them:",
          ...ctx.priorFailures.map((f) => `  - ${f.stage}: ${f.report.split("\n")[0]}`),
        ].join("\n")
      : "";

  const lastRound =
    ctx.attempt >= ctx.maxAttempts
      ? "\nThis is the FINAL attempt: prefer a simpler geometry that certainly passes over a clever one that might."
      : "";

  return {
    ...base,
    role: "repair",
    messages: [
      ...base.messages,
      { role: "assistant", content: JSON.stringify({ code: ctx.failedCode }) },
      {
        role: "user",
        content: [
          `That code failed gate ${ctx.failure.stage} (attempt ${ctx.attempt} of ${ctx.maxAttempts}):`,
          ctx.failure.report,
          spent,
          "",
          `Fix exactly this problem and emit the corrected complete module.${lastRound}`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  };
}
