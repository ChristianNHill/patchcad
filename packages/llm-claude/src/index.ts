import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { LlmProvider, LlmRequest, LlmResult, LlmRole } from "@patchcad/engine";

/**
 * Native Anthropic adapter. Structured output via output_config.format with
 * a json_schema derived from the request's zod schema (sanitized to the
 * structured-outputs subset), then validated client-side with the full zod
 * schema — one repair reprompt on mismatch.
 */

/** List prices per MTok (input, output) for cost attribution. */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export interface ClaudeProviderOptions {
  apiKey?: string;
  models?: Partial<Record<LlmRole, string>>;
}

const DEFAULT_MODELS: Record<LlmRole, string> = {
  architect: "claude-opus-5",
  generator: "claude-sonnet-5",
  repair: "claude-sonnet-5",
  classifier: "claude-haiku-4-5",
};

/** Structured outputs reject numeric/string/array constraints and require
 * additionalProperties:false on every object. Constraints still hold — the
 * zod safeParse below enforces them client-side. */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const obj = { ...(schema as Record<string, unknown>) };
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
  ]) {
    delete obj[key];
  }
  // A zod tuple becomes `items: [A, B, C]`, which structured outputs rejects:
  // "Array types must be specified with a single object schema for 'items'".
  // Every tuple in the CAD payload is a homogeneous xyz triple, so collapsing
  // to the single element schema loses nothing but the arity — and arity is a
  // client-side concern here like every other constraint stripped above, since
  // safeParse re-checks it. A heterogeneous tuple degrades to the union of its
  // positions rather than silently pinning position 0's type on all of them.
  if (Array.isArray(obj.items)) {
    const parts = (obj.items as unknown[]).map(sanitizeSchema);
    const distinct = [...new Map(parts.map((p) => [JSON.stringify(p), p])).values()];
    obj.items = distinct.length === 1 ? distinct[0] : { anyOf: distinct };
    // Deliberately NOT returning early. Today a tuple node carries only
    // type/minItems/maxItems/items, so falling through changes nothing — but a
    // `z.tuple().rest()` adds `additionalItems`, and a 2020-12 target renames
    // this to `prefixItems`, either of which would then slip past unsanitized.
    // sanitizeSchema is idempotent, so re-walking the collapsed items is free.
  }
  if (obj.type === "object") obj.additionalProperties = false;
  for (const [k, v] of Object.entries(obj)) obj[k] = sanitizeSchema(v);
  return obj;
}

/** Is this error the API refusing to compile the schema into a sampling grammar?
 *
 *  Narrow on purpose, and exported so a test pins the real predicate rather than
 *  a copy of it. `err.message` is the whole JSON response body, and two throws
 *  inside the request attempt interpolate `req.label`, which carries the user's
 *  goal slug. A bare /grammar/ test would therefore re-run the most expensive
 *  call in the system, at full price, for a project whose NAME contained the
 *  word. The class gate is the real guard: a schema rejection is refused before
 *  any tokens generate so the retry is free, while the post-generation throws
 *  are plain Errors, and BadRequestError, RateLimitError and InternalServerError
 *  are siblings under APIError. */
export function isGrammarRejection(err: unknown): boolean {
  return err instanceof Anthropic.BadRequestError && /compiled grammar/i.test(err.message);
}

export class ClaudeProvider implements LlmProvider {
  id = "claude";
  private client: Anthropic;
  private models: Record<LlmRole, string>;

  constructor(opts: ClaudeProviderOptions = {}) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.models = { ...DEFAULT_MODELS, ...opts.models };
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const model = this.models[req.role];
    // `$refStrategy: "none"` inlines every repeated subschema. Without it,
    // zod-to-json-schema emits internal refs pointing at `#/properties/...`,
    // and structured outputs rejects the whole schema: "References must be
    // defined under '$defs' or 'definitions', not 'properties'". The
    // OpenAI-compat adapter has always passed this; this one did not, and the
    // difference stayed invisible because OpenRouter ignores the schema field
    // for Anthropic models and reads the copy embedded in the prompt instead.
    // So the architect schema had never actually been validated by anyone.
    const rawSchema = zodToJsonSchema(req.schema, { target: "jsonSchema7", $refStrategy: "none" });
    const jsonSchema = sanitizeSchema(rawSchema);
    const price = PRICES[model] ?? { in: 5, out: 25 };
    const usage = { inputTokens: 0, outputTokens: 0, usd: 0 };
    /** Set when the API refuses to compile this schema into a grammar. */
    let promptSchema = false;

