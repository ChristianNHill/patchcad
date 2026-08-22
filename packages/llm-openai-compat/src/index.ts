import { zodToJsonSchema } from "zod-to-json-schema";
import type { LlmProvider, LlmRequest, LlmResult, LlmRole } from "@patchcad/engine";

/**
 * OpenAI-compatible adapter — one implementation covers OpenRouter, Ollama,
 * LM Studio, vLLM, and most hosted providers. Schema enforcement: native
 * response_format json_schema where the server supports it, with a
 * schema-in-prompt + validate + one-repair-reprompt universal fallback.
 */

export interface OpenAiCompatOptions {
  /** e.g. "https://openrouter.ai/api/v1" or "http://localhost:11434/v1" */
  baseUrl: string;
  apiKey?: string;
  models: Partial<Record<LlmRole, string>> & { generator: string };
  /** Server supports response_format: json_schema (OpenRouter: per-model). */
  nativeJsonSchema?: boolean;
  /** Wall-clock ceiling per request, milliseconds. Default 300000.
   *
   *  This path had NONE. `signal` is forwarded, so a caller who cancels is
   *  fine, but a stalled connection with nobody watching hangs the cook
   *  forever: no error, no timeout, a node stuck in `generating` until the
   *  process dies. Generous by design, because the calls it bounds are slow —
   *  a measured architect plan took 80.9s and a cook 100.9s — so this is a
   *  hang-breaker and not a latency budget. */
  timeoutMs?: number;
  /** USD per MTok for cost attribution; 0 for local models. Used only when
   *  `prices` has no entry for the model in play. */
  price?: { in: number; out: number };
  /** Per-model prices per MTok, keyed by the model id as configured. A single
   *  flat rate is wrong the moment roles run on different models — pricing a
   *  haiku classifier at opus rates overstated it 5x — and per-role model
   *  overrides are the documented way to change them. */
  prices?: Record<string, { in: number; out: number }>;
}

interface ChatResponse {
  choices: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  model?: string;
}

export class OpenAiCompatProvider implements LlmProvider {
  id: string;
  private opts: OpenAiCompatOptions;

  constructor(id: string, opts: OpenAiCompatOptions) {
    this.id = id;
    this.opts = opts;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const model = this.opts.models[req.role] ?? this.opts.models.generator;
    // Fully inline — local grammar converters (Ollama/llama.cpp) don't resolve $refs.
    const jsonSchema = zodToJsonSchema(req.wireSchema ?? req.schema, { $refStrategy: "none" });

    const attempt = async (extraUser?: string): Promise<{ raw: string; usage: ChatResponse["usage"] }> => {
      // OpenAI's vision shape: a content array of {type:"text"} and
      // {type:"image_url"} parts, the image inlined as a data: URI. Messages
      // without images keep the plain-string form.
      const toMessage = (m: (typeof req.messages)[number]) =>
        m.images?.length
          ? {
              role: m.role,
              content: [
                ...m.images.map((img) => ({
                  type: "image_url" as const,
                  image_url: { url: `data:${img.mediaType};base64,${img.dataB64}` },
                })),
                { type: "text" as const, text: m.content },
              ],
            }
          : m;
      const messages = [
        { role: "system", content: this.systemWithSchema(req.system, jsonSchema) },
        ...req.messages.map(toMessage),
        ...(extraUser ? [{ role: "user" as const, content: extraUser }] : []),
      ];
      // Reasoning models spend output budget thinking BEFORE the JSON comes
      // out; a tight cap yields an empty content field, so default generous.
      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: req.maxTokens ?? 32000,
      };
      if (this.opts.nativeJsonSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "result", schema: jsonSchema, strict: true },
        };
      }
      // A timeout of its own, combined with the caller's signal rather than
      // replacing it: cancelling a cook must still work, and a stall must not
      // depend on someone noticing.
      //
      // It covers the BODY READ too, which I assumed it did not. undici ties the
      // signal to the whole response, so a server that sends headers and then
      // stalls mid-body aborts res.json() on the same timer. Measured: headers
      // with no body and a 1s ceiling threw after 1010ms with a TimeoutError.
      // Worth stating, because "the timeout only covers the fetch" is the
      // plausible-sounding wrong answer.
      const ms = this.opts.timeoutMs ?? 300_000;
      const bound = AbortSignal.timeout(ms);
      const signal = req.signal ? AbortSignal.any([req.signal, bound]) : bound;
      let res: Response;
      try {
        res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        // A timeout and a cancel both surface as an abort, and they mean
        // opposite things: one is the server not answering, the other is the
        // user changing their mind. Reporting them identically would send
        // someone hunting a bug in their own cancel path.
        if (bound.aborted) {
          throw new Error(`${this.id}: no response for "${req.label}" within ${ms}ms — the request was abandoned, not refused`);
        }
        throw err;
      }
      if (!res.ok) {
        throw new Error(`${this.id} ${res.status}: ${(await res.text()).slice(0, 400)}`);
      }
      const data = (await res.json()) as ChatResponse;
      return { raw: data.choices[0]?.message.content ?? "", usage: data.usage };
    };

    let { raw, usage } = await attempt();
    let parsed = this.tryParse(req, raw);
    if (!parsed.success) {
      // One repair reprompt with the validation error.
      ({ raw, usage } = await attempt(
        `Your previous response failed schema validation:\n${parsed.error}\nRespond again with ONLY the corrected JSON.`,
      ));
      parsed = this.tryParse(req, raw);
      if (!parsed.success) {
        throw new Error(`${this.id}: schema validation failed twice for "${req.label}": ${parsed.error}`);
      }
    }

    const price =
      this.opts.prices?.[model] ?? this.opts.price ?? { in: 0, out: 0 };
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    return {
      data: parsed.data,
      usage: {
        inputTokens,
        outputTokens,
        usd: (inputTokens * price.in + outputTokens * price.out) / 1_000_000,
      },
    };
  }

  private systemWithSchema(system: string, schema: unknown): string {
    // The schema ALWAYS rides in the prompt: response_format json_schema is
    // silently ignored by some servers for some models (OpenRouter does not
    // enforce it for Anthropic models, for one), and a model that never saw
    // the schema invents its own field layout. Where the server does enforce
    // it, the two reinforce each other.
    return `${system}\n\nRespond with ONLY a JSON object (no markdown fences, no prose) matching this JSON Schema:\n${JSON.stringify(schema)}`;
  }

  private tryParse<T>(
    req: LlmRequest<T>,
    raw: string,
  ): { success: true; data: T } | { success: false; error: string } {
    // Tolerate fenced or prose-wrapped JSON from weaker models.
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
      return { success: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    } catch (err) {
      return { success: false, error: `invalid JSON: ${(err as Error).message}` };
    }
  }
}
