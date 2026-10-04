import { z } from "zod";
import type { LlmImage, LlmProvider, LlmUsage } from "./llm.js";

/**
 * The plan coverage critic: one cheap call that reads the BRIEF next to a
 * compact summary of a plan that already passed its lints, and names what the
 * brief explicitly asks for that the plan does not have.
 *
 * Lints judge a plan against itself and never read the brief, so a plan can be
 * internally perfect and still be the wrong product. Measured on the real
 * product evals: a pinewood car brief that says the wheels "spin on 2.2mm axle
 * nails" planned a body and a wheel with no nails and no joints (the architect
 * dropped its joints to clear joint lints), and an extruder brief naming a
 * drive gear and an idler gear came back without them.
 *
 * The critic sees the brief and the plan, never code, so hermeticity is
 * untouched. It is an LLM judgement, so it never fails a plan: a finding buys
 * one architect repair round, and what survives becomes a warning.
 */

export const CriticFinding = z.object({
  what: z.string().describe("the part, subsystem, motion, hardware or dimension, in a few words"),
  quote: z.string().describe("the brief's exact words that ask for it, copied verbatim"),
  why: z.string().describe("one sentence: what the brief asks for and what the plan has instead"),
  severity: z.enum(["missing", "wrong", "ok"]),
});
export type CriticFinding = z.infer<typeof CriticFinding>;

export const CriticQuantity = z.object({
  item: z.string(),
  quote: z.string().describe("the brief's exact words that state the count, copied verbatim"),
  briefSays: z.number(),
  planHas: z.number(),
});
export type CriticQuantity = z.infer<typeof CriticQuantity>;

export const CriticOutput = z.object({
  missing: z.array(CriticFinding),
  quantities: z.array(CriticQuantity),
});
export type CriticOutput = z.infer<typeof CriticOutput>;

export const CRITIC_SYSTEM = [
  "You check a mechanical design PLAN against the BRIEF it was planned from.",
  "The plan is a summary: its parts (with how many copies are placed), the joints",
  "between them (with motion and the hardware each joint was expanded into), a",
  "hardware list, and key dimensions. You never see geometry or code.",
  "",
  "Report ONLY what the brief EXPLICITLY states and the plan lacks or gets wrong:",
  "- a named part or subsystem (a latch, an idler arm, a drawer)",
  "- a motion the brief names (spins, hinges, slides, pivots, turns)",
  "- a named piece of hardware (an axle nail, a bearing, a gear, a spring, a screw size)",
  "- a quantity the brief states as a number (four wheels, eight screws)",
  "- a key dimension the brief states as a number, when the plan's value differs by",
  "  more than 10% AND more than 2 mm",
  "",
  "NEVER invent requirements. Do not report good practice, what a real product",
  "usually has, hardware the brief does not name, tolerances, materials, finishes,",
  "colours, weights, or anything the brief only implies. If you cannot copy the",
  "brief's exact words that ask for it into `quote`, it is not a finding.",
  "",
  "How to read the plan:",
  "- Hardware the plan lists under a different but equivalent name is present: an",
  "  ISO2338 pin is a dowel or pin, ISO4762 is a socket-head cap screw, a",
  "  `shaft` is an axle or pin, a `spur_gear`/`gear` is a gear. Judge by function.",
  "- A feature cut into a part (a hole, slot, pocket, boss, groove, recess, rib) is",
  "  present when that part's title, summary or params mention it.",
  "- A joint's motion is what it allows: a wheel that spins needs a revolute joint",
  "  between the wheel and what carries it; a fixed joint or a bare mate is not one.",
  "- One part node placed N times counts as N.",
  "- The overall envelope is padded and approximate: flag an overall dimension",
  "  only when it is off by more than 20%; judge part dimensions first.",
  "- Compare only numbers the plan states (a part's dims, a hardware size, the",
  "  overall envelope). Never derive one from other params (a span from an offset",
  "  plus a splay): poses are not in the summary, so the arithmetic is a guess.",
  "- Equivalent standards are the same thing: ACME and metric trapezoidal (T8) lead",
  "  screws, ISO and DIN parts, a pin and a dowel. Only a different function counts.",
  "- A part the brief names may be merged into another part when the summary says",
  "  so (a body with integral legs); that is not missing.",
  "- Bought items the brief names (a motor, a spring, a magnet) may be absent from",
  "  the plan only when the plan models a seat or pocket for them; then the item is",
  "  present enough. A motion they produce must still have its joint.",
  "",
  "severity: \"missing\" = the plan has no such thing; \"wrong\" = it has it with",
  "the wrong motion, type or dimension; \"ok\" = you checked it and it is present",
  "(list at most a few ok items, only for the subsystems you were unsure of).",
  "quantities: only counts the brief states as numbers or number words. briefSays",
  "is that number, planHas the count you find in the plan (0 if none). Do not",
  "list a quantity that matches.",
  "",
  "Be terse. An empty `missing` and `quantities` is the right answer for a plan",
  "that covers its brief.",
].join("\n");

