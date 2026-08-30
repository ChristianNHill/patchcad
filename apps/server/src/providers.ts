import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { LlmProvider, LlmRequest, LlmResult, LlmRole } from "@patchcad/engine";
import { ClaudeProvider, PRICES } from "@patchcad/llm-claude";
import { OpenAiCompatProvider } from "@patchcad/llm-openai-compat";
import { ClaudeCliProvider } from "./claude-cli-provider.js";

/**
 * Provider resolution, in order:
 *  1. ~/.patchcad/config.json `routing` map → per-role providers composed
 *     (the hosted-architect + local-generators hybrid). A per-role map is a
 *     deliberate statement and outranks the ambient env keys below; an exported
 *     key used to shadow it silently, which read as "my config does nothing".
 *     If its providers lack credentials, this warns and falls through rather
 *     than failing the boot.
 *  2. ANTHROPIC_API_KEY env (or `ant auth` ambient credentials) → Claude.
 *  3. OPENROUTER_API_KEY env → OpenRouter on the default model set.
 *  4. ~/.patchcad/config.json with no `routing` map → the first configured
 *     entry wins: claude | openrouter | local.
 * Steps 2 and 3 are the first-run escape hatch: they exist so a fresh install
 * needs no config file at all.
 * Returns null when nothing is configured; planning endpoints then explain
 * how to set a key instead of failing cryptically.
 */

const ProviderName = z.enum(["claude", "openrouter", "local", "subscription"]);

/** The same list prices, keyed by OpenRouter's slugs. DERIVED from the one
 *  table rather than re-typed beside it: two hand-maintained copies of the same
 *  numbers drift into a silently wrong cost ledger, not a crash. Attribution
 *  only — OpenRouter's own margin is not modelled, and an unlisted model falls
 *  back to the opus rate so it reads high rather than free. */
const OPENROUTER_PRICES: Record<string, { in: number; out: number }> = {
  ...Object.fromEntries(Object.entries(PRICES).map(([m, p]) => [`anthropic/${m}`, p])),
  // OpenRouter spells this one with a dot where the Anthropic API uses a dash.
  "anthropic/claude-haiku-4.5": PRICES["claude-haiku-4-5"]!,
};

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
      /** Handed every call that carries an image, whatever its role. Omit and
       *  image calls follow their role, losing the attachment on a text-only
       *  provider. */
      vision: ProviderName.optional(),
    })
    .optional(),
  claude: z.object({ apiKey: z.string().optional(), models: RoleModels.optional() }).optional(),
  /** Claude Code headless — bills the logged-in subscription, needs no key. */
  subscription: z
    .object({ models: RoleModels.optional(), bin: z.string().optional(), timeoutMs: z.number().optional() })
    .optional(),
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
export class CompositeProvider implements LlmProvider {
  id = "composite";
  constructor(
    private routes: Record<LlmRole, LlmProvider>,
    /** Takes any call carrying an image, whatever its role. */
    private vision?: LlmProvider,
  ) {
    const ids = [...new Set(Object.values(routes).map((p) => p.id))];
    const extra = vision && !ids.includes(vision.id) ? `+vision:${vision.id}` : "";
    this.id = `composite(${ids.join("+")}${extra})`;
  }
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    // IMAGES OUTRANK ROLE, because neither vision call is reachable by a role
    // map: inspectNode runs as "generator" (deliberately — it is triage, not
    // repair) and the CAD repair prompt attaches a render under "repair". A
    // provider that cannot see drops the attachment SILENTLY and answers about
    // a picture it never received, which reads as a model being stupid rather
    // than a router being wrong. So route on the capability the call needs.
    if (this.vision && req.messages.some((m) => m.images?.length)) return this.vision.complete(req);
    return this.routes[req.role].complete(req);
  }
}

