import { useEffect, useRef, type ReactNode } from "react";

/**
 * The app had three hand-rolled overlays and none of them had Esc, a focus
 * trap, or an initial focus; the plan overlay claimed `aria-modal="true"` while
 * Tab walked straight out of it into the canvas behind.
 *
 * `<dialog>` + `showModal()` gives all three for free, plus `::backdrop` and
 * top-layer stacking, so there is no reason to hand-roll them.
 */
export function Modal({
  label,
  onClose,
  closable = true,
  children,
}: {
  label: string;
  onClose: () => void;
  /** False while a request is in flight — Esc and backdrop stop dismissing. */
  closable?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  // Esc fires `cancel` before `close`; intercepting it is how a busy modal
  // refuses to be dismissed mid-request.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      if (closable) onClose();
    };
    el.addEventListener("cancel", onCancel);
    return () => el.removeEventListener("cancel", onCancel);
  }, [closable, onClose]);

  return (
    <dialog
      ref={ref}
      className="modal-host"
      aria-label={label}
      // A click that lands on the dialog element itself is a backdrop click:
      // the content sits in a child, so it never matches.
      onClick={(e) => {
        if (e.target === ref.current && closable) onClose();
      }}
    >
      <div className="modal">{children}</div>
    </dialog>
  );
}
