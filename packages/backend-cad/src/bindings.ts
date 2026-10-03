import type { GraphDoc, ParamValue } from "@patchcad/shared";
import {
  CATALOG,
  canonicalKey,
  dim,
  familyDims,
  parseSku,
  pickLength,
  standardLengths,
  threadSpec,
  type DimsRow,
} from "./catalog.js";
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
 *                                      stack expression snapped UP to a stocked SHCS length
 *   "screwLengthIn: button, param:s.thread, min=param(a.t) + 4, max=param(a.t) + 6"
 *                                      shortest stocked length of that family and thread in range
 *   "hw:<field>:<thread|sku|size|param:n.p>"
 *                                      a catalog dimension a port declares, see HW_FIELDS
 *
 * The engineering knowledge lives here and in the metric tables: change a
 * plate's thickness and a bound screw's length re-resolves to the next
 * standard size; drill a bigger hole and the bound thread steps up. When an
 * upstream param moves, bound consumers re-resolve and re-execute their
 * CACHED code — the resolver never guesses and never calls a model.
 */

/** `screwLength:` names no family or thread, so it snaps into every length
 *  some ISO 4762 screw is stocked in. `screwLengthIn:` is the exact form. */
const ANY_SHCS_LENGTH = [
  ...new Set(Object.keys(CATALOG.families.shcs!.dims).flatMap((t) => standardLengths("shcs", t))),
].sort((a, b) => a - b);

/**
 * `hw:` fields: the catalog size a host port declares for a bought part, read
 * from the families listed, in preference order (a bare "M3" for insertHoleD
 * is the standard heat-set insert). Always the PART's nominal size: the G3
 * probe applies the fit band (the port's `fit` param, FDM slip on nut traps),
 * so a fit added here would be counted twice. `tapDrill` and `clearance` read
 * the thread table instead.
 */
const HW_FIELDS: Record<string, { families: string[]; value: (r: DimsRow) => number }> = {
  insertHoleD: { families: ["heatset_std", "heatset_short"], value: (r) => dim(r, "holeD") },
  insertDepth: { families: ["heatset_std", "heatset_short"], value: (r) => dim(r, "length") },
  bossOd: { families: ["heatset_std", "heatset_short"], value: (r) => dim(r, "minBossOd") },
  nutTrapAf: { families: ["hex_nut"], value: (r) => dim(r, "af") },
  nutTrapDepth: { families: ["hex_nut"], value: (r) => dim(r, "height") },
  // The common machinist's counterbore: head Ø + 1, head height + 0.4.
  cboreD: { families: ["shcs", "button"], value: (r) => dim(r, "headD") + 1 },
  cboreDepth: { families: ["shcs", "button"], value: (r) => dim(r, "headH") + 0.4 },
  cskD: { families: ["csk"], value: (r) => dim(r, "headD") },
  washerOd: { families: ["washer"], value: (r) => dim(r, "od") },
  dowelHole: { families: ["dowel"], value: (r) => dim(r, "d") },
  bearingSeatD: { families: ["bearing", "bearing_flanged", "lm_uu", "bushing"], value: (r) => dim(r, "od") },
  bearingWidth: { families: ["bearing", "bearing_flanged"], value: (r) => dim(r, "width") },
  // The shaft a part takes: a rod's own Ø, or the bore of whatever rides on it.
  shaftD: {
    families: ["shaft", "d_shaft", "bearing", "bearing_flanged", "bushing", "lm_uu", "collar", "gt2_pulley", "nema17", "brushless", "n20"],
    value: (r) => dim(r, "d" in r ? "d" : "bore" in r ? "bore" : "shaftD"),
  },
  motorPilot: { families: ["nema17"], value: (r) => dim(r, "pilotD") },
  // A square NEMA pattern's PCD is its diagonal.
  motorPcd: {
    families: ["nema17", "brushless", "n20"],
    value: (r) => ("pcd" in r ? dim(r, "pcd") : dim(r, "holePitch") * Math.SQRT2),
  },
  magnetPocketD: { families: ["disc_magnet"], value: (r) => dim(r, "d") },
  // HUB_BORE `flat`: axis to the flat along +xAxis.
  hubFlat: { families: ["d_shaft"], value: (r) => dim(r, "d") / 2 - dim(r, "flatDepth") },
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function effectiveParam(graph: GraphDoc, nodeId: string, name: string): ParamValue | undefined {
  const node = graph.nodes[nodeId];
  if (!node) return undefined;
  if (name in node.params) return node.params[name];
  return node.contract.params.find((p) => p.name === name)?.default;
}

/** The only names an expression may call, plus `pi`. Trig is in radians, as
 *  in the generator's Python; `radians`/`degrees` convert. A dovetail's flank
 *  angle was written `tan(param(x.angle) * pi / 180)` and every attempt threw. */
const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  radians: (d) => (d * Math.PI) / 180,
  degrees: (r) => (r * 180) / Math.PI,
};

