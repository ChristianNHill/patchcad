import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LlmProvider, LlmRequest, LlmRole } from "@patchcad/engine";
import { CompositeProvider, paidRoutes, readMaxUsd } from "./providers.js";

/** Answers with its own id, so a test can see where a call was routed. */
const named = (id: string): LlmProvider => ({
  id,
  complete: async <T>() => ({ data: id as T, usage: { inputTokens: 0, outputTokens: 0, usd: 0 } }),
});

const req = (role: LlmRole, images = false): LlmRequest<string> => ({
  role,
  system: "",
  label: "t",
  schema: z.string(),
  messages: [{ role: "user", content: "x", ...(images ? { images: [{ mediaType: "image/png", dataB64: "AA" }] } : {}) }],
});

describe("CompositeProvider", () => {
  const sub = named("subscription");
  const routes = { architect: sub, generator: sub, repair: sub, classifier: named("local") };

  it("routes text calls by role", async () => {
    const p = new CompositeProvider(routes, named("claude"));
    expect((await p.complete(req("architect"))).data).toBe("subscription");
    expect((await p.complete(req("classifier"))).data).toBe("local");
  });

  it("sends any call carrying an image to the vision route, whatever its role", async () => {
    const p = new CompositeProvider(routes, named("claude"));
    expect((await p.complete(req("repair", true))).data).toBe("claude");
    expect((await p.complete(req("classifier", true))).data).toBe("claude");
  });

  it("follows the role for images when no vision route is set", async () => {
    const p = new CompositeProvider(routes);
    expect((await p.complete(req("repair", true))).data).toBe("subscription");
  });

  it("names the vision route in its id when it is an extra provider", () => {
    expect(new CompositeProvider(routes, named("claude")).id).toBe("composite(subscription+local+vision:claude)");
  });
});

describe("paidRoutes", () => {
  it("lists only the routes billed in real money", () => {
    const sub = named("subscription");
    const p = new CompositeProvider({ architect: sub, generator: sub, repair: sub, classifier: sub }, named("claude"));
    expect(paidRoutes(p)).toEqual(["vision"]);
    expect(paidRoutes(named("claude"))).toEqual(["architect", "generator", "repair", "classifier"]);
    expect(paidRoutes(named("subscription"))).toEqual([]);
    expect(paidRoutes(named("local"))).toEqual([]);
  });
});

describe("readMaxUsd", () => {
  const config = async (body: string) => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), "patchcad-cfg-")), "config.json");
    await writeFile(file, body);
    return file;
  };

  it("reads a cap, and no cap when none is set", async () => {
    expect(await readMaxUsd(await config(JSON.stringify({ maxUsd: 2.5 })))).toBe(2.5);
    expect(await readMaxUsd(await config(JSON.stringify({ subscription: {} })))).toBeUndefined();
    expect(await readMaxUsd("/nonexistent/config.json")).toBeUndefined();
  });

  it("keeps the cap when an unrelated entry is invalid", async () => {
    expect(await readMaxUsd(await config(JSON.stringify({ maxUsd: 1, routing: { architect: "nope" } })))).toBe(1);
  });

  it("throws rather than run uncapped when the cap is unreadable", async () => {
    await expect(readMaxUsd(await config(JSON.stringify({ maxUsd: "5" })))).rejects.toThrow(/positive number/);
    await expect(readMaxUsd(await config(JSON.stringify({ maxUsd: -1 })))).rejects.toThrow(/positive number/);
    await expect(readMaxUsd(await config("{ maxUsd: 5 "))).rejects.toThrow(/not valid JSON/);
  });
});
