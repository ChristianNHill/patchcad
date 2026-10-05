import type { ArchitectOutput } from "@patchcad/engine";
import type { CadContractPayload } from "./index.js";

/**
 * A port that repeats (`repeat: {count, step}`), expanded at plan time into
 * `count` ordinary ports `<name>_1 … <name>_N`, the k-th at origin + (k-1)·step.
 * Every edge and joint on the port is repeated onto each copy, so one bracket
 * node wired to a rod's repeated station becomes a bracket at every level
 * (the spaghetti shelf planned one bracket for twelve). Generators see N
 * plain ports, so hermeticity is untouched; G3 probes each one.
 *
 * Runs first in expandPlan. An expanded port carries no `repeat`, so
 * re-expanding a live graph finds nothing to do and changes nothing.
 */

type OutNode = ArchitectOutput["nodes"][number];
type D = number | string;
type Port = CadContractPayload["ports"][number];

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** origin + k·step, folded to a number when both are numbers. */
function shift(o: D, k: number, step: D): D {
  if (k === 0) return o;
  if (typeof o === "number" && typeof step === "number") return round(o + k * step);
  const s = typeof step === "number" ? String(round(k * step)) : k === 1 ? `(${step})` : `${k} * (${step})`;
  if (typeof step === "number" && round(k * step) === 0) return o;
  return o === 0 ? s : `(${o}) + ${s}`;
}

export function repeatedName(name: string, k: number): string {
  return `${name}_${k}`;
}

export function expandRepeats(input: ArchitectOutput): ArchitectOutput {
  const out = structuredClone(input) as ArchitectOutput;
  const repeated = new Map<string, number>(); // "node|port" → count
  for (const n of out.nodes as OutNode[]) {
    const payload = n.contract.payload as CadContractPayload | undefined;
    if (!payload?.ports?.some((p) => p.repeat)) continue;
    payload.ports = payload.ports.flatMap((p): Port[] => {
      if (!p.repeat) return [p];
      const { repeat, ...base } = p;
      repeated.set(`${n.id}|${p.name}`, repeat.count);
      return Array.from({ length: repeat.count }, (_, k) => ({
        ...base,
        name: repeatedName(p.name, k + 1),
        pose: { ...base.pose, origin: base.pose.origin.map((c, i) => shift(c as D, k, repeat.step[i] as D)) as Port["pose"]["origin"] },
      }));
    });
    for (const side of ["provides", "requires"] as const) {
      n.contract[side] = n.contract[side].flatMap((d) => {
        const count = repeated.get(`${n.id}|${d.key}`);
        return count ? Array.from({ length: count }, (_, k) => ({ ...d, key: repeatedName(d.key, k + 1) })) : [d];
      });
    }
  }
  if (!repeated.size) return out;
  const countOf = (node: string, port: string) => repeated.get(`${node}|${port}`);
  out.edges = out.edges.flatMap((e) => {
    const [cf, ct] = [countOf(e.from, e.fromPort), countOf(e.to, e.toPort)];
    const count = cf ?? ct;
    if (!count) return [e];
    return Array.from({ length: count }, (_, k) => ({
      ...e,
      ...(cf ? { fromPort: repeatedName(e.fromPort, k + 1) } : {}),
      // Both ends repeated: the k-th meets the k-th.
      ...(ct ? { toPort: repeatedName(e.toPort, k + 1) } : {}),
    }));
  });
  type End = { node: string; port: string };
  type J = { id: string; a: End; b: End; far?: End } & Record<string, unknown>;
  out.joints = ((out.joints ?? []) as J[]).flatMap((j) => {
    const ends = (["a", "b", "far"] as const).filter((s) => j[s] && countOf(j[s]!.node, j[s]!.port));
    if (!ends.length) return [j];
    const count = countOf(j[ends[0]!]!.node, j[ends[0]!]!.port)!;
    return Array.from({ length: count }, (_, k) => {
      const copy: J = { ...j, id: `${j.id}-${k + 1}` };
      for (const s of ends) copy[s] = { ...j[s]!, port: repeatedName(j[s]!.port, k + 1) };
      return copy;
    });
  }) as ArchitectOutput["joints"];
  return out;
}
