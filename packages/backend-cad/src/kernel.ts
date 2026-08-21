import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Client for the Python geometry kernel (kernel/ next to this package,
 * packaged with uv). The Node server owns the kernel lifecycle: spawn on
 * demand, poll /health until the warm workers are up, kill on shutdown.
 * Everything geometric happens kernel-side; this client only moves JSON.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const KERNEL_DIR = path.resolve(here, "..", "kernel");

/** One declared port, as actually probed in the solid. Which fields are
 *  present depends on the port type (gates.py g3_ports). Note the list only
 *  ever holds PASSES and may be partial: a failing probe raises and takes the
 *  whole job with it, so probing stops at the first failure. */
/** One pair of parts sharing space, and how much of it. */
export interface Clash {
  a: string;
  b: string;
  volume_mm3: number;
  /** Centroid of the shared volume, in world coordinates. */
  at: [number, number, number];
}

export interface ClashResult {
  ok: boolean;
  hash?: string;
  cached?: boolean;
  stage?: string;
  error?: string;
  hint?: string;
  clash?: { parts: number; pairs_tested: number; clashes: Clash[]; errors?: string[] };
}

export interface PortMeasurement {
  key: string;
  type: string;
  /** Hole-like ports (BORE, CLEARANCE_HOLE, SCREW_SEAT): measured bore. */
  measured_diameter?: number;
  /** FLAT_FACE: probed square, or 0 when the face is a sliver (center probe). */
  probed_size?: number;
  /** FLAT_FACE declared with ring_diameter: the annulus probed instead. */
  ring_diameter?: number;
  /** SCREW_BOSS: wall samples that hit material. */
  ring_hits?: number;
  /** SCREW_BOSS with a declared pilot. */
  measured_pilot?: number;
  /** Hole-like: does the hole pass through, or bottom out? */
  through?: boolean;
  /** GROOVE / SLOT: the gap actually cut, measured across the channel. This is
   *  the number a mating tongue is cut to, so it is the one worth surfacing. */
  measured_width?: number;
  /** GROOVE / SLOT declared with a depth: the floor found at that depth.
   *  Absent for a through-cut, which declares no depth. */
  measured_depth?: number;
  /** Port type with no probe implemented yet. */
  skipped?: string;
}

/** Advisory DfAM signal (CADClamp-derived). Never a gate; every key optional
 *  because each sub-block is dropped silently if its measurement throws. */
export interface Printability {
  min_wall?: { thin_wall_p2_mm: number; index: number; recommended_mm: number };
  overhang?: { warn_area_fraction: number; fail_area_fraction: number; index: number };
  composite?: number;
}

export interface KernelMeasurements {
  volume_mm3: number;
  area_mm2: number;
  solids: number;
  bbox: { min: number[]; max: number[]; size: number[] };
  /** Present only when the caller declared ports (the verify pass). */
  ports?: PortMeasurement[];
  /** Present only when the caller declared an envelope. Violations are always
   *  0 here — a non-zero count raises instead of returning. */
  envelope?: { vertices_checked: number; violations: number };
  printability?: Printability;
}

export type KernelResult =
  | {
      ok: true;
      hash: string;
      cached: boolean;
      measurements: KernelMeasurements;
      glb: string;
      elapsed_ms?: number;
    }
  | { ok: false; hash?: string; stage: string; error: string; hint: string };

export interface RenderResult {
  ok: boolean;
  hash: string;
  cached?: boolean;
  /** Kernel-relative path; use glbUrl-style joining for a fetchable URL. */
  sheet?: string;
  render?: { views: string[]; triangles: number; size: number[] };
  stage?: string;
  error?: string;
}

/** Formats the kernel will write. STEP is per-part: a posed assembly has no
 *  B-rep answer worth opening, and mesh is what a slicer wants anyway. */
