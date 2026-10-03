import { describe, expect, it } from "vitest";
import type { ImportResult } from "@patchcad/backend-cad";
import { buildImportedNodes } from "./import-split.js";

const piece = (index: number, min: number[], max: number[]) => ({
  index,
  file: `piece-${index}.ply`,
  volume_mm3: 1000,
  watertight: true,
  bbox: { min, max },
  faces: 12,
});

const opts = { process: { kind: "FDM" as const, minWall: 1.2, nozzle: 0.4 }, thread: "M4", taken: [] };
const idFor = (i: number) => `piece-${i}`;

type Built = { contract: { payload: { ports: { name: string; type: string }[]; paramBindings: Record<string, string> }; provides: { key: string }[]; requires: { key: string }[] }; title: string };

describe("buildImportedNodes", () => {
  const whole: ImportResult = { ok: true, dir: "/c", pieces: [piece(0, [0, 0, 0], [10, 10, 10])], interfaces: [] };
  const cut: ImportResult = {
    ok: true,
    dir: "/c",
    pieces: [piece(0, [0, 0, 0], [10, 10, 5]), piece(1, [0, 0, 5], [10, 10, 10])],
    interfaces: [
      {
        piece_a: 0,
        piece_b: 1,
        origin: [5, 5, 5],
        normal: [0, 0, 1],
        face_size: 10,
        holes: [{ center: [3, 5, 5], diameter: 4.5 }],
        pegs: [{ center: [7, 5, 5], peg_diameter: 3, socket_diameter: 3.3, length: 4 }],
      },
    ],
  };

  it.each([
    {
      name: "one piece: no ports, no edges, its own scale root",
      result: whole,
      nodes: { "piece-0": { ports: [], provides: [], requires: [], binding: undefined } },
      edges: 0,
    },
    {
      name: "a cut: a mating face each side, the hole on both, peg on A and socket on B, B bound to A's scale",
      result: cut,
      nodes: {
        "piece-0": {
          ports: ["joint_piece-1:FLAT_FACE", "joint_piece-1_hole_0:CLEARANCE_HOLE", "joint_piece-1_peg_0:SHAFT"],
          provides: ["joint_piece-1"],
          requires: [],
          binding: undefined,
        },
        "piece-1": {
          ports: ["joint_piece-0:FLAT_FACE", "joint_piece-0_hole_0:CLEARANCE_HOLE", "joint_piece-0_socket_0:BORE"],
          provides: [],
          requires: ["joint_piece-0"],
          binding: "param:piece-0.scale",
        },
      },
      edges: 1,
    },
  ])("$name", ({ result, nodes, edges }) => {
    const built = buildImportedNodes(result, "thing.stl", idFor, opts);
    expect(Object.keys(built.nodes)).toEqual(Object.keys(nodes));
    for (const [id, want] of Object.entries(nodes)) {
      const n = built.nodes[id] as Built;
      expect(n.contract.payload.ports.map((p) => `${p.name}:${p.type}`)).toEqual(want.ports);
      expect(n.contract.provides.map((d) => d.key)).toEqual(want.provides);
      expect(n.contract.requires.map((d) => d.key)).toEqual(want.requires);
      expect(n.contract.payload.paramBindings.scale).toBe(want.binding);
    }
    expect(built.edges).toHaveLength(edges);
  });

  it("titles pieces and wires the cut edge A→B", () => {
    const built = buildImportedNodes(cut, "thing.stl", idFor, opts);
    expect((built.nodes["piece-1"] as Built).title).toBe("thing.stl · piece 2");
    expect(built.edges[0]).toEqual({ id: "cut-piece-0-0", from: "piece-0", fromPort: "joint_piece-1", to: "piece-1", toPort: "joint_piece-0" });
  });
});
