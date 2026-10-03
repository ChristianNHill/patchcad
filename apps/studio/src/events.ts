import type { EngineEvent, GraphDoc, NodeRecord } from "@patchcad/shared";

/** One socket carries every project's events, and a project switched away from
 *  keeps cooking. graph:replaced IS the switch, and plan:phase is keyed by the
 *  slug of a project that does not exist yet; everything else must match. */
export function belongsToOpenProject(event: EngineEvent, graphId: string | undefined): boolean {
  if (event.type === "graph:replaced" || event.type === "plan:phase") return true;
  return event.projectId === graphId;
}

/** Swap in a fresh record from the server. A late update for a node that has
 *  since been deleted must not resurrect it. */
export function mergeNode(graph: GraphDoc, node: NodeRecord): GraphDoc {
  if (!graph.nodes[node.id]) return graph;
  return { ...graph, nodes: { ...graph.nodes, [node.id]: node } };
}