    const attempt = async (extra?: { assistant: string; user: string }): Promise<string> => {
      // A message with images becomes a content array; without, it stays a
      // plain string so every existing call is byte-identical on the wire.
      const toContent = (m: (typeof req.messages)[number]) =>
        m.images?.length
          ? [
              ...m.images.map((img) => ({
                type: "image" as const,
                source: { type: "base64" as const, media_type: img.mediaType, data: img.dataB64 },
              })),
              { type: "text" as const, text: m.content },
            ]
          : m.content;
      const messages = [
        ...req.messages.map((m) => ({ role: m.role, content: toContent(m) })),
        ...(extra
          ? [
              { role: "assistant" as const, content: extra.assistant },
              { role: "user" as const, content: extra.user },
            ]
          : []),
      ];
      const params: Anthropic.MessageCreateParamsStreaming = {
        model,
        max_tokens: req.maxTokens ?? 16000,
        // GRAMMAR FALLBACK. Structured outputs compiles the schema into a
        // sampling grammar, and rejects one that gets too large: "The compiled
        // grammar is too large". The whole-graph architect schema is exactly
        // that, and it cannot be deduplicated out of the problem, because the
        // compiler expands refs, so hoisting repeats into `$defs` shrinks the
        // document and not the grammar (tried, measured, reverted).
        //
        // So where the grammar will not compile, the schema goes in the prompt
        // and zod validates the reply instead. That is precisely what the
        // OpenAI-compat adapter always does, and how the architect has been
        // running all along, so it costs nothing that was previously working.
        // What it buys is the direct path for the largest call in the system:
        // effort, streaming, and a real price.
        // The PROMPT path gets the unsanitized schema. sanitizeSchema strips
        // minimum/maximum/pattern/minItems/maxItems because structured outputs
        // rejects them, and zod still enforces every one of them client-side.
        // Showing the model the stripped copy hides the constraints it is about
        // to be judged against: the architect caps nodes at .max(15) and the
        // model never saw the 15, so a violation costs a repair round on the
        // most expensive call in the system. Costs ~240 input tokens.
        system: promptSchema
          ? `${req.system}\n\nRespond with ONLY a JSON object matching this schema. No prose, no code fence.\n${JSON.stringify(rawSchema)}`
          : req.system,
        messages,
        stream: true,
        // Omitted entirely when there is nothing to put in it, rather than sent
        // as an empty object.
        ...(req.effort || !promptSchema ? { output_config: {
          // Effort rides alongside the schema in the same block. Left unset it
          // defaults to "high" — which is what made thinking 89-98% of billed
          // output on real projects. Lowering it is preferred over disabling
          // thinking outright: on this model family a disabled-thinking request
          // can write a tool call into visible text or leak reasoning tags.
          ...(req.effort ? { effort: req.effort } : {}),
          ...(promptSchema
            ? {}
            : { format: { type: "json_schema", schema: jsonSchema as Record<string, unknown> } }),
        } } : {}),
      };
      // STREAMING IS NOT OPTIONAL HERE. The SDK refuses a non-streaming request
      // whose max_tokens could outrun the HTTP timeout, and the architect emits
      // a whole graph — it asks for 32000 and got a hard error. Streaming also
      // finally gives `onDelta` something to deliver: the field has been on
      // LlmRequest since the beginning with no adapter behind it, which is why
      // planning showed a dead spinner for the entire call.
      const stream = this.client.messages.stream(params, { signal: req.signal });
      if (req.onDelta) {
        stream.on("text", (delta) => req.onDelta!(delta));
      }
      const response = await stream.finalMessage();
      // Account BEFORE any throw: the API bills a refusal, and returning zero
      // for it puts spend in the ledger that nobody can see.
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      usage.usd +=
        (response.usage.input_tokens * price.in + response.usage.output_tokens * price.out) /
        1_000_000;
      if (response.stop_reason === "refusal") {
        throw new Error(`model refused request "${req.label}"`);
      }
      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") {
        throw new Error(`no text block in response for "${req.label}" (stop: ${response.stop_reason})`);
      }
      return text.text;
    };

    let raw: string;
    try {
      raw = await attempt();
    } catch (err) {
      if (!isGrammarRejection(err)) throw err;
      promptSchema = true;
      raw = await attempt();
    }
    let parsed = this.tryParse(req, raw);
    if (!parsed.success) {
      raw = await attempt({
        assistant: raw,
        user: `Your response failed validation:\n${parsed.error}\nRespond again with ONLY the corrected JSON.`,
      });
      parsed = this.tryParse(req, raw);
      if (!parsed.success) {
        throw new Error(`schema validation failed twice for "${req.label}": ${parsed.error}`);
      }
    }

    return { data: parsed.data, model, usage };
  }

  private tryParse<T>(
    req: LlmRequest<T>,
    raw: string,
  ): { success: true; data: T } | { success: false; error: string } {
    // Tolerate a fenced or prose-wrapped reply, matching the OpenAI-compat
    // adapter. Structured outputs returns bare JSON, so this never mattered
    // here, but the grammar fallback puts the schema in the prompt instead, and
    // a model answering a prompt is free to wrap it in ```json. Without this
    // the fallback pays a whole validation-repair round trip for a code fence.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return {
        success: false,
        error: `no JSON object found in response (raw ${raw.length} chars: ${JSON.stringify(raw.slice(0, 200))})`,
      };
    }
    try {
      const value: unknown = JSON.parse(match[0]);
      const result = req.schema.safeParse(value);
      if (result.success) return { success: true, data: result.data };
      return {
        success: false,
        error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    } catch (err) {
      return { success: false, error: `invalid JSON: ${(err as Error).message}` };
    }
  }
}
