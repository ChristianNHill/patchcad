import { describe, expect, it } from "vitest";
import type { NodeRecord } from "@patchcad/shared";
import { CATALOG, skuFor, standardLengths } from "./catalog.js";
import { REGISTRY_SOLIDS, resolveHardware } from "./registry.js";

/**
 * Every size of every catalog family, built by a real kernel and held to G2
 * (valid, and the declared solid count). Text tests cannot tell a module that
 * builds from one that raises inside OCCT, and registry hardware gets no repair
 * round, so this is the only check that it builds at all.
 *
 * Live only: PATCHCAD_KERNEL_LIVE=1, against PATCHCAD_KERNEL_PORT (8621).
 */
const live = process.env.PATCHCAD_KERNEL_LIVE === "1";
const base = `http://127.0.0.1:${process.env.PATCHCAD_KERNEL_PORT ?? 8621}`;

const GEAR = { module: 1, teeth: 20, pressure_angle: 20, thickness: 5, bore: 5 };

describe.skipIf(!live)("catalog parts build in the kernel", () => {
  it("passes G2 for every family and size", async () => {
    const jobs = Object.entries(CATALOG.families).flatMap(([family, f]) =>
      Object.keys(f.dims).map((key) => {
        const sku = skuFor(family, key, standardLengths(family, key)[0])!;
        const node = { kind: f.kind, params: { sku: sku.id }, contract: { params: [] } } as unknown as NodeRecord;
        return { id: sku.id, kind: f.kind, code: resolveHardware(node)! };
      }),
    );
    const failures: string[] = [];
    // A few at a time: the pool is small and some parts carry many booleans.
    for (let i = 0; i < jobs.length; i += 4) {
      await Promise.all(
        jobs.slice(i, i + 4).map(async (job) => {
          const res = await fetch(`${base}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              code: job.code,
              params: job.kind === "gear" ? GEAR : {},
              solids: REGISTRY_SOLIDS[job.kind] === null ? undefined : (REGISTRY_SOLIDS[job.kind] ?? 1),
            }),
          });
          const body = (await res.json()) as { ok: boolean; stage?: string; error?: string };
          if (!body.ok) failures.push(`${job.id}: ${body.stage} ${body.error}`);
        }),
      );
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
