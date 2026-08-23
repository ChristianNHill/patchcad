import { useState } from "react";
import { computeDirtySet, isCooking, type CookFailure, type GraphDoc, type NodeRecord } from "@patchcad/shared";
import { fmtTokens, useStudio } from "./store.js";
import { BusyButton } from "./BusyButton.js";
import { groupParams, ParamRow } from "./params.js";
import { MeasurementsSection, RenderSheet } from "./measurements.js";

/** What the attribution means, in words. The engine decides whether a stuck
 *  node is the generator's fault or the architect's; that verdict determines
 *  what the user should DO next, so it has to be legible. */
const ATTRIBUTION: Record<CookFailure["attribution"], string> = {
  "code-invalid": "the generated code was wrong — re-cooking may fix it",
  "contract-infeasible": "the pinned interface may not be buildable — try changing it",
  unknown: "the cause could not be attributed",
};

/** The server has always sent {stage, message, attribution} with a failed
 *  node's status and the studio has always thrown it away, so a node that
 *  burned minutes and real money showed a red dot reading "error_code". */
function FailurePanel({ nodeId }: { nodeId: string }) {
  const failure = useStudio((s) => s.failures[nodeId]);
  if (!failure) return null;
  return (
    <div className="section">
      <span className="section__label">Why it failed</span>
      <div className="failure">
        <div className="failure__head">
          <span className="failure__stage">{failure.stage}</span>
          <span className="failure__attribution">
            {ATTRIBUTION[failure.attribution]}
          </span>
        </div>
        <pre className="failure__message">{failure.message}</pre>
      </div>
    </div>
  );
}

/** Hide keeps the part in the model and out of the output; delete removes it.
 *  Delete is the only confirmed action in the app — everything else gets a
 *  disabled state instead — because it is the only one that discards work the
 *  server cannot reconstruct from the graph. */
function NodeActions({ node, graph }: { node: NodeRecord; graph: GraphDoc }) {
  const setHidden = useStudio((s) => s.setHidden);
  const deleteNode = useStudio((s) => s.deleteNode);
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    const wave = downstreamOf(graph, node.id);
    return (
      <div className="node-actions node-actions--confirm">
        <div className="node-actions__warn">
          delete <strong>{node.title}</strong>?
          {wave.length > 0 && ` ${wave.length} downstream node${wave.length === 1 ? "" : "s"} will go stale.`}
          {" "}⌘Z undoes it.
        </div>
        <div className="node-actions__row">
          <BusyButton
            className="btn btn--warn btn--tiny"
            onClick={() => deleteNode(node.id)}
            busyLabel="deleting…"
          >
            delete
          </BusyButton>
          <button className="btn btn--quiet btn--tiny" onClick={() => setConfirming(false)}>
            keep it
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="node-actions">
      <BusyButton
        aria-pressed={node.hidden}
        onClick={() => setHidden(node.id, !node.hidden)}
        busyLabel="…"
        title={
          node.hidden
            ? "Include this part in the export and the viewport again"
            : "Keep it in the model but leave it out of the export and the viewport. Nothing mated to it moves."
        }
      >
        {node.hidden ? "show" : "hide"}
      </BusyButton>
      <button
        className="btn btn--quiet btn--tiny"
        onClick={() => setConfirming(true)}
        title="Remove this node from the graph"
      >
        delete
      </button>
    </div>
  );
}

