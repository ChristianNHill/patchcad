import { useState } from "react";
import { useStudio } from "./store.js";

/** Prompt bar (header) + plan approval overlay. Planning is CAD-only in the
 * studio; the web-code backend still runs existing projects. */

/** The one plan form — the header bar and Welcome render it with their own
 * classes and copy; the goal state, 4-char guard and cad-only plan call are
 * shared. */
export function PlanForm(p: {
  className: string;
  inputClassName: string;
  placeholder: string;
  ariaLabel: string;
  label: string;
  autoFocus?: boolean;
  /** extra reason to be busy (welcome: an import is running) */
  busy?: boolean;
  /** welcome also disables the button until the goal is long enough */
  requireGoal?: boolean;
}) {
  const planState = useStudio((s) => s.planState);
  const plan = useStudio((s) => s.plan);
  const [goal, setGoal] = useState("");

  const planning = planState.status === "planning";
  const busy = planning || !!p.busy;

  return (
    <form
      className={p.className}
      onSubmit={(e) => {
        e.preventDefault();
        if (goal.trim().length >= 4 && !busy) void plan(goal.trim(), "cad");
      }}
    >
      <input
        className={p.inputClassName}
        autoFocus={p.autoFocus}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder={p.placeholder}
        aria-label={p.ariaLabel}
      />
      <button
        type="submit"
        className="btn btn--primary"
        disabled={busy || (p.requireGoal === true && goal.trim().length < 4)}
        data-state={planning ? "loading" : undefined}
      >
        {planning ? "planning…" : p.label}
      </button>
    </form>
  );
}

export function PlanBar() {
  return (
    <PlanForm
      className="plan-form"
      inputClassName="input"
      placeholder="plan printed parts…"
      ariaLabel="goal"
      label="plan"
    />
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
