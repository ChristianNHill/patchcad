import { describe, expect, it } from "vitest";
import { architectOutputToGraph, type ArchitectOutput } from "@patchcad/engine";
import type { NodeRecord } from "@patchcad/shared";
import type { CadContractPayload } from "./index.js";
import type { ImportInterface, JointCandidate } from "./kernel.js";
import { expandJoints } from "./expand.js";
import { threadAllowances } from "./g5.js";
import { importJoints, importedNodeCode, jointCuts } from "./segment-joints.js";

/** The kernel reports joint sites on a cut; these tests read what each site
 *  becomes: one declared joint (the rules' input), the face ports it names,
 *  and after expansion the host features the deterministic code cuts. */

const site = (y: number, wallA = 30, wallB = 30): JointCandidate => ({
  center: [60, y, 0], normal: [1, 0, 0], span: 40, wallA, wallB, face_size: 9.6,
});
const cut = (candidates: JointCandidate[]): ImportInterface => ({
  piece_a: 0, piece_b: 1, origin: [60, 0, -12], normal: [1, 0, 0], holes: [], pegs: [], face_size: 3, candidates,
});
const opts = { idFor: (i: number) => `piece-${i}`, process: "FDM" as const, thread: "M3", taken: [] };

describe("importJoints", () => {
  it("makes two sites one removable joint with count 2 at their midpoint", () => {
    const r = importJoints([cut([site(-10), site(10)])], opts);
    expect(r.notes).toEqual([]);
    expect(r.joints).toHaveLength(1);
    const j = r.joints[0]!;
    expect(j).toMatchObject({
      id: "j1", intent: "removable", motion: "fixed", load: "light", access: "both_sides", count: 2, pitch: 20,
      a: { node: "piece-0", port: "face_j1" }, b: { node: "piece-1", port: "face_j1" },
      wallA: "expr: 12 * param(piece-0.scale)", threadHint: "M3",
    });
    const [a] = r.ports["piece-0"]!;
    const [b] = r.ports["piece-1"]!;
    expect(a!.pose).toEqual({ origin: ["expr: 60 * param(piece-0.scale)", 0, 0], zAxis: [1, 0, 0], xAxis: [0, 1, 0] });
    expect(b!.pose.zAxis).toEqual([-1, 0, 0]);
    expect(b!.pose.xAxis).toEqual(a!.pose.xAxis);
  });

  it("takes the shallowest wall of a pair, caps it at 4·d, and never reuses a joint id", () => {
    const r = importJoints([cut([site(-10, 30, 10), site(10, 9, 30)])], { ...opts, taken: ["j1"] });
    expect(r.joints[0]).toMatchObject({ id: "j2", wallA: "expr: 9 * param(piece-0.scale)", wallB: "expr: 10 * param(piece-1.scale)" });
    expect(importJoints([cut([site(0, 60, 60)])], opts).joints[0]).toMatchObject({ intent: "removable", wallA: "expr: 12 * param(piece-0.scale)" });
  });

  it("falls back to alignment, and says why, when no fastener fits", () => {
    const r = importJoints([cut([site(0, 3, 3)])], opts);
    expect(r.joints[0]!.intent).toBe("alignment");
    expect(r.joints[0]!.note).toMatch(/no fastener fits .*R4 wallB 3\.0/);
    // walls this thin take a printed peg, whose tip the envelope must reach
    expect(r.reach["piece-0"]).toEqual([[61.8, 0, 0]]);
  });

  it("records a cut with no site instead of inventing a joint", () => {
    const r = importJoints([cut([])], opts);
    expect(r.joints).toEqual([]);
    expect(r.notes[0]).toMatch(/piece-0↔piece-1: no site/);
  });
});

