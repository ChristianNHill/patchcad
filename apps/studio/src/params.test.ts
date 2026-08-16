import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ParamDecl } from "@patchcad/shared";
import { formatNumber, groupParams, ParamRow, paramStep } from "./params.js";

const num = (over: Partial<Extract<ParamDecl, { type: "number" }>>) =>
  ({ type: "number", name: "p", description: "", default: 0, ...over }) as Extract<
    ParamDecl,
    { type: "number" }
  >;

/** A range input steps from `min`, so `value = min + n*step`. Anything the
 *  declaration names — default, min, max — has to land on that grid. */
const onGrid = (v: number, min: number, step: number) => {
  const n = (v - min) / step;
  return Math.abs(n - Math.round(n)) < 1e-9;
};

describe("paramStep", () => {
  it("respects a declared step", () => {
    expect(paramStep(num({ min: 0, max: 10, step: 0.25 }))).toBe(0.25);
  });

  it("keeps whole-number declarations whole", () => {
    // Piece counts and hole counts must not acquire a fractional step.
    expect(paramStep(num({ min: 1, max: 8, default: 3 }))).toBe(1);
    expect(paramStep(num({ min: 0, max: 100, default: 50 }))).toBe(1);
  });

  it("falls back to 1 when the range is unusable", () => {
    expect(paramStep(num({ default: 5 }))).toBe(1);
    expect(paramStep(num({ min: 5, max: 5, default: 5 }))).toBe(1);
    expect(paramStep(num({ min: 10, max: 2, default: 5 }))).toBe(1);
  });

  it("fixes the cad-clamp case: default and max become reachable", () => {
    // thickness {default: 5, min: 2.5, max: 10}. With the old constant step of
    // 1 the grid was 2.5, 3.5 … 9.5 — the default of 5 was off-grid, so one
    // drag lost a value that could never be typed back, and max was unreachable.
    const decl = num({ min: 2.5, max: 10, default: 5 });
    const step = paramStep(decl);
    expect(onGrid(5, 2.5, step)).toBe(true);
    expect(onGrid(10, 2.5, step)).toBe(true);
    expect(onGrid(5, 2.5, 1)).toBe(false); // what it used to do
  });

  it("produces a step a person would have typed", () => {
    expect(paramStep(num({ min: 2.5, max: 10, default: 5 }))).toBe(0.1);
    expect(paramStep(num({ min: 0, max: 1, default: 0.5 }))).toBe(0.01);
    expect(paramStep(num({ min: 0, max: 2.5, default: 1 }))).toBe(0.02);
  });

  it("never returns a step coarser than the range", () => {
    for (const [min, max] of [
      [0, 0.5],
      [2.5, 10],
      [0.1, 0.2],
      [-5, 5.5],
      [1, 1000.5],
    ] as const) {
      const step = paramStep(num({ min, max, default: min }));
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThanOrEqual(max - min);
    }
  });
});

describe("formatNumber", () => {
  it("shows the step's precision, not float dust", () => {
    expect(formatNumber(4.550000000000001, 0.05)).toBe("4.55");
    expect(formatNumber(5, 0.1)).toBe("5");
  });

  it("does not eat trailing zeros of an integer", () => {
    // A blanket trailing-zero trim turns 100 into 1.
    expect(formatNumber(100, 1)).toBe("100");
    expect(formatNumber(10, 1)).toBe("10");
    expect(formatNumber(0, 1)).toBe("0");
  });

  it("survives a non-finite value", () => {
    expect(formatNumber(Number.NaN, 1)).toBe("");
  });
});

describe("groupParams", () => {
  const p = (name: string, group?: string) =>
    ({ type: "number", name, description: "", default: 0, ui: group ? { group } : undefined }) as ParamDecl;

  it("keeps declaration order and collects each group once", () => {
    const groups = groupParams([p("w"), p("d"), p("hole", "holes"), p("inset", "holes"), p("t")]);
    expect(groups.map((g) => g.group)).toEqual(["", "holes"]);
    expect(groups[0]!.params.map((x) => x.name)).toEqual(["w", "d", "t"]);
    expect(groups[1]!.params.map((x) => x.name)).toEqual(["hole", "inset"]);
  });

  it("returns one anonymous group when nothing is grouped", () => {
    const groups = groupParams([p("a"), p("b")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.group).toBe("");
  });

  it("handles no params", () => {
    expect(groupParams([])).toEqual([]);
  });
});

describe("ParamRow", () => {
  const render = (decl: ParamDecl, value: ParamDecl["default"], describe_ = false) =>
    renderToStaticMarkup(
      createElement(ParamRow, { decl, value, onChange: () => {}, describe: describe_ }),
    );

  it("puts the derived step on the slider, not a constant 1", () => {
    const html = render(num({ name: "thickness", min: 2.5, max: 10, default: 5 }), 5);
    expect(html).toContain('step="0.1"');
    expect(html).toContain('min="2.5"');
    expect(html).toContain('max="10"');
  });

  it("renders the value as an editable field, not static text", () => {
    const html = render(num({ name: "thickness", min: 2.5, max: 10, default: 5 }), 5);
    expect(html).toContain("param__value--edit");
    expect(html).toContain('value="5"');
  });

  it("shows a unit only when declared", () => {
    const withUnit = num({ name: "t", min: 0, max: 10, default: 1, ui: { unit: "mm" } });
    expect(render(withUnit, 1)).toContain("param__unit");
    expect(render(num({ name: "t", min: 0, max: 10, default: 1 }), 1)).not.toContain("param__unit");
  });

  it("shows the description only where there is room for it", () => {
    const decl = num({ name: "t", min: 0, max: 10, default: 1, description: "how thick it prints" });
    expect(render(decl, 1, true)).toContain("how thick it prints");
    expect(render(decl, 1, false)).not.toContain("param__desc");
  });

  it("still renders every other param type", () => {
    const base = { name: "p", description: "" } as const;
    expect(render({ ...base, type: "boolean", default: true } as ParamDecl, true)).toContain("checkbox");
    expect(render({ ...base, type: "color", default: "#112233" } as ParamDecl, "#112233")).toContain("color");
    expect(render({ ...base, type: "string", default: "x" } as ParamDecl, "x")).toContain("text");
    expect(
      render({ ...base, type: "enum", default: "a", options: ["a", "b"] } as ParamDecl, "a"),
    ).toContain("<option");
  });
});
