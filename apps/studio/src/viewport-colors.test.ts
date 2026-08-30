import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The viewport's colours are hex literals because three.js cannot read the
 * tokens: `Color.setStyle` has no CSS-variable branch and does not throw on one —
 * it warns and leaves the colour WHITE. A getComputedStyle bridge therefore
 * blanks every part in the scene, silently. (It did, for one afternoon.)
 *
 * Literals are the right answer, but they drift — an earlier set was 25% off on
 * accent chroma and 7° off on warn hue. This asserts each literal still equals
 * the token it claims to copy, so a token edit fails here instead of quietly
 * mismatching the 3D view.
 */

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

/** Pull `--name: #rrggbb` straight out of the token file. */
function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\b`).exec(read("tokens.css"));
  if (!m) throw new Error(`--${name} not found as a plain hex value in tokens.css`);
  return m[1]!;
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
      const m = new RegExp(`"${key}": new THREE\\.Color\\("(#[0-9a-f]{6})"\\)`).exec(source);
      expect(m, `${key} literal not found in CadViewport.tsx`).toBeTruthy();
      expect(m![1]).toBe(token(tokenName));
    });
  }

  it("BASE matches --color-graphite", () => {
    const m = /const BASE = new THREE\.Color\("(#[0-9a-f]{6})"\)/.exec(source);
    expect(m![1]).toBe(token("color-graphite"));
  });

  it("both grid tiers match their tokens", () => {
    expect(/const GRID = "(#[0-9a-f]{6})"/.exec(source)![1]).toBe(token("color-grid"));
    expect(/const GRID_MAJOR = "(#[0-9a-f]{6})"/.exec(source)![1]).toBe(token("color-grid-major"));
  });

  it("nobody reintroduces a CSS-var bridge three.js cannot parse", () => {
    // A CALL, not the word — the comment above the literals explains why the
    // bridge is wrong, and matching prose would fail on its own rationale.
    expect(source).not.toMatch(/getComputedStyle\s*\(/);
  });
});
