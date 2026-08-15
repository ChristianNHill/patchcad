import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge as FlowEdge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphDoc } from "@patchcad/shared";
import { PatchNode, type PatchNodeType } from "./PatchNode.js";
import { layoutGraph } from "./layout.js";
import { useStudio } from "../store.js";

const nodeTypes = { patch: PatchNode };

export function Canvas({ graph }: { graph: GraphDoc }) {
  const selectNode = useStudio((s) => s.selectNode);
  const [nodes, setNodes] = useState<PatchNodeType[]>([]);

  // Layout runs when the topology changes (not on every param tweak).
  const topologyKey = useMemo(
    () =>
      Object.keys(graph.nodes).sort().join(",") +
      "|" +
      graph.edges.map((e) => e.id).sort().join(","),
    [graph],
  );

  useEffect(() => {
    let cancelled = false;
    void layoutGraph(graph).then((positions) => {
      if (cancelled) return;
      setNodes(
        positions.map((p) => ({
          id: p.id,
          type: "patch" as const,
          position: { x: p.x, y: p.y },
          data: { record: graph.nodes[p.id]! },
        })),
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyKey]);

  // Keep node data fresh without relayout.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => ({ ...n, data: { record: graph.nodes[n.id] ?? n.data.record } })),
    );
  }, [graph]);

  const edges: FlowEdge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.from,
        sourceHandle: e.fromPort,
        target: e.to,
        targetHandle: e.toPort,
      })),
    [graph],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={(changes) => {
        setNodes((prev) => {
          const next = [...prev];
          for (const change of changes) {
            if (change.type === "position" && change.position) {
              const i = next.findIndex((n) => n.id === change.id);
              if (i >= 0) next[i] = { ...next[i]!, position: change.position };
            }
          }
          return next;
        });
      }}
      onNodeClick={(_e, node) => void selectNode(node.id)}
      onPaneClick={() => void selectNode(null)}
      fitView
      proOptions={{ hideAttribution: true }}
      style={{ background: "var(--color-paper)" }}
    >
      <Background color="var(--color-rule-2)" gap={26} size={1.5} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        bgColor="var(--color-paper-2)"
        nodeColor={() => "var(--color-rule)"}
        maskColor="var(--minimap-mask)"
      />
    </ReactFlow>
  );
}
