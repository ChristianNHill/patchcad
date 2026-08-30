/**
 * Checks for the subscription provider and vision routing.
 *   pnpm exec tsx src/claude-cli-smoke.ts          # free: parsing + routing
 *   pnpm exec tsx src/claude-cli-smoke.ts --live   # also one real CLI call
 * The paid call is opt-in so a routing regression is catchable for nothing.
 */
import { z } from "zod";
import type { LlmProvider, LlmRequest, LlmResult } from "@patchcad/engine";
import { ClaudeCliProvider, tryParse } from "./claude-cli-provider.js";
import { CompositeProvider } from "./providers.js";

const schema = z.object({ sum: z.number(), word: z.string() });

// --- parsing: fenced output is the observed CLI default, so it must survive.
const fenced = tryParse({ schema }, '```json\n{"sum":7,"word":"ok"}\n```');
if (!fenced.success || fenced.data.sum !== 7) throw new Error(`fenced parse failed: ${JSON.stringify(fenced)}`);
if (tryParse({ schema }, '{"sum":"seven"}').success) throw new Error("expected a validation failure for a string sum");
console.log("tryParse: fenced ok, invalid rejected");

// --- routing: an image must outrank the role map, or inspect ("generator")
// and the render-bearing CAD repair ("repair") silently lose their picture.
const stub = (id: string): LlmProvider => ({
  id,
  complete: <T,>(_req: LlmRequest<T>) => Promise.resolve({ data: id as T, usage: { inputTokens: 0, outputTokens: 0, usd: 0 } } as LlmResult<T>),
});
const text = stub("text");
const eyes = stub("eyes");
const composite = new CompositeProvider(
  { architect: text, generator: text, repair: text, classifier: text },
  eyes,
);
const call = (role: LlmRequest<string>["role"], withImage: boolean) =>
  composite.complete<string>({
    role,
    system: "",
    label: "t",
    schema: z.string(),
    messages: [{ role: "user", content: "x", ...(withImage ? { images: [{ mediaType: "image/png", dataB64: "" }] } : {}) }],
  });

for (const role of ["generator", "repair"] as const) {
  if ((await call(role, true)).data !== "eyes") throw new Error(`${role} WITH an image should route to vision`);
  if ((await call(role, false)).data !== "text") throw new Error(`${role} without an image should follow its role`);
}
if (!composite.id.includes("vision:eyes")) throw new Error(`id should name the vision route: ${composite.id}`);
// No vision configured => images follow the role map rather than throwing.
const noVision = new CompositeProvider({ architect: text, generator: text, repair: text, classifier: text });
if ((await noVision.complete<string>({ role: "generator", system: "", label: "t", schema: z.string(),
    messages: [{ role: "user", content: "x", images: [{ mediaType: "image/png", dataB64: "" }] }] })).data !== "text") {
  throw new Error("with no vision route, an image call should fall back to its role");
}
console.log("routing: images outrank role, absent vision falls back");

if (!process.argv.includes("--live")) {
  console.log("OK (skipped the live call; pass --live to include it)");
  process.exit(0);
}

const res = await new ClaudeCliProvider({ models: { classifier: "claude-haiku-4-5" } }).complete({
  role: "classifier",
  system: "You are a calculator.",
  messages: [{ role: "user", content: 'Set sum to 3+4 and word to "ok".' }],
  schema,
  label: "smoke",
});
if (res.data.sum !== 7) throw new Error(`expected sum 7, got ${res.data.sum}`);
console.log("live call:", res.data, `in=${res.usage.inputTokens} out=${res.usage.outputTokens} usd=${res.usage.usd.toFixed(4)}`);
console.log("OK");