/** Two imported slabs as the import path builds them, plus the joints. */
function slabs(candidates: JointCandidate[]): { out: ArchitectOutput; joints: ReturnType<typeof importJoints> } {
  const joints = importJoints([cut(candidates)], opts);
  const piece = (id: string, zx: number) => ({
    id, kind: "imported", title: id, spec: id,
    contract: {
      name: id, summary: id,
      params: [{ type: "number" as const, name: "scale", description: "", default: 1 }],
      provides: [], requires: [],
      payload: {
        units: "mm", process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
        ports: [{ name: `joint_${id === "piece-0" ? "piece-1" : "piece-0"}`, type: "FLAT_FACE", pose: { origin: [60, 0, -12], zAxis: [zx, 0, 0], xAxis: [0, 0, 1] }, params: { size: 3 } }, ...(joints.ports[id] ?? [])],
        envelope: { volumes: [{ kind: "box", pose: { origin: [60, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims: [120, 40, 30] }], clearance: 0.4 },
        paramBindings: {},
      } satisfies CadContractPayload,
    },
  });
  const out = {
    nodes: [piece("piece-0", 1), piece("piece-1", -1)],
    edges: [{ from: "piece-0", fromPort: "joint_piece-1", to: "piece-1", toPort: "joint_piece-0" }],
    entryNodeId: "piece-0", rationale: "", design: "", joints: joints.joints,
  } as unknown as ArchitectOutput;
  return { out: expandJoints(out), joints };
}

const asNode = (out: ArchitectOutput, id: string) =>
  ({ ...out.nodes.find((n) => n.id === id)!, params: {}, thread: [] }) as unknown as NodeRecord;

describe("expanded import joints", () => {
  it("mint a screw and an insert, each one node placed at both sites", () => {
    const { out } = slabs([site(-10), site(10)]);
    const ids = out.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["j1_screw", "j1_insert"]));
    expect(out.edges.filter((e) => e.to === "j1_screw").map((e) => e.fromPort)).toEqual(["j1_head_1", "j1_head_2"]);
    expect(out.edges.filter((e) => e.to === "j1_insert").map((e) => e.fromPort)).toEqual(["j1_pocket_1", "j1_pocket_2"]);
  });

  it("cut a counterbore through piece a and insert pockets into piece b, from own params only", () => {
    const { out } = slabs([site(-10), site(10)]);
    const a = jointCuts(asNode(out, "piece-0"));
    const b = jointCuts(asNode(out, "piece-1"));
    expect(a).toHaveLength(2);
    expect(a[0]).toMatch(/"kind": "round", "d": \(p\.j1_cbore_d\), "depth": \(p\.j1_cbore_depth\), "through": \(p\.j1_clear\), "access": \(p\.j1_cbore_d\)/);
    expect(a[0]).toMatch(/"o": \[\(\(60 \* p\.scale\) - 30\)|"o": \[/);
    expect(b).toHaveLength(2);
    expect(b[0]).toMatch(/"d": \(p\.j1_insert_d\), "depth": \(p\.j1_pocket\) \+ 0\.5/);
    for (const c of [...a, ...b]) expect(c).not.toMatch(/param\(/);
    // the cut faces are never re-cut
    expect(importedNodeCode(asNode(out, "piece-1"))).toMatch(/^def build\(p\):\n    return cut_joints\(load_import\("piece-1\.ply", scale=p\.scale\), \[/);
  });

  it("let G5 allow the screw's thread inside its insert (the screw names a sku, not a thread)", () => {
    const { out } = slabs([site(-10), site(10)]);
    const allowed = threadAllowances(architectOutputToGraph(out, "t", "cad", "g", "mm"));
    expect(allowed.some((x) => x.a === "j1_screw" && x.b === "j1_insert" && x.volume_mm3 > 0)).toBe(true);
  });

  it("leave a piece with no joint as a plain load", () => {
    const { out } = slabs([]);
    expect(importedNodeCode(asNode(out, "piece-0"))).toBe('def build(p):\n    return load_import("piece-0.ply", scale=p.scale)\n');
  });

  it("cut a dowel hole at the fit's cut target", () => {
    const { out } = slabs([site(0, 8, 4.7)]);
    const joint = out.joints![0] as unknown as { intent: string };
    expect(joint.intent).toBe("alignment");
    const [hole] = jointCuts(asNode(out, "piece-0"));
    // piece a takes the dowel's press fit: nominal − 0.05 on FDM
    expect(hole).toMatch(/"d": \(p\.j1_dowel_d\) \+ -0\.05/);
  });
});
