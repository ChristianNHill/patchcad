import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { LlmProvider, LlmRequest, LlmResult, LlmRole } from "@patchcad/engine";
import { ClaudeProvider } from "@patchcad/llm-claude";
import { OpenAiCompatProvider } from "@patchcad/llm-openai-compat";

/**
 * Provider resolution, in order:
 *  1. ANTHROPIC_API_KEY env (or `ant auth` ambient credentials) → Claude.
 *  2. ~/.patchcad/config.json → a `routing` map composes per-role providers
 *     (the hosted-architect + local-generators hybrid); otherwise the first
 *     configured entry wins: claude | openrouter | local.
 * Returns null when nothing is configured; planning endpoints then explain
 * how to set a key instead of failing cryptically.
 */

const ProviderName = z.enum(["claude", "openrouter", "local"]);

/** Per-role model overrides. Every role is optional; an omitted role falls back
 * to the provider's own default (see buildEntry), so a config can pin just the
 * generator and leave architect/repair/classifier alone. */
const RoleModels = z
  .object({
    architect: z.string(),
    generator: z.string(),
    repair: z.string(),
    classifier: z.string(),
  })
  .partial();

const ConfigSchema = z.object({
  /** Per-role provider routing, e.g. {"architect":"claude","generator":"local"}.
   * repair defaults to the architect's provider (escalation), classifier to
   * the generator's. Referenced entries must be configured below. */
  routing: z
    .object({
      architect: ProviderName,
      generator: ProviderName,
      repair: ProviderName.optional(),
      classifier: ProviderName.optional(),
    })
    .optional(),
  claude: z.object({ apiKey: z.string().optional(), models: RoleModels.optional() }).optional(),
  openrouter: z.object({ apiKey: z.string(), models: RoleModels.optional() }).optional(),
  local: z
    .object({
      baseUrl: z.string(),
      /** Default model for every role; `models` overrides individual roles. */
      model: z.string(),
      models: RoleModels.optional(),
      /** Ollama ≥0.5 enforces json_schema via grammar-constrained decoding. */
      nativeJsonSchema: z.boolean().default(true),
    })
    .optional(),
});

type Config = z.infer<typeof ConfigSchema>;

/** Routes each request to the provider configured for its role. */
class CompositeProvider implements LlmProvider {
  id = "composite";
  constructor(private routes: Record<LlmRole, LlmProvider>) {
    this.id = `composite(${[...new Set(Object.values(routes).map((p) => p.id))].join("+")})`;
  }
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    return this.routes[req.role].complete(req);
  }
}

function buildEntry(name: z.infer<typeof ProviderName>, config: Config): LlmProvider {
  if (name === "claude") {
    if (!config.claude?.apiKey) throw new Error(`routing references "claude" but no claude.apiKey is set`);
    // ClaudeProvider fills any role omitted here from its own defaults.
    return new ClaudeProvider({ apiKey: config.claude.apiKey, models: config.claude.models });
  }
  if (name === "openrouter") {
    if (!config.openrouter) throw new Error(`routing references "openrouter" but it is not configured`);
    const m = config.openrouter.models;
    return new OpenAiCompatProvider("openrouter", {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: config.openrouter.apiKey,
      nativeJsonSchema: true,
      models: {
        architect: m?.architect ?? "anthropic/claude-opus-5",
        generator: m?.generator ?? "anthropic/claude-sonnet-5",
        repair: m?.repair ?? m?.generator ?? "anthropic/claude-sonnet-5",
        classifier: m?.classifier ?? "anthropic/claude-haiku-4.5",
      },
    });
  }
  if (!config.local) throw new Error(`routing references "local" but it is not configured`);
  return new OpenAiCompatProvider("local", {
    baseUrl: config.local.baseUrl,
    nativeJsonSchema: config.local.nativeJsonSchema,
    // Unset roles fall through to `generator` inside the adapter, so `model`
    // stays the single-model shorthand it has always been.
    models: { ...config.local.models, generator: config.local.models?.generator ?? config.local.model },
    price: { in: 0, out: 0 },
  });
}

export async function resolveProvider(
  configPath = path.join(os.homedir(), ".patchcad", "config.json"),
): Promise<{ provider: LlmProvider; source: string } | null> {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: new ClaudeProvider(), source: "env:ANTHROPIC_API_KEY" };
  }

  if (existsSync(configPath)) {
    try {
      const config = ConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
      if (config.routing) {
        const r = config.routing;
        const names = {
          architect: r.architect,
          generator: r.generator,
          repair: r.repair ?? r.architect, // escalation defaults to the strong provider
          classifier: r.classifier ?? r.generator,
        };
        // One instance per distinct provider name, shared across roles.
        const instances = new Map<string, LlmProvider>();
        const get = (name: z.infer<typeof ProviderName>) => {
          if (!instances.has(name)) instances.set(name, buildEntry(name, config));
          return instances.get(name)!;
        };
        return {
          provider: new CompositeProvider({
            architect: get(names.architect),
            generator: get(names.generator),
            repair: get(names.repair),
            classifier: get(names.classifier),
          }),
          source: `${configPath} (routing)`,
        };
      }
      // No routing map: the first configured provider wins. buildEntry is the
      // only construction path, so a routed and an unrouted config of the same
      // provider can never drift apart (model overrides included).
      for (const name of ProviderName.options) {
        const configured = name === "claude" ? !!config.claude?.apiKey : !!config[name];
        if (configured) return { provider: buildEntry(name, config), source: configPath };
      }
    } catch (err) {
      console.warn(`[patchcad] ignoring invalid ${configPath}: ${(err as Error).message}`);
    }
  }

  // Ambient `ant auth login` credentials also work with a bare client.
  if (existsSync(path.join(os.homedir(), ".config", "anthropic"))) {
    try {
      return { provider: new ClaudeProvider(), source: "anthropic profile" };
    } catch {
      /* fall through */
    }
  }
  return null;
}

export const NO_PROVIDER_HELP =
  "No LLM provider configured. Either export ANTHROPIC_API_KEY, or create ~/.patchcad/config.json with " +
  '{"claude":{"apiKey":"sk-ant-..."}} or {"openrouter":{"apiKey":"sk-or-..."}} or {"local":{"baseUrl":"http://localhost:11434/v1","model":"qwen3-coder"}}.';
