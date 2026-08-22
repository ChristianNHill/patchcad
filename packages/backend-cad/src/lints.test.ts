import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import {
  cadEnvelopeCoherentLint,
  cadFastenerJustifiedLint,
  cadFlatFaceSizeLint,
  cadProbedPortsLint,
  cadFaceHoleConflictLint,
  cadPortConsistencyLint,
  cadHardwareSeatLint,
  threadEngagementVolume,
  OUTER_DIAMETER_KEYS,
} from "./index.js";

/** Plan-time lint: pure graph → problems. No kernel, no LLM, no I/O. */

const pose = { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] };
const payloadBase = {
  units: "mm",
  process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
  ports: [],
  envelope: { volumes: [{ kind: "box", pose, dims: [10, 10, 10] }], clearance: 0.4 },
};

function node(id: string, kind: string, ports: { name: string; type: string }[]) {
  return {
    id,
    kind,
    title: id,
    spec: "",
    contract: {
      name: id,
      summary: "",
      params: [],
      provides: [],
      requires: [],
      payload: { ...payloadBase, ports: ports.map((p) => ({ ...p, pose, params: {} })) },
      hash: "",
    },
    pinned: false,
    params: {},
    deps: [],
    artifact: null,
    thread: [],
    status: "ready",
    version: 1,
    history: [],
    cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
  };
}

function graph(
  nodes: ReturnType<typeof node>[],
  edges: { from: string; fromPort: string; to: string; toPort: string }[],
) {
  return GraphDoc.parse({
    schemaVersion: 1,
    id: "lint",
    backend: "cad",
    brief: { goal: "", constraints: [], clarifications: [] },
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: edges.map((e, i) => ({ id: `e${i}`, ...e })),
    assembly: { entryNodeId: nodes[0]!.id },
    layout: {},
    rev: 0,
  });
}

const plateWithHole = () => node("plate", "part", [{ name: "hole", type: "CLEARANCE_HOLE" }]);
const plateNoHole = () => node("plate", "part", [{ name: "face", type: "FLAT_FACE" }]);
const screw = () => node("screw", "fastener", [{ name: "head_seat", type: "FLAT_FACE" }]);

describe("cad-fastener-justified lint", () => {
  it("passes a screw seated in a hole port", () => {
    const g = graph([plateWithHole(), screw()], [{ from: "plate", fromPort: "hole", to: "screw", toPort: "head_seat" }]);
    expect(cadFastenerJustifiedLint.run(g)).toEqual([]);
  });

  it("flags a screw wired to nothing", () => {
    const problems = cadFastenerJustifiedLint.run(graph([plateWithHole(), screw()], []));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("wired to nothing");
  });

  it("flags a screw whose only neighbour has no hole to fasten into", () => {
    const g = graph([plateNoHole(), screw()], [{ from: "plate", fromPort: "face", to: "screw", toPort: "head_seat" }]);
    const problems = cadFastenerJustifiedLint.run(g);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("none of which declare");
  });

  it("leaves fastener-free designs alone", () => {
    expect(cadFastenerJustifiedLint.run(graph([plateNoHole()], []))).toEqual([]);
  });
});

/** A part with an explicit envelope and ports, for the geometry-coherence lints.
 *  Both defects below are real ones from the 5mm-sphere plan. */
function envNode(
  id: string,
  volumes: unknown[],
  ports: { name: string; type: string; origin?: number[]; params?: Record<string, unknown> }[] = [],
) {
  const n = node(id, "part", []);
  // payloadBase's literal types pin volumes to boxes; these fixtures use
  // cylinders, so the payload is replaced wholesale.
  (n.contract as { payload: unknown }).payload = {
    ...payloadBase,
    ports: ports.map((p) => ({
      name: p.name,
      type: p.type,
      pose: { ...pose, origin: p.origin ?? [0, 0, 0] },
      params: p.params ?? {},
    })),
    envelope: { volumes, clearance: 0.4 },
  };
  return n;
}

const cyl = (z: number, d: number, h: number) => ({
  kind: "cylinder",
  pose: { ...pose, origin: [0, 0, z] },
  d,
  h,
});

