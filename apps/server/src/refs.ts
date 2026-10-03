import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { RefView, type RefImage } from "@patchcad/shared";
import type { LlmImage } from "@patchcad/engine";
import type { KernelClient } from "@patchcad/backend-cad";

/** An image as the studio sends it: already downscaled to <=1568px. */
export const UploadedImage = z.object({
  dataB64: z.string().min(16),
  mediaType: z.enum(["image/png", "image/jpeg"]),
  view: RefView.optional(),
});
export type UploadedImage = z.infer<typeof UploadedImage>;

/** A reference image between /plan and /plan/approve: the project dir does not
 *  exist yet, so the bytes wait here with the pending plan. */
export interface PendingRef {
  ref: RefImage;
  png: Buffer;
  mask: Buffer | null;
  /** What the architect sees: the prepped picture when prep ran. */
  image: LlmImage;
}

const shortHash = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);

/** Background removal + crop + silhouette through the kernel. A kernel that
 *  cannot prep (down, no subject found) still lets the plan see the raw
 *  image; it just has no silhouette for G6, and the log says so. */
export async function prepReferences(
  kernel: KernelClient,
  images: UploadedImage[],
  log: (line: string) => void,
): Promise<PendingRef[]> {
  return Promise.all(
    images.map(async (img): Promise<PendingRef> => {
      const raw = Buffer.from(img.dataB64, "base64");
      try {
        const prep = await kernel.prepImage(img.dataB64);
        if (!prep.ok) throw new Error(prep.error);
        const png = Buffer.from(prep.png_b64, "base64");
        if (prep.method !== "rembg") log(`reference image: background removal fell back to ${prep.method}`);
        return {
          ref: { hash: shortHash(png), view: img.view, aspect: prep.aspect, mask: true },
          png,
          mask: Buffer.from(prep.mask_b64, "base64"),
          image: { mediaType: "image/png", dataB64: prep.png_b64 },
        };
      } catch (err) {
        log(`reference image not prepped (${(err as Error).message}); the architect sees it raw and G6 has no silhouette`);
        return {
          ref: { hash: shortHash(raw), view: img.view, mask: false },
          png: raw,
          mask: null,
          image: { mediaType: img.mediaType, dataB64: img.dataB64 },
        };
      }
    }),
  );
}

/** refs/<hash>.png, plus refs/<hash>.mask.png when a silhouette exists. */
export async function writeRefs(dir: string, refs: PendingRef[]): Promise<void> {
  if (refs.length === 0) return;
  await mkdir(path.join(dir, "refs"), { recursive: true });
  for (const r of refs) {
    await writeFile(path.join(dir, "refs", `${r.ref.hash}.png`), r.png);
    if (r.mask) await writeFile(path.join(dir, "refs", `${r.ref.hash}.mask.png`), r.mask);
  }
}

/** A reprompt attachment, stored as-is; returns the file name the thread
 *  message records. */
export async function saveThreadRef(dir: string, img: UploadedImage): Promise<string> {
  const bytes = Buffer.from(img.dataB64, "base64");
  const name = `${shortHash(bytes)}.${img.mediaType === "image/png" ? "png" : "jpg"}`;
  await mkdir(path.join(dir, "refs"), { recursive: true });
  await writeFile(path.join(dir, "refs", name), bytes);
  return name;
}

/** CookDeps.loadRef for one project. Names come from the project's own
 *  thread, but are still confined to refs/. */
export function refLoader(dir: string): (name: string) => Promise<LlmImage | null> {
  return async (name) => {
    if (!/^[a-f0-9]{16}\.(png|jpg)$/.test(name)) return null;
    const bytes = await readFile(path.join(dir, "refs", name));
    return { mediaType: name.endsWith(".png") ? "image/png" : "image/jpeg", dataB64: bytes.toString("base64") };
  };
}
