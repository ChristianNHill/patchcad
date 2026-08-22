import type { z } from "zod";

/**
 * Provider-agnostic LLM interface. Adapters: @patchcad/llm-claude (native,
 * forced tool-use schema) and @patchcad/llm-openai-compat (OpenRouter /
 * Ollama / LM Studio — json_schema mode where supported, schema-in-prompt +
 * validate + one repair reprompt as universal fallback).
 */

export type LlmRole = "architect" | "generator" | "repair" | "classifier";

/** A rendered image attached to a message. Base64 rather than a URL because
 *  the kernel's artifact server is loopback-only — no provider can reach it. */
export interface LlmImage {
  mediaType: "image/png" | "image/jpeg";
  dataB64: string;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
  /** Adapters that support vision send these alongside the text; the rest
   *  ignore them, so a text-only provider degrades rather than breaking. */
  images?: LlmImage[];
}

export interface LlmRequest<T> {
  role: LlmRole;
  system: string;
  messages: LlmMessage[];
  /** Input type is free so schemas with .default() fields still bind T to the OUTPUT type. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Schema for the WIRE (structured outputs grammar), when it must differ from
   *  the validation schema. The CAD architect's payload subtree alone makes the
   *  compiled grammar "too large", so every architect call was silently
   *  grammar-rejected and fell back to prompt-embedded schema — freeform JSON
   *  at temperature 1.0, malformed on ~20-25% of calls. The wire schema types
   *  payload as a JSON STRING (which compiles); `schema` still validates the
   *  real shape after a client-side parse. */
  wireSchema?: z.ZodType<unknown, z.ZodTypeDef, unknown>;
  /** Human label for logs/cost attribution, e.g. "generate:product-grid". */
  label: string;
  maxTokens?: number;
  /**
   * How hard the model should think. Output is billed at 5x input and reasoning
   * tokens come out of the output budget, so on measured CAD projects 89-98% of
   * every billed output token was thinking rather than emitted code. Unset means
   * the provider's default, which is the highest setting.
   *
   * A provider that has no such control ignores this, like the rest of the
   * optional fields here.
   */
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
}

export interface LlmProvider {
  id: string;
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}