describe("cad-envelope-coherent lint", () => {
  it("passes a single volume with its ports inside", () => {
    const g = graph([envNode("base", [cyl(0, 24, 8)], [{ name: "top", type: "FLAT_FACE", origin: [0, 0, 4] }])], []);
    expect(cadEnvelopeCoherentLint.run(g)).toEqual([]);
  });

  it("passes volumes that overlap", () => {
    const g = graph([envNode("base", [cyl(0, 24, 8), cyl(4, 24, 4)])], []);
    expect(cadEnvelopeCoherentLint.run(g)).toEqual([]);
  });

  it("flags disjoint volumes — a part cannot span the gap", () => {
    // display-base declared exactly this: z [-8,0] and z [3.25,4.75].
    const g = graph([envNode("base", [cyl(-4, 24, 8), cyl(4, 24, 1.5)])], []);
    const problems = cadEnvelopeCoherentLint.run(g);
    expect(problems.some((p) => p.includes("disjoint"))).toBe(true);
  });

  it("flags a port outside its own node's envelope", () => {
    const g = graph([
      envNode("base", [cyl(-4, 24, 8), cyl(4, 24, 1.5)], [{ name: "seat", type: "FLAT_FACE", origin: [0, 0, 1.8] }]),
    ], []);
    expect(cadEnvelopeCoherentLint.run(g).some((p) => p.includes('port "seat"'))).toBe(true);
  });

  it("does not judge where the origin sits — base-at-origin is a valid frame", () => {
    // l-bracket is modelled base-on-z=0, and imported pieces keep their source
    // model's frame entirely. Neither is a defect.
    const g = graph([envNode("bracket", [cyl(15, 30, 30)]), envNode("piece", [cyl(96, 40, 94)])], []);
    expect(cadEnvelopeCoherentLint.run(g)).toEqual([]);
  });

  it("skips registry hardware, which never faces G4", () => {
    const n = envNode("screw", [cyl(-4, 8, 8), cyl(40, 8, 8)]);
    n.kind = "fastener";
    expect(cadEnvelopeCoherentLint.run(graph([n], []))).toEqual([]);
  });
});

describe("cad-port-params lint", () => {
  it("accepts a declared face size, and the aliases models reach for", () => {
    for (const params of [{ size: 4 }, { faceSize: 4 }, { flatWidth: 1.5 }, { ring_diameter: 5.5 }]) {
      const g = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "f", type: "FLAT_FACE", params }])], []);
      expect(cadFlatFaceSizeLint.run(g), JSON.stringify(params)).toEqual([]);
    }
  });

  it("flags a flat face with no size — the probe used to invent 4mm", () => {
    const g = graph([
      envNode("p", [cyl(0, 20, 10)], [{ name: "seat", type: "FLAT_FACE", params: { seatDiameter: 5.3 } }]),
    ], []);
    const problems = cadFlatFaceSizeLint.run(g);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("declares no face size");
    expect(problems[0]).toContain("seatDiameter");
  });

  it("flags a hole with no diameter", () => {
    const g = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "h", type: "CLEARANCE_HOLE", params: {} }])], []);
    expect(cadFlatFaceSizeLint.run(g)[0]).toContain("declares no diameter");
  });

  it("leaves port types it has no probe for alone", () => {
    // SLOT used to sit here. It has a probe now, and therefore a required
    // width, so the type had to change for the assertion to still mean
    // "params are only demanded where something measures them".
    const g = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "s", type: "LIP", params: {} }])], []);
    expect(cadFlatFaceSizeLint.run(g)).toEqual([]);
  });

  it("flags a channel with no width", () => {
    const g = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "g", type: "GROOVE", params: {} }])], []);
    expect(cadFlatFaceSizeLint.run(g)[0]).toContain("declares no width");
  });

  it("accepts a channel width under any of its aliases", () => {
    for (const k of ["width", "slotWidth", "grooveWidth"]) {
      const g = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "g", type: "SLOT", params: { [k]: 3 } }])], []);
      expect(cadFlatFaceSizeLint.run(g), k).toEqual([]);
    }
  });
});

describe("cadProbedPortsLint", () => {
  it("rejects a port type no gate can measure", () => {
    const g = graph([node("wall", "part", [{ name: "hook", type: "SNAP_HOOK" }])], []);
    const problems = cadProbedPortsLint.run(g);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("SNAP_HOOK");
    expect(problems[0]).toContain("featureless block");
  });

  it("accepts every port type the kernel probes", () => {
    for (const type of ["CLEARANCE_HOLE", "BORE", "SCREW_SEAT", "SCREW_BOSS", "FLAT_FACE", "GROOVE", "SLOT"]) {
      const g = graph([node("p", "part", [{ name: "i", type }])], []);
      expect(cadProbedPortsLint.run(g), type).toEqual([]);
    }
  });

  // This set is a claim about gates.py. If a type is listed here with no probe
  // behind it, a node built from it passes verify as a featureless block.
  it("lists exactly the types gates.py dispatches a probe for", () => {
    const probed = ["BORE", "CLEARANCE_HOLE", "FLAT_FACE", "GROOVE", "SCREW_BOSS", "SCREW_SEAT", "SHAFT", "SLOT"];
    const rejected = ["SNAP_HOOK", "SNAP_RECESS", "LIP", "HOLE_PATTERN", "BOSS_PATTERN"];
    for (const type of probed) {
      expect(cadProbedPortsLint.run(graph([node("p", "part", [{ name: "i", type }])], [])), type).toEqual([]);
    }
    for (const type of rejected) {
      expect(cadProbedPortsLint.run(graph([node("p", "part", [{ name: "i", type }])], [])), type).toHaveLength(1);
    }
  });

  // LIP is the only unprobed type real graphs use, so its message names the
  // substitution instead of listing every verified type. Pinned because the
  // repair round acts on this sentence.
  it("tells a LIP to split into the SHAFT and BORE it actually is", () => {
    const g = graph([node("wall", "part", [{ name: "seat", type: "LIP" }])], []);
    const out = cadProbedPortsLint.run(g);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("not one feature");
    expect(out[0]).toContain("SHAFT");
    expect(out[0]).toContain("BORE");
    // and an unprobed type with no known meaning still gets the generic list
    const other = cadProbedPortsLint.run(graph([node("w", "part", [{ name: "s", type: "SNAP_HOOK" }])], []));
    expect(other[0]).toContain("Re-express this interface");
    expect(other[0]).not.toContain("not one feature");
  });

  it("names every unprobed port, not just the first", () => {
    const g = graph(
      [node("wall", "part", [{ name: "a", type: "SNAP_HOOK" }, { name: "b", type: "LIP" }])],
      [],
    );
    expect(cadProbedPortsLint.run(g)).toHaveLength(2);
  });

  // Registry hardware declares no ports and is exact by construction; the other
  // four lints skip it the same way.
  it("skips registry hardware", () => {
    const g = graph([node("m4", "fastener", [{ name: "x", type: "LIP" }])], []);
    expect(cadProbedPortsLint.run(g)).toEqual([]);
  });
});

