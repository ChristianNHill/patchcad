import { useState } from "react";
import { useStudio } from "./store.js";

/** Prompt bar (header) + plan approval overlay. Planning is CAD-only in the
 * studio; the web-code backend still runs existing projects. */

export function PlanBar() {
  const planState = useStudio((s) => s.planState);
  const plan = useStudio((s) => s.plan);
  const [goal, setGoal] = useState("");

  const busy = planState.status === "planning";

  return (
    <form
      className="plan-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (goal.trim().length >= 4 && !busy) void plan(goal.trim(), "cad");
      }}
    >
      <input
        className="input"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="plan printed parts…"
        aria-label="goal"
      />
      <button
        type="submit"
        className="btn btn--primary"
        disabled={busy}
        data-state={busy ? "loading" : undefined}
      >
        {busy ? "planning…" : "plan"}
      </button>
    </form>
  );
}

export function PlanOverlay() {
  const planState = useStudio((s) => s.planState);
  const approvePlan = useStudio((s) => s.approvePlan);
  const discardPlan = useStudio((s) => s.discardPlan);

  if (planState.status === "idle" || planState.status === "planning") return null;

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="proposed patch">
      <div className="modal">
        {planState.status === "error" ? (
          <>
            <h3>planning failed</h3>
            <pre className="modal__error">{planState.message}</pre>
            <div className="modal__actions">
              <button className="btn btn--quiet" onClick={() => void discardPlan()}>
                dismiss
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>proposed patch</h3>
            <p className="modal__rationale">{planState.rationale}</p>
            <div className="plan-rows">
              {Object.values(planState.plan.nodes).map((n) => (
                <div key={n.id} className="plan-row">
                  <strong>{n.title}</strong>
                  <span className="plan-row__kind">{n.kind}</span>
                  <div className="plan-row__summary">{n.contract.summary}</div>
                  {n.contract.params.length > 0 && (
                    <div className="plan-row__params">
                      params: {n.contract.params.map((p) => p.name).join(" · ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="modal__meta">
              {Object.keys(planState.plan.nodes).length} nodes ·{" "}
              {planState.plan.edges.length} wires · plan cost ≈ ${planState.usd.toFixed(3)} ·
              approving cooks every node in parallel
            </div>
            <div className="modal__actions">
              <button className="btn btn--primary" onClick={() => void approvePlan()}>
                approve &amp; cook
              </button>
              <button className="btn btn--quiet" onClick={() => void discardPlan()}>
                discard
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
