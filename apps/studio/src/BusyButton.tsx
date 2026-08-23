import { useState, type ReactNode } from "react";

/**
 * A button whose action is a request. It disables itself for the duration and
 * swaps its label, so the expensive actions in this app cannot be double-fired
 * — `approve & cook` had none of this and a second click sent a second approve.
 *
 * Written six times by hand before it was a component, each copy carrying its
 * own useState, its own `disabled`, its own `data-state` and its own busy label.
 */
export function BusyButton({
  onClick,
  busyLabel,
  children,
  className = "btn btn--quiet btn--tiny",
  disabled = false,
  title,
  "aria-pressed": ariaPressed,
}: {
  onClick: () => Promise<unknown>;
  busyLabel: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  "aria-pressed"?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={busy || disabled}
      data-state={busy ? "loading" : undefined}
      title={title}
      aria-pressed={ariaPressed}
      onClick={() => {
        setBusy(true);
        void onClick().finally(() => setBusy(false));
      }}
    >
      {busy ? busyLabel : children}
    </button>
  );
}
