import { spawn } from "node:child_process";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { LlmProvider, LlmRequest, LlmResult, LlmRole, LlmUsage } from "@patchcad/engine";

/**
 * Claude Code in headless mode (`claude -p`) as an LlmProvider, so a cook bills
 * against a Claude subscription instead of an API key.
 *
 * The CLI is spawned per call with its agent nature stripped off: tools
 * disallowed, one turn, no settings / MCP / CLAUDE.md discovery. What is left is
 * a plain completion endpoint that authenticates as the logged-in user.
 *
 * COST HERE IS ATTRIBUTION, NOT SPEND. `total_cost_usd` is list price (the CLI
 * reports costBasis "list") and it includes ~25k tokens of Claude Code's own
 * tool schemas that ride along on every call and cannot be flagged off — only
 * cached, which is why the marginal call reads ~$0.018 rather than ~$0.055. On a
 * subscription none of that is billed, it is quota. The ledger keeps reporting
 * it because "what this would have cost on the API" is the honest number, and a
 * silent $0 is exactly how the OpenRouter cost column became a lie.
 *
 * NO VISION. LlmRequest.images is dropped: the CLI takes one text prompt and
 * every tool that could read a file is disallowed. The interface documents
 * text-only providers as degrading rather than breaking, so inspect.ts still
 * runs, it just judges nothing. Use the API provider for the render->inspect
 * loop.
 */

const DEFAULT_MODELS: Record<LlmRole, string> = {
  architect: "claude-opus-5",
  generator: "claude-sonnet-5",
  repair: "claude-opus-5",
  classifier: "claude-haiku-4-5",
};

export interface ClaudeCliOptions {
  models?: Partial<Record<LlmRole, string>>;
  /** Killed after this long. Opus writing one complex part through the CLI has
   *  been measured past ten minutes (a toy-helicopter fuselage carrying a shell,
   *  a cockpit cutout, skids and two bores timed out at 600s), and a timeout
   *  costs the whole node, so the default is generous. */
  timeoutMs?: number;
  /** Override for a CLI that is not on PATH. */
  bin?: string;
}

type CliResult = {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export class ClaudeCliProvider implements LlmProvider {
  id = "subscription";
  constructor(private opts: ClaudeCliOptions = {}) {}

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const model = this.opts.models?.[req.role] ?? DEFAULT_MODELS[req.role];
    // Same contract as the openai-compat fallback: the schema rides in the
    // prompt, because there is no structured-output channel on a CLI at all.
    const jsonSchema = zodToJsonSchema(req.wireSchema ?? req.schema, { $refStrategy: "none" });
    const system =
      `${req.system}\n\nRespond with ONLY a JSON object (no markdown fences, no prose) ` +
      `matching this JSON Schema:\n${JSON.stringify(jsonSchema)}`;

    const attempt = (extra: string[]) =>
      this.run(
        system,
        [...req.messages.map((m) => (m.role === "user" ? m.content : `[assistant]\n${m.content}`)), ...extra].join(
          "\n\n",
        ),
        model,
        req.signal,
      );

    let out = await attempt([]);
    let parsed = tryParse(req, out.raw);
    if (!parsed.success) {
      // One repair reprompt, carrying the rejected answer so the model can see
      // what it just did rather than guessing from the error alone.
      out = await attempt([
        `[assistant]\n${out.raw}`,
        `Your previous response failed schema validation:\n${parsed.error}\nRespond again with ONLY the corrected JSON.`,
      ]);
      parsed = tryParse(req, out.raw);
      if (!parsed.success) {
        throw new Error(`${this.id}: schema validation failed twice for "${req.label}": ${parsed.error}`);
      }
    }
    return { data: parsed.data, usage: out.usage };
  }

  private run(
    system: string,
    prompt: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ raw: string; usage: LlmUsage }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error(`${this.id}: aborted`));
      const child = spawn(
        this.opts.bin ?? "claude",
        [
          "-p",
          "--output-format", "json",
          "--model", model,
          "--system-prompt", system,
          // Everything below turns the agent back into a completion call.
          "--exclude-dynamic-system-prompt-sections",
          "--setting-sources", "",
          "--strict-mcp-config",
          "--allowedTools", "",
          "--max-turns", "1",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

      let stdout = "";
      let stderr = "";
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        child.kill("SIGKILL");
        cleanup();
        reject(new Error(`${this.id}: aborted`));
      };
      // An unbounded child is how /cook/cancel loses a node forever.
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        cleanup();
        reject(new Error(`${this.id}: timed out after ${this.opts.timeoutMs ?? 1_800_000}ms`));
      }, this.opts.timeoutMs ?? 1_800_000);
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err) => {
        cleanup();
        reject(new Error(`${this.id}: could not spawn "${this.opts.bin ?? "claude"}": ${err.message}`));
      });
      child.on("close", (code) => {
        cleanup();
        if (code !== 0) {
          return reject(new Error(`${this.id}: claude exited ${code}: ${stderr.slice(0, 500)}`));
        }
        let r: CliResult;
        try {
          r = JSON.parse(stdout) as CliResult;
        } catch {
          return reject(new Error(`${this.id}: unparseable CLI output: ${JSON.stringify(stdout.slice(0, 300))}`));
        }
        if (r.is_error) return reject(new Error(`${this.id}: ${r.result ?? "CLI reported an error"}`));
        const u = r.usage ?? {};
        resolve({
          raw: r.result ?? "",
          usage: {
            inputTokens:
              (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            outputTokens: u.output_tokens ?? 0,
            usd: r.total_cost_usd ?? 0,
          },
        });
      });
      child.stdin.end(prompt);
    });
  }
}

/** Fence- and prose-tolerant, because a CLI turn has no JSON mode to enforce:
 *  a plain `claude -p` asked for one object still answered inside ```json. */
export function tryParse<T>(
  req: Pick<LlmRequest<T>, "schema">,
  raw: string,
): { success: true; data: T } | { success: false; error: string } {
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
