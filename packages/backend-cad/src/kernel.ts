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

/** How far apart two mated parts are near the point their ports meet. */
export interface ContactGap {
  edge: string;
  a: string;
  b: string;
  gap_mm: number;
  at: [number, number, number];
}

export interface ClashResult {
  ok: boolean;
  hash?: string;
  cached?: boolean;
  stage?: string;
  error?: string;
  hint?: string;
  clash?: {
    parts: number;
    pairs_tested: number;
    clashes: Clash[];
    /** Overlaps within an allowance: material the pair is designed to share. */
    exempt?: (Clash & { allowed_mm3: number })[];
    contacts?: ContactGap[];
    errors?: string[];
    /** A moving part at the worst pose of its joint's travel, overlapping a
     *  part that holds still. `travel` is degrees or mm from the solved pose. */
    swept?: (Clash & { joint: string; travel: number })[];
    swept_exempt?: (Clash & { joint: string; travel: number; allowed_mm3: number })[];
  };
}

export interface PortMeasurement {
  key: string;
  type: string;
  /** Hole-like ports (BORE, CLEARANCE_HOLE, SCREW_SEAT): the narrowest
   *  fitted circle over several depths. */
  measured_diameter?: number;
  /** Hole-like: fitted centre's distance from the declared origin, mm. */
  center_offset?: number;
  /** Hole-like: axis angle from the declared zAxis, when the hole is deep
   *  enough to measure one. */
  tilt_deg?: number;
  /** FLAT_FACE: probed square, or 0 when the face is a sliver (center probe). */
  probed_size?: number;
  /** FLAT_FACE declared with ring_diameter: the annulus probed instead. */
  ring_diameter?: number;
  /** SCREW_BOSS: wall samples that hit material. */
  ring_hits?: number;
  /** SCREW_BOSS with a declared pilot. */
  measured_pilot?: number;
  /** CLEARANCE_HOLE / HOLE_PATTERN member: not round (a Box teardrop), but
   *  short of the screw head's bearing face, so advisory. */
  finding?: string;
  /** Hole-like: does the hole pass through, or bottom out? */
  through?: boolean;
  /** GROOVE / SLOT: the gap actually cut, measured across the channel. This is
   *  the number a mating tongue is cut to, so it is the one worth surfacing. */
  measured_width?: number;
  /** Depth to the first material straight down the port axis. For a channel
   *  that is its floor. For a hole it is the DEEPEST floor in a coaxial stack,
   *  so a counterbore over a pilot reports the pilot: a counterbore's own floor
   *  is an annulus and never lies on the axis. Honest about what was measured,
   *  but do not read it as the port's own feature depth. */
  measured_depth?: number;
  /** HOLE_PATTERN / BOSS_PATTERN: member count and each member's probe. */
  count?: number;
  members?: PortMeasurement[];
  /** Legacy: kernels before GATES_VERSION 12 passed unprobed types as skipped. */
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
  /** Shells per solid; more than one means an enclosed void. */
  shells?: number[];
  /** Advisory findings that did not fail a gate (enclosed voids). */
  warnings?: string[];
  bbox: { min: number[]; max: number[]; size: number[] };
  /** Present only when the caller declared ports (the verify pass). */
  ports?: PortMeasurement[];
  /** Present only when the caller declared an envelope. Violations are always
   *  0 here — a non-zero count raises instead of returning. */
  envelope?: { vertices_checked: number; violations: number };
  /** G4b: each contract assertion that passed, with what was measured. */
  assertions?: { kind: string; measured: number | null; axis?: string; plane?: string }[];
  /** G4c: the fabricate process's DFM measurements, and any rule that could not run. */
  process?: { kind: string; unchecked?: Record<string, string> } & Record<string, unknown>;
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
  | {
      ok: false;
      hash?: string;
      stage: string;
      error: string;
      hint: string;
      /** Every failure behind this one: the contract gates report all failing
       *  ports and the envelope together. Absent on TIMEOUT / KERNEL_CRASH. */
      failures?: KernelFailure[];
      /** G0–G2 measurements, present when only the contract gates failed. */
      measurements?: KernelMeasurements;
    };

/** G4c wire format: snake_case like the rest of the kernel's request. */
export interface KernelProcess {
  kind: string;
  tool_radius?: number;
  allow_undercuts?: boolean;
}

export interface KernelFailure {
  stage: string;
  error: string;
  hint?: string;
  port?: string;
  expected?: number;
  measured?: number;
  /** Line of the node's code a G1 failure raised on. */
  line?: number;
  /** 1-based member of a HOLE_PATTERN / BOSS_PATTERN port. */
  member?: number;
  /** G4c: which process rule, where its worst instance is, and how many. */
  rule?: string;
  at?: number[];
  count?: number;
}

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

export type MeshFitResult =
  | {
      ok: true;
      dir: string;
      file: string;
      /** The uniform factor applied to the generator's units. */
      scale: number;
      watertight: boolean;
      bbox: { min: number[]; max: number[] };
      faces: number;
      /** Flats that could not be cut, and why. */
      notes: string[];
    }
  | { ok: false; stage: string; error: string; hint?: string };

/** What segmentation does at each cut: "auto" reports joint sites and cuts
 *  nothing (the server's joint rules pick hardware), holes/pegs cut there. */
export type ImportJointMode = "auto" | "none" | "holes" | "pegs";

/** A joint site on a cut (mode "auto"): a disk of Ø face_size material on
 *  both sides, and how deep it runs into each piece, unscaled mm. */
export interface JointCandidate {
  center: number[];
  /** From piece_a toward piece_b. */
  normal: number[];
  span: number;
  wallA: number;
  wallB: number;
  face_size: number;
}

export interface ImportInterface {
  piece_a: number;
  piece_b: number;
  origin: number[];
  normal: number[];
  holes: { center: number[]; diameter: number }[];
  pegs?: { center: number[]; peg_diameter: number; socket_diameter: number; length: number }[];
  face_size?: number;
  candidates?: JointCandidate[];
}

export interface ImportResult {
  ok: true;
  dir: string;
  pieces: { index: number; file: string; volume_mm3: number; watertight: boolean; bbox: { min: number[]; max: number[] }; faces: number }[];
  interfaces: ImportInterface[];
}

export type ImagePrepResult =
  | {
      ok: true;
      /** rembg, or threshold when rembg could not run. */
      method: string;
      png_b64: string;
      mask_b64: string;
      aspect: number;
      bbox: number[];
    }
  | { ok: false; error: string };

export interface SilhouetteView {
  view: string;
  ref: string;
  iou: number;
  /** Worst first: excess = covered but not in the reference, missing = in
   *  the reference, uncovered, nearest this part. */
  parts: { key: string; area_px: number; excess_px: number; missing_px: number }[];
}

export interface SilhouetteResult {
  ok: boolean;
  silhouette?: { views: SilhouetteView[] };
  error?: string;
}

/** Formats the kernel will write. A posed STEP is an XCAF assembly, one named
 *  child per placed copy; 3MF is one object per part. */

export interface ExportResult {
  ok: boolean;
  hash: string;
  cached?: boolean;
  file?: string;
  export?: {
    format: string;
    parts: number;
    units: string;
    triangles?: number;
    watertight?: boolean;
    /** STEP children / 3MF objects, one per placed copy. */
    names?: string[];
    /** Imported mesh parts a STEP export left out (no B-rep). */
    skipped?: string[];
    warning?: string;
  };
  stage?: string;
  error?: string;
  hint?: string;
}

export interface InsertionResult {
  ok: boolean;
  insertions?: {
    checks: { id: string; blocked: { part: string; by: string; depth_mm: number; volume_mm3: number; travel_mm: number }[] }[];
    errors: string[];
  };
  stage?: string;
  error?: string;
}

export interface InstructionsResult {
  ok: boolean;
  hash?: string;
  /** Kernel paths, one SVG per page. */
  pages?: string[];
  pdf?: string;
  html?: string;
  document?: { pages: number; steps: number; items: number };
  stage?: string;
  error?: string;
}

export class KernelClient {
  private child: ChildProcess | null = null;
  readonly baseUrl: string;

