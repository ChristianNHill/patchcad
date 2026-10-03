import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { NodeRecord } from "@patchcad/shared";
import type { CadContractPayload, MeshSource } from "@patchcad/backend-cad";
import { HostedMeshGen } from "./hosted.js";
import { MeshyMeshGen } from "./meshy.js";
import type { Budget } from "../spend.js";

/**
 * Image-to-3D for `geometrySource: "mesh"` nodes (Phase 6.4). A provider turns
 * reference images into a GLB; the CAD backend fits, repairs and gates it.
 * Absent from the config means no mesh generation, and the architect is told
 * so.
 */

export interface MeshGenRequest {
  /** Prepped (background-removed) reference PNGs, base64, with view labels. */
  images: { pngB64: string; view?: string }[];
  /** What the part is: its title and visualRef. Not every provider reads it. */
  prompt?: string;
  targetSizeMm?: number;
  symmetric?: boolean;
  /** A cheap low-poly draft for the plan preview, not the cooked part. */
  preview?: boolean;
}

export interface MeshGenProvider {
  id: string;
  generate(req: MeshGenRequest, signal?: AbortSignal): Promise<{ glb: Buffer; usage?: { usd: number } }>;
}

/** A generation that failed or was stopped after the vendor started billing:
 *  `usd` is what it still cost, so a budget and a ledger can count it. */
export class MeshGenError extends Error {
  constructor(
    message: string,
    readonly usd: number,
  ) {
    super(message);
    this.name = "MeshGenError";
  }
}

export const MeshGenConfig = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("meshy"),
    apiKey: z.string().min(1),
    /** Meshy's `ai_model` for the cooked part; the preview always uses meshy-6-lite. */
    model: z.string().optional(),
    /** Meshy bills credits and publishes no dollar rate; set yours to see dollars. */
    usdPerCredit: z.number().nonnegative().optional(),
  }),
  z.object({
    provider: z.literal("hosted"),
    url: z.string().url(),
    headers: z.record(z.string()).default({}),
  }),
]);
export type MeshGenConfig = z.infer<typeof MeshGenConfig>;

export function createMeshGen(config: MeshGenConfig, fetchImpl: typeof fetch = fetch): MeshGenProvider {
  return config.provider === "meshy" ? new MeshyMeshGen(config, fetchImpl) : new HostedMeshGen(config, fetchImpl);
}

/** A GLB starts with the ASCII magic "glTF". Anything else is an error page. */
export function assertGlb(bytes: Buffer, from: string): Buffer {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "glTF") {
    throw new Error(`${from} did not return a GLB (${bytes.length} bytes: ${bytes.toString("utf8", 0, 120)})`);
  }
  return bytes;
}

/** The project's prepped reference images, as a provider takes them. */
export async function refImages(projectDir: string, refs: { hash: string; view?: string }[]) {
  return Promise.all(
    refs.map(async (r) => ({
      pngB64: (await readFile(path.join(projectDir, "refs", `${r.hash}.png`))).toString("base64"),
      view: r.view,
    })),
  );
}

/** What a mesh node's generator is told in words: its title and visualRef. */
export function meshPrompt(node: Pick<NodeRecord, "title" | "contract">): string {
  const visualRef = (node.contract.payload as CadContractPayload | undefined)?.visualRef;
  return visualRef ? `${node.title}: ${visualRef}` : node.title;
}

/** The CAD backend's MeshSource over a configured provider. `budgetFor` finds
 *  the cook's budget by project dir, so mesh spend counts toward the same
 *  maxUsd as the wave's LLM calls. */
export function meshSourceFor(
  provider: MeshGenProvider,
  budgetFor: (projectDir: string) => Budget | undefined = () => undefined,
): MeshSource {
  return {
    async generate({ node, graph, projectDir }, signal) {
      const budget = budgetFor(projectDir);
      budget?.check();
      try {
        const out = await provider.generate(
          {
            images: await refImages(projectDir, graph.brief.refs),
            prompt: meshPrompt(node),
            targetSizeMm: graph.brief.sizeMm,
            symmetric: graph.brief.symmetric,
          },
          signal,
        );
        budget?.add(out.usage?.usd ?? 0);
        return { glb: out.glb, usd: out.usage?.usd };
      } catch (err) {
        if (err instanceof MeshGenError) budget?.add(err.usd);
        throw err;
      }
    },
  };
}