/** Collapsed whitespace, lower case: what "the brief says this" is matched on. */
const norm = (s: string) => s.toLowerCase().replace(/[\s ]+/g, " ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();

/**
 * Deterministic armor around the judgement. A finding must quote the brief:
 * the prompt forbids inventing requirements, and a finding whose quote is not
 * in the brief is how an invented one shows itself, so it is dropped. With
 * reference images the brief is partly a picture and no quote can be checked,
 * so an empty quote is kept then. "ok" items and matching counts are not
 * findings at all, and a count drops the "missing" that quotes the same words.
 */
export function criticFindings(out: CriticOutput, brief: string, hasImages = false): {
  missing: CriticFinding[];
  quantities: CriticQuantity[];
} {
  const text = norm(brief);
  const quoted = (q: string) => (q.trim() === "" ? hasImages : text.includes(norm(q).replace(/^["']|["']$/g, "")));
  const quantities = out.quantities.filter((q) => q.briefSays !== q.planHas && quoted(q.quote));
  // A count and a "missing" on the same words are one finding, and the count
  // is the sharper line ("4 × roller: the plan has 2", not "has none").
  const counted = quantities.map((q) => norm(q.quote));
  const overlaps = (quote: string) => counted.some((c) => c.includes(norm(quote)) || norm(quote).includes(c));
  return {
    missing: out.missing.filter((f) => f.severity !== "ok" && quoted(f.quote) && !overlaps(f.quote)),
    quantities,
  };
}

/** One line per finding, in the words a repair round or a warning shows. */
export function criticProblems(f: { missing: CriticFinding[]; quantities: CriticQuantity[] }): string[] {
  return [
    ...f.missing.map((m) =>
      m.severity === "missing"
        ? `The brief asks for ${m.what} ("${m.quote}"): the plan has none. ${m.why}`
        : `The brief asks for ${m.what} ("${m.quote}"): the plan has it wrong. ${m.why}`,
    ),
    ...f.quantities.map(
      (q) => `The brief asks for ${q.briefSays} × ${q.item} ("${q.quote}"): the plan has ${q.planHas}.`,
    ),
  ];
}

export interface CritiqueResult {
  /** Findings that survived the quote check, as problem lines. */
  problems: string[];
  raw: CriticOutput;
  usage: LlmUsage;
}

/** Run the critic once. Throws (LlmCallError, billed) like any provider call;
 *  planGraph treats a failed critic as no critic. */
export async function critiquePlan(opts: {
  provider: LlmProvider;
  brief: string;
  summary: string;
  images?: LlmImage[];
  label: string;
  signal?: AbortSignal;
}): Promise<CritiqueResult> {
  const res = await opts.provider.complete({
    role: "classifier",
    label: opts.label,
    system: CRITIC_SYSTEM,
    messages: [
      {
        role: "user",
        content: [`BRIEF:\n${opts.brief}`, "", `PLAN:\n${opts.summary}`].join("\n"),
        ...(opts.images?.length ? { images: opts.images } : {}),
      },
    ],
    schema: CriticOutput,
    maxTokens: 4000,
    effort: "low",
    signal: opts.signal,
  });
  return {
    problems: criticProblems(criticFindings(res.data, opts.brief, !!opts.images?.length)),
    raw: res.data,
    usage: res.usage,
  };
}
