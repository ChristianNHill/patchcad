import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GraphDoc } from "@patchcad/shared";
import { planGraph, referenceLines } from "./architect.js";
import type { DomainBackend, LlmProvider, LlmRequest } from "./index.js";

/** Phase 6: reference images are part of the user's spec. Old docs must still
 *  parse, and the architect must see every image in every round. */

const doc = (brief: Record<string, unknown>) =>
  GraphDoc.parse({
    schemaVersion: 1,
    id: "p",
    backend: "cad",
    brief,
    nodes: {},
    edges: [],
    assembly: { entryNodeId: "x" },
  });

describe("brief.refs", () => {
  it("defaults to [] so a doc written before refs existed still parses", () => {
    expect(doc({ goal: "a cup" }).brief.refs).toEqual([]);
  });

  it("round-trips a labelled ref with its silhouette flag", () => {
    const b = doc({ goal: "g", refs: [{ hash: "ab12", view: "side", aspect: 0.5, mask: true }], sizeMm: 150 }).brief;
    expect(b.refs).toEqual([{ hash: "ab12", view: "side", aspect: 0.5, mask: true }]);
    expect(b.sizeMm).toBe(150);
  });

  it("rejects a view label outside front/side/back/top", () => {
    expect(() => doc({ goal: "g", refs: [{ hash: "a", view: "iso" }] })).toThrow();
  });
});

describe("referenceLines", () => {
  it("says nothing when there are no images and no size", () => {
    expect(referenceLines({})).toEqual([]);
  });

  it("numbers the images in attachment order with their labels, then the size", () => {
    const lines = referenceLines({ references: [{ view: "front", aspect: 0.5 }, {}], sizeMm: 120, symmetric: true });
    expect(lines[1]).toContain("image 1: front view, subject width/height 0.50");
    expect(lines[2]).toContain("image 2: view unlabelled");
    expect(lines.join("\n")).toContain("Target overall height: 120 mm");
    expect(lines.join("\n")).toContain("symmetric");
  });
});

describe("planGraph with references", () => {
  const emission = (blocked: boolean) => ({
    rationale: "r",
    design: "",
    nodes: [{ id: "body", kind: "part", title: "Body", spec: "s",
              contract: { name: "body", summary: "s", params: [], provides: [], requires: [], payload: { blocked } } }],
    edges: [],
    entryNodeId: "body",
  });
  const backend = {
    id: "cad",
    planning: {
      nodeKinds: [{ kind: "part", description: "d", guidance: "g" }],
      payloadSchema: z.object({ blocked: z.boolean() }),
      architectGuidance: [],
      graphLints: [{ run: (g: GraphDoc) => Object.values(g.nodes).filter((n) => (n.contract.payload as { blocked: boolean }).blocked).map(() => "blocked") }],
    },
  } as unknown as DomainBackend<unknown>;

  it("attaches every image to the goal turn of the draft AND each repair round", async () => {
    const seen: LlmRequest<unknown>[] = [];
    const provider = {
      id: "s",
      complete: async <T>(req: LlmRequest<T>) => {
        seen.push(req as LlmRequest<unknown>);
        return { data: emission(seen.length === 1) as T, usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, model: "s" };
      },
    } as unknown as LlmProvider;
    const image = { mediaType: "image/png" as const, dataB64: "AAAA" };
    await planGraph({ provider, backend, projectId: "t", goal: "a robot", references: [{ image, view: "front" }], sizeMm: 150 });
    expect(seen).toHaveLength(2);
    for (const req of seen) {
      expect(req.messages[0]!.images).toEqual([image]);
      expect(req.messages[0]!.content).toContain("image 1: front view");
      expect(req.messages[0]!.content).toContain("150 mm");
    }
  });
});
