import { useEffect, useRef, useState } from "react";
import { PlanForm, PlanProgress } from "./PlanBar.js";
import { PlanReferences } from "./ImageDrop.js";
import { useStudio, type ProjectEntry } from "./store.js";

/** The front door: an empty project shows nothing but the question that
 * matters — describe what you want to design, or bring geometry you already
 * have. All studio chrome stays hidden until there is a graph to show. */
export function Welcome() {
  const planState = useStudio((s) => s.planState);
  const importCad = useStudio((s) => s.importCad);
  const projects = useStudio((s) => s.projects);
  const loadProjects = useStudio((s) => s.loadProjects);
  const openProject = useStudio((s) => s.openProject);
  const status = useStudio((s) => s.status);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const busy = planState.status === "planning" || importing;
  const yours = projects.filter((p) => !p.example);
  const examples = projects.filter((p) => p.example);
  // Unknown until /api/status answers; only a definite "none" earns the banner.
  const noProvider = status !== null && status.provider === null;

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

        {noProvider && (
          <div className="banner" role="status">
            <strong>No model is configured, so planning is off.</strong> Importing a model and
            opening an example still work. {status.providerHelp}
          </div>
        )}

        <PlanForm
          className="welcome__form"
          inputClassName="input welcome__input"
          autoFocus
          placeholder="a wall mount for my headphones, printable in one piece…"
          ariaLabel="what to design"
          label="design it"
          busy={importing}
          requireGoal
        />

        <PlanReferences disabled={busy} />

        <PlanProgress />

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

        {yours.length > 0 && (
          <div className="welcome__recent">
            <span className="section__label">or pick up where you left off</span>
            {yours.slice(0, 6).map((p) => (
              <ProjectRow key={p.dir} project={p} onOpen={openProject} />
            ))}
          </div>
        )}

        {examples.length > 0 && (
          <div className="welcome__recent">
            <span className="section__label">or try an example (no model needed to open one)</span>
            {examples.map((p) => (
              <ProjectRow key={p.dir} project={p} onOpen={openProject} />
            ))}
          </div>
        )}

        <p className="welcome__how">
          An architect model breaks your idea into parts with pinned interfaces, then
          <em> cooks</em> each one — writes its geometry, verifies it against the interface, and
          shows it live. Reshape any single part afterwards and the rest stays as it was.
        </p>
      </div>
    </div>
  );
}

function ProjectRow({ project: p, onOpen }: { project: ProjectEntry; onOpen: (dir: string) => Promise<void> }) {
  return (
    <button className="project-list__row" onClick={() => void onOpen(p.dir)}>
      <span className="project-list__name">{p.name}</span>
      <span className="project-list__goal">{p.goal || "—"}</span>
      <span className="project-list__count">
        {p.nodes} node{p.nodes === 1 ? "" : "s"}
      </span>
    </button>
  );
}