export const EXPORT_FORMATS = ["stl", "3mf", "obj", "step"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportResult {
  ok: boolean;
  hash: string;
  cached?: boolean;
  file?: string;
  export?: { format: string; parts: number; units: string; triangles?: number; watertight?: boolean };
  stage?: string;
  error?: string;
  hint?: string;
}

export class KernelClient {
  private child: ChildProcess | null = null;
  readonly baseUrl: string;

  constructor(private port = Number(process.env.PATCHCAD_KERNEL_PORT ?? 8621)) {
    this.baseUrl = `http://127.0.0.1:${this.port}`;
  }

  async health(): Promise<{ ok: boolean; workers?: { size: number; alive: number; respawns: number } }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? ((await res.json()) as never) : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  /** Spawn `uv run patchcad-kernel` unless a kernel already answers, then
   * wait for the warm workers (first boot can pay the OCP import). */
  /** In-flight or completed start, so concurrent callers wait on one spawn. */
  private starting: Promise<void> | null = null;

  /**
   * Ensure the service is up, then do the work. Every request method goes
   * through this, so no caller can reach a kernel that was never started.
   *
   * It used to be the caller's job, via a private ensureKernel on the backend,
   * and five call sites did not do it: the sheet route, cad-scene, export and
   * both import paths. On a fresh server those threw, and the viewport's empty
   * `.catch(() => {})` turned the throw into a blank grid with no error. Putting
   * the guard on the resource instead of in every caller makes that class of
   * mistake unavailable.
   */
  private async ready(): Promise<void> {
    if (!this.starting) {
      // Memoized, and NOT cleared on success: four cook workers hitting a cold
      // kernel each saw `kernelStarted === false` and each ran `uv run`, so
      // three lost the port bind and then polled /health until the winner came
      // up. Self-healing, and the exact "address already in use" footgun
      // CLAUDE.md records.
      this.starting = this.start().catch((err) => {
        this.starting = null; // a failed start must be retryable
        throw err;
      });
    }
    return this.starting;
  }

  async start(timeoutMs = 180_000): Promise<void> {
    if ((await this.health()).ok) return; // reuse an externally started kernel

    this.child = spawn("uv", ["run", "patchcad-kernel"], {
      cwd: KERNEL_DIR,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, PATCHCAD_KERNEL_PORT: String(this.port) },
    });
    this.child.on("exit", (code) => {
      if (code !== 0 && code !== null) console.warn(`[patchcad] cad kernel exited with code ${code}`);
      this.child = null;
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.health()).ok) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`cad kernel did not become healthy within ${timeoutMs / 1000}s (is uv installed?)`);
  }

  async execute(
    code: string,
    params: Record<string, unknown>,
    contract?: { ports?: unknown[]; envelope?: unknown[]; importDir?: string },
  ): Promise<KernelResult> {
    await this.ready();
    const res = await fetch(`${this.baseUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        params,
        ports: contract?.ports ?? [],
        envelope: contract?.envelope ?? [],
        import_dir: contract?.importDir ?? "",
      }),
    });
    return (await res.json()) as KernelResult;
  }

  /**
   * Multi-view contact sheet for one part. Separate from execute on purpose:
   * rendering costs 100-300ms and execute is the T0 slider path, so a picture
   * pays its own way and caches under its own hash.
   */
  async render(
    code: string,
    params: Record<string, unknown>,
    opts: { importDir?: string; views?: number } = {},
  ): Promise<RenderResult> {
    await this.ready();
    const res = await fetch(`${this.baseUrl}/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        params,
        import_dir: opts.importDir ?? "",
        views: opts.views ?? 6,
      }),
    });
    return (await res.json()) as RenderResult;
  }

  /** The posed assembly as one image — for judging parts in company, which
   *  no per-part gate can do. */
  async renderAssembly(
    parts: { code: string; params: Record<string, unknown>; matrix: number[] }[],
    opts: { importDir?: string; views?: number } = {},
  ): Promise<RenderResult> {
    await this.ready();
    const res = await fetch(`${this.baseUrl}/render-assembly`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts, import_dir: opts.importDir ?? "", views: opts.views ?? 4 }),
    });
    return (await res.json()) as RenderResult;
  }

  /** G5: do any two posed parts occupy the same space? Assembly-level, so it
   *  reports rather than failing a node — no single part is at fault, and
   *  failing one arbitrarily sends a generator to fix correct code. */
  async clash(
    parts: { key: string; code: string; params: Record<string, unknown>; matrix: number[] }[],
    opts: { importDir?: string } = {},
  ): Promise<ClashResult> {
    await this.ready();
    const res = await fetch(`${this.baseUrl}/clash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts, import_dir: opts.importDir ?? "" }),
    });
    return (await res.json()) as ClashResult;
  }

  /** Geometry out: a mesh a slicer can open, or STEP for another CAD tool. */
  async export(
    parts: { code: string; params: Record<string, unknown>; matrix: number[] }[],
    format: string,
    opts: { importDir?: string } = {},
  ): Promise<ExportResult> {
    await this.ready();
    const res = await fetch(`${this.baseUrl}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts, format, import_dir: opts.importDir ?? "" }),
    });
    return (await res.json()) as ExportResult;
  }

  /** Segment an uploaded STL/3MF/STEP into pieces + cut-plane interfaces. */
  async importFile(
    filename: string,
    dataB64: string,
    opts: { pieces: number; joints: "none" | "holes" | "pegs"; thread: string },
  ): Promise<
    | {
        ok: true;
        dir: string;
        pieces: { index: number; file: string; volume_mm3: number; watertight: boolean; bbox: { min: number[]; max: number[] }; faces: number }[];
        interfaces: {
          piece_a: number;
          piece_b: number;
          origin: number[];
          normal: number[];
          holes: { center: number[]; diameter: number }[];
          pegs?: { center: number[]; peg_diameter: number; socket_diameter: number; length: number }[];
          face_size?: number;
        }[];
      }
    | { ok: false; stage: string; error: string; hint: string }
  > {
    await this.ready();
    const res = await fetch(`${this.baseUrl}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename,
        data_b64: dataB64,
        pieces: opts.pieces,
        joints: opts.joints,
        thread: opts.thread,
      }),
    });
    return (await res.json()) as never;
  }

  /** Absolute URL for a cooked node's mesh — what the viewport loads. */
  glbUrl(resultGlbPath: string): string {
    return `${this.baseUrl}${resultGlbPath}`;
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
