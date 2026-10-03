import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { contractHash, type GenerateCtx } from "@patchcad/engine";
import { CadContractPayload } from "./index.js";
import { meshSourceLint } from "./mesh-source.js";
import { SILHOUETTE_MIN_IOU, silhouetteAdvisories } from "./silhouette.js";
import { generatePrompt } from "./prompts.js";

/** Phase 6 on the CAD side: geometrySource + visualRef in the payload, the
 *  mesh lint, the silhouette advisory, and what a generator gets to see. */

const pose = { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] };
const payload = (extra: Record<string, unknown> = {}, ports: { name: string; type: string }[] = []) => ({
  units: "mm",
  process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
  ports: ports.map((p) => ({ ...p, pose, params: {} })),
  envelope: { volumes: [{ kind: "box", pose, dims: [10, 10, 10] }], clearance: 0.4 },
  ...extra,
});

const graphOf = (nodes: Record<string, { title?: string; payload: unknown }>) =>
  GraphDoc.parse({
    schemaVersion: 1,
    id: "g",
    backend: "cad",
    brief: { goal: "" },
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, n]) => [
        id,
        {
          id, kind: "part", title: n.title ?? id, spec: "",
          contract: { name: id, summary: "", params: [], provides: [], requires: [], payload: n.payload, hash: "" },
          status: "planned",
        },
      ]),
    ),
    edges: [],
    assembly: { entryNodeId: Object.keys(nodes)[0]! },
  });

describe("payload fields", () => {
  it("leave the contract hash alone when absent", () => {
    const parsed = CadContractPayload.parse(payload());
    expect("geometrySource" in parsed).toBe(false);
    expect("visualRef" in parsed).toBe(false);
    const c = { name: "n", summary: "", params: [], provides: [], requires: [], hash: "" };
    // The schema as it was before these fields existed hashes the same.
    const before = CadContractPayload.omit({ geometrySource: true, visualRef: true }).parse(payload());
    expect(contractHash({ ...c, payload: parsed })).toBe(contractHash({ ...c, payload: before }));
  });

  it("accept parametric | mesh and nothing else", () => {
    expect(CadContractPayload.parse(payload({ geometrySource: "mesh" })).geometrySource).toBe("mesh");
    expect(() => CadContractPayload.parse(payload({ geometrySource: "sculpt" }))).toThrow();
  });
});

describe("mesh-source lint", () => {
  it("passes parametric and unlabelled nodes", () => {
    const g = graphOf({ a: { payload: payload({ geometrySource: "parametric" }, [{ name: "b", type: "BORE" }]) }, b: { payload: payload() } });
    expect(meshSourceLint(false).run(g)).toEqual([]);
  });

  it("refuses any mesh node while mesh generation is not configured", () => {
    const g = graphOf({ body: { payload: payload({ geometrySource: "mesh" }, [{ name: "f", type: "FLAT_FACE" }]) } });
    const problems = meshSourceLint(false).run(g);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("mesh generation not configured");
  });

  it("allows only FLAT_FACE and joint ports on a mesh node once configured", () => {
    const g = graphOf({
      body: {
        payload: payload({ geometrySource: "mesh" }, [
          { name: "seat", type: "FLAT_FACE" },
          { name: "joint", type: "CLEARANCE_HOLE" },
          { name: "battery", type: "SCREW_BOSS" },
        ]),
      },
    });
    g.brief.refs = [{ hash: "abc", mask: false }];
    const problems = meshSourceLint(true).run(g);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"battery" is SCREW_BOSS');
  });
});

describe("silhouette advisories", () => {
  const g = graphOf({ fuselage: { title: "Fuselage", payload: payload() }, tail: { title: "Tail Boom", payload: payload() } });
  const view = (iou: number) => ({
    view: "side",
    ref: "abc",
    iou,
    parts: [
      { key: "tail", area_px: 900, excess_px: 50, missing_px: 1200 },
      { key: "fuselage", area_px: 9000, excess_px: 100, missing_px: 80 },
    ],
  });

  it("stay silent at or above the threshold", () => {
    expect(silhouetteAdvisories(g, [view(SILHOUETTE_MIN_IOU)])).toEqual([]);
  });

  it("name the view, the score and the part that differs most", () => {
    const [a] = silhouetteAdvisories(g, [view(0.62)]);
    expect(a).toMatchObject({ kind: "silhouette", nodes: ["tail"], measured: 0.62, expected: 0.8, view: "side", ref: "abc" });
    expect(a!.message).toContain("silhouette IoU 0.62 < 0.8 in side view");
    expect(a!.message).toContain("Tail Boom");
    expect(a!.message).toContain("advisory");
  });

  it("sum placed copies into their node", () => {
    const v = { ...view(0.5), parts: [
      { key: "fuselage", area_px: 1, excess_px: 400, missing_px: 0 },
      { key: "tail", area_px: 1, excess_px: 300, missing_px: 0 },
      { key: "tail#1", area_px: 1, excess_px: 300, missing_px: 0 },
    ] };
    expect(silhouetteAdvisories(g, [v])[0]!.nodes).toEqual(["tail", "fuselage"]);
  });
});

describe("generator sees its own reference, nothing else", () => {
  const ctx = (over: Partial<GenerateCtx<CadContractPayload>["node"]> = {}, refImages?: GenerateCtx["refImages"]) =>
    ({
      brief: { goal: "a toy helicopter", design: "", refs: [{ hash: "r", view: "side", mask: true }] },
      node: {
        id: "tail", kind: "part", title: "Tail", spec: "a boom",
        contract: { name: "t", summary: "", params: [], provides: [], requires: [], hash: "",
                    payload: CadContractPayload.parse(payload({ visualRef: "thin boom tapering to the rear" })) },
        params: {}, thread: [], ...over,
      },
      upstream: [], downstream: [],
      ...(refImages ? { refImages } : {}),
    }) as GenerateCtx<CadContractPayload>;

  it("prints the node's visualRef", () => {
    expect(generatePrompt(ctx()).messages[0]!.content).toContain("In the reference image: thin boom tapering to the rear");
  });

  it("attaches only images from the node's own thread, and none otherwise", () => {
    expect(generatePrompt(ctx()).messages[0]!.images).toBeUndefined();
    const img = { mediaType: "image/png" as const, dataB64: "AAAA" };
    expect(generatePrompt(ctx({}, [img])).messages[0]!.images).toEqual([img]);
  });
});
