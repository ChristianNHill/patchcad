import type { GraphDoc, ParamValue } from "@patchcad/shared";
import { METRIC } from "./registry.js";
import type { CadContractPayload } from "./index.js";

/**
 * T1: deterministic param re-resolution — the zero-LLM tier between sliders
 * (T0) and regeneration (T2). A contract's `paramBindings` map binds a param
 * to a whitelisted symbolic expression over OTHER nodes' params:
 *
 *   "param:<nodeId>.<paramName>"       copy that node's effective value
 *   "clearance:M4"                     ISO clearance Ø for a literal thread
 *   "clearance:param:<nodeId>.<name>"  clearance Ø for an upstream thread param
 *   "threadForHole:param:<n>.<name>"   largest thread whose clearance fits the hole
 *   "expr: param(a.thickness) + 2*3"   arithmetic over params (+ - * / parens)
 *   "screwLength: param(a.t) + param(b.t) + 4"
 *                                      stack expression snapped UP to a standard length
 *
 * The engineering knowledge lives here and in the metric tables: change a
 * plate's thickness and a bound screw's length re-resolves to the next
 * standard size; drill a bigger hole and the bound thread steps up. When an
 * upstream param moves, bound consumers re-resolve and re-execute their
 * CACHED code — the resolver never guesses and never calls a model.
 */

/** ISO 4762-ish stocked SHCS lengths — screwLength snaps UP into this list. */
export const STANDARD_SCREW_LENGTHS = [6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50];

export function effectiveParam(graph: GraphDoc, nodeId: string, name: string): ParamValue | undefined {
  const node = graph.nodes[nodeId];
  if (!node) return undefined;
  if (name in node.params) return node.params[name];
  return node.contract.params.find((p) => p.name === name)?.default;
}

/**
 * Tiny arithmetic evaluator for binding expressions: numbers, + - * /,
 * parentheses, and `param(<nodeId>.<paramName>)` references. Recursive
 * descent, no eval, no identifiers beyond param() — unresolvable refs and
 * malformed input return an error instead of guessing.
 */
function evalArithmetic(graph: GraphDoc, src: string): { value: number } | { error: string } {
  let pos = 0;
  const s = src;
  const fail = (msg: string) => ({ error: `${msg} in expression "${src}"` });
  const skip = () => {
    while (pos < s.length && s[pos] === " ") pos++;
  };

  function primary(): { value: number } | { error: string } {
    skip();
    // unary minus over a parenthesized or param() term: -(a + b), -param(x.y)
    if (s[pos] === "-" && !/\d/.test(s[pos + 1] ?? "")) {
      pos++;
      const inner = primary();
      return "error" in inner ? inner : { value: -inner.value };
    }
    if (s[pos] === "(") {
      pos++;
      const inner = addSub();
      if ("error" in inner) return inner;
      skip();
      if (s[pos] !== ")") return fail("missing )");
      pos++;
      return inner;
    }
    if (s.startsWith("param(", pos)) {
      const close = s.indexOf(")", pos);
      if (close < 0) return fail("missing ) after param(");
      const ref = s.slice(pos + "param(".length, close).trim();
      pos = close + 1;
      const dot = ref.indexOf(".");
      if (dot < 1) return fail(`malformed param ref "${ref}"`);
      const value = effectiveParam(graph, ref.slice(0, dot), ref.slice(dot + 1));
      if (typeof value !== "number") return fail(`param(${ref}) is ${value === undefined ? "missing" : "not numeric"}`);
      return { value };
    }
    const m = /^-?\d+(\.\d+)?/.exec(s.slice(pos));
    if (!m) return fail(`unexpected token at "${s.slice(pos, pos + 12)}"`);
    pos += m[0].length;
    return { value: Number(m[0]) };
  }

  function mulDiv(): { value: number } | { error: string } {
    let left = primary();
    if ("error" in left) return left;
    for (;;) {
      skip();
      const op = s[pos];
      if (op !== "*" && op !== "/") return left;
      pos++;
      const right = primary();
      if ("error" in right) return right;
      left = { value: op === "*" ? left.value * right.value : left.value / right.value };
    }
  }

  function addSub(): { value: number } | { error: string } {
    let left = mulDiv();
    if ("error" in left) return left;
    for (;;) {
      skip();
      const op = s[pos];
      if (op !== "+" && op !== "-") return left;
      pos++;
      const right = mulDiv();
      if ("error" in right) return right;
      left = { value: op === "+" ? left.value + right.value : left.value - right.value };
    }
  }

  const result = addSub();
  if ("error" in result) return result;
  skip();
  if (pos !== s.length) return fail(`trailing input at "${s.slice(pos, pos + 12)}"`);
  return result;
}

