import type { z } from "zod";

/**
 * Provider-agnostic LLM interface. Adapters: @patchcad/llm-claude (native,
 * forced tool-use schema) and @patchcad/llm-openai-compat (OpenRouter /
 * Ollama / LM Studio — json_schema mode where supported, schema-in-prompt +
 * validate + one repair reprompt as universal fallback).
 */

export type LlmRole = "architect" | "generator" | "repair" | "classifier";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest<T> {
  role: LlmRole;
  system: string;
  messages: LlmMessage[];
  /** Input type is free so schemas with .default() fields still bind T to the OUTPUT type. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Human label for logs/cost attribution, e.g. "generate:product-grid". */
  label: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
  model: string;
}

export interface LlmProvider {
  id: string;
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

/** Role → model routing, config-overridable. */
export interface ModelRouting {
  architect: { provider: string; model: string };
  generator: { provider: string; model: string };
  repairEscalation: { provider: string; model: string };
  classifier: { provider: string; model: string };
}

export const DEFAULT_ROUTING: ModelRouting = {
  architect: { provider: "claude", model: "claude-opus-5" },
  generator: { provider: "claude", model: "claude-sonnet-5" },
  repairEscalation: { provider: "claude", model: "claude-opus-5" },
  classifier: { provider: "claude", model: "claude-haiku-4-5" },
};
