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

  it("builds a gear of any tooth count as one valid solid", async () => {
    // hand-winch: bd_warehouse raised "Invalid configuration" from z = 42 at 20°.
    const code = resolveHardware({ kind: "gear", params: {}, contract: { params: [] } } as unknown as NodeRecord)!;
    const failures: string[] = [];
    for (const teeth of [15, 45, 60, 120]) {
      const res = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, params: { ...GEAR, module: 1.5, teeth, bore: 8 }, solids: 1 }),
      });
      const body = (await res.json()) as { ok: boolean; stage?: string; error?: string; measurements?: { bbox: { size: number[] } } };
      const od = body.measurements?.bbox.size[0] ?? 0;
      if (!body.ok || Math.abs(od - 1.5 * (teeth + 2)) > 0.6) failures.push(`z${teeth}: ${body.stage ?? ""} ${body.error ?? `Ø${od}`}`);
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it("passes G3 for a gear and a pulley that declare their own HUB_BORE", async () => {
    // spur-gear-pair: the gear's port as the architect declared it, on the
    // bore's -z face. Registry parts get no repair round, so this is terminal.
    const hub = (fit?: string, origin: (number | string)[] = [0, 0, -3], zAxis = [0, 0, -1]) => ({
      key: "bore", type: "HUB_BORE", pose: { origin, zAxis, xAxis: [1, 0, 0] }, params: { diameter: 5, ...(fit ? { fit } : {}) },
    });
    const jobs = [
      { id: "gear slip", kind: "gear", params: { ...GEAR, thickness: 6 }, port: hub() },
      { id: "gear press", kind: "gear", params: { ...GEAR, thickness: 6 }, port: hub("press") },
      { id: "pulley slip", kind: "pulley", params: { sku: "GT2P-20T-5" }, port: hub(undefined, [0, 0, 0]) },
    ];
    const failures: string[] = [];
    for (const job of jobs) {
      const { key: name, ...port } = job.port;
      const node = {
        kind: job.kind, params: job.kind === "gear" ? {} : job.params,
        contract: { params: [], payload: { ports: [{ name, ...port }] } },
      } as unknown as NodeRecord;
      const res = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: resolveHardware(node)!, params: job.kind === "gear" ? job.params : {}, ports: [job.port], solids: 1 }),
      });
      const body = (await res.json()) as { ok: boolean; stage?: string; error?: string };
      if (!body.ok) failures.push(`${job.id}: ${body.stage} ${body.error}`);
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it("passes G3 on a joint-minted gear hub: slip and press, round and D, either clocking", async () => {
    // hand-winch: pinion_left_hub posed zAxis -z, xAxis -x, D-flat 3 on +x of
    // the gear measured Ø8.28 against a 7.90..8.00 press band.
    const failures: string[] = [];
    const jobs = [15, 45, 60].flatMap((teeth) =>
      (["slip", "press"] as const).flatMap((fit) =>
        [0, 3].flatMap((flat) =>
          [
            { zAxis: [0, 0, -1], xAxis: [-1, 0, 0], z: -5 },
            { zAxis: [0, 0, 1], xAxis: [1, 0, 0], z: 5 },
            { zAxis: [0, 0, 1], xAxis: [0, 1, 0], z: 5 },
          ].map((f) => ({ teeth, fit, flat, ...f })),
        ),
      ),
    );
    for (let i = 0; i < jobs.length; i += 6) {
      await Promise.all(
        jobs.slice(i, i + 6).map(async (j) => {
          const port = {
            type: "HUB_BORE",
            pose: { origin: [0, 0, j.z], zAxis: j.zAxis, xAxis: j.xAxis },
            params: { diameter: "param(g.j_shaft_d)", fit: j.fit, depth: 10, ...(j.flat ? { flat: "param(g.j_flat)" } : {}) },
          };
          const node = { id: "g", kind: "gear", params: {}, contract: { params: [], payload: { ports: [{ name: "hub", ...port }] } } } as unknown as NodeRecord;
          const params = { module: 1.5, teeth: j.teeth, pressure_angle: 20, thickness: 10, bore: 8, j_shaft_d: 8, j_flat: 3 };
          const res = await fetch(`${base}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              code: resolveHardware(node)!,
              params,
              ports: [{ key: "hub", ...port, params: { ...port.params, diameter: 8, ...(j.flat ? { flat: 3 } : {}) } }],
              solids: 1,
            }),
          });
          const body = (await res.json()) as { ok: boolean; stage?: string; error?: string };
          if (!body.ok) failures.push(`z${j.teeth} ${j.fit} flat${j.flat} x${j.xAxis.join(",")}: ${body.stage} ${body.error}`);
        }),
      );
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
