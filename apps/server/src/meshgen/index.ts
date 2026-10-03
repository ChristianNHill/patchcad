import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { NodeRecord } from "@patchcad/shared";
import type { CadContractPayload, MeshSource } from "@patchcad/backend-cad";
import { HostedMeshGen } from "./hosted.js";
import { MeshyMeshGen } from "./meshy.js";

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

/** The CAD backend's MeshSource over a configured provider. */
export function meshSourceFor(provider: MeshGenProvider): MeshSource {
  return {
    async generate({ node, graph, projectDir }, signal) {
      const out = await provider.generate(
        {
          images: await refImages(projectDir, graph.brief.refs),
          prompt: meshPrompt(node),
          targetSizeMm: graph.brief.sizeMm,
          symmetric: graph.brief.symmetric,
        },
        signal,
      );
      return { glb: out.glb, usd: out.usage?.usd };
    },
  };
}