function buildEntry(name: z.infer<typeof ProviderName>, config: Config): LlmProvider {
  if (name === "claude") {
    if (!config.claude?.apiKey) throw new Error(`routing references "claude" but no claude.apiKey is set`);
    // ClaudeProvider fills any role omitted here from its own defaults.
    return new ClaudeProvider({ apiKey: config.claude.apiKey, models: config.claude.models });
  }
  if (name === "subscription") {
    // No credential check: the CLI carries the user's own login, so there is
    // nothing in the config that can be missing. A CLI that is absent or
    // logged out surfaces on the first spawn, with its own message.
    return new ClaudeCliProvider(config.subscription ?? {});
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
      // WITHOUT THIS EVERY CALL REPORTS $0. The adapter falls back to a zero
      // price when none is passed, so the token counters were right and the
      // dollar column was a lie — every project on disk reads $0.000 against
      // tens of thousands of tokens, which is why the cost chip was never worth
      // looking at. Priced per model, not flat: roles run on different models by
      // design, and one rate for all of them priced the haiku classifier at opus
      // rates. The flat `price` stays as the fallback for a model pinned through
      // `openrouter.models` that isn't listed here — deliberately the expensive
      // guess, so an unknown model overstates rather than disappears.
      prices: OPENROUTER_PRICES,
      price: { in: 5, out: 25 },
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

/** The per-role routing map, if the config declares one. Separate from
 *  resolveProvider so it can be consulted BEFORE the ambient env hatches. */
async function readRouting(
  configPath: string,
): Promise<{ provider: LlmProvider; source: string } | null> {
  let config: z.infer<typeof ConfigSchema>;
  try {
    config = ConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  } catch {
    // A malformed config is reported by the caller's own parse below, which
    // still runs; staying quiet here avoids warning twice about one file.
    return null;
  }
  if (!config.routing) return null;
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
  try {
    return {
      provider: new CompositeProvider(
        {
          architect: get(names.architect),
          generator: get(names.generator),
          repair: get(names.repair),
          classifier: get(names.classifier),
        },
        r.vision ? get(r.vision) : undefined,
      ),
      source: `${configPath} (routing)`,
    };
  } catch (err) {
    // A ROUTING MAP MISSING ITS CREDENTIALS MUST NOT STOP THE SERVER BOOTING.
    // `buildEntry` throws when a routed provider has no key, and the only caller
    // of resolveProvider awaits it un-caught at startup — so the perfectly
    // ordinary arrangement of "routing in the config file, secret in the shell"
    // took the whole server down rather than falling through to the env hatch
    // that used to serve it. Warn loudly (the map is what the user asked for, so
    // silently using something else is its own trap) and let resolution
    // continue.
    console.warn(
      `[patchcad] routing map in ${configPath} is unusable: ${(err as Error).message}` +
        ` — falling back to environment credentials`,
    );
    return null;
  }
}

export async function resolveProvider(
  configPath = path.join(os.homedir(), ".patchcad", "config.json"),
): Promise<{ provider: LlmProvider; source: string } | null> {
  // AN EXPLICIT ROUTING MAP OUTRANKS AMBIENT ENV KEYS. The env hatches below
  // exist so a first run needs no config file at all; they were never meant to
  // override a config that names a provider per role. They did: a stale
  // OPENROUTER_API_KEY left in a shell profile silently shadowed a freshly
  // written routing map, and the only clue was one line of startup log — the
  // symptom being every request going to the provider the config had just been
  // edited to stop using. A per-role map is a deliberate statement; an
  // exported key is ambient, so the map wins.
  const routed = existsSync(configPath) ? await readRouting(configPath) : null;
  if (routed) return routed;

  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: new ClaudeProvider(), source: "env:ANTHROPIC_API_KEY" };
  }

  // The same escape hatch for OpenRouter, so a first run needs no config file
  // at all — creating ~/.patchcad/config.json by hand is the step people get
  // wrong (wrong directory, Notepad saving .txt, a UTF-8 BOM breaking parse).
  if (process.env.OPENROUTER_API_KEY) {
    return {
      provider: buildEntry("openrouter", { openrouter: { apiKey: process.env.OPENROUTER_API_KEY } }),
      source: "env:OPENROUTER_API_KEY",
    };
  }

  if (existsSync(configPath)) {
    try {
      const config = ConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
      // A routing map was already handled above, before the env hatches.
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
  "No LLM provider configured. Either export ANTHROPIC_API_KEY or OPENROUTER_API_KEY, or create ~/.patchcad/config.json with " +
  '{"claude":{"apiKey":"sk-ant-..."}} or {"openrouter":{"apiKey":"sk-or-..."}} or {"local":{"baseUrl":"http://localhost:11434/v1","model":"qwen3-coder"}}.';
