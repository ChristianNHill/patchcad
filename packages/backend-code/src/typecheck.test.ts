import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { extractDts, typecheckNode } from "./typecheck.js";

/** The design-tokens regression: a consumer reading an inner member the
 * provider does not have must FAIL verification once the provider's real
 * .d.ts is known — any-stubs let exactly this crash reach the browser. */

// anchor inside the repo so react types resolve up the tree
const wsRoot = mkdtempSync(path.join(path.resolve(__dirname, "..", ".."), "backend-code", ".test-ws-"));
const ws = { root: wsRoot };
afterAll(() => rmSync(wsRoot, { recursive: true, force: true }));

const TOKENS_CODE = `export const tokens = {
  color: { bg: "#111", text: "#eee" },
  space: (n: number) => n * 4,
};
`;

function makeGraph(consumerCode: string, tokensDts?: string) {
  return GraphDoc.parse({
    schemaVersion: 1,
    id: "t",
    backend: "web-code",
    brief: { goal: "", constraints: [], clarifications: [] },
    nodes: {
      tokens: {
        id: "tokens", kind: "style", title: "tokens", spec: "",
        contract: {
          name: "tokens", summary: "", params: [],
          provides: [{ key: "tokens", type: "tokens", description: "" }], requires: [],
          payload: { module: "@nodes/tokens", exports: [{ name: "tokens", exportKind: "const", signature: "tokens" }], propsType: "", postconditions: [] },
          hash: "t1",
        },
        pinned: true, params: {}, deps: [],
        artifact: { code: TOKENS_CODE, testCode: "", dts: tokensDts, hash: "x" },
        thread: [], status: "ready", version: 1, history: [],
        cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
      },
      consumer: {
        id: "consumer", kind: "component", title: "consumer", spec: "",
        contract: {
          name: "consumer", summary: "", params: [], provides: [], requires: [{ key: "tokens", type: "tokens", description: "" }],
          payload: { module: "@nodes/consumer", exports: [{ name: "Consumer", exportKind: "component", signature: "" }], propsType: "", postconditions: [] },
          hash: "c1",
        },
        pinned: true, params: {}, deps: ["tokens"],
        artifact: { code: consumerCode, testCode: "", hash: "y" },
        thread: [], status: "ready", version: 1, history: [],
        cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
      },
    },
    edges: [{ id: "e0", from: "tokens", fromPort: "tokens", to: "consumer", toPort: "tokens" }],
    assembly: { entryNodeId: "consumer" },
    layout: {},
    rev: 0,
  });
}

const GOOD = `import React from "react";
import { tokens } from "@nodes/tokens";
export function Consumer() { return <div style={{ background: tokens.color.bg }} />; }
`;
const DRIFTED = `import React from "react";
import { tokens } from "@nodes/tokens";
export function Consumer() { return <div style={{ background: tokens.color.panelAlt }} />; }
`;

describe("real-interface verification", () => {
  it("extracts a real .d.ts from committed code", async () => {
    const graph = makeGraph(GOOD);
    const dts = await extractDts(graph.nodes.tokens!, ws);
    expect(dts).toBeTruthy();
    expect(dts).toContain("tokens");
    expect(dts).toContain("bg");
  });

  it("any-stubs let inner-shape drift through (the old blind spot)", async () => {
    const graph = makeGraph(DRIFTED, undefined);
    const result = await typecheckNode(graph.nodes.consumer!, graph, ws);
    expect(result.ok).toBe(true); // passes — and would crash at runtime
  });

  it("real dts FAILS the drifted consumer and names the missing member", async () => {
    const base = makeGraph(GOOD);
    const dts = (await extractDts(base.nodes.tokens!, ws))!;
    const graph = makeGraph(DRIFTED, dts);
    const result = await typecheckNode(graph.nodes.consumer!, graph, ws);
    expect(result.ok).toBe(false);
    expect(result.report).toContain("panelAlt");
  });

  it("real dts passes the correct consumer", async () => {
    const base = makeGraph(GOOD);
    const dts = (await extractDts(base.nodes.tokens!, ws))!;
    const graph = makeGraph(GOOD, dts);
    const result = await typecheckNode(graph.nodes.consumer!, graph, ws);
    expect(result.ok).toBe(true);
  });
});
