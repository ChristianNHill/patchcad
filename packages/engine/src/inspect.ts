import { z } from "zod";
import type { LlmImage, LlmProvider, LlmUsage } from "./llm.js";

/**
 * The inspect step of write → render → inspect → rewrite, per node: a judge
 * in the CADCodeVerify mould.
 *
 * Repairs can already see what they built (backend.renderArtifact), but only
 * when a gate has already failed. A part that passes every gate is never
 * looked at — and "valid solid, declared bore measured, inside the envelope,
 * completely the wrong object" is a real state the whole gate stack is blind
 * to by construction.
 *
 * The judge does not decide what "right" means. The architect wrote yes/no
 * questions into the contract at plan time (`visualChecks`, YES = correct),
 * before any code existed, so the render is checked against the brief and not
 * against whatever the judge would have modelled. A model asked "does this
 * look right?" reasons its way to a taste verdict; a model asked "is the
 * opening on the top face?" reads one fact off a picture.
 *
 * APPEARANCE NEVER FAILS A NODE. A model judging a picture is not an oracle,
 * so a "no" here buys at most one rewrite attempt; if that attempt also looks
 * wrong, or fails its gates, the code that passed the gates is what gets
 * committed. The worst case is one wasted round, never a lost working part.
 */

export const VisualAnswer = z.object({
  question: z.string().describe("the question, copied verbatim"),
  answer: z.enum(["yes", "no", "unsure"]),
  evidence: z.string().default("").describe("which view shows it and what you see there, one sentence"),
});
export type VisualAnswer = z.infer<typeof VisualAnswer>;

export const NodeInspection = z.object({ answers: z.array(VisualAnswer) });
export type NodeInspection = z.infer<typeof NodeInspection>;

const SYSTEM = [
  "You are checking a rendered 3D part against a list of yes/no questions.",
  "It has already passed automated checks: it is a valid solid, its declared",
  "holes measure correctly, and it fits inside its envelope.",
  "",
  "The image is a contact sheet of orthographic views, each labelled (iso,",
  "front, right, top). Each view has an axis triad in its corner (x red, y",
  "green, z blue; an axis along your line of sight is a filled dot when it",
  "points at you, a ring when it points away) and a scale bar in millimetres.",
  "Dark lines are silhouettes and sharp edges.",
  "",
  "Answer every question, in order, copying it verbatim:",
  "  yes    the views plainly show it",
  "  no     the views plainly show it is NOT so — say where you looked",
  "  unsure the views do not settle it (hidden, too small, ambiguous)",
  "Answer from what is drawn, not from what the part is supposed to be. A",
  "`no` costs a full rewrite of code that currently passes every check, so use",
  "it only when a view contradicts the question, and prefer `unsure` to a",
  "guess. Do not comment on anything the questions do not ask.",
].join("\n");

export interface InspectResult {
  answers: VisualAnswer[];
  /** The `no` answers. `unsure` is never a failure: an unreadable picture is
   *  not evidence against a part that passes every gate. */
  failed: VisualAnswer[];
  usage: LlmUsage;
}

/** What a rewrite is told: only the questions that failed, with evidence. */
export function inspectFeedback(failed: VisualAnswer[]): string {
  return [
    "The part passes every gate but a render of it fails these visual checks",
    "(each should be YES):",
    ...failed.map((a) => `- ${a.question} — ${a.evidence || "no evidence given"}`),
  ].join("\n");
}

export async function inspectNode(opts: {
  provider: LlmProvider;
  node: { title: string; spec: string; kind: string };
  /** From the pinned contract; YES = correct. */
  questions: string[];
  image: LlmImage;
  signal?: AbortSignal;
}): Promise<InspectResult> {
  const result = await opts.provider.complete({
    // CLASSIFIER, not generator. A judge that shares the generator's model
    // shares its blind spots, and on every shipped default the classifier is
    // a different model (haiku vs opus/sonnet). The work is classification
    // too: read one fact per question off a picture. A user who wants a
    // stronger judge raises `models.classifier`; the tier classifier it shares
    // with only runs on ambiguous reprompts. Images still route to `vision`.
    role: "classifier",
    system: SYSTEM,
    label: `inspect:${opts.node.title}`,
    schema: NodeInspection,
    signal: opts.signal,
    messages: [
      {
        role: "user",
        images: [opts.image],
        content: [
          `The part: ${opts.node.title} (${opts.node.kind})`,
          opts.node.spec,
          "",
          "Questions:",
          ...opts.questions.map((q, i) => `${i + 1}. ${q}`),
        ].join("\n"),
      },
    ],
  });
  const answers = result.data.answers;
  return { answers, failed: answers.filter((a) => a.answer === "no"), usage: result.usage };
}
