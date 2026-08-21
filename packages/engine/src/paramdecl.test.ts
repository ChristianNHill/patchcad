import { describe, expect, it } from "vitest";
import { ParamDecl, ParamDeclNoUi } from "@patchcad/shared";

describe("ParamDeclNoUi", () => {
  // The variants are spelled out by index rather than derived, because mapping a
  // discriminated union's options loses the per-option type that .omit() needs.
  // That makes a 6th param type a silent gap, so pin the arity.
  it("covers every ParamDecl variant", () => {
    expect(ParamDeclNoUi.options).toHaveLength(ParamDecl.options.length);
  });

  it("drops ui and keeps everything else", () => {
    const r = ParamDeclNoUi.safeParse({ type: "number", name: "w", default: 5, min: 1, max: 9 });
    expect(r.success).toBe(true);
    if (r.success) expect("ui" in r.data).toBe(false);
  });

  it("still rejects a param the full schema rejects", () => {
    expect(ParamDeclNoUi.safeParse({ type: "number", name: "w" }).success).toBe(false);
  });
});
