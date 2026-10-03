import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ClaudeProvider, costUsd, PRICES, withCacheBreakpoints } from "./index.js";

/** A provider whose SDK client records each request and replays canned replies. */
function stubbed(replies: { text: string; usage: Partial<Anthropic.Usage> }[]) {
  const sent: Anthropic.MessageCreateParamsStreaming[] = [];
  const provider = new ClaudeProvider({ apiKey: "test", models: { repair: "claude-opus-5" } });
  (provider as unknown as { client: unknown }).client = {
    messages: {
      stream: (params: Anthropic.MessageCreateParamsStreaming) => {
        sent.push(params);
        const reply = replies[sent.length - 1]!;
        return {
          finalMessage: async () => ({
            stop_reason: "end_turn",
            content: [{ type: "text", text: reply.text }],
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...reply.usage },
          }),
        };
      },
    },
  };
  return { provider, sent };
}

const repairReq = {
  role: "repair" as const,
  label: "repair:plate",
  system: "You write ONE printed part.",
  messages: [
    { role: "user" as const, content: "Part: plate" },
    { role: "assistant" as const, content: '{"code":"def build(p): ..."}' },
    { role: "user" as const, content: "That code failed gate G3" },
  ],
  schema: z.object({ code: z.string() }),
};

describe("cache breakpoints", () => {
  it("marks the system block and the first message, nothing else", () => {
    const { system, messages } = withCacheBreakpoints("sys", [
      { role: "user", content: "task" },
      { role: "assistant", content: "code" },
      { role: "user", content: "failure" },
    ]);
    expect(system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
    expect(messages[0]!.content).toEqual([{ type: "text", text: "task", cache_control: { type: "ephemeral" } }]);
    // The failed code changes every round, so a marker there is written and never read.
    expect(messages[1]!.content).toBe("code");
    expect(messages[2]!.content).toBe("failure");
  });

  it("marks the LAST block of an image-bearing first message", () => {
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "AA==" } };
    const { messages } = withCacheBreakpoints("sys", [{ role: "user", content: [image, { type: "text", text: "look" }] }]);
    const blocks = messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(blocks[0]).toEqual(image);
    expect(blocks[1]).toMatchObject({ text: "look", cache_control: { type: "ephemeral" } });
  });

  it("uses at most two of the four allowed breakpoints, so a schema retry stays legal", async () => {
    const { provider, sent } = stubbed([
      { text: "not json", usage: {} },
      { text: '{"code":"ok"}', usage: {} },
    ]);
    await provider.complete(repairReq);
    expect(sent).toHaveLength(2);
    for (const params of sent) {
      expect(JSON.stringify(params).match(/cache_control/g)).toHaveLength(2);
      // structured outputs still ride alongside the markers
      expect(params.output_config?.format).toBeDefined();
    }
    // The retry repeats the marked prefix exactly, which is what makes it a read.
    expect(sent[1]!.system).toEqual(sent[0]!.system);
    expect(sent[1]!.messages[0]).toEqual(sent[0]!.messages[0]);
  });

  it("keeps the system prefix identical across repair rounds whatever the failure", async () => {
    const { provider, sent } = stubbed([
      { text: '{"code":"a"}', usage: {} },
      { text: '{"code":"b"}', usage: {} },
    ]);
    await provider.complete(repairReq);
    await provider.complete({
      ...repairReq,
      messages: [repairReq.messages[0]!, { role: "assistant", content: "other" }, { role: "user", content: "G4 escape" }],
    });
    expect(sent[1]!.system).toEqual(sent[0]!.system);
    expect(sent[1]!.messages[0]).toEqual(sent[0]!.messages[0]);
  });
});

describe("cache-aware cost", () => {
  const opus5 = PRICES["claude-opus-5"]!;

  it("prices writes at 1.25× and reads at 0.1× input", () => {
    const usd = costUsd(opus5, {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(5 + 6.25 + 0.5 + 25);
  });

  it("uses a model's own read price where it differs", () => {
    const usd = costUsd(PRICES["claude-opus-5-5"]!, {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 0,
    });
    expect(usd).toBeCloseTo(0.2);
  });

  it("treats null cache fields as zero", () => {
    expect(
      costUsd(opus5, { input_tokens: 1000, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null }),
    ).toBeCloseTo(0.005);
  });

  it("reports the whole prompt as input tokens and breaks out the cached share", async () => {
    const { provider } = stubbed([
      { text: '{"code":"ok"}', usage: { input_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500, output_tokens: 100 } },
    ]);
    const { usage } = await provider.complete(repairReq);
    expect(usage).toMatchObject({ inputTokens: 3700, outputTokens: 100, cacheReadTokens: 3000, cacheWriteTokens: 500 });
    expect(usage.usd).toBeCloseTo((200 * 5 + 500 * 5 * 1.25 + 3000 * 0.5 + 100 * 25) / 1_000_000);
  });
});
