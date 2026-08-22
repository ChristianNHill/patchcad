/**
 * Node-kind glyphs — one hand-built set, one stroke voice (1.5px, round caps,
 * currentColor) so every kind reads as part of the same instrument.
 */

const PATHS: Record<string, React.ReactNode> = {
  shell: (
    // layout: frame with a header slot
    <>
      <rect x="1.5" y="2" width="11" height="10" rx="1.5" />
      <line x1="1.5" y1="5.5" x2="12.5" y2="5.5" />
    </>
  ),
  component: (
    // diamond node
    <path d="M7 1.5 L12.5 7 L7 12.5 L1.5 7 Z" />
  ),
  state: (
    // store: concentric
    <>
      <circle cx="7" cy="7" r="5.5" />
      <circle cx="7" cy="7" r="1.75" fill="currentColor" stroke="none" />
    </>
  ),
  style: (
    // tokens: two overlapping swatches
    <>
      <rect x="1.5" y="1.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="5" y="5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  data: (
    // rows
    <>
      <line x1="2" y1="3.5" x2="12" y2="3.5" />
      <line x1="2" y1="7" x2="12" y2="7" />
      <line x1="2" y1="10.5" x2="8.5" y2="10.5" />
    </>
  ),
  logic: (
    // pure function: signal step
    <path d="M1.5 10.5 H5.5 V3.5 H12.5" />
  ),
  part: (
    // CAD part: hexagon
    <path d="M7 1.5 L11.75 4.25 V9.75 L7 12.5 L2.25 9.75 V4.25 Z" />
  ),
  fastener: (
    // bolt head
    <>
      <circle cx="7" cy="7" r="5.5" />
      <line x1="4" y1="7" x2="10" y2="7" />
    </>
  ),
  imported: (
    // brought-in geometry: arrow landing on a tray
    <>
      <path d="M7 1.5 V8.25" />
      <path d="M4.25 5.5 L7 8.25 L9.75 5.5" />
      <path d="M2 10 V12.5 H12 V10" />
    </>
  ),
};

const FALLBACK = <rect x="2" y="2" width="10" height="10" rx="1.5" />;

export function KindGlyph({ kind, size = 14 }: { kind: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[kind] ?? FALLBACK}
    </svg>
  );
}
