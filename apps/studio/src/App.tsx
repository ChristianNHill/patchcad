import { useEffect, useRef } from "react";
import { fmtTokens, useStudio } from "./store.js";
import { Canvas } from "./canvas/Canvas.js";
import { CadViewport } from "./CadViewport.js";
import { Inspector } from "./Inspector.js";
import { PlanBar, PlanOverlay } from "./PlanBar.js";
import { ImportButton } from "./ImportButton.js";
import { Welcome } from "./Welcome.js";

export function App() {
  const graph = useStudio((s) => s.graph);
  const previewUrl = useStudio((s) => s.previewUrl);
  const connect = useStudio((s) => s.connect);
  const setPreviewFrame = useStudio((s) => s.setPreviewFrame);
  const logs = useStudio((s) => s.logs);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    void connect();
  }, [connect]);

  useEffect(() => {
    setPreviewFrame(frameRef.current);
  });

  // Cmd/Ctrl-Z anywhere outside a text control rolls back the last mutation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      void useStudio.getState().undoLast();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!graph) {
    return <div className="app__empty">connecting to the patchcad server on :4100…</div>;
  }

  // Nothing designed yet: the front door is a single question, no chrome.
  if (Object.keys(graph.nodes).length === 0) {
    return (
      <>
        <Welcome />
        <PlanOverlay />
      </>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <button
          className="wordmark wordmark--home"
          onClick={() => void useStudio.getState().closeProject()}
          title="back to the front door — this design stays saved in projects"
        >
          <span className="wordmark__dot" aria-hidden="true">
            ●
          </span>
          patchcad
        </button>
        <PlanBar />
        <ImportButton />
        <CheckerChip />
        <CostChip />
        <DirtyButton />
        <UndoButton />
        <ProjectButton />
        <span className="header__goal" title={graph.brief.goal}>
          {graph.brief.goal}
        </span>
        {logs.length > 0 && (
          <span className="header__log" aria-live="polite">
            {logs[logs.length - 1]}
          </span>
        )}
      </header>

      <div className="app__main">
        <div className="app__canvas">
          <Canvas graph={graph} />
        </div>

        <div className="app__preview">
          {graph.backend === "cad" ? (
            <CadViewport />
          ) : previewUrl ? (
            <iframe ref={frameRef} src={previewUrl} title="live preview" />
          ) : (
            <div className="app__empty">preview offline — is the server running?</div>
          )}
        </div>

        <Inspector graph={graph} />
      </div>

      <PlanOverlay />
      <ProjectPicker />
    </div>
  );
}

function CostChip() {
  const graph = useStudio((s) => s.graph);
  if (!graph) return null;
  let calls = 0;
  let tokens = 0;
  let usd = 0;
  for (const n of Object.values(graph.nodes)) {
    calls += n.cost.calls;
    tokens += n.cost.inputTokens + n.cost.outputTokens;
    usd += n.cost.usd;
  }
  if (calls === 0) return null;
  return (
    <span
      className="checker cost-chip"
      title={`LLM spend on this project — ${calls} call${calls === 1 ? "" : "s"}, ${fmtTokens(tokens)} tokens${usd > 0 ? `, $${usd.toFixed(2)}` : " (local model, $0)"}`}
    >
      {fmtTokens(tokens)} tok{usd > 0 ? ` · $${usd.toFixed(2)}` : ""}
    </span>
  );
}

function UndoButton() {
  const undo = useStudio((s) => s.undo);
  const undoLast = useStudio((s) => s.undoLast);
  const statuses = useStudio((s) => s.statuses);
  const cooking = Object.values(statuses).some((s) =>
    ["queued", "generating", "building", "verifying", "repairing"].includes(s),
  );
  if (undo.depth === 0) return null;
  return (
    <button
      className="btn btn--quiet"
      disabled={cooking}
      onClick={() => void undoLast()}
      title={`⌘Z — ${undo.depth} step${undo.depth === 1 ? "" : "s"} available`}
    >
      undo · {undo.label}
    </button>
  );
}

function ProjectButton() {
  const projectDir = useStudio((s) => s.projectDir);
  const setOpen = useStudio((s) => s.setProjectPickerOpen);
  const name = projectDir?.split("/").pop() ?? "project";
  return (
    <button
      className="btn btn--quiet"
      onClick={() => setOpen(true)}
      title={projectDir ?? undefined}
      aria-haspopup="dialog"
    >
      {name}
    </button>
  );
}

function ProjectPicker() {
  const open = useStudio((s) => s.projectPickerOpen);
  const projects = useStudio((s) => s.projects);
  const projectDir = useStudio((s) => s.projectDir);
  const openProject = useStudio((s) => s.openProject);
  const closeProject = useStudio((s) => s.closeProject);
  const setOpen = useStudio((s) => s.setProjectPickerOpen);
  if (!open) return null;
  return (
    <div className="overlay" role="dialog" aria-label="open a project" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Projects</h2>
          <button className="btn btn--quiet btn--tiny" onClick={() => setOpen(false)}>
            close
          </button>
        </div>
        <div className="project-list">
          <button className="project-list__row project-list__row--new" onClick={() => void closeProject()}>
            <span className="project-list__name">start something new</span>
            <span className="project-list__goal">describe a part or bring a model — this design stays saved</span>
          </button>
          {projects.map((p) => {
            const isActive = p.dir === projectDir;
            return (
              <button
                key={p.dir}
                className="project-list__row"
                data-active={isActive || undefined}
                disabled={isActive}
                onClick={() => void openProject(p.dir)}
              >
                <span className="project-list__name">{p.name}</span>
                <span className="project-list__goal">{p.goal || "—"}</span>
                <span className="project-list__count">
                  {p.nodes} node{p.nodes === 1 ? "" : "s"}
                </span>
              </button>
            );
          })}
          {projects.length === 0 && <div className="inspector__hint">nothing here yet — plan a goal to create the first project</div>}
        </div>
      </div>
    </div>
  );
}

function DirtyButton() {
  const statuses = useStudio((s) => s.statuses);
  const cookDirty = useStudio((s) => s.cookDirty);
  const stale = Object.values(statuses).filter((s) =>
    ["planned", "dirty", "error_code", "error_contract"].includes(s),
  ).length;
  const cooking = Object.values(statuses).some((s) =>
    ["queued", "generating", "building", "verifying", "repairing"].includes(s),
  );
  if (stale === 0) return null;
  return (
    <button
      className="btn btn--warn"
      disabled={cooking}
      data-state={cooking ? "loading" : undefined}
      onClick={() => void cookDirty()}
      title="Regenerates dirty and errored nodes; clean neighbors stay untouched"
    >
      {cooking ? "cooking…" : `re-cook ${stale} dirty`}
    </button>
  );
}

function CheckerChip() {
  const checker = useStudio((s) => s.checker);
  const label =
    checker.status === "clean"
      ? "build clean"
      : checker.status === "checking"
        ? "checking…"
        : `${checker.problems.length} build ${checker.problems.length === 1 ? "problem" : "problems"}`;
  return (
    <span
      className="checker"
      data-status={checker.status}
      title={checker.problems.slice(0, 6).join("\n") || "the assembled graph bundles cleanly"}
    >
      {label}
    </span>
  );
}
