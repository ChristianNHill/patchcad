import { spawn } from "node:child_process";
import { zodToJsonSchema } from "zod-to-json-schema";
import { LlmCallError, type LlmImage, type LlmProvider, type LlmRequest, type LlmResult, type LlmRole, type LlmUsage } from "@patchcad/engine";
import { addUsage } from "./spend.js";

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
 * VISION, BY WAY OF READ. A call carrying images switches to stream-json input
 * so the images ride as content blocks. The CLI does not hand them to the model
 * inline: it saves each to a temp file and the model opens it with its Read
 * tool. So an image call gets exactly that one tool and two turns (read, then
 * answer). With one turn it ended `error_max_turns` on the tool_use and never
 * answered. Text-only calls keep the plain single-turn path.
 */

const DEFAULT_MODELS: Record<LlmRole, string> = {
  architect: "claude-opus-5-5",
  generator: "claude-opus-5-5",
  repair: "claude-opus-5-5",
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

export type CliResult = {
  is_error?: boolean;
  subtype?: string;
  errors?: string[];
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

    const images = req.messages.flatMap((m) => m.images ?? []);
    const attempt = (extra: string[]) =>
      this.run(
        system,
        [...req.messages.map((m) => (m.role === "user" ? m.content : `[assistant]\n${m.content}`)), ...extra].join(
          "\n\n",
        ),
        model,
        images,
        req.effort,
        req.signal,
      );

    let out = await attempt([]);
    let parsed = tryParse(req, out.raw);
    if (!parsed.success) {
      // One repair reprompt, carrying the rejected answer so the model can see
      // what it just did rather than guessing from the error alone.
      const first = { calls: 1, ...out.usage };
      try {
        out = await attempt([
          `[assistant]\n${out.raw}`,
          `Your previous response failed schema validation:\n${parsed.error}\nRespond again with ONLY the corrected JSON.`,
        ]);
      } catch (err) {
        // The first attempt was billed too; a throw here must not drop it.
        throw new LlmCallError((err as Error).message, addUsage(first, (err instanceof LlmCallError && err.usage) || ZERO), { cause: err });
      }
      out = { ...out, usage: addUsage(first, out.usage) };
      parsed = tryParse(req, out.raw);
      if (!parsed.success) {
        throw new LlmCallError(`${this.id}: schema validation failed twice for "${req.label}": ${parsed.error}`, out.usage);
      }
    }
    return { data: parsed.data, usage: out.usage };
  }

  private run(
    system: string,
    prompt: string,
    model: string,
    images: LlmImage[],
    effort: LlmRequest<unknown>["effort"],
    signal?: AbortSignal,
  ): Promise<{ raw: string; usage: LlmUsage }> {
    const vision = images.length > 0;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error(`${this.id}: aborted`));
      const child = spawn(
        this.opts.bin ?? "claude",
        [
          "-p",
          ...(vision
            ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
            : ["--output-format", "json"]),
          "--model", model,
          // Escalation lives in effort; there is no CLI flag for an output ceiling.
          ...(effort ? ["--effort", effort] : []),
          "--system-prompt", system,
          // Everything below turns the agent back into a completion call.
          "--exclude-dynamic-system-prompt-sections",
          "--setting-sources", "",
          "--strict-mcp-config",
          // `--tools` REMOVES tools; `--allowedTools ""` only skipped the
          // permission prompt, so Opus still reached for Bash (to check the
          // build123d version), was denied, and ended `error_max_turns`.
          ...(vision ? ["--tools", "Read", "--max-turns", "2"] : ["--tools", "", "--max-turns", "1"]),
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
        // The diagnosis is on STDOUT even on a non-zero exit (subtype, errors,
        // cost); stderr is usually empty. Parse it first so a failure says why
        // and still bills what it spent.
        const r = parseCliOutput(stdout, vision);
        const usage = r ? usageOf(r) : undefined;
        if (code !== 0 || !r || r.is_error) {
          const why = r
            ? [r.subtype, ...(r.errors ?? []), r.is_error ? r.result : undefined].filter(Boolean).join(": ")
            : `unparseable CLI output: ${JSON.stringify(stdout.slice(0, 300))}`;
          return reject(
            new LlmCallError(`${this.id}: claude exited ${code}: ${why || stderr.slice(0, 500) || "no detail"}`, usage),
          );
        }
        resolve({ raw: r.result ?? "", usage: usage! });
      });
      child.stdin.end(
        vision
          ? JSON.stringify({
              type: "user",
              message: {
                role: "user",
                content: [
                  ...images.map((i) => ({
                    type: "image",
                    source: { type: "base64", media_type: i.mediaType, data: i.dataB64 },
                  })),
                  { type: "text", text: prompt },
                ],
              },
            }) + "\n"
          : prompt,
      );
    });
  }
}

export function usageOf(r: CliResult): LlmUsage {
  const u = r.usage ?? {};
  return {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    usd: r.total_cost_usd ?? 0,
  };
}

/** The CLI's result object: the whole of stdout for `json`, the last `result`
 *  event for `stream-json` (one event per line). Undefined when unparseable. */
export function parseCliOutput(stdout: string, streamJson: boolean): CliResult | undefined {
  try {
    return streamJson
      ? (JSON.parse(stdout.trim().split("\n").reverse().find((l) => l.includes('"type":"result"')) ?? "") as CliResult)
      : (JSON.parse(stdout) as CliResult);
  } catch {
    return undefined;
  }
}

const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, usd: 0 };

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