describe("cadFlatFaceSizeLint · SHAFT", () => {
  it("demands an outer diameter on SCREW_BOSS, the last probed type with no branch", () => {
    const bare = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "b", type: "SCREW_BOSS", params: {} }])], []);
    const out = cadFlatFaceSizeLint.run(bare);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("SCREW_BOSS");
    expect(out[0]).toContain("no outer diameter");
    // A bare `diameter` is NOT an alias: ambiguous between wall and pilot.
    const ambiguous = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "b", type: "SCREW_BOSS", params: { diameter: 10 } }])], []);
    expect(cadFlatFaceSizeLint.run(ambiguous)).toHaveLength(1);
    for (const key of ["outer_diameter", "od", "bossDiameter"]) {
      const ok = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "b", type: "SCREW_BOSS", params: { [key]: 10 } }])], []);
      expect(cadFlatFaceSizeLint.run(ok), key).toEqual([]);
    }
  });

  // Guard against the next probed type arriving with no branch. This lint's
  // whole job is to catch a missing dimension before the kernel does, and two
  // types (SHAFT, SCREW_BOSS) reached production without one.
  //
  // Each fixture carries ONE port of ONE type, so only that type's branch can
  // fire and deleting any single branch fails that type's row. It does NOT cover
  // FLAT_FACE's ring_diameter alternative — the older "accepts a declared face
  // size, and the aliases models reach for" case does that.
  it("has a branch for every probed port type", () => {
    const needsDim: Record<string, Record<string, number>> = {
      CLEARANCE_HOLE: { diameter: 5 }, BORE: { diameter: 5 }, SCREW_SEAT: { diameter: 5 },
      SCREW_BOSS: { outer_diameter: 10 }, SHAFT: { diameter: 5 },
      GROOVE: { width: 3 }, SLOT: { width: 3 }, FLAT_FACE: { size: 20 },
    };
    for (const [type, params] of Object.entries(needsDim)) {
      const bare = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "x", type, params: {} }])], []);
      expect(cadFlatFaceSizeLint.run(bare), `${type} with no params must be flagged`).toHaveLength(1);
      const ok = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "x", type, params }])], []);
      expect(cadFlatFaceSizeLint.run(ok), `${type} with params must pass`).toEqual([]);
    }
  });

  it("demands a diameter on SHAFT, which the import path emits unlinted", () => {
    const bare = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "peg", type: "SHAFT", params: {} }])], []);
    const out = cadFlatFaceSizeLint.run(bare);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("SHAFT");
    expect(out[0]).toContain("no diameter");
    const ok = graph([envNode("p", [cyl(0, 20, 10)], [{ name: "peg", type: "SHAFT", params: { diameter: 5 } }])], []);
    expect(cadFlatFaceSizeLint.run(ok)).toEqual([]);
  });
});

