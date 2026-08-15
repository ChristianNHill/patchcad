import { transform } from "esbuild";
import type { GraphDoc, NodeRecord } from "@patchcad/shared";
import type { ExecuteResult, VerifyResult } from "@patchcad/engine";
import { CodeContractPayload } from "./payload.js";

/**
 * M3-lite verification (full TS LanguageService worker + vitest smoke tests
 * are the M3 completion items):
 *
 *  execute: esbuild TSX transform — catches syntax errors cheaply.
 *  verify:  contract export presence + the hermetic import lint (every
 *           @nodes/* import must be a declared graph dependency, and every
 *           imported symbol must exist in that neighbor's contract).
 */

export async function executeNode(node: NodeRecord): Promise<ExecuteResult> {
  const code = node.artifact?.code ?? "";
  if (!code.trim()) return { ok: false, stage: "execute", report: "empty artifact" };
  try {
    await transform(code, { loader: "tsx", jsx: "automatic" });
    return { ok: true, stage: "execute", report: "syntax ok" };
  } catch (err) {
    return { ok: false, stage: "execute", report: (err as Error).message };
  }
}

const IMPORT_RE = /import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\{([^}]*)\}|(\w+))\s+from\s+["']@nodes\/([\w-]+)["']/g;
const EXPORT_RE = /export\s+(?:async\s+)?(?:function|const|let|class|interface|type)\s+(\w+)/g;

export function verifyNode(node: NodeRecord, graph: GraphDoc): VerifyResult {
  const code = node.artifact?.code ?? "";
  const problems: string[] = [];

  // 1. Contract exports must exist in the artifact.
  const payload = CodeContractPayload.safeParse(node.contract.payload);
  if (!payload.success) {
    return { ok: false, stage: "verify", report: `invalid contract payload: ${payload.error.message}` };
  }
  const exported = new Set<string>();
  for (const m of code.matchAll(EXPORT_RE)) exported.add(m[1]!);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const name of m[1]!.split(",")) {
      const clean = name.trim().split(/\s+as\s+/).pop();
      if (clean) exported.add(clean);
    }
  }
  for (const exp of payload.data.exports) {
    if (!exported.has(exp.name)) {
      problems.push(`contract export "${exp.name}" is missing from the module`);
    }
  }

  // 2. Hermetic import lint: @nodes imports ⊆ upstream edges, symbols ⊆ contracts.
  const allowedNeighbors = new Set(graph.edges.filter((e) => e.to === node.id).map((e) => e.from));
  for (const m of code.matchAll(IMPORT_RE)) {
    const [, named, defaultImport, neighborId] = m;
    if (!allowedNeighbors.has(neighborId!)) {
      problems.push(
        `imports "@nodes/${neighborId}" but has no incoming edge from it — ` +
          `only these neighbors are wired: ${[...allowedNeighbors].join(", ") || "(none)"}`,
      );
      continue;
    }
    const neighbor = graph.nodes[neighborId!];
    const neighborPayload = neighbor ? CodeContractPayload.safeParse(neighbor.contract.payload) : null;
    if (neighborPayload?.success) {
      const contractExports = new Set(neighborPayload.data.exports.map((e) => e.name));
      const symbols = named
        ? named.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean)
        : defaultImport
          ? [defaultImport]
          : [];
      for (const sym of symbols) {
        if (sym && !contractExports.has(sym)) {
          problems.push(
            `imports "${sym}" from @nodes/${neighborId}, but that contract only exports: ${[...contractExports].join(", ")}`,
          );
        }
      }
    }
  }

  // 3. No external packages beyond the allowlist.
  const ALLOWED_BARE = new Set(["react", "react-dom", "@patchcad/preview-runtime"]);
  for (const m of code.matchAll(/from\s+["']([^."'@][^"']*|@[^"']+)["']/g)) {
    const spec = m[1]!;
    if (spec.startsWith("@nodes/")) continue;
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
    if (!ALLOWED_BARE.has(pkg) && !ALLOWED_BARE.has(spec)) {
      problems.push(`imports disallowed package "${spec}" — only react and @patchcad/preview-runtime are available`);
    }
  }

  return problems.length === 0
    ? { ok: true, stage: "verify", report: "contract satisfied" }
    : { ok: false, stage: "verify", report: problems.join("\n") };
}
