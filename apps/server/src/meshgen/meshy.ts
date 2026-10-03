import { assertGlb, type MeshGenConfig, type MeshGenProvider, type MeshGenRequest } from "./index.js";

/**
 * Meshy image-to-3D (https://docs.meshy.ai/en/api/image-to-3d and
 * /multi-image-to-3d): create a task, poll it, download `model_urls.glb`.
 * One image goes to image-to-3d, two to four to multi-image-to-3d. Images go
 * inline as data URIs, which both endpoints accept.
 *
 * Asked for what a printed part needs and nothing it does not: untextured
 * (20 credits instead of 30), remeshed triangles, GLB only. Meshy's
 * `symmetry_mode` is deprecated and its text input only steers textures, so
 * `symmetric` and `prompt` are not sent. The preview is meshy-6-lite at a low
 * polycount (5 credits).
 */

const BASE = "https://api.meshy.ai/openapi/v1";
const POLL_MS = 5000;
const TIMEOUT_MS = 20 * 60_000;

interface MeshyTask {
  status: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED";
  model_urls?: { glb?: string };
  consumed_credits?: number;
  task_error?: { message?: string };
}

export class MeshyMeshGen implements MeshGenProvider {
  id = "meshy";
  constructor(
    private config: Extract<MeshGenConfig, { provider: "meshy" }>,
    private fetchImpl: typeof fetch = fetch,
    private pollMs = POLL_MS,
  ) {}

  async generate(req: MeshGenRequest, signal?: AbortSignal) {
    if (req.images.length === 0) throw new Error("meshy: image-to-3D needs at least one reference image");
    const images = req.images.slice(0, 4).map((i) => `data:image/png;base64,${i.pngB64}`);
    const kind = images.length === 1 ? "image-to-3d" : "multi-image-to-3d";
    const body = {
      ...(images.length === 1 ? { image_url: images[0] } : { image_urls: images }),
      ai_model: req.preview ? "meshy-6-lite" : (this.config.model ?? "latest"),
      should_texture: false,
      should_remesh: true,
      topology: "triangle",
      target_polycount: req.preview ? 5000 : 30000,
      target_formats: ["glb"],
    };
    const created = (await this.call(`${BASE}/${kind}`, { method: "POST", body: JSON.stringify(body), signal })) as {
      result: string;
    };

    const deadline = Date.now() + TIMEOUT_MS;
    let task: MeshyTask;
    for (;;) {
      task = (await this.call(`${BASE}/${kind}/${created.result}`, { signal })) as MeshyTask;
      if (task.status === "SUCCEEDED") break;
      if (task.status === "FAILED" || task.status === "CANCELED") {
        throw new Error(`meshy task ${created.result} ${task.status}: ${task.task_error?.message || "no reason given"}`);
      }
      if (Date.now() > deadline) throw new Error(`meshy task ${created.result} still ${task.status} after ${TIMEOUT_MS / 60_000} min`);
      await sleep(this.pollMs, signal);
    }
    const url = task.model_urls?.glb;
    if (!url) throw new Error(`meshy task ${created.result} succeeded with no GLB url`);
    // A signed URL: no auth header.
    const res = await this.fetchImpl(url, { signal });
    if (!res.ok) throw new Error(`meshy GLB download ${res.status}`);
    const glb = assertGlb(Buffer.from(await res.arrayBuffer()), "meshy");
    const credits = task.consumed_credits ?? 0;
    return { glb, usage: { usd: credits * (this.config.usdPerCredit ?? 0) } };
  }

  private async call(url: string, init: { method?: string; body?: string; signal?: AbortSignal }): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
    });
    if (!res.ok) throw new Error(`meshy ${init.method ?? "GET"} ${url.replace(BASE, "")} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}
