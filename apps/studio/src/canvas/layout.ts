import ELK from "elkjs/lib/elk.bundled.js";
import type { GraphDoc } from "@patchcad/shared";

const elk = new ELK();

export interface Positioned {
  id: string;
  x: number;
  y: number;
}

const NODE_WIDTH = 240;

function nodeHeight(paramCount: number): number {
  return 88 + Math.min(paramCount, 3) * 34;
}

/** ELK layered layout, left→right. Manual positions in graph.layout win. */
export async function layoutGraph(graph: GraphDoc): Promise<Positioned[]> {
  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
    },
    children: Object.values(graph.nodes).map((n) => ({
      id: n.id,
      width: NODE_WIDTH,
      height: nodeHeight(n.contract.params.length),
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
    })),
  };

  const result = await elk.layout(elkGraph);
  return (result.children ?? []).map((c) => {
    const manual = graph.layout[c.id];
    return manual?.manual
      ? { id: c.id, x: manual.x, y: manual.y }
      : { id: c.id, x: c.x ?? 0, y: c.y ?? 0 };
  });
}
