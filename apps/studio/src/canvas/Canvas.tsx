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
            const i = next.findIndex(
              (n) => n.id === (change as { id?: string }).id,
            );
            if (i < 0) continue;
            if (change.type === "position" && change.position) {
              next[i] = { ...next[i]!, position: change.position };
            } else if (change.type === "select") {
              // `nodes` is controlled, so dropping select changes meant
              // node.selected was never true and .node--selected — which has
              // been styled all along — never rendered.
              next[i] = { ...next[i]!, selected: change.selected };
            }
          }
          return next;
        });
      }}
      // NOT onNodeClick: React Flow's keyboard handler selects on Enter/Space
      // but never calls onClick, so the whole inspector was mouse-only.
      onSelectionChange={({ nodes: sel }) => void selectNode(sel[0]?.id ?? null)}
      // React Flow's own delete path is disabled — deletion is a server op with
      // edge surgery and a stale wave, so it routes through the inspector's
      // confirm instead of vanishing a node locally.
      deleteKeyCode={null}
      fitView
      proOptions={{ hideAttribution: true }}
      style={{ background: "var(--color-paper)" }}
    >
      <Background color="var(--color-dot)" gap={26} size={1.5} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        bgColor="var(--color-paper-2)"
        nodeColor={() => "var(--color-ash)"}
        maskColor="var(--minimap-mask)"
      />
    </ReactFlow>
  );
}
