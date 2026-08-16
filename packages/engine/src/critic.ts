import { z } from "zod";
import type { GraphDoc } from "@patchcad/shared";
import type { LlmImage, LlmProvider } from "./llm.js";

/**
 * The assembly critic: one look at the whole posed thing.
 *
 * Every other check in the pipeline is per-node and blind by design. A part can
 * pass G0-G4 — valid solid, declared bore measured, inside its envelope — and
 * still be wrong the moment it stands next to its neighbours: sunk into one,
 * floating clear of another, a quarter turn out. Nothing per-part can see that,
 * because nothing per-part ever looks at two parts at once.
 *
 * It is ADVISORY, deliberately and permanently. A model looking at a picture is
 * not an oracle, and wiring it as a gate would let a confident hallucination
 * block a correct assembly. Findings name a node and a suggested fix so they
 * can become a contract edit or a reprompt — the pipeline fixing itself, never
 * a hand edit to generated output.
 */

export const AssemblyCritique = z.object({
  /** Reads as assembled, nothing worth raising. */
  ok: z.boolean(),
  summary: z.string().describe("one sentence on how the assembly reads"),
  problems: z
    .array(
      z.object({
        severity: z.enum(["blocking", "suspect", "cosmetic"]),
        nodeId: z.string().describe("the node most likely at fault, or \"\" if unclear"),
        issue: z.string().describe("what looks wrong, in one sentence"),
        suggestion: z.string().describe("the contract or param change that would fix it"),
      }),
    )
    .default([]),
});
export type AssemblyCritique = z.infer<typeof AssemblyCritique>;

const SYSTEM = [
  "You are inspecting an assembled 3D-printed design from several angles.",
  "Every part has already passed automated dimension checks, so do NOT",
  "comment on sizes you cannot see, surface finish, or print quality.",
  "",
  "Look for what only a picture reveals:",
  "- parts intersecting or sunk into each other where they should meet at a face",
  "- parts floating clear of the thing they are supposed to touch",
  "- a part rotated or mirrored the wrong way (a bracket lying on its back)",
  "- a part obviously out of proportion with the rest",
  "",
  "Report nothing you are not reasonably confident of. An empty problems list",
  "is the correct answer for an assembly that reads fine, and is much more",
  "useful than a speculative one — a false alarm sends a person to inspect a",
  "part that was already right.",
].join("\n");

export async function critiqueAssembly(opts: {
  provider: LlmProvider;
  graph: GraphDoc;
  image: LlmImage;
  signal?: AbortSignal;
}): Promise<AssemblyCritique> {
  const parts = Object.values(opts.graph.nodes)
    .filter((n) => n.artifact?.code)
    .map((n) => `- ${n.id} (${n.kind}): ${n.title} — ${n.contract.summary || n.spec}`)
    .join("\n");

  const result = await opts.provider.complete({
    // The repair role: this is the same kind of judgement call, and it should
    // run on whatever model the user pointed at hard problems.
    role: "repair",
    system: SYSTEM,
    label: `critique:${opts.graph.id}`,
    schema: AssemblyCritique,
    signal: opts.signal,
    messages: [
      {
        role: "user",
        images: [opts.image],
        content: [
          `Goal: ${opts.graph.brief.goal}`,
          opts.graph.brief.design ? `Intended design: ${opts.graph.brief.design}` : "",
          "",
          "Parts in the assembly:",
          parts || "(none)",
          "",
          "The image shows them placed by the assembly solver. Does this read as",
          "the thing described above, correctly put together?",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });
  return result.data;
}
