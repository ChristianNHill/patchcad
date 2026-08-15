import { useRef, useState } from "react";
import { useStudio } from "./store.js";

/** Bring an existing CAD file (STL / STEP / 3MF / OBJ) into the graph system:
 * multi-body files become one node per body; a single solid can be cut into
 * pieces whose cut faces become mating contracts — optionally with joining
 * holes sized to a chosen thread. */
export function ImportButton() {
  const importCad = useStudio((s) => s.importCad);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pieces, setPieces] = useState(1);
  const [joints, setJoints] = useState<"none" | "holes" | "pegs">("pegs");
  const [thread, setThread] = useState<"M3" | "M4" | "M5">("M4");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".stl,.step,.stp,.3mf,.obj"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            setFile(f);
            setError(null);
          }
          e.target.value = "";
        }}
      />
      <button className="btn btn--quiet" onClick={() => fileRef.current?.click()}>
        import
      </button>

      {file && (
        <div className="overlay" role="dialog" aria-label="import a CAD file" onClick={() => !busy && setFile(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h2 className="modal__title">{file.name}</h2>
              <button className="btn btn--quiet btn--tiny" disabled={busy} onClick={() => setFile(null)}>
                close
              </button>
            </div>
            <div className="import-opts">
              <label className="import-opts__row">
                <span>split into</span>
                <select className="input" value={pieces} onChange={(e) => setPieces(Number(e.target.value))}>
                  <option value={1}>keep whole (one node per body)</option>
                  <option value={0}>where the shape naturally separates</option>
                  <option value={2}>2 equal pieces</option>
                  <option value={3}>3 equal pieces</option>
                  <option value={4}>4 equal pieces</option>
                </select>
              </label>
              <label className="import-opts__row">
                <span>joints at each cut</span>
                <select
                  className="input"
                  value={joints}
                  disabled={pieces === 1}
                  onChange={(e) => setJoints(e.target.value as "none" | "holes" | "pegs")}
                >
                  <option value="pegs">alignment pegs (Ø5, slip fit)</option>
                  <option value="holes">screw holes</option>
                  <option value="none">plain cuts</option>
                </select>
                {joints === "holes" && (
                  <select
                    className="input"
                    value={thread}
                    disabled={pieces === 1}
                    onChange={(e) => setThread(e.target.value as "M3" | "M4" | "M5")}
                  >
                    <option>M3</option>
                    <option>M4</option>
                    <option>M5</option>
                  </select>
                )}
              </label>
              <p className="import-opts__hint">
                Cut faces become mating ports, so the pieces reassemble in the viewport and every piece is a
                reprompt-able node. Pegs print 0.3&nbsp;mm smaller than their sockets so the pieces actually fit.
              </p>
              {error && <div className="contract-editor__error">{error}</div>}
            </div>
            <div className="modal__actions">
              <button
                className="btn btn--primary"
                disabled={busy}
                data-state={busy ? "loading" : undefined}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void importCad(file, { pieces, joints: pieces === 1 ? "none" : joints, thread })
                    .then((err) => {
                      if (err) setError(err);
                      else setFile(null);
                    })
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? "importing…" : "import & cook"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
