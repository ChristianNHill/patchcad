import { useEffect, useRef, useState } from "react";
import { useStudio } from "./store.js";

/** The front door: an empty project shows nothing but the question that
 * matters — describe what you want to design, or bring geometry you already
 * have. All studio chrome stays hidden until there is a graph to show. */
export function Welcome() {
  const plan = useStudio((s) => s.plan);
  const planState = useStudio((s) => s.planState);
  const importCad = useStudio((s) => s.importCad);
  const projects = useStudio((s) => s.projects);
  const loadProjects = useStudio((s) => s.loadProjects);
  const openProject = useStudio((s) => s.openProject);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);
  const [goal, setGoal] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const busy = planState.status === "planning" || importing;

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <span className="wordmark welcome__mark">
          <span className="wordmark__dot" aria-hidden="true">
            ●
          </span>
          patchcad
        </span>
        <h1 className="welcome__ask">What do you want to design?</h1>

        <form
          className="welcome__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (goal.trim().length >= 4 && !busy) void plan(goal.trim(), "cad");
          }}
        >
          <input
            className="input welcome__input"
            autoFocus
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="a wall mount for my headphones, printable in one piece…"
            aria-label="what to design"
          />
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || goal.trim().length < 4}
            data-state={planState.status === "planning" ? "loading" : undefined}
          >
            {planState.status === "planning" ? "planning…" : "design it"}
          </button>
        </form>

        <div className="welcome__or">or</div>

        <input
          ref={fileRef}
          type="file"
          accept=".stl,.step,.stp,.3mf,.obj"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setImporting(true);
            setImportError(null);
            void importCad(f, { pieces: 1, joints: "none", thread: "M4" })
              .then((err) => setImportError(err))
              .finally(() => setImporting(false));
          }}
        />
        <button className="btn btn--quiet welcome__import" disabled={busy} onClick={() => fileRef.current?.click()}>
          {importing ? "importing…" : "bring a model you already have (STL · STEP · 3MF)"}
        </button>

        {planState.status === "error" && <div className="contract-editor__error">{planState.message}</div>}
        {importError && <div className="contract-editor__error">{importError}</div>}

        {projects.length > 0 && (
          <div className="welcome__recent">
            <span className="section__label">or pick up where you left off</span>
            {projects.slice(0, 6).map((p) => (
              <button key={p.dir} className="project-list__row" onClick={() => void openProject(p.dir)}>
                <span className="project-list__name">{p.name}</span>
                <span className="project-list__goal">{p.goal || "—"}</span>
                <span className="project-list__count">
                  {p.nodes} node{p.nodes === 1 ? "" : "s"}
                </span>
              </button>
            ))}
          </div>
        )}

        <p className="welcome__how">
          An architect model breaks your idea into parts with pinned interfaces; each part is
          built, verified, and shown live — then you reshape any single part without breaking the rest.
        </p>
      </div>
    </div>
  );
}
