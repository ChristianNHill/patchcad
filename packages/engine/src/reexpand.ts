import { computeDirtySet, type GraphDoc } from "@patchcad/shared";
import { architectOutputToGraph, type ArchitectOutput } from "./architect.js";
import type { DomainBackend } from "./backend.js";
import { contractHash, diffContract } from "./graph/diff.js";

/**
 * Re-running a domain's plan expansion on a LIVE graph, after a joint's intent
 * or a wall it depends on changed. Expansion is deterministic, so the new plan
 * differs from the old only where the change reaches; every node whose
 * contract moved goes through diffContract, and the dirty set is the
 * port-granular one a contract edit would produce. Nothing here sets a status:
 * the caller owns the store and its legal transitions.
 */

export interface Reexpansion {
  graph: GraphDoc;
  added: string[];
  removed: string[];
  /** Nodes whose contract changed, each with what changed. */
  changed: { id: string; notes: string[] }[];
  /** `changed` plus everything downstream of their shape-changed ports. */
  dirty: string[];
}

/** A graph as the emission that would have produced it. */
export function graphAsArchitectOutput(graph: GraphDoc): ArchitectOutput {
  return {
    nodes: Object.values(graph.nodes).map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      spec: n.spec,
      contract: {
        name: n.contract.name,
        summary: n.contract.summary,
        params: n.contract.params,
        provides: n.contract.provides,
        requires: n.contract.requires,
        payload: n.contract.payload,
      },
    })) as ArchitectOutput["nodes"],
    edges: graph.edges.map(({ from, fromPort, to, toPort }) => ({ from, fromPort, to, toPort })),
    entryNodeId: graph.assembly.entryNodeId,
    rationale: "",
    design: graph.brief.design,
    joints: graph.joints ?? [],
  };
}

export function reexpandGraph(graph: GraphDoc, backend: DomainBackend<unknown>): Reexpansion | null {
  const expand = backend.planning.expandPlan;
  if (!expand) return null;
  const fresh = architectOutputToGraph(
    expand(
      structuredClone(graphAsArchitectOutput(graph)),
      Object.fromEntries(Object.values(graph.nodes).map((n) => [n.id, n.params])),
    ),
    graph.id,
    graph.backend,
    graph.brief.goal,
    backend.planning.paramUnit,
  );
  const next: GraphDoc = { ...structuredClone(graph), nodes: {}, edges: [], joints: fresh.joints };
  const added: string[] = [];
  const changed: Reexpansion["changed"] = [];
  const shapeMoved = new Map<string, string[]>();
  for (const [id, n] of Object.entries(fresh.nodes)) {
    const old = graph.nodes[id];
    if (!old) {
      next.nodes[id] = n;
      added.push(id);
      continue;
    }
    // Presentation the user chose (param groups) survives; it is outside the
    // hash, so it never decides whether anything changed.
    const params = n.contract.params.map((p) => {
      const ui = old.contract.params.find((q) => q.name === p.name)?.ui;
      return ui ? { ...p, ui } : p;
    });
    const contract = { ...n.contract, params, hash: "" };
    contract.hash = contractHash(contract);
    const diff = diffContract(old.contract, contract);
    next.nodes[id] = structuredClone({ ...old, contract: diff.changed ? contract : old.contract });
    if (!diff.changed) continue;
    changed.push({ id, notes: diff.notes });
    if (diff.shapeChanged) shapeMoved.set(id, diff.shapeChangedProvides);
  }
  const key = (e: { from: string; fromPort: string; to: string; toPort: string }) => `${e.from}.${e.fromPort}>${e.to}.${e.toPort}`;
  const kept = new Map(graph.edges.map((e) => [key(e), e.id]));
  next.edges = fresh.edges.map((e) => ({ ...e, id: kept.get(key(e)) ?? e.id }));
  const removed = Object.keys(graph.nodes).filter((id) => !fresh.nodes[id]);
  if (removed.includes(next.assembly.entryNodeId)) next.assembly.entryNodeId = Object.keys(next.nodes)[0] ?? "";
  const dirty = new Set(changed.map((c) => c.id));
  for (const [id, ports] of shapeMoved) for (const d of computeDirtySet(next, id, ports)) dirty.add(d);
  return { graph: next, added, removed, changed, dirty: [...dirty].filter((id) => next.nodes[id]) };
}
