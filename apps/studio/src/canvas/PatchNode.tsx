import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { NodeRecord, ParamValue } from "@patchcad/shared";
import { fmtTokens, useStudio } from "../store.js";
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

  const visibleParams = record.contract.params.slice(0, 3);

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
            <ParamControl
              key={p.name}
              decl={p}
              value={liveParams[p.name] ?? p.default}
              onChange={(v) => pushParam(record.id, p.name, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ParamControl({
  decl,
  value,
  onChange,
}: {
  decl: NodeRecord["contract"]["params"][number];
  value: ParamValue;
  onChange: (v: ParamValue) => void;
}) {
  const row = (control: React.ReactNode, showValue = false) => (
    <label className="param nodrag" title={decl.description || decl.name}>
      <span className="param__name">{decl.name}</span>
      {control}
      {showValue && <span className="param__value">{String(value)}</span>}
    </label>
  );

  switch (decl.type) {
    case "number":
      return row(
        <input
          type="range"
          min={decl.min ?? 0}
          max={decl.max ?? 100}
          step={decl.step ?? 1}
          value={Number(value)}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={decl.name}
        />,
        true,
      );
    case "boolean":
      return row(
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={decl.name}
        />,
      );
    case "enum":
      return row(
        <select
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={decl.name}
        >
          {decl.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>,
      );
    case "color":
      return row(
        <input
          type="color"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={decl.name}
        />,
      );
    default:
      return row(
        <input
          type="text"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={decl.name}
        />,
      );
  }
}
