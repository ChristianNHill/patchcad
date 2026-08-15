# Design — patchcad

A locked design system for this app. Every surface (studio UI today; marketing
pages later) reads this file before emitting code. Do not regenerate per page —
extend or amend this file when the system needs to grow.

Vibe: **"late-night patchbay — wired, precise, instrument-grade."** The product
is a patch editor: a dark instrument panel where cyan means signal, amber means
stale, green means ready. The design system is derived from that identity, not
from a stock theme.

## Genre

atmospheric (dark instrument · AI tool). App surfaces skip the genre's marketing
apparatus (blooms, heroes); they keep its discipline: dark canvas, one cool
accent, elevation by lightness, roman display type.

## Macrostructure family

- **App pages:** three-pane instrument panel — toolbar · node canvas · live
  preview · inspector. This is product IA, not a rotating pick; variation lives
  in panel content, never in the frame.
- **Marketing pages (when they exist):** Workbench — the product-screenshot
  tour. patchcad is its own best demo; the landing page walks the canvas.
  Nav: N5 floating pill or N9 edge-aligned. Footer: Ft5 statement.
- **Content/docs pages:** Long Document, typography-only.

## Theme (custom · axes: dark / grotesk-sans / cool)

- `--color-paper`      oklch(15% 0.012 220) — canvas ground
- `--color-paper-2`    oklch(19% 0.014 220) — panels
- `--color-paper-3`    oklch(23% 0.015 220) — elevated (modal, hover)
- `--color-well`       oklch(12% 0.010 220) — recessed (inputs, code, preview host)
- `--color-ink`        oklch(93% 0.010 220)
- `--color-ink-2`      oklch(75% 0.012 220)
- `--color-muted`      oklch(58% 0.014 220) — ≥ 12px text only
- `--color-rule`       oklch(30% 0.014 220)
- `--color-rule-2`     oklch(25% 0.012 220)
- `--color-accent`     oklch(78% 0.13 215) — wire cyan; the *signal*, ≤ 5% of any view
- `--color-accent-ink` oklch(16% 0.020 220) — text on accent fills
- `--color-focus`      oklch(82% 0.17 215) — :focus-visible only, never animated

**Semantic status hues** (data encoding, exempt from the accent budget, always
paired with a text/title signal — never colour-only):

- `--color-ok`     oklch(76% 0.13 150) — ready
- `--color-warn`   oklch(78% 0.13 75)  — dirty · repairing
- `--color-danger` oklch(66% 0.17 25)  — error states

Elevation on dark = lighter surface, never shadow-glow. No pure #000/#fff.

## Typography (2+1)

- **Display:** Space Grotesk (variable), 500–700, tracking −0.01 to −0.02em —
  wordmark, panel/node/modal titles. Roman always.
- **Body:** Geist (variable), 400/600 — UI text, buttons, labels.
- **Outlier:** JetBrains Mono (variable), 400/600 — exactly one role:
  **machine text** (code, params, port keys, node kinds, statuses, log lines,
  cost figures). Never for prose or headings. `tabular-nums` on numeric columns.
- UI base 14px (`--text-md`); nothing below 11px. Type scale in tokens.css.
- Fonts ship via @fontsource-variable packages (local-first; no CDN).

## Spacing

4-point named scale (`--space-3xs` … `--space-xl`) in tokens.css. Named tokens
only; never raw px in components.

## Motion

- Easings: `--ease-out` cubic-bezier(0.16,1,0.3,1) · `--ease-in`
  cubic-bezier(0.7,0,0.84,0) · `--ease-in-out` cubic-bezier(0.65,0,0.35,1).
- Durations: 120 / 220 / 320ms. Exits ~75% of entries.
- Three primitives max, currently: status-LED pulse (functional, 1.2s, ≤3Hz),
  modal scale-in (0.96→1), button press/hover micro. No scroll reveals — app
  surfaces are just *there*.
- Reduced motion: everything collapses to ≤150ms, LED pulse goes static.

## Microinteractions stance

- Silent success — the canvas updating IS the feedback. Toasts for failures only.
- Optimistic updates with rollback (param pushes are optimistic already).
- Hover tooltips delayed; focus tooltips instant. Focus rings instant, always.
- Confirmation dialogs only for irreversible actions (plan approval is a
  deliberate gate, not a confirmation anti-pattern — it spends money).

## CTA voice

- Primary: accent fill, `--color-accent-ink` text, radius `--radius-input`,
  lowercase verb labels — "plan", "re-cook", "approve & cook". The lowercase
  voice is the brand; keep it.
- Secondary: `--color-paper-3` fill, hairline `--color-rule` border, same shape.
- Buttons ship all 8 states (default/hover/focus/active/disabled/loading/
  error/success) — loading via `data-state="loading"` with a verb+ellipsis label.

## Iconography

One hand-built SVG glyph set (`apps/studio/src/canvas/KindGlyph.tsx`):
14px viewBox, 1.5px stroke, round caps, `currentColor`. Extend the set in the
same voice; never mix icon libraries or Unicode/emoji glyphs into chrome.

## Per-page allowances

- App surfaces: no enrichment ever — function carries the page.
- Marketing pages: Tier-A CSS art or Tier-B hand-built SVG only (the canvas
  itself, drawn, is the natural hero).
- Generated apps (cook output) are a SEPARATE surface: their design discipline
  comes from the generator prompts + the style node's tokens, not this file.
  (Planned: bake a token contract into the style-node prompt.)

## What surfaces MUST share

- The wordmark: lowercase "patchcad" in Space Grotesk 700 with the accent port-dot.
- The cyan accent + semantic status hues and their meanings.
- The three font roles and the machine-text rule.
- The CTA voice (shape, lowercase verbs).
- tokens.css values — one source of truth, imported everywhere.

## What surfaces MAY differ on

- Marketing macrostructure within the declared family.
- Marketing pages may run the atmospheric bloom treatment; app surfaces never do.

## Exports

### tokens.css

Canonical copy lives at `apps/studio/src/tokens.css` (imported by the studio).
Treat that file as the export; copy it forward to new surfaces rather than
re-deriving values.
