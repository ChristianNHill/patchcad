import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAiCompatProvider } from "./index.js";

/** The raw fetch path had no timeout, so a stalled connection hung a cook
 *  forever: no error, no abort, a node stuck in `generating` until the process
 *  died.
 *
 *  A refusing address is NOT this test — 192.0.2.1 failed in 10ms with "fetch
 *  failed", which is the opposite case. A stall means the connection is
 *  ACCEPTED and never answered, so this runs a server that does exactly that. */
describe("a stalled connection is abandoned, not waited on", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    server = createServer(() => {
      // accept, read nothing, answer never
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const a = server.address();
    baseUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/v1`;
  });
  afterAll(() => new Promise<void>((res) => server.close(() => res())));

  const req = {
    role: "generator" as const,
    label: "t",
    system: "s",
    messages: [{ role: "user" as const, content: "x" }],
    schema: z.object({ a: z.string() }),
  };
  const provider = (timeoutMs: number) =>
    new OpenAiCompatProvider("test", { baseUrl, models: { generator: "m" }, timeoutMs });

  it("gives up after timeoutMs instead of hanging", async () => {
    await expect(provider(300).complete(req)).rejects.toThrow(/within 300ms/);
  }, 10_000);

  it("says abandoned rather than refused, so nobody hunts a cancel bug", async () => {
    await expect(provider(300).complete(req)).rejects.toThrow(/abandoned, not refused/);
  }, 10_000);

  it("still honours a caller's cancel, and does not blame the timeout", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    await expect(
      provider(60_000).complete({ ...req, signal: ac.signal }),
    ).rejects.not.toThrow(/within 60000ms/);
  }, 10_000);

  it("without the bound it would still be waiting", async () => {
    // Proves the server really does stall: a generous ceiling is not reached.
    const started = Date.now();
    await expect(provider(400).complete(req)).rejects.toThrow(/within 400ms/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  }, 10_000);
});
