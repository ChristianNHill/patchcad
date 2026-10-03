import { describe, expect, it } from "vitest";
import { LatestWinsQueue } from "./t0-queue.js";

/** A run function whose jobs finish only when the test says so. */
function harness() {
  const ran: string[] = [];
  const gates: (() => void)[] = [];
  const queue = new LatestWinsQueue<number>(
    (key, job) =>
      new Promise<void>((resolve) => {
        ran.push(`${key}:${job}`);
        gates.push(resolve);
      }),
  );
  const finishNext = async () => {
    gates.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { queue, ran, finishNext };
}

describe("LatestWinsQueue", () => {
  it("lets the job in flight finish, drops the intermediates and runs the latest", async () => {
    const { queue, ran, finishNext } = harness();
    queue.push("bracket", 1);
    queue.push("bracket", 2);
    queue.push("bracket", 3);
    expect(ran).toEqual(["bracket:1"]);
    await finishNext();
    expect(ran).toEqual(["bracket:1", "bracket:3"]);
    await finishNext();
    expect(ran).toEqual(["bracket:1", "bracket:3"]);
  });

  it("runs different keys independently", () => {
    const { queue, ran } = harness();
    queue.push("plate", 1);
    queue.push("screw", 1);
    expect(ran).toEqual(["plate:1", "screw:1"]);
  });

  it("starts fresh once a key has drained", async () => {
    const { queue, ran, finishNext } = harness();
    queue.push("plate", 1);
    await finishNext();
    queue.push("plate", 2);
    expect(ran).toEqual(["plate:1", "plate:2"]);
  });

  it("keeps draining after a job throws", async () => {
    const errors: unknown[] = [];
    const ran: number[] = [];
    let release!: () => void;
    const queue = new LatestWinsQueue<number>(
      async (_key, job) => {
        ran.push(job);
        if (job === 1) {
          await new Promise<void>((r) => (release = r));
          throw new Error("kernel down");
        }
      },
      (_key, err) => errors.push(err),
    );
    queue.push("plate", 1);
    queue.push("plate", 2);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toEqual([1, 2]);
    expect(errors).toHaveLength(1);
  });

  it("reports a key busy while its job runs or waits, and idle after", async () => {
    const { queue, finishNext } = harness();
    const isA = (k: string) => k.startsWith("a/");
    queue.push("a/plate", 1);
    queue.push("a/plate", 2);
    expect(queue.busy(isA)).toBe(true);
    expect(queue.busy((k) => k.startsWith("b/"))).toBe(false);
    await finishNext();
    expect(queue.busy(isA)).toBe(true);
    await finishNext();
    expect(queue.busy(isA)).toBe(false);
  });
});
