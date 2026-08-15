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

export interface KernelMeasurements {
  volume_mm3: number;
  area_mm2: number;
  solids: number;
  bbox: { min: number[]; max: number[]; size: number[] };
}

export type KernelResult =
  | {
      ok: true;
      hash: string;
      cached: boolean;
      measurements: KernelMeasurements & { ports?: unknown[]; envelope?: unknown };
      glb: string;
      elapsed_ms?: number;
    }
  | { ok: false; hash?: string; stage: string; error: string; hint: string };

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
