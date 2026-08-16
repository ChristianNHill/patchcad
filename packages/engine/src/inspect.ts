import { z } from "zod";
import type { LlmImage, LlmProvider } from "./llm.js";

/**
 * The inspect step of write → render → inspect → rewrite, per node.
 *
 * Repairs can already see what they built (backend.renderArtifact), but only
 * when a gate has already failed. A part that passes every gate is never
 * looked at — and "valid solid, declared bore measured, inside the envelope,
 * completely the wrong object" is a real state the whole gate stack is blind
 * to by construction.
 *
 * APPEARANCE NEVER FAILS A NODE. A model judging a picture is not an oracle,
 * so a verdict here buys at most one rewrite attempt; if that attempt also
 * looks wrong, or fails its gates, the code that passed the gates is what gets
 * committed. The worst case is one wasted round, never a lost working part.
 */

export const NodeInspection = z.object({
  looksRight: z.boolean().describe("does the geometry match the part described?"),
  /** Only `blocking` buys a rewrite; anything softer is not worth the round. */
  severity: z.enum(["blocking", "minor", "none"]).default("none"),
  issue: z.string().default("").describe("what is wrong, one sentence, empty when it looks right"),
  fix: z.string().default("").describe("the change to the CODE that would fix it"),
});
export type NodeInspection = z.infer<typeof NodeInspection>;

const SYSTEM = [
  "You are checking whether a generated 3D part matches what was asked for.",
  "It has already passed automated checks: it is a valid solid, its declared",
  "holes measure correctly, and it fits inside its envelope. Do NOT re-check",
  "any of that, and do not comment on surface finish or print quality.",
  "",
  "You are looking for one thing only: geometry that is measurably correct and",
  "still the wrong object. A bracket with no upright leg. A mount with its arm",
  "on the wrong face. A part that is a featureless block where a shaped one was",
  "described.",
  "",
  "Say it looks right unless something is plainly, structurally wrong. This",
  "verdict costs a full rewrite of code that currently works and passes every",
  "check, so `blocking` must mean you would reject the part in your hand — not",
  "that you would have modelled it differently.",
].join("\n");

export async function inspectNode(opts: {
  provider: LlmProvider;
  node: { title: string; spec: string; kind: string };
  /** What the contract pins, so the model judges against the brief not its taste. */
  contractSummary: string;
  image: LlmImage;
  signal?: AbortSignal;
}): Promise<NodeInspection> {
  const result = await opts.provider.complete({
    role: "repair",
    system: SYSTEM,
    label: `inspect:${opts.node.title}`,
    schema: NodeInspection,
    signal: opts.signal,
    messages: [
      {
        role: "user",
        images: [opts.image],
        content: [
          `The part was specified as: ${opts.node.title} (${opts.node.kind})`,
          opts.node.spec,
          opts.contractSummary ? `Its contract promises: ${opts.contractSummary}` : "",
          "",
          "The image is what the generated code actually produced. Is this that part?",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });
  return result.data;
}
