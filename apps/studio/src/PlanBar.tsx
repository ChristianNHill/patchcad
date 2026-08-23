import { useEffect, useState } from "react";
import { BusyButton } from "./BusyButton.js";
import { Modal } from "./Modal.js";
import { useStudio, type PlanPhase } from "./store.js";

/** Prompt bar (header) + plan approval overlay. Planning is CAD-only in the
 * studio; the web-code backend still runs existing projects. */

/** The architect runs one long call plus up to three lint-repair rounds. The
 *  whole of it used to be a button reading "planning…", so a 90-second wait was
 *  indistinguishable from a hang. Named steps, elapsed time, and a way out. */
const STEPS: { key: PlanPhase; label: string }[] = [
  { key: "drafting", label: "reading the goal and drafting parts" },
  { key: "checking", label: "checking how the parts wire together" },
  { key: "repairing", label: "fixing what the checks caught" },
];

const elapsed = (since: number) => `${Math.max(0, Math.round((Date.now() - since) / 1000))}s`;

export function PlanProgress() {
  const planState = useStudio((s) => s.planState);
  const cancelCook = useStudio((s) => s.cancelCook);
  const [, tick] = useState(0);

  // One timer while planning; the elapsed readout is the honest part — it is
  // the only number here that cannot be wrong.
  useEffect(() => {
    if (planState.status !== "planning") return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [planState.status]);

  if (planState.status !== "planning") return null;
  const reached = STEPS.findIndex((st) => st.key === planState.phase);

  return (
    <div className="plan-progress" role="status" aria-live="polite">
      <div className="plan-progress__head">
        <span className="section__label">Designing</span>
        <span className="plan-progress__time">{elapsed(planState.startedAt)}</span>
      </div>
      <ol className="plan-progress__steps">
        {STEPS.map((st, i) => (
          <li
            key={st.key}
            className="plan-progress__step"
            data-state={i < reached ? "done" : i === reached ? "active" : "waiting"}
          >
            <span className="plan-progress__mark" aria-hidden="true">
              {i < reached ? "✓" : i === reached ? "◐" : "○"}
            </span>
            <span>
              {st.label}
              {i === reached && planState.detail ? ` — ${planState.detail}` : ""}
            </span>
          </li>
        ))}
      </ol>
      <button className="btn btn--quiet btn--tiny" onClick={() => void cancelCook()}>
        stop
      </button>
    </div>
  );
}

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
  const [submitting, setSubmitting] = useState(false);

  if (planState.status === "idle" || planState.status === "planning") return null;

  return (
    <Modal label="proposed design" closable={!submitting} onClose={() => void discardPlan()}>
      <>
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
            <h3>proposed design</h3>
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
              {/* THE money button. It had no disabled state and awaited the POST
                  before closing, so a second click sent a second approve. */}
              <BusyButton
                className="btn btn--primary"
                onClick={() => {
                  setSubmitting(true);
                  return approvePlan().finally(() => setSubmitting(false));
                }}
                busyLabel="starting…"
              >
                approve &amp; cook
              </BusyButton>
              <button
                className="btn btn--quiet"
                disabled={submitting}
                onClick={() => void discardPlan()}
              >
                discard
              </button>
            </div>
          </>
        )}
      </>
    </Modal>
  );
}
