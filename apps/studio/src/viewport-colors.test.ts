import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The viewport's colours are hex literals because three.js cannot read the
 * tokens: `Color.setStyle` has no `oklch()` branch and does not throw on one —
 * it warns and leaves the colour WHITE. A getComputedStyle bridge therefore
 * blanks every part in the scene, silently. (It did, for one afternoon.)
 *
 * Literals are the right answer, but they drift — the previous set was 25% off
 * on accent chroma and 7° off on warn hue. This converts the tokens the same
 * way a browser does and asserts the literals still match, so a token edit
 * fails here instead of quietly desaturating the 3D view.
 */

/** oklch -> sRGB hex, per CSS Color 4. */
function oklchToHex(L: number, C: number, H: number): string {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const [l, m, s] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return (
    "#" +
    lin
      .map((c) => {
        const v = Math.max(0, Math.min(1, c));
        const enc = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
        return Math.round(enc * 255)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

/** Pull `--name: oklch(L% C H)` straight out of the token file. */
function token(name: string): [number, number, number] {
  const m = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(
    read("tokens.css"),
  );
  if (!m) throw new Error(`--${name} not found as a plain oklch() in tokens.css`);
  return [Number(m[1]) / 100, Number(m[2]), Number(m[3])];
}

describe("viewport colour literals track the tokens", () => {
  const source = read("CadViewport.tsx");

  const pairs: [string, string][] = [
    ["color-accent", "var-accent"],
    ["color-warn", "var-warn"],
    ["color-danger", "var-danger"],
  ];

  for (const [tokenName, key] of pairs) {
    it(`${key} matches --${tokenName}`, () => {
      const want = oklchToHex(...token(tokenName));
      const m = new RegExp(`"${key}": new THREE\\.Color\\("(#[0-9a-f]{6})"\\)`).exec(source);
      expect(m, `${key} literal not found in CadViewport.tsx`).toBeTruthy();
      expect(m![1]).toBe(want);
    });
  }

  it("BASE matches --color-ink-2", () => {
    const m = /const BASE = new THREE\.Color\("(#[0-9a-f]{6})"\)/.exec(source);
    expect(m![1]).toBe(oklchToHex(...token("color-ink-2")));
  });

  it("the grid matches --color-rule and --color-rule-2", () => {
    expect(/const GRID = "(#[0-9a-f]{6})"/.exec(source)![1]).toBe(oklchToHex(...token("color-rule")));
    expect(/const GRID_2 = "(#[0-9a-f]{6})"/.exec(source)![1]).toBe(
      oklchToHex(...token("color-rule-2")),
    );
  });

  it("nobody reintroduces a CSS-var bridge three.js cannot parse", () => {
    // A CALL, not the word — the comment above the literals explains why the
    // bridge is wrong, and matching prose would fail on its own rationale.
    expect(source).not.toMatch(/getComputedStyle\s*\(/);
  });
});
