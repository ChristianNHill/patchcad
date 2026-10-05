import { describe, expect, it } from "vitest";
import { orderLinkText, orderLinkTitle, viewportLabel, type OrderLink } from "./order-links.js";

describe("order links", () => {
  const verified: OrderLink = { vendor: "McMaster-Carr", url: "https://example.com/p", kind: "verified", pn: "PN-1", verifiedAt: "2026-10-04" };
  const search: OrderLink = { vendor: "MISUMI", url: "https://example.com/s?q=x", kind: "search" };

  it("shows a part number only for a verified link", () => {
    expect(orderLinkText(verified)).toBe("McMaster-Carr PN-1");
    expect(orderLinkTitle(verified)).toMatch(/2026-10-04/);
    expect(orderLinkText(search)).toBe("Search MISUMI");
    expect(orderLinkTitle(search)).toMatch(/not a specific product/);
  });
});

describe("viewportLabel", () => {
  const designations = { screw: "ISO 4762 M3×12 socket head cap screw", plate: undefined };

  it("labels the hovered catalog part, else the selected one", () => {
    expect(viewportLabel("screw", "plate", designations)).toEqual({ nodeId: "screw", text: designations.screw });
    expect(viewportLabel("plate", "screw", designations)).toEqual({ nodeId: "screw", text: designations.screw });
    expect(viewportLabel(null, "screw", designations)?.nodeId).toBe("screw");
  });

  it("labels nothing that is not bought hardware", () => {
    expect(viewportLabel("plate", null, designations)).toBeNull();
    expect(viewportLabel(null, null, designations)).toBeNull();
  });
});
