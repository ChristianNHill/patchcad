import ELK from "elkjs/lib/elk.bundled.js";
import type { GraphDoc } from "@patchcad/shared";

const elk = new ELK();

export interface Positioned {
  id: string;
  x: number;
  y: number;
}

const NODE_WIDTH = 240;

/** Mirrors PatchNode's face: at most 3 param rows, plus an overflow line when
 *  there are more. ELK overlaps nodes if this drifts from what renders. */
const MAX_FACE_PARAMS = 3;

function nodeHeight(paramCount: number): number {
  const rows = Math.min(paramCount, MAX_FACE_PARAMS);
  const overflow = paramCount > MAX_FACE_PARAMS ? 16 : 0;
  return 88 + rows * 34 + overflow;
}

/** ELK layered layout, left→right. */
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
  return (result.children ?? []).map((c) => ({ id: c.id, x: c.x ?? 0, y: c.y ?? 0 }));
}
