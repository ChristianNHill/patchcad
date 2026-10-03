/** Reference images (Phase 6): pure helpers shared by ImageDrop and the store. */

export type RefView = "front" | "side" | "back" | "top";

/** An image ready to send: downscaled, base64, with an optional view label. */
export interface RefDraft {
  id: string;
  dataB64: string;
  mediaType: "image/png" | "image/jpeg";
  /** Object URL for the thumbnail. */
  url: string;
  view?: RefView;
}

/** Claude's own ceiling: anything longer is downscaled by the API anyway, at
 *  our upload cost. */
export const MAX_SIDE = 1568;

/** Long side <= max, aspect kept, never upscaled. */
export function scaledSize(w: number, h: number, max = MAX_SIDE): [number, number] {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/** Reference images + size the next plan is drawn from (ImageDrop). */
export interface PlanRefs {
  images: RefDraft[];
  sizeMm?: number;
  symmetric: boolean;
}

/** The /plan body's image fields: only what the server's schema accepts. */
export function refsBody(r: PlanRefs) {
  return {
    images: r.images.map(({ dataB64, mediaType, view }) => ({ dataB64, mediaType, ...(view ? { view } : {}) })),
    ...(r.sizeMm ? { sizeMm: r.sizeMm } : {}),
    ...(r.symmetric ? { symmetric: true } : {}),
  };
}

