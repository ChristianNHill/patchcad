import path from "node:path";
import type { GraphDoc, NodeRecord } from "@patchcad/shared";
import type { VerifyResult, Workspace } from "@patchcad/engine";
import { CodeContractPayload } from "./payload.js";

/**
 * Typecheck-grade per-node verification. The node's module is compiled by
 * the real TypeScript checker against:
 *  - ambient declarations for its @nodes/* neighbors generated FROM THEIR
 *    CONTRACTS (exact export names; `any`-typed bodies until contracts carry
 *    real type expressions) — verification stays hermetic, no neighbor code;
 *  - a stable ambient stub for @patchcad/preview-runtime;
 *  - real react types resolved from the monorepo root.
 *
 * Catches what the regex lint can't: importing symbols that don't exist on
 * a contract, undefined identifiers, malformed JSX, type errors inside the
 * module.
 */

/** Real extracted declarations win; contract-derived any-stubs are the
 * fallback for neighbors that haven't cooked yet (first parallel wave). */
function neighborStub(neighborId: string, graph: GraphDoc): string {
  const neighbor = graph.nodes[neighborId];
  const payload = neighbor ? CodeContractPayload.safeParse(neighbor.contract.payload) : null;
  const exports = payload?.success
    ? payload.data.exports
        .map((e) =>
          e.exportKind === "component" || e.exportKind === "hook" || e.exportKind === "function"
            ? `  export const ${e.name}: (...args: any[]) => any;`
            : `  export const ${e.name}: any;`,
        )
        .join("\n")
    : "  const anything: any;\n  export default anything;";
  return `declare module "@nodes/${neighborId}" {\n${exports}\n}`;
}

const RUNTIME_STUB = `declare module "@patchcad/preview-runtime" {
  import type { ReactNode, Component } from "react";
  export function usePatchcadParam<T>(nodeId: string, key: string, fallback: T): T;
  export function ParamsProvider(props: { initial?: Record<string, Record<string, unknown>>; children: ReactNode }): any;
  export class NodeErrorBoundary extends Component<{ nodeId: string; children: ReactNode }> {}
}`;

export async function typecheckNode(
  node: NodeRecord,
  graph: GraphDoc,
  ws: Workspace,
): Promise<VerifyResult> {
  const ts = (await import("typescript")).default;
  const code = node.artifact?.code ?? "";

  // Anchor the virtual files inside the workspace so bare imports (react,
  // react/jsx-runtime) resolve up the real directory tree to root node_modules.
  const nodeFile = path.join(ws.root, "src", "nodes", `__verify__${node.id}.tsx`);
  const ambientFile = path.join(ws.root, "src", "nodes", `__verify__${node.id}.ambient.d.ts`);

  const neighborIds = [...new Set(graph.edges.filter((e) => e.to === node.id).map((e) => e.from))];

  // Neighbors with extracted interfaces become REAL .d.ts module files mapped
  // via paths — the checker then sees actual types (tokens.color.bg exists or
  // it does not). Others keep the any-typed ambient stub.
  const virtual = new Map<string, string>([[nodeFile, code]]);
  const paths: Record<string, string[]> = {};
  const stubIds: string[] = [];
  for (const id of neighborIds) {
    const dts = graph.nodes[id]?.artifact?.dts;
    if (dts && dts.trim().length > 0) {
      const dtsFile = path.join(ws.root, "src", "nodes", `__iface__${id}.d.ts`);
      virtual.set(dtsFile, dts);
      paths[`@nodes/${id}`] = [dtsFile];
    } else {
      stubIds.push(id);
    }
  }
  const ambient = [RUNTIME_STUB, ...stubIds.map((id) => neighborStub(id, graph))].join("\n\n");
  virtual.set(ambientFile, ambient);

  const options: import("typescript").CompilerOptions = {
    noEmit: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    allowJs: false,
    esModuleInterop: true,
    isolatedModules: true,
    baseUrl: ws.root,
    paths,
  };

  const host = ts.createCompilerHost(options, true);
  const realReadFile = host.readFile.bind(host);
  const realFileExists = host.fileExists.bind(host);
  host.readFile = (f) => virtual.get(path.normalize(f)) ?? realReadFile(f);
  host.fileExists = (f) => virtual.has(path.normalize(f)) || realFileExists(f);

  const program = ts.createProgram([nodeFile, ambientFile], options, host);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].filter((d) => d.file && path.normalize(d.file.fileName) === nodeFile);

  if (diagnostics.length === 0) {
    return { ok: true, stage: "typecheck", report: "typecheck clean" };
  }

  const problems = diagnostics.slice(0, 12).map((d) => {
    const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
    const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
    return `line ${line + 1}: ${message} (TS${d.code})`;
  });
  return { ok: false, stage: "typecheck", report: problems.join("\n") };
}

/**
 * Emit the node's REAL declaration file — the machine-checkable interface
 * consumers verify against. Best-effort: null when emit fails.
 */
export async function extractDts(node: NodeRecord, ws: Workspace): Promise<string | null> {
  const ts = (await import("typescript")).default;
  const code = node.artifact?.code ?? "";
  if (!code) return null;

  const nodeFile = path.join(ws.root, "src", "nodes", `__extract__${node.id}.tsx`);
  const ambientFile = path.join(ws.root, "src", "nodes", `__extract__${node.id}.ambient.d.ts`);
  // Neighbor imports resolve to any-stubs — extraction only needs THIS
  // module's own surface; neighbor types flow in when THEY are extracted.
  const graphless = `declare module "@nodes/*" { const anything: any; export = anything; }`;

  const options: import("typescript").CompilerOptions = {
    declaration: true,
    emitDeclarationOnly: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    esModuleInterop: true,
  };

  const virtual = new Map<string, string>([
    [nodeFile, code],
    [ambientFile, `${RUNTIME_STUB}\n\n${graphless}`],
  ]);
  const host = ts.createCompilerHost(options, true);
  const realReadFile = host.readFile.bind(host);
  const realFileExists = host.fileExists.bind(host);
  host.readFile = (f) => virtual.get(path.normalize(f)) ?? realReadFile(f);
  host.fileExists = (f) => virtual.has(path.normalize(f)) || realFileExists(f);
  let out: string | null = null;
  host.writeFile = (fileName, text) => {
    if (fileName.includes(`__extract__${node.id}`)) out = text;
  };

  const program = ts.createProgram([nodeFile, ambientFile], options, host);
  program.emit();
  return out;
}