/**
 * Tiny arithmetic evaluator for binding expressions: numbers, + - * /,
 * parentheses, `param(<nodeId>.<paramName>)` references, `pi` and the
 * FUNCTIONS above. Recursive descent, no eval, a closed set of names —
 * unresolvable refs and malformed input return an error instead of guessing.
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
    const name = /^[a-z_]\w*/i.exec(s.slice(pos))?.[0];
    if (name === "pi") {
      pos += name.length;
      return { value: Math.PI };
    }
    if (name && Object.hasOwn(FUNCTIONS, name)) {
      pos += name.length;
      skip();
      if (s[pos] !== "(") return fail(`missing ( after ${name}`);
      pos++;
      const args: number[] = [];
      for (;;) {
        const arg = addSub();
        if ("error" in arg) return arg;
        args.push(arg.value);
        skip();
        if (s[pos] === ",") {
          pos++;
          continue;
        }
        if (s[pos] !== ")") return fail(`missing ) after ${name}(`);
        pos++;
        break;
      }
      const fn = FUNCTIONS[name]!;
      if (fn.length === 1 && args.length !== 1) return fail(`${name}() takes one argument`);
      const value = fn(...args);
      return Number.isFinite(value) ? { value } : fail(`${name}(${args.join(", ")}) is not a finite number`);
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

/** A binding argument that may itself be a `param:` reference, as a string. */
function resolveArg(graph: GraphDoc, arg: string): { value: string } | { error: string } {
  if (!arg.startsWith("param:")) return { value: arg };
  const resolved = resolveBinding(graph, arg);
  return "error" in resolved ? resolved : { value: String(resolved.value) };
}

function resolveHw(graph: GraphDoc, expr: string): { value: number } | { error: string } {
  const m = /^hw:(\w+):(.+)$/.exec(expr);
  if (!m) return { error: `malformed binding "${expr}" — expected hw:<field>:<thread|sku|param:…>` };
  const [, field, rawArg] = m as unknown as [string, string, string];
  const arg = resolveArg(graph, rawArg.trim());
  if ("error" in arg) return arg;
  const sku = parseSku(arg.value);
  if (field === "tapDrill" || field === "clearance") {
    const spec = threadSpec(sku?.key ?? arg.value);
    if (!spec) return { error: `binding "${expr}": "${arg.value}" is not a known thread` };
    return { value: field === "tapDrill" ? spec.tapDrill : spec.clearance };
  }
  const spec = HW_FIELDS[field];
  if (!spec) return { error: `binding "${expr}": unknown hw field "${field}"` };
  const family = sku ? sku.family : spec.families.find((f) => canonicalKey(f, arg.value));
  if (!family || !spec.families.includes(family)) {
    return { error: `binding "${expr}": "${arg.value}" is not a ${spec.families.join(" / ")} size` };
  }
  const row = familyDims(family, sku?.key ?? arg.value)!;
  return { value: round2(spec.value(row)) };
}

function resolveScrewLengthIn(graph: GraphDoc, expr: string): { value: number } | { error: string } {
  const [family = "", threadArg = "", ...opts] = expr.slice("screwLengthIn:".length).split(",").map((s) => s.trim());
  const thread = resolveArg(graph, threadArg);
  if ("error" in thread) return thread;
  const range: { min?: number; max?: number } = {};
  for (const opt of opts) {
    const [name, src] = [opt.slice(0, opt.indexOf("=")).trim(), opt.slice(opt.indexOf("=") + 1)];
    if (name !== "min" && name !== "max") return { error: `binding "${expr}": unknown option "${opt}"` };
    const v = evalArithmetic(graph, src.trim());
    if ("error" in v) return v;
    range[name] = v.value;
  }
  if (range.min === undefined) return { error: `binding "${expr}": needs min=<expr>` };
  const stocked = standardLengths(family, thread.value);
  if (stocked.length === 0) return { error: `binding "${expr}": no stocked lengths for ${family} ${thread.value}` };
  const length = pickLength(family, thread.value, { min: range.min, max: range.max });
  if (length === undefined) {
    const span = `${range.min.toFixed(1)}..${range.max?.toFixed(1) ?? "∞"}`;
    return { error: `binding "${expr}": no ${family} ${thread.value} length in ${span} mm (stocked: ${stocked.join(", ")})` };
  }
  return { value: length };
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
    const entry = threadSpec(thread);
    if (!entry) return { error: `binding "${expr}": unknown thread "${thread}"` };
    return { value: entry.clearance };
  }
  if (expr.startsWith("threadForHole:")) {
    const inner = resolveBinding(graph, expr.slice("threadForHole:".length).trim());
    if ("error" in inner) return inner;
    const hole = Number(inner.value);
    if (!Number.isFinite(hole)) return { error: `binding "${expr}": hole diameter is not numeric` };
    // Largest thread whose normal-fit clearance still fits the drilled hole.
    const fit = Object.entries(CATALOG.threads)
      .filter(([, t]) => t.clearance <= hole + 0.05)
      .sort((a, b) => b[1].clearance - a[1].clearance)[0];
    if (!fit) return { error: `binding "${expr}": Ø${hole} is below every known thread's clearance` };
    return { value: fit[0] };
  }
  if (expr.startsWith("screwLength:")) {
    const stack = evalArithmetic(graph, expr.slice("screwLength:".length).trim());
    if ("error" in stack) return stack;
    const snapped = ANY_SHCS_LENGTH.find((l) => l >= stack.value - 1e-9);
    if (snapped === undefined) {
      return { error: `binding "${expr}": stack ${stack.value.toFixed(1)} mm exceeds the longest standard screw` };
    }
    return { value: snapped };
  }
  if (expr.startsWith("screwLengthIn:")) return resolveScrewLengthIn(graph, expr);
  if (expr.startsWith("hw:")) return resolveHw(graph, expr);
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

/** Nodes whose bindings read the changed node — the T1 re-execute set —
 * TRANSITIVELY and in the order to resolve them: a joint's insert pocket reads
 * its screw's length, which reads the wall that changed, so the screw has to
 * re-resolve first. A dependent only passes a change on through a BOUND param:
 * the screw also reads the lid's thickness, but the lid re-resolving moves its
 * pocket, not its thickness. Covers both reference syntaxes:
 * `param:<node>.<p>` and `param(<node>.<p>)`. */
export function boundDependents(graph: GraphDoc, changedNodeId: string): string[] {
  const bound = (id: string) => (graph.nodes[id]?.contract.payload as CadContractPayload | undefined)?.paramBindings ?? {};
  const reads = new Map<string, { node: string; param: string }[]>();
  for (const n of Object.values(graph.nodes)) {
    const refs = Object.values(bound(n.id)).flatMap((e) =>
      [...e.matchAll(/param[:(]\s*([^.\s()]+)\.(\w+)/g)].map((m) => ({ node: m[1]!, param: m[2]! })),
    );
    reads.set(n.id, refs.filter((r) => r.node !== n.id));
  }
  const moves = (r: { node: string; param: string }, from: Set<string>) =>
    r.node === changedNodeId || (from.has(r.node) && r.param in bound(r.node));
  const affected = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, refs] of reads) {
      if (id !== changedNodeId && !affected.has(id) && refs.some((r) => moves(r, affected))) {
        affected.add(id);
        grew = true;
      }
    }
  }
  // Kahn over the affected set, graph order breaking ties; a cycle keeps
  // graph order for whatever is left rather than dropping it.
  const order: string[] = [];
  const pending = Object.keys(graph.nodes).filter((id) => affected.has(id));
  while (pending.length) {
    const waits = (id: string) => reads.get(id)!.some((r) => pending.includes(r.node) && r.param in bound(r.node));
    const i = pending.findIndex((id) => !waits(id));
    order.push(...pending.splice(i < 0 ? 0 : i, 1));
  }
  return order;
}
