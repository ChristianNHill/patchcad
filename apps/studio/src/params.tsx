import { useState } from "react";
import type { ParamDecl, ParamValue } from "@patchcad/shared";

/**
 * The T0 surface, shared by the node face (top few params, compact) and the
 * inspector (all of them, grouped). T0 never calls an LLM: a change here is a
 * postMessage to the preview plus a debounced persist.
 */

/** Round to a "nice" 1/2/5×10^k value, so a derived step reads like something
 *  a person would have typed. */
function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const mag = 10 ** exp;
  const f = raw / mag;
  const mult = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  // toPrecision clears float dust: 0.1, never 0.10000000000000002.
  return Number((mult * mag).toPrecision(2));
}

/**
 * A range input steps from `min`, not from zero, so an undeclared step of 1
 * against min 2.5 / max 10 admits only 2.5, 3.5 … 9.5 — the declared max is
 * unreachable and so is the default of 5, meaning one drag loses a value the
 * user can never get back. The architect never emits `step` (it is set exactly
 * once in the whole repo), so the fallback has to be derived rather than
 * constant.
 */
export function paramStep(decl: Extract<ParamDecl, { type: "number" }>): number {
  if (decl.step !== undefined) return decl.step;
  const { min, max } = decl;
  if (min === undefined || max === undefined || !(max > min)) return 1;
  // A declaration written entirely in whole numbers means whole numbers —
  // piece counts and hole counts must not acquire a fractional step.
  if (Number.isInteger(min) && Number.isInteger(max) && Number.isInteger(decl.default)) {
    return 1;
  }
  return niceStep((max - min) / 100);
}

/** Show a value at the step's precision: dragging a 0.05 step should read
 *  4.55, not 4.550000000000001. */
export function formatNumber(value: number, step: number): string {
  if (!Number.isFinite(value)) return "";
  const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(step))));
  const s = value.toFixed(decimals);
  // Trim only a fractional tail — a blanket /0+$/ would turn 100 into 1.
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

const GROUP_FALLBACK = "";

/** Params in declaration order, partitioned by ui.group. Ungrouped params keep
 *  their position ahead of the first named group. */
export function groupParams(params: ParamDecl[]): { group: string; params: ParamDecl[] }[] {
  const out: { group: string; params: ParamDecl[] }[] = [];
  for (const p of params) {
    const group = p.ui?.group ?? GROUP_FALLBACK;
    const last = out.find((g) => g.group === group);
    if (last) last.params.push(p);
    else out.push({ group, params: [p] });
  }
  return out;
}

/** Editable readout beside the slider. Keeps the raw text while focused so
 *  intermediate states ("2.", "") do not fight the typist, then falls back to
 *  the real value on blur. */
function NumberValue({
  decl,
  value,
  step,
  onChange,
}: {
  decl: Extract<ParamDecl, { type: "number" }>;
  value: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) =>
    Math.min(decl.max ?? Number.POSITIVE_INFINITY, Math.max(decl.min ?? Number.NEGATIVE_INFINITY, n));

  return (
    <input
      className="param__value param__value--edit"
      type="text"
      inputMode="decimal"
      value={draft ?? formatNumber(value, step)}
      aria-label={`${decl.name} value`}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(clamp(n));
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function ParamRow({
  decl,
  value,
  onChange,
  describe = false,
}: {
  decl: ParamDecl;
  value: ParamValue;
  onChange: (v: ParamValue) => void;
  /** Inspector renders the description under the row; the node face has no
   *  room and keeps it in the tooltip. */
  describe?: boolean;
}) {
  const row = (control: React.ReactNode, readout?: React.ReactNode) => (
    <>
      <label className="param nodrag" title={decl.description || decl.name}>
        <span className="param__name">{decl.name}</span>
        {control}
        {readout}
      </label>
      {describe && decl.description && <p className="param__desc">{decl.description}</p>}
    </>
  );

  switch (decl.type) {
    case "number": {
      const step = paramStep(decl);
      return row(
        <input
          type="range"
          min={decl.min ?? 0}
          max={decl.max ?? 100}
          step={step}
          value={Number(value)}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={decl.name}
        />,
        <span className="param__readout">
          <NumberValue decl={decl} value={Number(value)} step={step} onChange={onChange} />
          {decl.ui?.unit && <span className="param__unit">{decl.ui.unit}</span>}
        </span>,
      );
    }
    case "boolean":
      return row(
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={decl.name}
        />,
      );
    case "enum":
      return row(
        <select value={String(value)} onChange={(e) => onChange(e.target.value)} aria-label={decl.name}>
          {decl.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>,
      );
    case "color":
      return row(
        <input
          type="color"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={decl.name}
        />,
      );
    default:
      return row(
        <input
          type="text"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={decl.name}
        />,
      );
  }
}
