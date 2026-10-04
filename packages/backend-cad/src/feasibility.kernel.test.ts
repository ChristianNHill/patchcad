import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { reexpandGraph, type Workspace } from "@patchcad/engine";
import { CadBackend } from "./index.js";
import { KernelClient } from "./kernel.js";

/**
 * Assembly feasibility through globalCheck against a real kernel: the cooked
 * folding phone stand (real-products, 2026-10-04) printed its hinge pin on the
 * back plate, so the front plate's closed knuckles can never reach it.
 *
 * Live only: PATCHCAD_KERNEL_LIVE=1, against PATCHCAD_KERNEL_PORT (8621).
 */
const live = process.env.PATCHCAD_KERNEL_LIVE === "1";
const backend = new CadBackend({ kernel: new KernelClient(Number(process.env.PATCHCAD_KERNEL_PORT ?? 8621)) });
const ws = { root: "/nonexistent/feasibility" } as Workspace;

const stand = () => GraphDoc.parse(JSON.parse(readFileSync(new URL("fixtures/real-folding-phone-stand.json", import.meta.url), "utf8")));

/** The graph re-expanded with `joint` changes, hardware codegen'd as a cook would. */
function reexpanded(g: GraphDoc, joint: Record<string, unknown> = {}): GraphDoc {
  g.joints = g.joints!.map((j) => ({ ...j, ...joint }));
  const next = reexpandGraph(g, backend as never)!.graph;
  for (const n of Object.values(next.nodes)) {
    const code = backend.deterministicArtifact(n)?.code;
    if (code) n.artifact = { ...n.artifact!, code };
  }
  return next;
}

function example(name: string): GraphDoc {
  const root = new URL(`../../../examples/${name}/`, import.meta.url);
  const g = GraphDoc.parse(JSON.parse(readFileSync(new URL("patchcad.json", root), "utf8")));
  for (const n of Object.values(g.nodes)) {
    const f = new URL(`nodes/${n.id}/v1.code.py`, root);
    if (existsSync(f)) n.artifact = { ...n.artifact!, code: readFileSync(f, "utf8") };
  }
  return g;
}

const assembly = async (g: GraphDoc) => {
  const res = await backend.globalCheck(g, ws);
  expect(res.incomplete).toBeFalsy();
  return (res.findings ?? []).filter((f) => f.kind === "assembly");
};

describe.skipIf(!live)("assembly feasibility in globalCheck", () => {
  it("phone stand: a pin printed on the back plate cannot get through the front plate's knuckles", async () => {
    const found = await assembly(stand());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nodeA: "front-plate", nodeB: "back-plate" });
    expect(found[0]!.repair).toBeUndefined();
    expect(found[0]!.blame).toBeUndefined();
    expect(found[0]!.message).toMatch(/separate pin/);
  }, 120_000);

  it("phone stand with a separate filament pin goes together", async () => {
    const g = reexpanded(stand());
    expect((g.joints![0] as { expanded?: string }).expanded).toBe("M2d|pin=filament_pin:1.75");
    // The plates as their generators would write them now: no pin stub, and
    // the filament pin's bore run out through both plates' ends so it goes in
    // once they are together.
    const plate = g.nodes["back-plate"]!;
    const code = plate.artifact!.code;
    const at = code.indexOf("    # pin bore through knuckle 5");
    plate.artifact!.code = code.slice(0, at) + "    plate = plate - Pos(0, ay, az) * Rot(0, 90, 0) * Cylinder(0.95, W + 2.0)\n    return plate\n";
    const front = g.nodes["front-plate"]!.artifact!;
    front.code = front.code.replace("Cylinder(rb, L + 1.0)", "Cylinder(rb, W + 2.0)");
    expect(await assembly(g)).toEqual([]);
  }, 120_000);

  it("a print-in-place hinge is printed, never inserted", async () => {
    const g = reexpanded(stand(), { printInPlace: true });
    expect(g.nodes.hinge_pin_clip).toBeUndefined();
    expect(await assembly(g)).toEqual([]);
  }, 120_000);

  it.each(["cad-rotor", "cad-joints", "cad-belt-drive"])("%s still goes together", async (name) => {
    expect(await assembly(example(name))).toEqual([]);
  }, 120_000);
});
