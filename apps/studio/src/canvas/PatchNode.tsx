import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { NodeRecord } from "@patchcad/shared";
import { fmtTokens, useStudio } from "../store.js";
import { ParamRow } from "../params.js";
import { KindGlyph } from "./KindGlyph.js";

export type PatchNodeData = {
  record: NodeRecord;
};
export type PatchNodeType = Node<PatchNodeData, "patch">;

export function PatchNode({ data, selected }: NodeProps<PatchNodeType>) {
  const record = data.record;
  const status = useStudio((s) => s.statuses[record.id] ?? record.status);
  const pushParam = useStudio((s) => s.pushParam);
  const liveParams = useStudio(
    (s) => s.graph?.nodes[record.id]?.params ?? record.params,
  );
  // T3 diff overlay: while a proposal is pending, tint its blast radius.
  const proposal = useStudio((s) => s.proposal);
  const proposalRole = !proposal
    ? undefined
    : proposal.nodeId === record.id
      ? "target"
      : proposal.dirtied.includes(record.id)
        ? "wave"
        : undefined;

  // The face is the quick surface; the inspector lists every param, grouped.
  // Keep NODE_PARAM_ROWS in sync with canvas/layout.ts nodeHeight().
  const visibleParams = record.contract.params.slice(0, 3);
  const hiddenParams = record.contract.params.length - visibleParams.length;

  return (
    <div className={`node${selected ? " node--selected" : ""}`} data-proposal={proposalRole}>
      {/* requires → left handles, provides → right handles */}
      {record.contract.requires.map((p, i) => (
        <Handle
          key={p.key}
          id={p.key}
          type="target"
          position={Position.Left}
          className="handle--requires"
          style={{ top: 40 + i * 18 }}
          title={`${p.key}: ${p.type}`}
        />
      ))}
      {record.contract.provides.map((p, i) => (
        <Handle
          key={p.key}
          id={p.key}
          type="source"
          position={Position.Right}
          className="handle--provides"
          style={{ top: 40 + i * 18 }}
          title={`${p.key}: ${p.type}`}
        />
      ))}

      <div className="node__head">
        <span className="node__glyph">
          <KindGlyph kind={record.kind} />
        </span>
        <span className="node__title">{record.title}</span>
        <span className="led" data-status={status} title={status} />
      </div>

      <div className="node__kind">
        {record.kind} · v{record.version}
        {record.cost.calls > 0 && (
          <span className="node__cost" title={`${record.cost.calls} LLM calls`}>
            {" "}
            · {fmtTokens(record.cost.inputTokens + record.cost.outputTokens)} tok
          </span>
        )}
      </div>

      {visibleParams.length > 0 && (
        <div className="node__params">
          {visibleParams.map((p) => (
            <ParamRow
              key={p.name}
              decl={p}
              value={liveParams[p.name] ?? p.default}
              onChange={(v) => pushParam(record.id, p.name, v)}
            />
          ))}
          {hiddenParams > 0 && (
            <span className="node__more" title="select the node to edit every parameter">
              +{hiddenParams} more in the inspector
            </span>
          )}
        </div>
      )}
    </div>
  );
}