export function Inspector({ graph }: { graph: GraphDoc }) {
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const code = useStudio((s) => s.selectedCode);
  const revertTo = useStudio((s) => s.revert);
  const codeLoading = useStudio((s) => s.codeLoading);
  const node = selectedNodeId ? graph.nodes[selectedNodeId] : null;

  if (!node) {
    const cad = graph.backend === "cad";
    return (
      <aside className="inspector">
        <div className="inspector__hint">
          Pick a node on the canvas to see what it promises its neighbors, the
          code that keeps that promise, and every version it has been through.
          <br />
          <br />
          {cad
            ? "Sliders re-execute a part through the kernel instantly; bound params (screw threads, lengths) re-derive on their own."
            : "Describe a change in the node's box and only that node re-cooks — its interface stays pinned, so the rest of the app cannot break."}
        </div>
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <div className="inspector__head">
        <h2 className="inspector__title">{node.title}</h2>
        <div className="inspector__meta">
          {node.kind} · v{node.version} · {node.id}
        </div>
        <NodeActions node={node} graph={graph} />
        <PrintabilityLine nodeId={node.id} />
        {node.cost.calls > 0 && (
          <div className="inspector__meta">
            {node.cost.calls} LLM call{node.cost.calls === 1 ? "" : "s"} ·{" "}
            {fmtTokens(node.cost.inputTokens)} in / {fmtTokens(node.cost.outputTokens)} out
            {node.cost.usd > 0 ? ` · $${node.cost.usd.toFixed(3)}` : ""}
          </div>
        )}
      </div>

      <div className="inspector__body">
      <div className="section">
        <span className="section__label">Generator brief</span>
        <p>{node.spec}</p>
      </div>

      <ParamsSection node={node} />

      <div className="section">
        <span className="section__label">Pinned interface</span>
        <ContractEditor key={node.id + node.contract.hash} node={node} graph={graph} />
        <div className="contract-summary">{node.contract.summary}</div>
        {node.contract.provides.length > 0 && (
          <div style={{ marginTop: "var(--space-xs)" }}>
            <span className="section__label">provides</span>
            {node.contract.provides.map((p) => (
              <div key={p.key} className="contract-line">
                <code>{p.key}</code> <span className="type">({p.type})</span>
              </div>
            ))}
          </div>
        )}
        {node.contract.requires.length > 0 && (
          <div style={{ marginTop: "var(--space-xs)" }}>
            <span className="section__label">requires</span>
            {node.contract.requires.map((p) => (
              <div key={p.key} className="contract-line">
                <code>{p.key}</code> <span className="type">({p.type})</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {node.kind === "imported" && <SegmentBox nodeId={node.id} />}

      <div className="section">
        <span className="section__label">Change only this node</span>
        <RepromptBox nodeId={node.id} />
        <ProposalCard nodeId={node.id} />
        {node.thread.length > 0 && (
          <div className="thread">
            {node.thread.slice(-4).map((m, i) => (
              <div
                key={i}
                className={`thread__msg${m.role === "user" ? " thread__msg--user" : ""}`}
              >
                <span className="thread__who">{m.role === "user" ? "you" : "generator"}</span>{" "}
                {m.content.slice(0, 200)}
              </div>
            ))}
          </div>
        )}
      </div>

      <FailurePanel nodeId={node.id} />

      <MeasurementsSection node={node} />

      {graph.backend === "cad" && (
        <RenderSheet nodeId={node.id} cooked={!!node.artifact} />
      )}

      {node.history.length > 0 && (
        <div className="section">
          <span className="section__label">Versions</span>
          <div className="history">
            {[...node.history].reverse().slice(0, 5).map((h) => (
              <div key={h.version} className="history__row">
                <span className="history__meta">
                  v{h.version} · {h.cause}
                </span>
                {h.version !== node.version ? (
                  <BusyButton
                    onClick={() => revertTo(node.id, h.version)}
                    busyLabel="reverting…"
                  >
                    revert
                  </BusyButton>
                ) : (
                  <span className="history__current">current</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="section section--grow">
        <span className="section__label">{graph.backend === "cad" ? "Geometry code" : "Module source"}</span>
        <pre className="code-view">
          {code || (codeLoading ? "loading…" : "not cooked yet — nothing generated for this node so far")}
        </pre>
      </div>
      </div>
    </aside>
  );
}

/** Every param, grouped — the node face only has room for the first three.
 * T0: each edit is a postMessage plus a debounced persist, never an LLM call. */
function ParamsSection({ node }: { node: NodeRecord }) {
  const pushParam = useStudio((s) => s.pushParam);
  const live = useStudio((s) => s.graph?.nodes[node.id]?.params ?? node.params);
  if (node.contract.params.length === 0) return null;

  return (
    <div className="section">
      <span className="section__label">Parameters</span>
      {groupParams(node.contract.params).map(({ group, params }) => (
        <div key={group || "_"} className="param-group">
          {group && <span className="param-group__label">{group}</span>}
          {params.map((p) => (
            <ParamRow
              key={p.name}
              decl={p}
              value={live[p.name] ?? p.default}
              onChange={(v) => pushParam(node.id, p.name, v)}
              describe
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Split an imported mesh where it naturally separates (necks, bulges —
 * "break out the orbs"). Each piece becomes its own node, jointed at the cuts. */
function SegmentBox({ nodeId }: { nodeId: string }) {
  const segmentNode = useStudio((s) => s.segmentNode);
  const [joints, setJoints] = useState<"none" | "holes" | "pegs">("pegs");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div className="section">
      <span className="section__label">Split where it naturally separates</span>
      <div className="segment-box">
        <select className="input" value={joints} onChange={(e) => setJoints(e.target.value as never)} aria-label="joint type at cuts">
          <option value="pegs">with alignment pegs (slip fit)</option>
          <option value="holes">with screw holes</option>
          <option value="none">plain cuts</option>
        </select>
        <button
          className="btn btn--quiet"
          disabled={busy}
          data-state={busy ? "loading" : undefined}
          onClick={() => {
            setBusy(true);
            setNotice(null);
            void segmentNode(nodeId, joints)
              .then((msg) => setNotice(msg))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "cutting…" : "split into pieces"}
        </button>
      </div>
      {notice && <div className="inspector__meta">{notice}</div>}
    </div>
  );
}

/** DfAM signal (CADClamp-derived): advisory, filled by the CAD viewport fetch. */
function PrintabilityLine({ nodeId }: { nodeId: string }) {
  const p = useStudio((s) => s.printability[nodeId]);
  if (!p || p.composite === undefined) return null;
  const wall = p.min_wall ? ` · thinnest wall ${p.min_wall.thin_wall_p2_mm.toFixed(1)}mm` : "";
  const overhang =
    p.overhang && p.overhang.fail_area_fraction > 0.001
      ? ` · ${(p.overhang.fail_area_fraction * 100).toFixed(1)}% steep overhang`
      : "";
  return (
    <div className="inspector__meta" title="printability: 1.0 prints clean on FDM; low values need redesign or supports">
      printability {p.composite.toFixed(2)}{wall}{overhang}
    </div>
  );
}

/** T2 surface: edit the contract as JSON. A shape change marks this node and
 * its port-affected descendants dirty (amber) for the re-cook wave. */
/** The same traversal the server runs, so the blast radius shown here is the
 *  one that will actually happen — not a second implementation that can drift. */
function downstreamOf(graph: GraphDoc, nodeId: string): string[] {
  return [
    ...computeDirtySet(
      graph,
      nodeId,
      graph.edges.filter((e) => e.from === nodeId).map((e) => e.fromPort),
    ),
  ];
}

function ContractEditor({ node, graph }: { node: GraphDoc["nodes"][string]; graph: GraphDoc }) {
  const updateContract = useStudio((s) => s.updateContract);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const wave = downstreamOf(graph, node.id);

  if (!open) {
    return (
      <button
        className="btn btn--quiet btn--tiny contract-edit-toggle"
        onClick={() => {
          const { hash: _hash, ...editable } = node.contract;
          setText(JSON.stringify(editable, null, 2));
          setError(null);
          setOpen(true);
        }}
      >
        edit interface
      </button>
    );
  }

  return (
    <div className="contract-editor">
      <textarea
        className="input contract-editor__text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label="interface JSON"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "contract-error" : undefined}
      />
      {error && (
        <div className="contract-editor__error" id="contract-error">
          {error}
        </div>
      )}
      {/* The T3 proposal card shows exactly this before the architect's change;
          the manual editor dirtied the same wave and said nothing. */}
      <div className="proposal__impact">
        a shape change re-cooks this node
        {wave.length > 0 && (
          <>
            {" "}
            and up to {wave.length} downstream — <code>{wave.join(", ")}</code>
          </>
        )}
      </div>
      <div className="contract-editor__actions">
        <button
          className="btn btn--primary btn--tiny"
          onClick={() => {
            void (async () => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(text);
              } catch (err) {
                setError(`invalid JSON: ${(err as Error).message}`);
                return;
              }
              const result = await updateContract(node.id, parsed);
              if (!result.ok) {
                setError(result.error ?? "update failed");
                return;
              }
              setOpen(false);
            })();
          }}
        >
          apply
        </button>
        <button className="btn btn--quiet btn--tiny" onClick={() => setOpen(false)}>
          cancel
        </button>
      </div>
    </div>
  );
}

function RepromptBox({ nodeId }: { nodeId: string }) {
  const reprompt = useStudio((s) => s.reprompt);
  const backend = useStudio((s) => s.graph?.backend);
  const status = useStudio((s) => s.statuses[nodeId]);
  const [text, setText] = useState("");
  const [routing, setRouting] = useState(false);
  const [routed, setRouted] = useState<{ tier: "T2" | "T3"; reason: string } | null>(null);
  const cooking = !!status && isCooking(status);
  const busy = cooking || routing;

  return (
    <>
      <form
        className="reprompt"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim().length >= 2 && !busy) {
            const message = text.trim();
            setText("");
            setRouted(null);
            setRouting(true);
            void reprompt(nodeId, message)
              .then((r) => setRouted(r))
              .finally(() => setRouting(false));
          }
        }}
      >
        <input
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={backend === "cad" ? "add a fillet, drill a hole, thicken a wall…" : "rename the button, add sorting, restyle the rows…"}
          aria-label="describe a change to this part"
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy}
          data-state={busy ? "loading" : undefined}
          title="Asks that fit the pinned interface re-cook this node alone; anything that changes the interface goes to the architect first"
        >
          {routing ? "routing…" : cooking ? "cooking…" : "re-cook"}
        </button>
      </form>
      {routed && (
        <div className="tier-note">
          <span
            className={`tier-badge tier-badge--${routed.tier.toLowerCase()}`}
            title={
              routed.tier === "T2"
                ? "T2 — this node only. Its interface is pinned, so neighbours cannot break."
                : "T3 — the interface itself has to change, so the architect proposes it first."
            }
          >
            {routed.tier === "T2" ? "this node only" : "interface change"}
          </span>
          {routed.reason}
        </div>
      )}
    </>
  );
}

/** A T3 renegotiation waiting for approval: the architect's proposed contract
 * change plus its blast radius. Nothing applies until the user accepts. */
function ProposalCard({ nodeId }: { nodeId: string }) {
  const proposal = useStudio((s) => s.proposal);
  const acceptProposal = useStudio((s) => s.acceptProposal);
  const rejectProposal = useStudio((s) => s.rejectProposal);
  if (!proposal || proposal.nodeId !== nodeId) return null;

  const waveSize = 1 + proposal.dirtied.length;
  return (
    <div className="proposal" role="region" aria-label="proposed interface change">
      <div className="proposal__head">
        <span className="tier-badge tier-badge--t3" title="T3 — an interface change, so it needs your approval first">
          interface change
        </span>
        <span className="proposal__title">the architect wants to change this interface</span>
      </div>
      <p className="proposal__rationale">{proposal.rationale}</p>
      {proposal.notes.length > 0 && (
        <ul className="proposal__notes">
          {proposal.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {proposal.constraintsApplied.length > 0 && (
        <div className="proposal__guard">
          {proposal.constraintsApplied.map((c, i) => (
            <div key={i}>guard: {c}</div>
          ))}
        </div>
      )}
      <div className="proposal__impact">
        re-cooks {waveSize} node{waveSize === 1 ? "" : "s"}
        {proposal.dirtied.length > 0 && (
          <>
            {" "}
            — <code>{[nodeId, ...proposal.dirtied].join(", ")}</code>
          </>
        )}
      </div>
      <div className="proposal__actions">
        <BusyButton
          className="btn btn--primary btn--tiny"
          onClick={acceptProposal}
          busyLabel="applying…"
        >
          apply &amp; re-cook
        </BusyButton>
        <button className="btn btn--quiet btn--tiny" onClick={() => void rejectProposal()}>
          discard
        </button>
      </div>
    </div>
  );
}