export function resolveBinding(
  graph: GraphDoc,
  expr: string,
): { value: ParamValue } | { error: string } {
  if (expr.startsWith("param:")) {
    const rest = expr.slice("param:".length);
    const dot = rest.indexOf(".");
    if (dot < 1) return { error: `malformed binding "${expr}" — expected param:<nodeId>.<param>` };
    const value = effectiveParam(graph, rest.slice(0, dot), rest.slice(dot + 1));
    if (value === undefined) return { error: `binding "${expr}" resolves to nothing` };
    return { value };
  }
  if (expr.startsWith("clearance:")) {
    const inner = expr.slice("clearance:".length);
    let thread: string;
    if (inner.startsWith("param:")) {
      const resolved = resolveBinding(graph, inner);
      if ("error" in resolved) return resolved;
      thread = String(resolved.value);
    } else {
      thread = inner;
    }
    const entry = METRIC[thread.toUpperCase()];
    if (!entry) return { error: `binding "${expr}": unknown thread "${thread}"` };
    return { value: entry.clearance };
  }
  if (expr.startsWith("threadForHole:")) {
    const inner = resolveBinding(graph, expr.slice("threadForHole:".length).trim());
    if ("error" in inner) return inner;
    const hole = Number(inner.value);
    if (!Number.isFinite(hole)) return { error: `binding "${expr}": hole diameter is not numeric` };
    // Largest thread whose normal-fit clearance still fits the drilled hole.
    const fit = Object.entries(METRIC)
      .filter(([, t]) => t.clearance <= hole + 0.05)
      .sort((a, b) => b[1].clearance - a[1].clearance)[0];
    if (!fit) return { error: `binding "${expr}": Ø${hole} is below every known thread's clearance` };
    return { value: fit[0] };
  }
  if (expr.startsWith("screwLength:")) {
    const stack = evalArithmetic(graph, expr.slice("screwLength:".length).trim());
    if ("error" in stack) return stack;
    const snapped = STANDARD_SCREW_LENGTHS.find((l) => l >= stack.value - 1e-9);
    if (snapped === undefined) {
      return { error: `binding "${expr}": stack ${stack.value.toFixed(1)} mm exceeds the longest standard screw` };
    }
    return { value: snapped };
  }
  if (expr.startsWith("expr:")) {
    const result = evalArithmetic(graph, expr.slice("expr:".length).trim());
    return "error" in result ? result : { value: result.value };
  }
  return { error: `unsupported binding expression "${expr}"` };
}

export function resolveParamBindings(
  graph: GraphDoc,
  nodeId: string,
): { resolved: Record<string, ParamValue>; problems: string[] } {
  const node = graph.nodes[nodeId];
  const payload = node?.contract.payload as CadContractPayload | undefined;
  const resolved: Record<string, ParamValue> = {};
  const problems: string[] = [];
  for (const [param, expr] of Object.entries(payload?.paramBindings ?? {})) {
    const result = resolveBinding(graph, expr);
    if ("error" in result) problems.push(`${nodeId}.${param}: ${result.error}`);
    else resolved[param] = result.value;
  }
  return { resolved, problems };
}

/**
 * Parametric dimensions: any pose component or envelope dimension may be an
 * expression string instead of a number — "param(base-plate.thickness) / 2"
 * keeps a port glued to a face whose position is itself a parameter. The
 * same T1 engine resolves them, so probes and assembly always see geometry
 * consistent with the CURRENT param values.
 */
export type Dim = number | string;

export function resolveDim(graph: GraphDoc, dim: Dim): number {
  if (typeof dim === "number") return dim;
  const src = dim.startsWith("expr:") ? dim.slice("expr:".length) : dim;
  const result = evalArithmetic(graph, src.trim());
  if ("error" in result) throw new Error(result.error);
  return result.value;
}

export interface NumericPose {
  origin: [number, number, number];
  zAxis: [number, number, number];
  xAxis: [number, number, number];
}

export function resolvePose(
  graph: GraphDoc,
  pose: { origin: Dim[]; zAxis: Dim[]; xAxis: Dim[] },
): NumericPose {
  const triple = (v: Dim[]) =>
    [resolveDim(graph, v[0]!), resolveDim(graph, v[1]!), resolveDim(graph, v[2]!)] as [number, number, number];
  return { origin: triple(pose.origin), zAxis: triple(pose.zAxis), xAxis: triple(pose.xAxis) };
}

/** Nodes whose bindings read the changed node — the T1 re-execute set.
 * Covers both reference syntaxes: `param:<node>.<p>` and `param(<node>.<p>)`. */
export function boundDependents(graph: GraphDoc, changedNodeId: string): string[] {
  const needles = [`param:${changedNodeId}.`, `param(${changedNodeId}.`];
  return Object.values(graph.nodes)
    .filter((n) => {
      const payload = n.contract.payload as CadContractPayload | undefined;
      return Object.values(payload?.paramBindings ?? {}).some((expr) =>
        needles.some((needle) => expr.includes(needle)),
      );
    })
    .map((n) => n.id);
}
