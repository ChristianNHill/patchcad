/**
 * The plan-geometry overlap lints, fixed by rule. A hinge whose leaves land on
 * top of each other is almost always one port frame turned the wrong way, and
 * a low-effort repair round could spend all three of its rounds failing to see
 * that (hinge-revolute, 2026-10-03: 3 repairs, 18k tokens, still overlapping).
 * Turning the moving part's mated port 180° is cheap to try, and the lints are
 * the judge: a flip is kept only when it clears an overlap and adds nothing.
 */
import type { ArchitectOutput } from "@patchcad/engine";
import type { CadContractPayload, Dim, Pose } from "./index.js";
import type { z } from "zod";

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
