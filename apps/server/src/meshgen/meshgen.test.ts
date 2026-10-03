import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphDoc } from "@patchcad/shared";
import { ConfigSchema, readMeshGen } from "../providers.js";
import { HostedMeshGen } from "./hosted.js";
import { MeshyMeshGen } from "./meshy.js";
import { createMeshGen, meshSourceFor, type MeshGenProvider } from "./index.js";

/** Request/response mapping with a mocked fetch: no live calls, no key. */

const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A fetch that answers each call from `replies` in order and records it. */
function scripted(replies: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected fetch ${String(url)}`);
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const meshy = (f: typeof fetch, extra: { usdPerCredit?: number } = {}) =>
  new MeshyMeshGen({ provider: "meshy", apiKey: "msy-test", ...extra }, f, 0);

describe("meshy", () => {
  it("creates an untextured image-to-3d task, polls it, downloads the GLB", async () => {
    const { fetch, calls } = scripted([
      json({ result: "task-1" }),
      json({ status: "IN_PROGRESS", progress: 40 }),
      json({ status: "SUCCEEDED", model_urls: { glb: "https://assets.meshy.ai/t.glb?sig=x" }, consumed_credits: 20 }),
      new Response(GLB),
    ]);
    const out = await meshy(fetch, { usdPerCredit: 0.02 }).generate({ images: [{ pngB64: "AAAA", view: "front" }] });

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.meshy.ai/openapi/v1/image-to-3d",
      "https://api.meshy.ai/openapi/v1/image-to-3d/task-1",
      "https://api.meshy.ai/openapi/v1/image-to-3d/task-1",
      "https://assets.meshy.ai/t.glb?sig=x",
    ]);
    expect(calls[0]!.init?.method).toBe("POST");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer msy-test");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      image_url: "data:image/png;base64,AAAA",
      ai_model: "latest",
      should_texture: false,
      should_remesh: true,
      topology: "triangle",
      target_polycount: 30000,
      target_formats: ["glb"],
    });
    // The signed download carries no key.
    expect(calls[3]!.init?.headers).toBeUndefined();
    expect(out.glb.equals(GLB)).toBe(true);
    expect(out.usage?.usd).toBeCloseTo(0.4);
  });

  it("sends several views to multi-image-to-3d, and a preview as meshy-6-lite", async () => {
    const { fetch, calls } = scripted([
      json({ result: "task-2" }),
      json({ status: "SUCCEEDED", model_urls: { glb: "https://x/t.glb" }, consumed_credits: 5 }),
      new Response(GLB),
    ]);
    const out = await meshy(fetch).generate({ images: [{ pngB64: "AA" }, { pngB64: "BB" }], preview: true });
    expect(calls[0]!.url).toBe("https://api.meshy.ai/openapi/v1/multi-image-to-3d");
    expect(calls[1]!.url).toBe("https://api.meshy.ai/openapi/v1/multi-image-to-3d/task-2");
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.image_urls).toEqual(["data:image/png;base64,AA", "data:image/png;base64,BB"]);
    expect(body.ai_model).toBe("meshy-6-lite");
    expect(body.target_polycount).toBe(5000);
    // No dollar rate configured: credits are not guessed into dollars.
    expect(out.usage?.usd).toBe(0);
  });

  it("reports a failed task with Meshy's reason", async () => {
    const { fetch } = scripted([json({ result: "t" }), json({ status: "FAILED", task_error: { message: "no subject" } })]);
    await expect(meshy(fetch).generate({ images: [{ pngB64: "AA" }] })).rejects.toThrow("FAILED: no subject");
  });

  it("reports an HTTP error and refuses a download that is not a GLB", async () => {
    await expect(meshy(scripted([json({ message: "Invalid API key" }, 401)]).fetch).generate({ images: [{ pngB64: "AA" }] })).rejects.toThrow("401");
    const { fetch } = scripted([
      json({ result: "t" }),
      json({ status: "SUCCEEDED", model_urls: { glb: "https://x" } }),
      new Response("<html>expired</html>"),
    ]);
    await expect(meshy(fetch).generate({ images: [{ pngB64: "AA" }] })).rejects.toThrow("did not return a GLB");
  });

  it("needs an image", async () => {
    await expect(meshy(scripted([]).fetch).generate({ images: [] })).rejects.toThrow("at least one");
  });
});

describe("hosted", () => {
  it("posts the documented JSON with the configured headers and returns the GLB", async () => {
    const { fetch, calls } = scripted([new Response(GLB)]);
    const gen = new HostedMeshGen({ provider: "hosted", url: "https://gpu.example/gen", headers: { "x-token": "t" } }, fetch);
    const out = await gen.generate({ images: [{ pngB64: "AA", view: "side" }], prompt: "Body: an egg", targetSizeMm: 80, symmetric: true });
    expect(calls[0]!.url).toBe("https://gpu.example/gen");
    expect(calls[0]!.init?.headers).toEqual({ "content-type": "application/json", "x-token": "t" });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      images: [{ png_b64: "AA", view: "side" }],
      prompt: "Body: an egg",
      target_size_mm: 80,
      symmetric: true,
      preview: false,
    });
    expect(out.glb.equals(GLB)).toBe(true);
    expect("usage" in out).toBe(false);
  });

  it("fails on a non-200", async () => {
    const gen = new HostedMeshGen({ provider: "hosted", url: "https://gpu.example/gen", headers: {} }, scripted([new Response("OOM", { status: 500 })]).fetch);
    await expect(gen.generate({ images: [] })).rejects.toThrow("500: OOM");
  });
});

describe("config", () => {
  it("parses each provider and treats absent as none", () => {
    expect(ConfigSchema.parse({}).meshgen).toBeUndefined();
    expect(ConfigSchema.parse({ meshgen: { provider: "meshy", apiKey: "k" } }).meshgen).toEqual({ provider: "meshy", apiKey: "k" });
    expect(ConfigSchema.parse({ meshgen: { provider: "hosted", url: "http://gpu:8000/gen" } }).meshgen).toEqual({
      provider: "hosted",
      url: "http://gpu:8000/gen",
      headers: {},
    });
    expect(createMeshGen({ provider: "hosted", url: "http://gpu:8000/gen", headers: {} }).id).toBe("hosted");
  });

  it("does not let a broken meshgen entry break the rest of the config", async () => {
    const cfg = { routing: { architect: "subscription", generator: "subscription" }, meshgen: { provider: "meshy" } };
    expect(ConfigSchema.parse(cfg).routing?.architect).toBe("subscription");
    const dir = await mkdtemp(path.join(os.tmpdir(), "patchcad-cfg-"));
    const file = path.join(dir, "config.json");
    await writeFile(file, JSON.stringify(cfg));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await readMeshGen(file)).toBeNull();
    expect(warn.mock.calls[0]![0]).toContain("apiKey");
    warn.mockRestore();
    await writeFile(file, JSON.stringify({ meshgen: { provider: "meshy", apiKey: "k", usdPerCredit: 0.02 } }));
    expect(await readMeshGen(file)).toEqual({ provider: "meshy", apiKey: "k", usdPerCredit: 0.02 });
    expect(await readMeshGen(path.join(dir, "missing.json"))).toBeNull();
  });
});

describe("meshSourceFor", () => {
  it("hands the provider the project's prepped refs and the node's visualRef", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "patchcad-proj-"));
    await mkdir(path.join(projectDir, "refs"));
    await writeFile(path.join(projectDir, "refs", "0123456789abcdef.png"), Buffer.from("png-bytes"));
    const seen: unknown[] = [];
    const provider: MeshGenProvider = {
      id: "fake",
      generate: async (req) => (seen.push(req), { glb: GLB, usage: { usd: 0.3 } }),
    };
    const graph = GraphDoc.parse({
      schemaVersion: 1,
      id: "g",
      backend: "cad",
      brief: { goal: "", refs: [{ hash: "0123456789abcdef", view: "front", mask: true }], sizeMm: 90 },
      nodes: {
        body: {
          id: "body", kind: "part", title: "Body", spec: "", status: "planned",
          contract: { name: "body", summary: "", params: [], provides: [], requires: [], payload: { visualRef: "an upright egg" }, hash: "" },
        },
      },
      edges: [],
      assembly: { entryNodeId: "body" },
    });
    const out = await meshSourceFor(provider).generate({ node: graph.nodes.body!, graph, projectDir });
    expect(seen[0]).toEqual({
      images: [{ pngB64: Buffer.from("png-bytes").toString("base64"), view: "front" }],
      prompt: "Body: an upright egg",
      targetSizeMm: 90,
      symmetric: undefined,
    });
    expect(out).toEqual({ glb: GLB, usd: 0.3 });
  });
});
