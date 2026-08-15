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
  if (obj.type === "object") obj.additionalProperties = false;
  for (const [k, v] of Object.entries(obj)) obj[k] = sanitizeSchema(v);
  return obj;
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
    const jsonSchema = sanitizeSchema(zodToJsonSchema(req.schema, { target: "jsonSchema7" }));
    const price = PRICES[model] ?? { in: 5, out: 25 };
    const usage = { inputTokens: 0, outputTokens: 0, usd: 0 };

    const attempt = async (extra?: { assistant: string; user: string }): Promise<string> => {
      const messages = [
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(extra
          ? [
              { role: "assistant" as const, content: extra.assistant },
              { role: "user" as const, content: extra.user },
            ]
          : []),
      ];
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages,
        output_config: {
          format: { type: "json_schema", schema: jsonSchema as Record<string, unknown> },
        },
      };
      const response = await this.client.messages.create(params, { signal: req.signal });
      if (response.stop_reason === "refusal") {
        throw new Error(`model refused request "${req.label}"`);
      }
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      usage.usd +=
        (response.usage.input_tokens * price.in + response.usage.output_tokens * price.out) /
        1_000_000;
      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") {
        throw new Error(`no text block in response for "${req.label}" (stop: ${response.stop_reason})`);
      }
      return text.text;
    };

    let raw = await attempt();
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
    try {
      const value: unknown = JSON.parse(raw);
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