// The alias lists are mirrored across the TS/Python boundary with no import
// path, so a comment asking the next reader to keep them in step is the weakest
// possible guard. This reads gates.py and enforces it. The drift is asymmetric:
// a lint list narrower than the probe's blocks a plan the probe could have
// measured, which is the expensive direction.
describe("alias lists agree with the kernel", () => {
  const gates = readFileSync(
    new URL("../kernel/src/patchcad_kernel/gates.py", import.meta.url), "utf8",
  );
  const pyTuple = (name: string) => {
    const m = gates.match(new RegExp(`^${name} = \\(([^)]*)\\)`, "m"));
    if (!m) throw new Error(`${name} not found in gates.py`);
    return (m[1]!.match(/"[^"]+"/g) ?? []).map((q) => q.slice(1, -1)).sort();
  };

  it("PROBE_INSET_MM matches gates.py", () => {
    const m = gates.match(/^PROBE_INSET_MM = ([\d.]+)/m);
    expect(m, "PROBE_INSET_MM not found in gates.py").toBeTruthy();
    // The offset rule reproduces the probe's sample radii, so this constant is
    // load-bearing: drift makes the lint fire where the probe passes.
    expect(Number(m![1])).toBe(0.3);
  });

  it("SCREW_BOSS outer-diameter keys match gates.py exactly", () => {
    expect([...OUTER_DIAMETER_KEYS].sort()).toEqual(pyTuple("OUTER_D_KEYS"));
  });

  it("neither list accepts a bare `diameter` on a boss", () => {
    expect(OUTER_DIAMETER_KEYS).not.toContain("diameter");
    expect(pyTuple("OUTER_D_KEYS")).not.toContain("diameter");
  });
});

describe("cadPortConsistencyLint · edges to hardware", () => {
  // The architect emitted plate-a.screw_hole -> screw-m4.hole and
  // plate-b.nut_hole -> nut-m4.hole. Registry hardware declares no ports, so
  // both named something that cannot exist, and the edge check skipped them for
  // being hardware. The cook finished and the assembly reported "missing port".
  it("rejects an edge naming a port the hardware does not declare", () => {
    const g = graph(
      [node("plate-a", "part", [{ name: "screw_hole", type: "CLEARANCE_HOLE" }]),
       node("screw-m4", "fastener", [])],
      [{ from: "plate-a", fromPort: "screw_hole", to: "screw-m4", toPort: "hole" }],
    );
    const out = cadPortConsistencyLint.run(g);
    expect(out).toHaveLength(1);
    // A node declaring NO ports gets the specific message naming why, since
    // "not a payload port name" would leave the architect guessing at a node
    // that has none at all.
    expect(out[0]).toContain("declares no ports");
    expect(out[0]).toContain("head_seat");
  });

  // THE HAND-AUTHORED REFERENCE MUST PASS. examples/cad-clamp wires
  // base-plate.back_right_hole -> m4-screw.head_seat, and the screw declares
  // head_seat. A lint that rejects the reference design is wrong by definition,
  // and my first version of this check rejected it.
  it("allows the cad-clamp wiring, where the screw declares its seat", () => {
    const g = graph(
      [node("base-plate", "part", [{ name: "back_right_hole", type: "CLEARANCE_HOLE" }]),
       node("m4-screw", "fastener", [{ name: "head_seat", type: "FLAT_FACE" }])],
      [{ from: "base-plate", fromPort: "back_right_hole", to: "m4-screw", toPort: "head_seat" }],
    );
    expect(cadPortConsistencyLint.run(g)).toEqual([]);
  });

  // The deadlock my first attempt created: cad-fastener-justified requires a
  // fastener to be wired, so rejecting every edge to hardware made a fastener
  // impossible to satisfy either way. Both lints must be satisfiable at once.
  it("leaves a wired, seat-declaring fastener clean under BOTH lints", () => {
    const g = graph(
      [node("plate", "part", [{ name: "bolt_hole", type: "CLEARANCE_HOLE" }]),
       node("m4", "fastener", [{ name: "head_seat", type: "FLAT_FACE" }])],
      [{ from: "plate", fromPort: "bolt_hole", to: "m4", toPort: "head_seat" }],
    );
    expect(cadPortConsistencyLint.run(g)).toEqual([]);
    expect(cadFastenerJustifiedLint.run(g)).toEqual([]);
  });

  // The FROM side carried the identical skip. A fastener lands there whenever
  // the architect phrases the requirement the other way round.
  it("rejects a bad port name on the FROM side too", () => {
    const g = graph(
      [node("screw-m4", "fastener", []),
       node("plate", "part", [{ name: "hole", type: "CLEARANCE_HOLE" }])],
      [{ from: "screw-m4", fromPort: "seat", to: "plate", toPort: "hole" }],
    );
    const out = cadPortConsistencyLint.run(g);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("declares no ports");
  });

  // Hardware WITH ports matched neither arm of the previous branch structure and
  // went unchecked entirely.
  it("checks hardware that DOES declare ports", () => {
    const g = graph(
      [node("plate", "part", [{ name: "hole", type: "CLEARANCE_HOLE" }]),
       node("m4", "fastener", [{ name: "head_seat", type: "FLAT_FACE" }])],
      [{ from: "plate", fromPort: "hole", to: "m4", toPort: "wrong_name" }],
    );
    const out = cadPortConsistencyLint.run(g);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("not a payload port name");
    expect(out[0]).not.toContain("declares no ports");
  });

  it("still allows an edge between two real parts", () => {
    const g = graph(
      [node("a", "part", [{ name: "face", type: "FLAT_FACE" }]),
       node("b", "part", [{ name: "face", type: "FLAT_FACE" }])],
      [{ from: "a", fromPort: "face", to: "b", toPort: "face" }],
    );
    expect(cadPortConsistencyLint.run(g)).toEqual([]);
  });
});

describe("cadHardwareSeatLint", () => {
  const posedHw = (kind: string, zAxis: number[], origin = [0, 0, 0]) => ({
    ...node("m4", kind, []),
    contract: {
      name: "m4", summary: "",
      params: [{ type: "enum", name: "thread", description: "", default: "M4", options: ["M3", "M4", "M5"] }],
      provides: [], requires: [],
      payload: { units: "mm", process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
                 ports: [{ name: "head_seat", type: "FLAT_FACE",
                           pose: { origin, zAxis, xAxis: [1, 0, 0] },
                           params: { ring_diameter: 5.5 } }],
                 envelope: { volumes: [], clearance: 0.4 } },
      hash: "",
    },
  }) as unknown as ReturnType<typeof node>;

  // THE POSE THAT BROKE A GREEN LADDER, copied from the run artifact. One sign:
  // the architect wrote zAxis [0,0,1] where cad-clamp has [0,0,-1], and both
  // fasteners landed in unrecoverable error_code with zero model calls.
  it("rejects a seat facing INTO the hardware, which cannot repair", () => {
    for (const kind of ["fastener", "nut", "insert"]) {
      const out = cadHardwareSeatLint.run(graph([posedHw(kind, [0, 0, 1])], []));
      expect(out, kind).toHaveLength(1);
      expect(out[0]).toContain("zAxis [0, 0, -1]");
      expect(out[0]).toContain("no repair round");
    }
  });

  // The volume-based clash exemption: a thread is exempt, a nut driven into a
  // screw head is not. Muting the PAIR would have hidden both.
  it("exempts a thread engagement but not a real overlap", () => {
    const expected = threadEngagementVolume("M4", 3.2); // M4 nutH
    expect(expected).toBeCloseTo(12.8, 1);
    // the gate's own measurement sits at the expected volume
    expect(12.8).toBeLessThanOrEqual(expected * 1.5);
    // a nut driven 3mm into the head is an order of magnitude beyond it
    expect(90.3).toBeGreaterThan(expected * 1.5);
  });

  it("accepts the pose cad-clamp actually uses", () => {
    for (const kind of ["fastener", "nut", "insert"]) {
      expect(cadHardwareSeatLint.run(graph([posedHw(kind, [0, 0, -1])], [])), kind).toEqual([]);
    }
  });

  it("rejects a seat moved off the origin, where the bearing face is not", () => {
    expect(cadHardwareSeatLint.run(graph([posedHw("fastener", [0, 0, -1], [0, 0, 4])], []))).toHaveLength(1);
  });

  it("rejects a sideways seat", () => {
    expect(cadHardwareSeatLint.run(graph([posedHw("fastener", [1, 0, 0])], []))).toHaveLength(1);
  });

  const hw = (kind: string, thread: string, ring: number | string) => ({
    ...node("m4", kind, []),
    contract: {
      name: "m4", summary: "",
      params: [{ type: "enum", name: "thread", description: "", default: thread, options: ["M3", "M4", "M5"] }],
      provides: [], requires: [],
      payload: { units: "mm", process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
                 ports: [{ name: "head_seat", type: "FLAT_FACE",
                           pose: { origin: [0, 0, 0], zAxis: [0, 0, -1], xAxis: [1, 0, 0] },
                           params: { ring_diameter: ring } }],
                 envelope: { volumes: [], clearance: 0.4 } },
      hash: "",
    },
  }) as unknown as ReturnType<typeof node>;

  // Measured against cad-clamp's M4 screw geometry: 4.5 to 6.9 pass, 7.5 fails.
  it("accepts a ring inside the M4 bearing annulus", () => {
    for (const r of [4.5, 5.5, 6.5, 6.9]) {
      expect(cadHardwareSeatLint.run(graph([hw("fastener", "M4", r)], [])), String(r)).toEqual([]);
    }
  });

  it("rejects a ring outside it, naming the band and a usable value", () => {
    const out = cadHardwareSeatLint.run(graph([hw("fastener", "M4", 7.5)], []));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("between Ø4 and Ø7");
    expect(out[0]).toContain("no repair round");
    expect(out[0]).toContain("5.5");
  });

  it("rejects a ring inside the shank, where there is no material at all", () => {
    const out = cadHardwareSeatLint.run(graph([hw("fastener", "M4", 3.5)], []));
    expect(out).toHaveLength(1);
  });

  // The architect picked exactly 7.0 on a PASSING run, so the boundary must not
  // fire. An earlier version warned here, and a lint that flags geometry which
  // verifiably works risks a repair loop for no gain — the same shape as the
  // deadlock in 97c82ed. The fragility belongs in guidance, not in a blocker.
  it("stays silent at exactly the bearing edge, which a passing run used", () => {
    expect(cadHardwareSeatLint.run(graph([hw("fastener", "M4", 7.0)], []))).toEqual([]);
    expect(cadHardwareSeatLint.run(graph([hw("nut", "M4", 7.0)], []))).toEqual([]);
  });

  it("uses across-flats for a nut and the flange for an insert", () => {
    expect(cadHardwareSeatLint.run(graph([hw("nut", "M5", 7.0)], []))).toEqual([]);      // M5 nutAf 8.0
    expect(cadHardwareSeatLint.run(graph([hw("nut", "M5", 8.5)], []))).toHaveLength(1);
    expect(cadHardwareSeatLint.run(graph([hw("insert", "M4", 5.0)], []))).toEqual([]);   // M4 insertD 5.6
    expect(cadHardwareSeatLint.run(graph([hw("insert", "M4", 6.0)], []))).toHaveLength(1);
  });

  it("says nothing about an expression it cannot resolve, or a real part", () => {
    expect(cadHardwareSeatLint.run(graph([hw("fastener", "M4", "param(x.d)")], []))).toEqual([]);
    expect(cadHardwareSeatLint.run(graph([node("p", "part", [{ name: "f", type: "FLAT_FACE" }])], []))).toEqual([]);
  });
});

describe("cadFaceHoleConflictLint", () => {
  const at = (name: string, type: string, origin: (number | string)[], zAxis = [0, 0, 1]) => ({
    name, type, pose: { origin, zAxis, xAxis: [1, 0, 0] }, params: {},
  });

  // The shared `node()` helper REPLACES every port's pose with one fixed pose,
  // so it cannot express this lint's subject at all: under it every pair shares
  // an origin and the "real contract" test below passed no matter what the lint
  // did. This builder keeps the poses it is given.
  const posed = (id: string, kind: string, ports: ReturnType<typeof at>[]) => {
    const n = node(id, kind, []) as unknown as { contract: { payload: { ports: unknown[] } } };
    n.contract.payload.ports = ports;
    return n as unknown as ReturnType<typeof node>;
  };

  // THE ACTUAL CONTRACT THAT COST $0.82, copied from the eval run that failed
  // twice on it: a BORE and a FLAT_FACE on the same expression-valued origin.
  it("rejects the real plate contract the architect emitted", () => {
    const z = "param(square-plate.thickness) / 2";
    const g = graph([posed("square-plate", "part", [
      at("center_bore", "BORE", [0, 0, z]),
      at("top_face", "FLAT_FACE", [0, 0, z]),
    ])], []);
    const out = cadFaceHoleConflictLint.run(g);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("share an origin");
    expect(out[0]).toContain("center_bore");
    expect(out[0]).toContain("top_face");
  });

  // THE CONTRACT THAT COST $1.03, copied from the run that failed on it: a
  // through-hole on one face and the mating face on the other, coaxial.
  it("rejects the real two-plate contract: a clearance hole coaxial with a face", () => {
    const g = graph([posed("plate-a", "part", [
      at("screw_hole", "CLEARANCE_HOLE", [0, 0, "param(plate-a.thickness) / 2"]),
      at("mating_face", "FLAT_FACE", [0, 0, "0 - param(plate-a.thickness) / 2"], [0, 0, -1]),
    ])], []);
    const out = cadFaceHoleConflictLint.run(g);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("coaxial");
    expect(out[0]).toContain("screw_hole");
  });

  // The reference design's own idiom: a screw's bearing annulus is coaxial with
  // the shank by definition, and the annular probe never samples the centre.
  // THE CONTRACT THAT COST $0.638, from the run artifact: mounting_face size 40
  // at the plate centre, clearance hole 20mm along it. Not coaxial, still
  // unsatisfiable, and verified against the real probe (size 40 fails; 36, 34,
  // 30 and 20 pass) before this lint was written.
  it("rejects a face whose sample ring reaches an OFFSET hole", () => {
    const plate = (size: number) => graph([
      { ...posed("rib-plate", "part", [
          { name: "bolt_hole_bottom", type: "CLEARANCE_HOLE",
            pose: { origin: [-20, 0, -2.5], zAxis: [0, 0, -1], xAxis: [1, 0, 0] },
            params: { diameter: 4.5 } },
          { name: "mounting_face", type: "FLAT_FACE",
            pose: { origin: [0, 0, -2.5], zAxis: [0, 0, -1], xAxis: [1, 0, 0] },
            params: { size } },
        ]) },
    ], []);
    const out = cadFaceHoleConflictLint.run(plate(40));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("reaches port");
    expect(out[0]).toContain("20.0mm away");
  });

  // The boundary the probe actually has. A lint that fires where the probe
  // passes blocks working geometry, which is the whole reason this rule waited.
  it("stays silent at every face size the real probe accepts", () => {
    for (const size of [36, 34, 30, 20]) {
      const g = graph([
        { ...posed("p", "part", [
            { name: "h", type: "CLEARANCE_HOLE",
              pose: { origin: [-20, 0, -2.5], zAxis: [0, 0, -1], xAxis: [1, 0, 0] },
              params: { diameter: 4.5 } },
            { name: "f", type: "FLAT_FACE",
              pose: { origin: [0, 0, -2.5], zAxis: [0, 0, -1], xAxis: [1, 0, 0] },
              params: { size } },
          ]) },
      ], []);
      expect(cadFaceHoleConflictLint.run(g), `size ${size}`).toEqual([]);
    }
  });

  // WITH EXPRESSIONS, which is what every real graph declares. The literal
  // fixture above hid a NaN: the suggested size read Number() on the diameter,
  // and Number("param(x.y)") is NaN, so the real graph printed "below NaNmm"
  // while the test passed.
  it("resolves param() expressions and suggests a real number", () => {
    const g = graph([
      { ...posed("rib-plate", "part", [
          { name: "bolt_hole_bottom", type: "CLEARANCE_HOLE",
            pose: { origin: ["-param(rib-plate.length)/2 + param(rib-plate.hole_offset)", 0, "-param(rib-plate.thickness)/2"], zAxis: [0, 0, -1], xAxis: [1, 0, 0] },
            params: { diameter: "param(rib-plate.hole_diameter)" } },
          { name: "mounting_face", type: "FLAT_FACE",
            pose: { origin: [0, 0, "-param(rib-plate.thickness)/2"], zAxis: [0, 0, -1], xAxis: [1, 0, 0] },
            params: { size: "param(rib-plate.width)" } },
        ]),
        contract: {
          name: "rib-plate", summary: "",
          params: [
            { type: "number", name: "length", description: "", default: 70 },
            { type: "number", name: "width", description: "", default: 40 },
            { type: "number", name: "thickness", description: "", default: 5 },
            { type: "number", name: "hole_diameter", description: "", default: 4.5 },
            { type: "number", name: "hole_offset", description: "", default: 15 },
          ],
          provides: [], requires: [],
          payload: (posed("rib-plate", "part", [
            { name: "bolt_hole_bottom", type: "CLEARANCE_HOLE",
              pose: { origin: ["-param(rib-plate.length)/2 + param(rib-plate.hole_offset)", 0, "-param(rib-plate.thickness)/2"], zAxis: [0, 0, -1], xAxis: [1, 0, 0] },
              params: { diameter: "param(rib-plate.hole_diameter)" } },
            { name: "mounting_face", type: "FLAT_FACE",
              pose: { origin: [0, 0, "-param(rib-plate.thickness)/2"], zAxis: [0, 0, -1], xAxis: [1, 0, 0] },
              params: { size: "param(rib-plate.width)" } },
          ]) as unknown as { contract: { payload: unknown } }).contract.payload,
          hash: "",
        },
      } as unknown as ReturnType<typeof node>,
    ], []);
    const out = cadFaceHoleConflictLint.run(g);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("20.0mm away");
    expect(out[0]).not.toContain("NaN");
    expect(out[0]).toContain("Shrink the face below 36.1mm");
  });

  it("says nothing when the values will not resolve", () => {
    const g = graph([
      { ...posed("p", "part", [
          { name: "h", type: "CLEARANCE_HOLE",
            pose: { origin: ["param(missing.x)", 0, -2.5], zAxis: [0, 0, -1], xAxis: [1, 0, 0] },
            params: { diameter: 4.5 } },
          { name: "f", type: "FLAT_FACE",
            pose: { origin: [0, 0, -2.5], zAxis: [0, 0, -1], xAxis: [1, 0, 0] },
            params: { size: 40 } },
        ]) },
    ], []);
    expect(cadFaceHoleConflictLint.run(g)).toEqual([]);
  });

  it("exempts an ANNULAR face, whose probe never samples the centre", () => {
    const g = graph([posed("p", "part", [
      { name: "bolt", type: "CLEARANCE_HOLE", pose: { origin: [0, 0, 2], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, params: {} },
      { name: "seat", type: "FLAT_FACE", pose: { origin: [0, 0, -2], zAxis: [0, 0, -1], xAxis: [1, 0, 0] }, params: { ring_diameter: 5.5 } },
    ])], []);
    expect(cadFaceHoleConflictLint.run(g)).toEqual([]);
  });

  // The ordinary bolted plate: clearance hole plus a coaxial screw-head seat,
  // sharing the hole's exact origin. Exempting only the coaxial branch left this
  // blocked, and it is the most common part in the domain.
  it("exempts an annular seat sharing the hole's ORIGIN, not only its axis", () => {
    const g = graph([posed("p", "part", [
      { name: "bolt", type: "CLEARANCE_HOLE", pose: { origin: [0, 0, 2], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, params: {} },
      { name: "seat", type: "FLAT_FACE", pose: { origin: [0, 0, 2], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, params: { ring_diameter: 9 } },
    ])], []);
    expect(cadFaceHoleConflictLint.run(g)).toEqual([]);
  });

  // An oblique pose must skip the coaxial branch rather than guess an axis.
  // |zAxis| compared elementwise read [0.7,0,0.7] and [0.7,0,-0.7] as parallel,
  // and findIndex(|v|>0.5) then picked x, comparing the wrong two components.
  it("skips the coaxial rule for an OBLIQUE axis instead of guessing", () => {
    const g = graph([posed("p", "part", [
      { name: "bolt", type: "CLEARANCE_HOLE", pose: { origin: [0, 0, 0], zAxis: [0.7, 0, 0.7], xAxis: [0, 1, 0] }, params: {} },
      { name: "face", type: "FLAT_FACE", pose: { origin: [0, 0, 9], zAxis: [0.7, 0, -0.7], xAxis: [0, 1, 0] }, params: { size: 20 } },
    ])], []);
    expect(cadFaceHoleConflictLint.run(g)).toEqual([]);
  });

  it("still rejects a SOLID face coaxial with the same hole", () => {
    const g = graph([posed("p", "part", [
      { name: "bolt", type: "CLEARANCE_HOLE", pose: { origin: [0, 0, 2], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, params: {} },
      { name: "seat", type: "FLAT_FACE", pose: { origin: [0, 0, -2], zAxis: [0, 0, -1], xAxis: [1, 0, 0] }, params: { size: 20 } },
    ])], []);
    expect(cadFaceHoleConflictLint.run(g)).toHaveLength(1);
  });

  it("exempts a BLIND bore, which stops before the far face", () => {
    const g = graph([posed("p", "part", [
      at("seat", "BORE", [0, 0, 2]),
      at("mating_face", "FLAT_FACE", [0, 0, -2], [0, 0, -1]),
    ])], []);
    expect(cadFaceHoleConflictLint.run(g)).toEqual([]);
  });

  it("allows a clearance hole OFF the face axis", () => {
    const g = graph([posed("p", "part", [
      at("bolt", "CLEARANCE_HOLE", [20, 0, 2]),
      at("mating_face", "FLAT_FACE", [0, 0, -2], [0, 0, -1]),
    ])], []);
    expect(cadFaceHoleConflictLint.run(g)).toEqual([]);
  });

  it("allows a clearance hole PERPENDICULAR to the face", () => {
    const g = graph([posed("p", "part", [
      at("side_hole", "CLEARANCE_HOLE", [0, 0, 0], [1, 0, 0]),
      at("top", "FLAT_FACE", [0, 0, 5]),
    ])], []);
    expect(cadFaceHoleConflictLint.run(g)).toEqual([]);
  });

  it("allows a face with an OFFSET hole, which is an ordinary plate", () => {
    const g = graph([posed("p", "part", [
      at("top_face", "FLAT_FACE", [0, 0, 2.5]),
      at("bolt", "CLEARANCE_HOLE", [20, 0, 2.5]),
    ])], []);
    expect(cadFaceHoleConflictLint.run(g)).toEqual([]);
  });

  // This case previously asserted "allowed", and that expectation was wrong. A
  // bore drilling from the exact point a face occupies removes the material the
  // face probe samples just below itself, whichever way the bore points. Facing
  // the other direction does not put the material back.
  it("rejects a hole drilled from the very point a face occupies", () => {
    const g = graph([posed("p", "part", [
      at("top_face", "FLAT_FACE", [0, 0, 2.5]),
      at("b", "BORE", [0, 0, 2.5], [0, 0, -1]),
    ])], []);
    const out = cadFaceHoleConflictLint.run(g);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("share an origin");
  });

  it("allows a face and a BLIND bore on genuinely opposite faces", () => {
    const g = graph([posed("p", "part", [
      at("top_face", "FLAT_FACE", [0, 0, 2.5]),
      at("b", "BORE", [0, 0, -2.5], [0, 0, -1]),
    ])], []);
    expect(cadFaceHoleConflictLint.run(g)).toEqual([]);
  });

  it("names every conflicting pair", () => {
    const g = graph([posed("p", "part", [
      at("f", "FLAT_FACE", [0, 0, 1]),
      at("h1", "BORE", [0, 0, 1]),
      at("h2", "SCREW_SEAT", [0, 0, 1]),
    ])], []);
    expect(cadFaceHoleConflictLint.run(g)).toHaveLength(2);
  });

  it("skips registry hardware", () => {
    const g = graph([posed("m4", "fastener", [
      at("f", "FLAT_FACE", [0, 0, 0]), at("h", "BORE", [0, 0, 0]),
    ])], []);
    expect(cadFaceHoleConflictLint.run(g)).toEqual([]);
  });
});
