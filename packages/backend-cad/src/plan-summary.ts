import type { GraphDoc, NodeRecord } from "@patchcad/shared";
import { transformPoint } from "./assembly.js";
import { planPreview, solvePlan } from "./plan-geometry.js";
import { REGISTRY_HARDWARE } from "./registry.js";
import { buyRow } from "./bom.js";
import { NOUN } from "./instructions.js";
import { sourcingOf } from "./sourcing.js";
import type { CadJoint } from "./joints.js";

/**
 * The plan as the coverage critic reads it (engine plan-critic.ts): what is
 * made and how many copies are placed, what is bought, what moves, and the
 * key numbers. Contracts only, never code. Compact on purpose: the critic is
 * a cheap call, and ports, poses and envelopes are the lints' business.
 */
export function summarizeCadPlan(graph: GraphDoc): string {
  const nodes = Object.values(graph.nodes);
  const joints = (graph.joints ?? []) as (Partial<CadJoint> & { id: string; a: { node: string }; b: { node: string }; expanded?: string; failed?: string })[];
  let copies: Record<string, number> = {};
  try {
    copies = Object.fromEntries(Object.entries(solvePlan(graph).instances).map(([id, m]) => [id, m.length]));
  } catch {
    // an unsolvable plan still summarizes, one copy each
  }
  const count = (n: NodeRecord) => Math.max(1, copies[n.id] ?? 1);
  // Expansion mints host params named after the joint (`jl_uf_tap_depth`):
  // plumbing, not a dimension the brief could state.
  const minted = joints.map((j) => `${j.id.replace(/-/g, "_")}_`);
  const num = (v: unknown) => (typeof v === "number" ? +v.toFixed(2) : v);

  const made = nodes.filter((n) => !REGISTRY_HARDWARE.has(n.kind));
  const bought = nodes.filter((n) => REGISTRY_HARDWARE.has(n.kind));
  const lines: string[] = [`PARTS MADE (${made.length} node(s)):`];
  for (const n of made) {
    const s = sourcingOf(n);
    const dims = n.contract.params
      .filter((p) => p.type === "number" && !minted.some((m) => p.name.startsWith(m)))
      .slice(0, 10)
      .map((p) => `${p.name}=${num(p.default)}`);
    lines.push(
      `- ${n.id} "${n.title}" ×${count(n)} [${s.class}${s.process ? ` ${s.process}` : ""}${s.material ? `, ${s.material}` : ""}]: ${clip(n.contract.summary, 200)}` +
        (dims.length ? ` | dims: ${dims.join(" ")}` : ""),
    );
  }

  lines.push("", `HARDWARE BOUGHT (${bought.length} node(s)):`);
  if (bought.length === 0) lines.push("- none");
  const totals = new Map<string, number>();
  for (const n of bought) {
    const what = hardwareName(n);
    const teeth = / z\d/.test(what) ? undefined : n.contract.params.find((p) => p.name === "teeth")?.default;
    lines.push(`- ${n.id} ×${count(n)}: ${what}${teeth !== undefined ? ` ${teeth} teeth` : ""}`);
    totals.set(what, (totals.get(what) ?? 0) + count(n));
  }
  if (totals.size) lines.push(`Hardware totals: ${[...totals].map(([k, q]) => `${q} × ${k}`).join(", ")}`);

  lines.push("", `JOINTS (${joints.length}):`);
  if (joints.length === 0) lines.push("- none: no joint is declared, so nothing in this plan moves or is joined by hardware");
  for (const j of joints) {
    const hw = (j.expanded ?? "").split("|").slice(1).join(", ");
    const extra = [
      j.intent,
      j.driven ? "driven" : "",
      j.count && j.count > 1 ? `count ${j.count}` : "",
      j.ratio ? `ratio ${j.ratio}:1` : "",
      j.limits ? `travel ${j.limits[0]}..${j.limits[1]}°` : "",
      j.strokeMm ? `stroke ${j.strokeMm}mm` : "",
      j.prefer ? `named hardware ${[j.prefer.family, j.prefer.key].filter(Boolean).join(" ")}` : "",
      j.threadHint ? `thread ${j.threadHint}` : "",
      j.shaftHint ? `shaft Ø${j.shaftHint}` : "",
    ].filter(Boolean);
    lines.push(
      `- ${j.id}: ${j.a.node} ↔ ${j.b.node}, ${j.motion ?? "fixed"}${extra.length ? ` (${extra.join(", ")})` : ""}; ` +
        (j.failed ? `hardware FAILED: ${clip(j.failed, 120)}` : hw ? `hardware: ${hw}` : "no hardware"),
    );
  }

  // Edges are the plain mates: which part sits on which, and how many times.
  const mates = new Map<string, number>();
  for (const e of graph.edges) {
    if (REGISTRY_HARDWARE.has(graph.nodes[e.to]?.kind ?? "") || REGISTRY_HARDWARE.has(graph.nodes[e.from]?.kind ?? "")) continue;
    const k = `${e.from} → ${e.to}`;
    mates.set(k, (mates.get(k) ?? 0) + 1);
  }
  lines.push("", `MATES between made parts (placement only; motion comes from JOINTS): ${[...mates].map(([k, q]) => (q > 1 ? `${k} ×${q}` : k)).join("; ") || "none"}`);

  const size = extents(graph);
  // Largest first, axes unnamed: a model frame's x is not the brief's "wide",
  // and reading y as "deep" flagged a correct stool.
  if (size) lines.push(`OVERALL ENVELOPE (approx., padded; largest first, axes unnamed): ${size.map((v) => Math.round(v)).sort((a, b) => b - a).join(" × ")} mm`);
  return lines.join("\n");
}

/** "countersunk screw M3×30 (ISO 10642)": the catalog row in words, since
 *  a bare SKU such as ISO10642 read to the critic as a socket head screw. */
function hardwareName(n: NodeRecord): string {
  const row = buyRow(n);
  const [family, ...rest] = row.description.split(" ");
  const standard = /^(ISO|DIN|NEMA) [\w.]+/.exec(row.standard)?.[0];
  return `${NOUN[family!] ?? family} ${rest.join(" ")}`.trim() + (standard ? ` (${standard})` : "");
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** World extents of the placed envelopes, or null when nothing placed. */
function extents(graph: GraphDoc): [number, number, number] | null {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  try {
    for (const n of planPreview(graph).nodes) {
      for (const p of n.primitives) {
        const [sx, sy, sz] = p.size.map((v) => v / 2) as [number, number, number];
        for (const c of [[-1, -1, -1], [-1, -1, 1], [-1, 1, -1], [-1, 1, 1], [1, -1, -1], [1, -1, 1], [1, 1, -1], [1, 1, 1]]) {
          const w = transformPoint(p.matrix, [c[0]! * sx, c[1]! * sy, c[2]! * sz]);
          for (let i = 0; i < 3; i++) {
            lo[i] = Math.min(lo[i]!, w[i]!);
            hi[i] = Math.max(hi[i]!, w[i]!);
          }
        }
      }
    }
  } catch {
    return null;
  }
  return Number.isFinite(lo[0]) ? [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!] : null;
}
