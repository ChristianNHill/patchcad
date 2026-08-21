import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ClaudeProvider, isGrammarRejection } from "./index.js";

/** The real predicate, imported rather than reimplemented: a local copy would
 *  keep passing after the adapter changed. */
const shouldFallBack = isGrammarRejection;

/** SDK errors carry a status their constructors want a real response for, so
 *  build them off the prototype and set only what the predicate reads. */
const apiError = (Cls: { prototype: object }, message: string) =>
  Object.assign(Object.create(Cls.prototype) as Error, { message });

describe("grammar fallback predicate", () => {
  it("fires on the real rejection", () => {
    expect(shouldFallBack(apiError(Anthropic.BadRequestError,
      "400 {\"type\":\"error\",\"error\":{\"message\":\"The compiled grammar is too large, which would cause performance issues.\"}}",
    ))).toBe(true);
  });

  it("ignores an unrelated 400", () => {
    expect(shouldFallBack(apiError(Anthropic.BadRequestError, "max_tokens must be at least 1"))).toBe(false);
  });

  // These are the ones that matter. A retry after any of them is NOT free,
  // because tokens have already been billed or a limit is already being hit.
  it("ignores every error a retry would charge for", () => {
    for (const [label, err] of [
      ["rate limit", apiError(Anthropic.RateLimitError, "429 rate_limit_error")],
      ["overloaded", apiError(Anthropic.InternalServerError, "529 overloaded_error")],
      ["network", new Error("Connection error.")],
      ["abort", new Error("Request was aborted.")],
    ] as const) {
      expect(shouldFallBack(err), label).toBe(false);
    }
  });

  // err.message is the whole JSON body, and two throws inside the attempt
  // interpolate req.label, which carries the user's goal slug. A bare
  // /grammar/i would have re-run the architect at full price for a project
  // whose NAME contained the word.
  it("is not fooled by a project named after the word", () => {
    for (const msg of [
      'model refused request "architect:grammar-school-desk-organizer"',
      'no text block in response for "architect:grammar-school-desk-organizer" (stop: max_tokens)',
    ]) {
      expect(shouldFallBack(new Error(msg)), msg.slice(0, 24)).toBe(false);
      // even as a 400, the message does not say "compiled grammar"
      expect(shouldFallBack(apiError(Anthropic.BadRequestError, msg)), "as 400").toBe(false);
    }
  });
});

describe("tryParse", () => {
  const parse = (raw: string) => {
    const p = new ClaudeProvider({ apiKey: "x" });
    return (p as unknown as {
      tryParse: (r: unknown, raw: string) => { success: boolean };
    }).tryParse.bind(p)({ schema: z.object({ code: z.string() }) }, raw);
  };

  // The grammar fallback drops the `format` block, which was the only thing
  // guaranteeing bare JSON. A fence would otherwise cost a second full
  // architect generation.
  it("survives a fence, prose, and bare JSON", () => {
    expect(parse('```json\n{"code":"ok"}\n```').success, "fenced").toBe(true);
    expect(parse('{"code":"ok"}').success, "bare").toBe(true);
    expect(parse('Here:\n{"code":"ok"}\nDone.').success, "prose").toBe(true);
  });

  it("reports the raw head when there is no JSON at all", () => {
    const r = parse("I cannot do that.") as { success: boolean; error?: string };
    expect(r.success).toBe(false);
    expect(r.error).toContain("no JSON object found");
  });
});
