import { useEffect, useState } from "react";
import { API } from "./api.js";
import { BusyButton } from "./BusyButton.js";
import { download } from "./download.js";
import { Modal } from "./Modal.js";
import { useStudio } from "./store.js";

/** The part of `@patchcad/backend-cad` AssemblySequence the panel reads, plus page URLs. */
interface Instructions {
  steps: { n: number; title: string }[];
  sequenceProblems: string[];
  pages: string[];
  error?: string;
}

export function InstructionsButton() {
  const [open, setOpen] = useState(false);
  const backend = useStudio((s) => s.graph?.backend);
  if (backend !== "cad") return null;
  return (
    <>
      <button className="btn btn--quiet" onClick={() => setOpen(true)} aria-haspopup="dialog">
        Instructions
      </button>
      {open && <InstructionsPanel onClose={() => setOpen(false)} />}
    </>
  );
}

/** Steps through the pages the kernel drew; PDF and HTML download the same pages. */
function InstructionsPanel({ onClose }: { onClose: () => void }) {
  const [doc, setDoc] = useState<Instructions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const rev = useStudio((s) => s.graph?.rev);

  useEffect(() => {
    let live = true;
    setDoc(null);
    fetch(`${API}/api/project/instructions`)
      .then(async (r) => {
        const body = (await r.json()) as Instructions & { error?: string };
        if (!live) return;
        if (!r.ok) return setError(body.error ?? `HTTP ${r.status}`);
        setDoc(body);
        setPage((p) => Math.min(p, Math.max(0, body.pages.length - 1)));
        setError(body.error ?? null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [rev]);

  const save = async (format: "pdf" | "html") => setError(await download(`/api/project/instructions?format=${format}`, `instructions.${format}`));
  const pages = doc?.pages ?? [];

  return (
    <Modal label="assembly instructions" onClose={onClose}>
      <div className="modal__head">
        <h2 className="modal__title">Assembly instructions</h2>
        <span className="modal__actions">
          <BusyButton onClick={() => save("pdf")} busyLabel="PDF…">
            PDF
          </BusyButton>
          <BusyButton onClick={() => save("html")} busyLabel="HTML…">
            HTML
          </BusyButton>
          <button className="btn btn--quiet btn--tiny" onClick={onClose}>
            close
          </button>
        </span>
      </div>
      {error && <p className="modal__error">{error}</p>}
      {!doc && !error && <p className="modal__meta">sequencing and drawing…</p>}
      {doc && doc.sequenceProblems.length > 0 && (
        <ul className="instructions__problems">
          {doc.sequenceProblems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {pages.length > 0 && (
        <div className="instructions">
          <img className="instructions__page" src={pages[page]} alt={`page ${page + 1} of ${pages.length}`} />
          <div className="instructions__nav">
            <button className="btn btn--quiet btn--tiny" disabled={page === 0} onClick={() => setPage(page - 1)}>
              previous
            </button>
            <span className="modal__meta">
              page {page + 1} / {pages.length} · {doc!.steps.length} steps
            </span>
            <button className="btn btn--quiet btn--tiny" disabled={page >= pages.length - 1} onClick={() => setPage(page + 1)}>
              next
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