  /** Set when the kernel runs elsewhere (a docker sidecar): never spawn one. */
  private readonly external = process.env.PATCHCAD_KERNEL_URL?.replace(/\/$/, "");

  constructor(private port = Number(process.env.PATCHCAD_KERNEL_PORT ?? 8621)) {
    this.baseUrl = this.external ?? `http://127.0.0.1:${this.port}`;
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

    // Set when the child dies before it is healthy, so the wait below fails
    // now instead of polling to the deadline. A missing `uv` is an 'error'
    // event, which unhandled would crash the server.
    let failed: Error | null = null;
    if (!this.external) {
      const child = spawn("uv", ["run", "patchcad-kernel"], {
        cwd: KERNEL_DIR,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, PATCHCAD_KERNEL_PORT: String(this.port) },
        // Its own process group, so stop() can take down `uv` AND the python
        // it runs: killing uv alone left python reparented to PID 1, still
        // holding the port.
        detached: true,
      });
      this.child = child;
      child.once("error", (err) => {
        failed ??= new Error(`could not start the cad kernel: ${err.message} (is uv installed?)`);
        if (this.child === child) this.child = null;
      });
      child.on("exit", (code) => {
        if (code !== 0 && code !== null) console.warn(`[patchcad] cad kernel exited with code ${code}`);
        failed ??= new Error(`cad kernel exited with code ${code} before it became healthy`);
        if (this.child === child) this.child = null;
      });
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.health()).ok) return;
      if (failed) throw failed;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`cad kernel did not become healthy within ${timeoutMs / 1000}s (is uv installed?)`);
  }

  async execute(
    code: string,
    params: Record<string, unknown>,
    contract?: {
      ports?: unknown[];
      envelope?: unknown[];
      assertions?: unknown[];
      /** Expected solid count; omitted skips the check (registry hardware). */
      solids?: number;
      /** G4c: the fabricate process to DFM-check; omitted for printed parts. */
      process?: KernelProcess;
      importDir?: string;
    },
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
        assertions: contract?.assertions ?? [],
        solids: contract?.solids,
        process: contract?.process,
        import_dir: contract?.importDir ?? "",
      }),
    });
    return (await res.json()) as KernelResult;
  }

  /** STEP + DXF + PDF drawing + RFQ.md for one part, zipped. The kernel
   *  re-runs G4c first and refuses (422, stage G4c) a part that fails it. */
  async vendorPackage(req: {
    code: string;
    params: Record<string, unknown>;
    ports: unknown[];
    measured?: unknown[];
    process?: KernelProcess;
    meta: Record<string, unknown>;
    importDir?: string;
  }): Promise<
    | { ok: true; file: string; vendor: { files: string[]; step_schema: string; flat_pattern: boolean } }
    | { ok: false; stage?: string; error: string; hint?: string; failures?: KernelFailure[] }
  > {
    await this.ready();
    const { importDir, ...rest } = req;
    const res = await fetch(`${this.baseUrl}/vendor-package`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...rest, import_dir: importDir ?? "" }),
    });
    return (await res.json()) as never;
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

  /** G5: do any two posed parts occupy the same space, and do mated parts
   *  touch where their ports meet? Keys are `node` or `node#i` per placed
   *  copy; `allow` and `contacts` name nodes. Reports facts — the caller
   *  attributes them. */
  async clash(
    parts: { key: string; code: string; params: Record<string, unknown>; matrix: number[] }[],
    opts: {
      importDir?: string;
      allow?: { a: string; b: string; volume_mm3: number }[];
      contacts?: { edge: string; a: string; b: string; at: number[]; radius: number }[];
      /** Kinematic joints: their moving nodes are swept through `limits`. */
      sweeps?: {
        joint: string; type: "revolute" | "prismatic"; origin: number[]; direction: number[]; limits: [number, number]; moving: string[];
        coupled?: { origin: number[]; direction: number[]; ratio: number; moving: string[] }[];
      }[];
    } = {},
  ): Promise<ClashResult> {
    await this.ready();
    const res = await fetch(`${this.baseUrl}/clash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts,
        import_dir: opts.importDir ?? "",
        allow: opts.allow ?? [],
        contacts: opts.contacts ?? [],
        sweeps: opts.sweeps ?? [],
      }),
    });
    return (await res.json()) as ClashResult;
  }

  /** Assembly instructions: can each step's new parts travel in to their pose
   *  past the parts already placed? `direction` is the way they travel IN. */
  async insertions(
    parts: { key: string; code: string; params: Record<string, unknown>; matrix: number[] }[],
    checks: { id: string; moving: string[]; still: string[]; direction: number[]; clear_mm?: number }[],
    opts: { importDir?: string; allow?: { a: string; b: string; volume_mm3: number }[] } = {},
  ): Promise<InsertionResult> {
    await this.ready();
    const res = await fetch(`${this.baseUrl}/instructions/insertions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts, checks, allow: opts.allow ?? [], import_dir: opts.importDir ?? "" }),
    });
    return (await res.json()) as InsertionResult;
  }

  /** The instruction document: step pictures, hardware page, SVG pages, PDF, HTML. */
  async instructions(
    parts: { key: string; code: string; params: Record<string, unknown>; matrix: number[] }[],
    document: unknown,
    opts: { importDir?: string } = {},
  ): Promise<InstructionsResult> {
    await this.ready();
    const res = await fetch(`${this.baseUrl}/instructions/document`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts, document, import_dir: opts.importDir ?? "" }),
    });
    return (await res.json()) as InstructionsResult;
  }

  /** A reference image with its background removed, cropped to the subject
   *  and padded square, plus the normalized silhouette G6 compares against. */
  async prepImage(dataB64: string): Promise<ImagePrepResult> {
    await this.ready();
    const res = await fetch(`${this.baseUrl}/image/prep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data_b64: dataB64 }),
    });
    return (await res.json()) as ImagePrepResult;
  }

  /** Phase 6.4: a generated GLB rotated to Z-up, repaired, scaled into the
   *  node's envelope box and flat-cut at its face ports. `dir` holds
   *  `mesh.ply` (what load_import reads) and `mesh.glb`. */
  async meshFit(
    glbB64: string,
    fit: { box: { center: number[]; dims: number[] }; flats: { name: string; origin: number[]; normal: number[]; size: number }[] },
  ): Promise<MeshFitResult> {
    await this.ready();
    const res = await fetch(`${this.baseUrl}/mesh/fit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data_b64: glbB64, up: "y", ...fit }),
    });
    return (await res.json()) as MeshFitResult;
  }

  /** G6: the posed assembly's orthographic silhouette against each labelled
   *  reference mask. Keys as in `clash`. */
  async silhouette(
    parts: { key: string; code: string; params: Record<string, unknown>; matrix: number[] }[],
    views: { view: string; ref: string; mask_b64: string }[],
    opts: { importDir?: string } = {},
  ): Promise<SilhouetteResult> {
    await this.ready();
    const res = await fetch(`${this.baseUrl}/silhouette`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts, views, import_dir: opts.importDir ?? "" }),
    });
    return (await res.json()) as SilhouetteResult;
  }

  /** Geometry out: a mesh a slicer can open, or STEP for another CAD tool. */
  async export(
    parts: { code: string; params: Record<string, unknown>; matrix: number[]; matrices?: number[][]; name?: string }[],
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
    opts: { pieces: number; joints: ImportJointMode; thread: string; avoid?: number[][] },
  ): Promise<ImportResult | { ok: false; stage: string; error: string; hint: string }> {
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
        avoid: opts.avoid ?? [],
      }),
    });
    return (await res.json()) as never;
  }

  /** Absolute URL for a cooked node's mesh — what the viewport loads. */
  glbUrl(resultGlbPath: string): string {
    return `${this.baseUrl}${resultGlbPath}`;
  }

  /** Stop the kernel this client spawned: SIGTERM to its whole group, then
   *  SIGKILL whatever outlives the grace. An external kernel, or one this
   *  client found already running, is not ours and is left alone. The
   *  SIGTERM is sent synchronously, so an `exit` handler may call this. */
  async stop(graceMs = 3000): Promise<void> {
    const pid = this.child?.pid;
    this.child = null;
    this.starting = null;
    if (!pid) return;
    const signal = (sig: NodeJS.Signals | 0) => {
      try {
        process.kill(-pid, sig);
        return true;
      } catch {
        return false; // the group is gone
      }
    };
    if (!signal("SIGTERM")) return;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (!signal(0)) return;
    }
    signal("SIGKILL");
  }
}
