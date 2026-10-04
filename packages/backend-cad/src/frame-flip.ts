/**
 * The plan-geometry overlap lints, fixed by rule. A hinge whose leaves land on
 * top of each other is almost always one port frame turned the wrong way, and
 * a low-effort repair round could spend all three of its rounds failing to see
 * that (hinge-revolute, 2026-10-03: 3 repairs, 18k tokens, still overlapping).
 * Turning the moving part's mated port 180° is cheap to try, and the lints are
 * the judge: a flip is kept only when it clears an overlap and adds nothing.
 */
import { architectOutputToGraph, type ArchitectOutput } from "@patchcad/engine";
import type { CadContractPayload, Dim, Pose } from "./index.js";
import type { z } from "zod";
import type { GraphDoc } from "@patchcad/shared";
import { resolveParamBindings, resolvePose } from "./bindings.js";
import { expandJoints } from "./expand.js";
import { solvePlan } from "./plan-geometry.js";

type D = z.infer<typeof Dim>;
type Axis = [D, D, D];

const OVERLAP = /^(\S+?)(?:#\d+)? and (\S+?)(?:#\d+)? are (?:not )?mated\b/;

const neg = (v: D): D => (typeof v === "number" ? (v === 0 ? 0 : -v) : `-(${v})`);
const negate = (a: Axis): Axis => a.map(neg) as Axis;

/** The three half-turns of a port frame, about its own z, x and y. With y
 *  derived as z × x, negating xAxis alone IS the turn about z. */
const TURNS: { name: string; turn: (p: Pose) => Pose }[] = [
  { name: "180° about its z (xAxis negated)", turn: (p) => ({ ...p, xAxis: negate(p.xAxis) }) },
  { name: "180° about its x (zAxis negated)", turn: (p) => ({ ...p, zAxis: negate(p.zAxis) }) },
  { name: "180° about its y (zAxis and xAxis negated)", turn: (p) => ({ ...p, zAxis: negate(p.zAxis), xAxis: negate(p.xAxis) }) },
];

/** The ports that place one part of the pair against the other, the moving
 *  side first: a joint's b, then the consuming end of a direct edge. */
function targets(draft: ArchitectOutput, x: string, y: string): { node: string; port: string }[] {
  const pair = (a: string, b: string) => (a === x && b === y) || (a === y && b === x);
  const out = [
    ...(draft.joints ?? []).filter((j) => pair(j.a.node, j.b.node)).map((j) => j.b),
    ...draft.edges.filter((e) => pair(e.from, e.to)).map((e) => ({ node: e.to, port: e.toPort })),
  ];
  return out.filter((t, i) => out.findIndex((u) => u.node === t.node && u.port === t.port) === i && chosen(draft, t.node));
}

/** An imported or mesh part's frames were measured off real geometry, not
 *  chosen, so turning one would misplace the part rather than fix the plan. */
function chosen(draft: ArchitectOutput, id: string): boolean {
  const n = draft.nodes.find((x) => x.id === id);
  return !!n && n.kind !== "imported" && (n.contract.payload as CadContractPayload).geometrySource !== "mesh";
}

function withPose(draft: ArchitectOutput, node: string, port: string, turn: (p: Pose) => Pose): ArchitectOutput | null {
  const next = structuredClone(draft);
  const p = (next.nodes.find((n) => n.id === node)?.contract.payload as CadContractPayload | undefined)?.ports?.find((q) => q.name === port);
  if (!p) return null;
  p.pose = turn(p.pose);
  return next;
}

/** `planning.autoFix`: flip frames until no overlap the flips can reach is
 *  left. A candidate must lint to a strict subset of the problems it started
 *  from, so it never trades an overlap for anything else. */
export function fixFrameFlips(
  draft: ArchitectOutput,
  problems: string[],
  check: (d: ArchitectOutput) => string[],
): { draft: ArchitectOutput; notes: string[] } | null {
  const notes: string[] = [];
  let current = draft;
  let found = problems;
  const tried = new Set<string>();
  for (;;) {
    const pairs = found.map((p) => p.match(OVERLAP)).filter((m): m is RegExpMatchArray => !!m && m[1] !== m[2]);
    let step: { draft: ArchitectOutput; problems: string[]; note: string; key: string } | null = null;
    for (const [line, x, y] of pairs) {
      for (const t of targets(current, x!, y!)) {
        if (tried.has(`${t.node}.${t.port}`)) continue;
        for (const { name, turn } of TURNS) {
          const candidate = withPose(current, t.node, t.port, turn);
          if (!candidate) break;
          const after = check(candidate);
          if (after.length < found.length && after.every((p) => found.includes(p))) {
            step = { draft: candidate, problems: after, note: `frame flip: ${t.node}.${t.port} turned ${name}, which cleared "${line!.split(". ")[0]}"`, key: `${t.node}.${t.port}` };
            break;
          }
        }
        if (step) break;
      }
      if (step) break;
    }
    if (!step) break;
    tried.add(step.key);
    notes.push(step.note);
    current = step.draft;
    found = step.problems;
  }
  return notes.length ? { draft: current, notes } : null;
}

const SPAN = /^plan assembly: (\S+) spans ([\d.]+)mm (less|more) than the gap between (\S+) and (\S+) \(its (\S+) on \S+, its (\S+) /;

/** The distance between two of a node's own ports with its params as given. */
function portGap(draft: ArchitectOutput, node: string, p: string, q: string): number {
  const graph = { nodes: Object.fromEntries(draft.nodes.map((n) => [n.id, { id: n.id, kind: n.kind, params: {}, contract: n.contract }])) } as unknown as GraphDoc;
  const ports = (draft.nodes.find((n) => n.id === node)!.contract.payload as CadContractPayload).ports;
  const [a, b] = [p, q].map((name) => resolvePose(graph, ports.find((x) => x.name === name)!.pose).origin);
  return Math.hypot(...a!.map((v, i) => v - b![i]!));
}

/** The draft with every T1 binding applied to its param's default, as the
 *  cook will see it: a floor bound to the slat's length moves with it. */
export function settled(draft: ArchitectOutput): ArchitectOutput {
  const next = structuredClone(draft);
  const graph = { nodes: Object.fromEntries(next.nodes.map((n) => [n.id, { id: n.id, kind: n.kind, params: {}, contract: n.contract }])) } as unknown as GraphDoc;
  for (let pass = 0; pass < 4; pass++) {
    for (const n of next.nodes) {
      for (const [name, value] of Object.entries(resolveParamBindings(graph, n.id).resolved)) {
        const p = n.contract.params.find((x) => x.name === name);
        if (p) (p as { default: unknown }).default = value;
      }
    }
  }
  return next;
}

/** How much longer `node` must be to close its loop, mm (negative: shorter),
 *  from the solver's span message on the expanded plan; 0 when it closes. */
function shortBy(draft: ArchitectOutput, node: string): number {
  const graph = architectOutputToGraph(expandJoints(settled(draft)), "t", "cad", "g", "mm");
  const m = solvePlan(graph).problems.map((p) => p.match(new RegExp(`^${node.replace(/[-.]/g, "\\$&")} spans ([\\d.]+)mm (less|more)`))).find(Boolean);
  return m ? (m[2] === "less" ? 1 : -1) * Number(m[1]) : 0;
}

/** The loop's gap as a T1 expression: `value` plus how far each free number
 *  param of the other parts moves the gap per mm, by finite difference,
 *  measured with the part `probe` mm short so the span stays open. Exact for
 *  the translation chains a crate or a frame is (panels apart by a floor's
 *  width); undefined when no param moves it. */
function gapBinding(draft: ArchitectOutput, node: string, param: string, value: number, slope: number): string | undefined {
  const probe = 50;
  const set = (d: ArchitectOutput, id: string, name: string, v: number) => {
    const next = structuredClone(d);
    (next.nodes.find((x) => x.id === id)!.contract.params.find((x) => x.name === name) as { default: number }).default = v;
    return next;
  };
  const short = set(draft, node, param, value - probe / slope);
  const base = shortBy(short, node);
  if (Math.abs(base - probe) > 1) return undefined;
  const terms: string[] = [];
  for (const n of draft.nodes) {
    if (n.id === node || n.kind !== "part") continue;
    const bound = (n.contract.payload as CadContractPayload).paramBindings ?? {};
    for (const p of n.contract.params) {
      if (p.type !== "number" || typeof p.default !== "number" || bound[p.name]) continue;
      const moved = shortBy(set(short, n.id, p.name, p.default + 1), node);
      // A param that breaks the loop some other way (one panel's groove moved,
      // not both) is not part of the gap.
      const k = moved === 0 ? 0 : Math.round(((moved - base) / slope) * 1e4) / 1e4;
      if (k !== 0) terms.push(`${k} * (param(${n.id}.${p.name}) - ${p.default})`);
    }
  }
  return terms.length ? `expr: ${value} + ${terms.join(" + ")}` : undefined;
}

/**
 * A part that closes a mate loop at the wrong length (the crate's slat
 * between two side panels) gets the length that closes it: the free number
 * param that moves its two mated ports apart, solved for the gap the solver
 * measured, and bound by T1 to the other parts' params that set that gap, so
 * the slat follows the panels with no LLM call. Kept when the lints then drop
 * that span and add nothing. A param already bound is left alone.
 */
export function fixSpans(draft: ArchitectOutput, problems: string[], check: (d: ArchitectOutput) => string[]): { draft: ArchitectOutput; notes: string[] } | null {
  const notes: string[] = [];
  let current = draft;
  let found = problems;
  const done = new Set<string>();
  for (const line of problems) {
    const m = line.match(SPAN);
    if (!m || done.has(m[1]!)) continue;
    const [, node, by, sign, from, to, p, q] = m;
    done.add(node!);
    const n = current.nodes.find((x) => x.id === node);
    if (!n || !chosen(current, node!)) continue;
    const bound = (n.contract.payload as CadContractPayload).paramBindings ?? {};
    const want = portGap(current, node!, p!, q!) + (sign === "less" ? 1 : -1) * Number(by);
    for (const param of n.contract.params) {
      if (param.type !== "number" || typeof param.default !== "number" || bound[param.name]) continue;
      const at = (v: number) => {
        const next = structuredClone(current);
        (next.nodes.find((x) => x.id === node)!.contract.params.find((x) => x.name === param.name) as { default: number }).default = v;
        return next;
      };
      let slope: number;
      try {
        slope = portGap(at(param.default + 1), node!, p!, q!) - portGap(current, node!, p!, q!);
      } catch {
        continue;
      }
      if (Math.abs(slope) < 1e-6) continue;
      const value = Math.round((param.default + (want - portGap(current, node!, p!, q!)) / slope) * 100) / 100;
      const candidate = at(value);
      const binding = gapBinding(candidate, node!, param.name, value, slope);
      if (binding) ((candidate.nodes.find((x) => x.id === node)!.contract.payload as CadContractPayload).paramBindings ??= {})[param.name] = binding;
      const after = check(candidate);
      if (after.some((x) => x.match(SPAN)?.[1] === node) || !after.every((x) => found.includes(x))) continue;
      notes.push(`loop closure: ${node}.${param.name} ${param.default} → ${value}, the gap between ${from} and ${to}${binding ? ` (T1: ${binding})` : ""}`);
      current = candidate;
      found = after;
      break;
    }
  }
  return notes.length ? { draft: current, notes } : null;
}

/** `planning.autoFix`: wrong-length loop closers first, then frame flips. */
export function autoFixPlan(draft: ArchitectOutput, problems: string[], check: (d: ArchitectOutput) => string[]): { draft: ArchitectOutput; notes: string[] } | null {
  const spans = fixSpans(draft, problems, check);
  const flips = fixFrameFlips(spans?.draft ?? draft, spans ? check(spans.draft) : problems, check);
  if (!spans && !flips) return null;
  return { draft: flips?.draft ?? spans!.draft, notes: [...(spans?.notes ?? []), ...(flips?.notes ?? [])] };
}
