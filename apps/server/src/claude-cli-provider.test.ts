import path from "node:path";
import os from "node:os";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmCallError } from "@patchcad/engine";
import { ClaudeCliProvider, parseCliOutput, tryParse, usageOf } from "./claude-cli-provider.js";

const schema = z.object({ code: z.string() });

describe("tryParse", () => {
  it.each([
    ["bare JSON", '{"code":"x"}', true],
    ["fenced JSON", '```json\n{"code":"x"}\n```', true],
    ["JSON inside prose", 'Here it is: {"code":"x"} hope that helps', true],
    ["no object", "I cannot do that", false],
    ["invalid JSON", "{code: x}", false],
    ["wrong shape", '{"code":1}', false],
  ])("%s", (_name, raw, ok) => {
    const r = tryParse({ schema }, raw);
    expect(r.success).toBe(ok);
    if (r.success) expect(r.data).toEqual({ code: "x" });
  });
});

describe("parseCliOutput", () => {
  const result = { type: "result", result: '{"code":"x"}', total_cost_usd: 0.02, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } };

  it("reads the whole of stdout in json mode", () => {
    expect(parseCliOutput(JSON.stringify(result), false)?.result).toBe('{"code":"x"}');
  });

  it("reads the last result event in stream-json mode", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
      JSON.stringify(result),
      "",
    ].join("\n");
    const r = parseCliOutput(stdout, true);
    expect(r?.result).toBe('{"code":"x"}');
    expect(usageOf(r!)).toEqual({ inputTokens: 100, outputTokens: 5, usd: 0.02 });
  });

  it("is undefined for output it cannot read", () => {
    expect(parseCliOutput("Error: not logged in", false)).toBeUndefined();
    expect(parseCliOutput(JSON.stringify({ type: "system" }), true)).toBeUndefined();
  });
});

describe("ClaudeCliProvider", () => {
  /** A fake `claude` that answers garbage first, then fails with a cost. */
  async function fakeCli(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "patchcad-cli-"));
    const bin = path.join(dir, "claude");
    await writeFile(
      bin,
      `#!/bin/sh
cat > /dev/null
if [ -f "${dir}/called" ]; then
  echo '{"is_error":true,"subtype":"error_during_execution","total_cost_usd":0.2,"usage":{"input_tokens":20,"output_tokens":2}}'
  exit 1
fi
touch "${dir}/called"
echo '{"result":"no json here","total_cost_usd":0.1,"usage":{"input_tokens":10,"output_tokens":1}}'
`,
    );
    await chmod(bin, 0o755);
    return bin;
  }

  it("keeps the first attempt's usage when the repair attempt throws", async () => {
    const provider = new ClaudeCliProvider({ bin: await fakeCli() });
    const err = await provider
      .complete({ role: "generator", system: "s", label: "t", schema, messages: [{ role: "user", content: "go" }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect(err.message).toMatch(/error_during_execution/);
    expect(err.usage.usd).toBeCloseTo(0.3);
    expect(err.usage.inputTokens).toBe(30);
  });

  /** A fake vision `claude` that runs out of turns first, then answers; it
   *  records its --max-turns so the test can see what it was given. */
  async function maxTurnsCli(): Promise<{ bin: string; dir: string }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "patchcad-cli-"));
    const bin = path.join(dir, "claude");
    await writeFile(
      bin,
      `#!/bin/sh
cat > /dev/null
while [ $# -gt 0 ]; do [ "$1" = "--max-turns" ] && echo "$2" >> "${dir}/turns"; shift; done
if [ -f "${dir}/called" ]; then
  echo '{"type":"result","result":"{\\"code\\":\\"x\\"}","total_cost_usd":0.2,"usage":{"input_tokens":20,"output_tokens":2}}'
  exit 0
fi
touch "${dir}/called"
echo '{"type":"result","is_error":true,"subtype":"error_max_turns","total_cost_usd":0.1,"usage":{"input_tokens":10,"output_tokens":1}}'
exit 1
`,
    );
    await chmod(bin, 0o755);
    return { bin, dir };
  }

  it("gives an image call three turns and retries error_max_turns once, billing both", async () => {
    const { bin, dir } = await maxTurnsCli();
    const provider = new ClaudeCliProvider({ bin });
    const out = await provider.complete({
      role: "generator",
      system: "s",
      label: "t",
      schema,
      messages: [{ role: "user", content: "go", images: [{ mediaType: "image/png", dataB64: "AA==" }] }],
    });
    expect(out.data).toEqual({ code: "x" });
    expect(out.usage.usd).toBeCloseTo(0.3);
    expect(out.usage.inputTokens).toBe(30);
    expect((await readFile(path.join(dir, "turns"), "utf8")).trim().split("\n")).toEqual(["3", "3"]);
  });
});
