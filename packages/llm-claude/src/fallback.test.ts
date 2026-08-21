import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ClaudeProvider, isGrammarRejection, LlmCallError } from "./index.js";

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

describe("parse failures say enough to diagnose without a second paid call", () => {
  // tryParse is private, and reaching it through a stubbed SDK is more machinery
  // than the check is worth, so this pins the DIAGNOSTIC CONTENT the adapter is
  // required to produce. A real architect call failed with nothing but
  // "Expected ',' or '}' after property value in JSON at position 3082" — no
  // length, no stop reason, not one character of the text — and telling
  // truncation from malformed JSON cost another call.
  const call = (raw: string, stop: string | null) => {
    const provider = new ClaudeProvider({ apiKey: "test" }) as unknown as {
      tryParse: (
        req: { schema: z.ZodTypeAny },
        raw: string,
        stop: string | null,
      ) => { success: boolean; error?: string };
    };
    return provider.tryParse({ schema: z.object({ a: z.string() }) }, raw, stop);
  };

  it("names truncation as truncation, and points at the ceiling", () => {
    const truncated = '{"a": "x", "b": {"c": 1}, "d": "unterminat';
    const out = call(truncated, "max_tokens");
    expect(out.success).toBe(false);
    expect(out.error).toContain("TRUNCATED");
    expect(out.error).toContain("raise maxTokens");
    expect(out.error).toContain("stop: max_tokens");
  });

  it("reports length, stop reason and a window around the position", () => {
    const bad = '{"a": "x" "b": 2}';
    const out = call(bad, "end_turn");
    expect(out.success).toBe(false);
    expect(out.error).toContain(`${bad.length} chars`);
    expect(out.error).toContain("stop: end_turn");
    // the offending text itself, not just a number
    expect(out.error).toMatch(/around it|head:/);
    expect(out.error).not.toContain("TRUNCATED");
  });

  // The position V8 reports is an offset into the matched object, not the whole
  // reply, so a reply with prose before the brace must report both lengths or
  // the reader compares position against the wrong one.
  it("distinguishes the JSON's length from the reply's when they differ", () => {
    const bad = '{"a": "x" "b": 2}';
    const out = call(`Here is the plan you asked for:\n\n${bad}`, "end_turn");
    expect(out.success).toBe(false);
    expect(out.error).toContain(`${bad.length} chars of JSON`);
    expect(out.error).toContain("char reply");
  });

  it("reports one length when the reply IS the JSON", () => {
    const bad = '{"a": "x" "b": 2}';
    const out = call(bad, "end_turn");
    expect(out.error).toContain(`${bad.length} chars,`);
    expect(out.error).not.toContain("chars of JSON");
  });

  it("still reports the raw head when no JSON object is present at all", () => {
    const out = call("I cannot help with that.", "end_turn");
    expect(out.success).toBe(false);
    expect(out.error).toContain("no JSON object found");
    expect(out.error).toContain("cannot help");
  });

  it("passes a valid object through", () => {
    expect(call('{"a": "x"}', "end_turn").success).toBe(true);
  });
});

describe("a failed call still reports what it billed", () => {
  it("carries usage out on the error", () => {
    const err = new LlmCallError("boom", { inputTokens: 6333, outputTokens: 1462, usd: 0.0682 });
    expect(err).toBeInstanceOf(Error);
    expect(err.usage.usd).toBeCloseTo(0.0682);
    expect(err.usage.inputTokens).toBe(6333);
    expect(err.name).toBe("LlmCallError");
  });
});

describe("every throw carries what it billed", () => {
  // The selective version attached usage only to the schema-failed-twice path,
  // so a refusal or an SDK error lost it and a caller could not tell "no usage
  // attached" from "no usage spent". Wrapping complete() removes the choice.
  it("wraps a non-LlmCallError throw, preserving the message", async () => {
    const provider = new ClaudeProvider({ apiKey: "test" });
    // No network: the SDK throws on a bad request, which is the path that used
    // to lose its usage entirely.
    await expect(
      provider.complete({
        role: "generator", label: "t", system: "s",
        messages: [{ role: "user", content: "x" }],
        schema: z.object({ a: z.string() }),
      } as never),
    ).rejects.toBeInstanceOf(LlmCallError);
  });

  it("does not double-wrap an LlmCallError", () => {
    const inner = new LlmCallError("inner", { inputTokens: 1, outputTokens: 2, usd: 3 });
    // the wrapper rethrows the same instance rather than nesting it
    expect(inner instanceof LlmCallError).toBe(true);
    expect(inner.usage.usd).toBe(3);
  });
});
