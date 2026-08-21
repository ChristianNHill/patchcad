import { describe, expect, it } from "vitest";
import { KernelClient } from "./kernel.js";

/** Reach the private start/ready pair without exporting them. */
const spyOnStart = (k: KernelClient) => {
  const calls = { n: 0 };
  const inner = k as unknown as { start: () => Promise<void> };
  inner.start = async () => {
    calls.n += 1;
    await new Promise((r) => setTimeout(r, 20)); // a real spawn is not instant
  };
  return calls;
};
const ready = (k: KernelClient) =>
  (k as unknown as { ready: () => Promise<void> }).ready.call(k);

describe("KernelClient start memoization", () => {
  it("collapses concurrent callers onto one spawn", async () => {
    const k = new KernelClient();
    const calls = spyOnStart(k);
    // Four cook workers hitting a cold kernel. Each used to see
    // `kernelStarted === false` and run `uv run`, so three lost the port bind.
    await Promise.all([ready(k), ready(k), ready(k), ready(k)]);
    expect(calls.n).toBe(1);
  });

  it("does not spawn again once started", async () => {
    const k = new KernelClient();
    const calls = spyOnStart(k);
    await ready(k);
    await ready(k);
    await ready(k);
    expect(calls.n).toBe(1);
  });

  it("lets a failed start be retried", async () => {
    const k = new KernelClient();
    let attempts = 0;
    (k as unknown as { start: () => Promise<void> }).start = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("uv not found");
    };
    await expect(ready(k)).rejects.toThrow("uv not found");
    // A memoized rejection would poison the client for the process lifetime.
    await expect(ready(k)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
