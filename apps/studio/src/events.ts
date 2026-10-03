import type { EngineEvent, GraphDoc, NodeCost, NodeRecord, NodeStatus } from "@patchcad/shared";
import type { StudioState } from "./store";

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

/** Fold one cost event into a cost record, returning a new one. */
const plusCost = (c: NodeCost, e: { inputTokens: number; outputTokens: number; usd: number }): NodeCost => ({
  calls: c.calls + 1,
  inputTokens: c.inputTokens + e.inputTokens,
  outputTokens: c.outputTokens + e.outputTokens,
  usd: c.usd + e.usd,
});

/** The slice of the store the event stream writes. */
export type EventState = Pick<
  StudioState,
  | "graph"
  | "statuses"
  | "failures"
  | "logs"
  | "planState"
  | "cadSceneRev"
  | "checker"
  | "undo"
  | "proposal"
  | "selectedNodeId"
  | "selectedCode"
  | "printability"
>;

/** One socket event → the store patch it causes. Pure: the socket handler
 *  applies the patch and runs the side effects (a refetch) itself. */
export function reduceEvent(s: EventState, event: EngineEvent): Partial<EventState> {
  if (!belongsToOpenProject(event, s.graph?.id)) return {};
  switch (event.type) {
    case "graph:replaced": {
      const statuses: Record<string, NodeStatus> = {};
      for (const n of Object.values(event.graph.nodes)) statuses[n.id] = n.status;
      // A replaced graph invalidates any server-side proposal; a switched one
      // invalidates everything the old project left on screen.
      const switched = s.graph?.id !== event.graph.id;
      const lostSelection = s.selectedNodeId !== null && !event.graph.nodes[s.selectedNodeId];
      return {
        graph: event.graph,
        statuses,
        failures: {},
        ...(switched
          ? { proposal: null, checker: { status: "clean", problems: [] }, logs: [], printability: {} }
          : {}),
        ...(lostSelection ? { selectedNodeId: null, selectedCode: "" } : {}),
      };
    }
    case "node:status": {
      const failures = { ...s.failures };
      // Keep the reason a node failed; clear it the moment it recovers.
      if (event.detail) failures[event.nodeId] = event.detail;
      else delete failures[event.nodeId];
      return { statuses: { ...s.statuses, [event.nodeId]: event.status }, failures };
    }
    case "plan:phase":
      return s.planState.status === "planning"
        ? { planState: { ...s.planState, phase: event.phase, detail: event.detail } }
        : {};
    case "job:log":
      return { logs: [...s.logs.slice(-99), `[${event.nodeId}] ${event.line}`] };
    case "node:committed":
    case "preview:reload":
      return { cadSceneRev: s.cadSceneRev + 1 };
    case "node:updated":
      return s.graph ? { graph: mergeNode(s.graph, event.node) } : {};
    case "checker:status":
      return { checker: { status: event.status, problems: event.problems } };
    case "undo:stack":
      return { undo: { depth: event.depth, label: event.label } };
    case "cost:update": {
      // Fold streamed usage into the local graph so totals stay live.
      if (!s.graph) return {};
      if (event.bucket) {
        const ledger = { ...s.graph.ledger, [event.bucket]: plusCost(s.graph.ledger[event.bucket], event) };
        return { graph: { ...s.graph, ledger } };
      }
      const node = event.nodeId ? s.graph.nodes[event.nodeId] : undefined;
      return node ? { graph: mergeNode(s.graph, { ...node, cost: plusCost(node.cost, event) }) } : {};
    }
  }
}
