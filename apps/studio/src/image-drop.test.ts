import { describe, expect, it } from "vitest";
import { MAX_SIDE, refsBody, scaledSize } from "./refs";

describe("reference image upload", () => {
  it("downscales the long side to the model's ceiling and never upscales", () => {
    expect(scaledSize(4000, 3000)).toEqual([MAX_SIDE, 1176]);
    expect(scaledSize(1000, 3136)).toEqual([500, MAX_SIDE]);
    expect(scaledSize(800, 600)).toEqual([800, 600]);
  });

  it("sends only what the plan endpoint accepts: no thumbnail URL, no ids, no empty options", () => {
    const img = { id: "x", dataB64: "AAAA", mediaType: "image/png" as const, url: "blob:1", view: "side" as const };
    expect(refsBody({ images: [img, { ...img, view: undefined }], symmetric: false })).toEqual({
      images: [
        { dataB64: "AAAA", mediaType: "image/png", view: "side" },
        { dataB64: "AAAA", mediaType: "image/png" },
      ],
    });
    expect(refsBody({ images: [], sizeMm: 150, symmetric: true })).toEqual({ images: [], sizeMm: 150, symmetric: true });
  });
});
