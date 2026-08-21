import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hashValue, type NodeRecord } from "@patchcad/shared";
import { MeasurementsSection } from "./measurements.js";

const node = (measurements: NodeRecord["measurements"], params: NodeRecord["params"] = {}) =>
  ({ id: "plate", params, measurements }) as NodeRecord;

const measured = (data: unknown, params: NodeRecord["params"] = {}) =>
  node({ version: 2, paramsHash: hashValue(params), data }, params);

const render = (n: NodeRecord) => renderToStaticMarkup(createElement(MeasurementsSection, { node: n }));

describe("MeasurementsSection", () => {
  it("renders nothing when a node has never been measured", () => {
    expect(render(node(null))).toBe("");
    expect(render(node({ version: 1, paramsHash: "x", data: null }))).toBe("");
  });

  it("shows size and volume", () => {
    const html = render(measured({ volume_mm3: 12345.6, bbox: { min: [], max: [], size: [60, 40, 5] } }));
    expect(html).toContain("60 × 40 × 5 mm");
    expect(html).toContain("12346 mm³");
  });

  it("reports a hole port as the diameter actually bored", () => {
    const html = render(measured({ ports: [{ key: "mount_hole", type: "BORE", measured_diameter: 4.501 }] }));
    expect(html).toContain("mount_hole");
    expect(html).toContain("Ø4.5 mm");
  });

  it("speaks each port type in its own terms", () => {
    const html = render(
      measured({
        ports: [
          { key: "face", type: "FLAT_FACE", probed_size: 12 },
          { key: "sliver", type: "FLAT_FACE", probed_size: 0 },
          { key: "ring", type: "FLAT_FACE", ring_diameter: 12 },
          { key: "boss", type: "SCREW_BOSS", ring_hits: 16, measured_pilot: 3.3 },
          { key: "novel", type: "WHATEVER", skipped: "no probe for this type yet" },
        ],
      }),
    );
    expect(html).toContain("12 mm flat");
    expect(html).toContain("flat (center probe)");
    expect(html).toContain("ring Ø12 mm");
    expect(html).toContain("16 wall hits · pilot Ø3.3 mm");
    expect(html).toContain("no probe for this type yet");
  });

  it("hides the solids count unless it is surprising", () => {
    expect(render(measured({ solids: 1, volume_mm3: 1 }))).not.toContain("solids");
    expect(render(measured({ solids: 3, volume_mm3: 1 }))).toContain("solids");
  });

  it("names the version it describes", () => {
    expect(render(measured({ volume_mm3: 1 }))).toContain("probed at v2");
  });

  it("says so when params have moved on since the probe", () => {
    // A T0 slider re-executes but does not re-probe, so the numbers can
    // describe a shape that is no longer on screen.
    const stale = node({ version: 2, paramsHash: hashValue({ t: 5 }), data: { volume_mm3: 1 } }, { t: 9 });
    expect(render(stale)).toContain("params have changed since");
    expect(render(measured({ volume_mm3: 1 }, { t: 5 }))).not.toContain("params have changed");
  });
});

describe("channel ports", () => {
  it("shows the width a mating tongue is cut to, and the depth when there is a floor", () => {
    const html = render(
      measured({
        ports: [
          { key: "wall_seat", type: "GROOVE", measured_width: 3, measured_depth: 4 },
          { key: "divider", type: "SLOT", measured_width: 2.4 },
        ],
      }),
    );
    expect(html).toContain("wall_seat");
    expect(html).toContain("3 mm wide × 4 mm deep");
    expect(html).toContain("2.4 mm wide");
  });

  it("says nothing about depth for a through-cut", () => {
    const html = render(measured({ ports: [{ key: "s", type: "SLOT", measured_width: 2.4 }] }));
    expect(html).not.toContain("deep");
  });
});

describe("hole depth", () => {
  it("says whether a hole goes through or bottoms out", () => {
    const html = render(
      measured({
        ports: [
          { key: "bolt", type: "CLEARANCE_HOLE", measured_diameter: 4.5, through: true },
          { key: "pocket", type: "BORE", measured_diameter: 8, measured_depth: 4 },
        ],
      }),
    );
    expect(html).toContain("Ø4.5 mm through");
    expect(html).toContain("Ø8 mm × 4 mm deep");
  });
});
