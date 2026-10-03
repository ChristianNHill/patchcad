import { assertGlb, type MeshGenConfig, type MeshGenProvider, type MeshGenRequest } from "./index.js";

/**
 * Any endpoint that turns images into a GLB, e.g. Hunyuan3D-2 or TRELLIS on a
 * rented GPU behind a small wrapper. The contract, one synchronous call:
 *
 *   POST <url>   headers: content-type: application/json, plus config.headers
 *   {
 *     "images": [{ "png_b64": "<base64 PNG, background removed>", "view": "front" }],
 *     "prompt": "Body: a rounded egg standing upright",   // may be absent
 *     "target_size_mm": 120,                               // may be absent
 *     "symmetric": true,                                   // may be absent
 *     "preview": false                                     // true = a fast low-poly draft
 *   }
 *   → 200, body = the GLB bytes (any content-type; the "glTF" magic is checked)
 *   → anything else = failure; the body's first 300 chars are reported
 *
 * Scale and orientation do not matter beyond glTF's Y-up: the kernel rotates,
 * repairs and scales the mesh into the part's envelope. Untextured is fine.
 * A self-hosted GPU is billed by the hour, not the call, so this bills $0.
 */
export class HostedMeshGen implements MeshGenProvider {
  id = "hosted";
  constructor(
    private config: Extract<MeshGenConfig, { provider: "hosted" }>,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(req: MeshGenRequest, signal?: AbortSignal) {
    const res = await this.fetchImpl(this.config.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.config.headers },
      body: JSON.stringify({
        images: req.images.map((i) => ({ png_b64: i.pngB64, view: i.view })),
        prompt: req.prompt,
        target_size_mm: req.targetSizeMm,
        symmetric: req.symmetric,
        preview: req.preview ?? false,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`hosted mesh endpoint → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { glb: assertGlb(Buffer.from(await res.arrayBuffer()), "hosted mesh endpoint") };
  }
}
