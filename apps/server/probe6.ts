import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { z } from "zod";
import { makeArchitectSchema } from "@patchcad/engine";
import { CadContractPayload } from "@patchcad/backend-cad";
import { ClaudeProvider } from "../../packages/llm-claude/src/index.js";

const cfg = JSON.parse(readFileSync(`${homedir()}/.patchcad/config.json`, "utf8"));
const p = new ClaudeProvider({ apiKey: cfg.claude.apiKey, models: cfg.claude.models });
const schema = makeArchitectSchema(CadContractPayload as unknown as z.ZodType<unknown>, ["part", "fastener"]);
const goal = "a wall bracket for a 60mm fan, bolted to a 2020 extrusion rail";

for (const effort of ["high", "medium"] as const) {
  const t0 = Date.now();
  const r = await p.complete({
    role: "architect", label: `arch-${effort}`,
    system: "You plan 3d-printed parts as a graph of nodes with pinned interface contracts.",
    messages: [{ role: "user", content: `Goal: ${goal}` }],
    schema, maxTokens: 24000, effort,
  });
  const d = r.data as { nodes: unknown[] };
  console.log(
    `effort=${effort.padEnd(6)} ${((Date.now() - t0) / 1000).toFixed(1)}s  nodes=${d.nodes.length}  ` +
    `in=${r.usage.inputTokens} out=${r.usage.outputTokens}  usd=$${r.usage.usd.toFixed(4)}`,
  );
}
