"""FastAPI service: POST /execute runs node code through the gated worker
pool; results are content-addressed by (code, params) so unchanged nodes are
instant cache hits (the T0 slider path re-executes only on new param values).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import anyio
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

PORT = int(os.environ.get("PATCHCAD_KERNEL_PORT", "8621"))
#: 0.0.0.0 in a container, where the server reaches the kernel by service name.
HOST = os.environ.get("PATCHCAD_KERNEL_HOST", "127.0.0.1")
TIMEOUT_S = float(os.environ.get("PATCHCAD_KERNEL_TIMEOUT", "20"))
#: The gates' own budget, started when the build returns. A probe slow on a
#: helical sweep used to share the build's 20s and was reported as code that
#: "loops forever", so the generator simplified a correct part.
GATE_TIMEOUT_S = float(os.environ.get("PATCHCAD_KERNEL_GATE_TIMEOUT", "30"))
def _default_pool_size() -> int:
    """Warm workers to keep. Two left a cook wave serialising on geometry: eight
    parts in parallel took 4.5s of wall for 7.5s of work, a 1.7x speedup against
    a 2x ceiling, while twelve cores sat idle. Scaled to the machine rather than
    pinned at a flat number, because each worker holds a live OCP interpreter
    (~200MB) and this default also lands on other people's laptops."""
    cpus = os.cpu_count() or 2
    return max(2, min(8, cpus - 2))


POOL_SIZE = int(os.environ.get("PATCHCAD_KERNEL_WORKERS") or _default_pool_size())
CACHE_ROOT = Path(os.environ.get("PATCHCAD_KERNEL_CACHE", str(Path.home() / ".patchcad" / "kernel-cache")))

pool = None  # set at startup; parent process stays OCP-free


# The cache is keyed on the JOB, but a cached entry is really a claim about what
# the GATES said — and only passes are stored, so tightening a gate left every
# part already in the cache holding its old, laxer verdict. A FLAT_FACE probe
# was corrected from accepting an 11% overstated face to 0.6mm, and the parts the
# correction existed for kept passing on a cache hit; the fix applied only to
# geometry nobody had built yet. BUMP THIS WHENEVER GATE LOGIC CHANGES — it costs
# one re-execute per part and is the difference between a gate fix that ships and
# one that only appears to.
# 2 -> 3: GROOVE and SLOT gained a probe. Under 2 they were recorded "skipped"
# and the job passed, and those passes are in the cache — so without this bump a
# node whose ports are all channels keeps its unverified verdict, which is the
# exact grandfathering this constant was introduced for one commit ago.
# 3 -> 4: channel width became the NARROWEST gap over several depths, and the
# floor is measured rather than echoed. Both change verdicts, and a chamfered
# channel that passed under 3 as "3.00" may have been 2.2mm wide.
# 4 -> 5: G5's discriminator changed from a shared VOLUME to mean penetration
# depth. Clash results are cached like any other job, so without this the
# projects the change exists to re-judge keep the verdict it was correcting —
# which is exactly what happened on the first sweep after the fix.
# 5 -> 6: hole probes measure depth and through-ness, and a CLEARANCE_HOLE must
# pass through at ANY depth, not merely be deeper than a dimple. A cached pass
# would otherwise keep the verdict this change exists to overturn.
# 6 -> 7: joining-hole cutters changed size, so a re-split of an imported node
# produces different geometry. The mesh bytes are NOT in the digest below,
# because import_dir is hashed as a path string and no file is ever read, so an
# undo-then-re-split reuses the same key: same node ids, same filenames, same
# code, same params, same ports, new holes. The cache is on disk and outlives
# the restart, which is precisely when it would serve the stale verdict.
# 7 -> 8: SHAFT is probed instead of skipped. Every peg joint on disk holds a
# cached pass whose port report says "no probe for this type yet", and those are
# exactly the verdicts this overturns.
# 8 -> 9: the SHAFT comparisons changed in every direction. Diameter is read
# near the base instead of mid-height (a drafted peg was false-failed), all
# eight rays must agree (a peg fused to a slab passed as perfectly round), the
# length check is two-sided (a long peg bottoms out) and reach exhaustion is a
# failure instead of a silent omission. Any peg that passed under 8 was judged
# by weaker comparisons.
# 9 -> 10: a bare `diameter` stopped being an outer-diameter alias on a
# SCREW_BOSS, so a boss declaring only that used to PASS (resolved to the wall)
# and now fails with a repairable message. That is a pass-to-fail change, which
# is the direction only-passes-are-cached makes dangerous.
#
# I could argue the bump away: smoke is the only producer of boss passes and it
# uses outer_diameter, and no graph on disk declares a SCREW_BOSS at all. But the
# cache stores measurements, not request bodies, so nothing on disk PROVES which
# spellings produced the nine stored boss passes. Bumping costs one
# re-execution; reasoning wrongly here has cost four commits already.
# 10 -> 11: G3 probes every port and G4 runs beside it, failures reported
# together; the mesh moved to a contract-free key so a verify pass and the
# viewport share one build. New cache layout, so old entries cannot be read.
# 11 -> 12: G2 fails more than one solid unless the contract declares the
# count; the hole probe fits a circle and gates centre offset, axis tilt and
# the narrowest diameter over several depths; G4 tests points in each
# primitive's own rotated frame and samples edge midpoints and face points.
# G5 (same bump): thread overlap is exempted inside the clash, per allowed
# node pair, and each mate reports the contact gap at its port point. The
# clash request carries both, so its cache key changes with them.
# G3 (same bump): HOLE_PATTERN and BOSS_PATTERN are probed member by member,
# and a port type with no probe FAILS instead of passing as "skipped". G4b
# (same bump): contract assertions are measured, and they join the verdict key.
# 12 -> 13: G3 probes the hardware host features (THREADED_HOLE, INSERT_POCKET,
# NUT_TRAP, COUNTERBORE, COUNTERSINK, DOWEL_HOLE, BEARING_SEAT, BUSHING_BORE,
# MOTOR_MOUNT, MAGNET_POCKET, HUB_BORE), each against a fit band. Under 12 these
# failed as "no probe", so their verdicts all change.
# 13 -> 14: G4c process DFM (dfm_process.py) for fabricate parts: CNC corner
# radius / undercut / pocket depth, sheet-metal gauge / bend / hole-to-edge,
# laser single profile, SLS/MJF/resin walls. `process` joins the verdict key.
# 14 -> 15: hardware fit bands follow the process. A machined part (cnc,
# sheet_metal, laser_cut) is held to press d-0.05..d and slip d..d+0.05, where
# FDM keeps d-0.1..d and d+0.05..d+0.25; band edges get 0.02 of resolution slack.
# 15 -> 16: HOLE_PATTERN members, MOTOR_MOUNT screw holes and the bore under a
# COUNTERBORE/COUNTERSINK must pass through unless they declare a depth; min_wall
# gates on a guarded minimum instead of the 2nd percentile; hole_count clusters
# axes by tolerance; a solids assertion fails as G2; a declaration no gate can
# read fails as CONTRACT; depth marches intersect the B-rep instead of stepping.
# Every one of these overturns cached passes.
# 16 -> 17: LINEAR_BEARING_SEAT, CLIP_GROOVE and RAIL_MOUNT have probes; a port
# of those types failed "no probe" before, and passes now when the part is right.
# 17 -> 18: a hole that breaks out into a cavity is through (a C-clamp's screw
# hole into the jaw "bottomed out" on the far arm); hole slices refit without
# stray crossings and read the inscribed circle (a keyway read Ø12 as Ø12.52,
# 0.74mm off centre); G2 fails a non-watertight export mesh, welded the way
# exporters weld it; G0 rejects a try/except that silently drops a boolean,
# sweep, loft, revolve or helix, and a feature added only if a volume test
# passes; G4b helix and line_count; G4c "fdm" (wall blocks under 0.45mm on
# generated parts; stability, overhang and thin walls are findings).
# 18 -> 19: containment reads the nearest face a ray meets (the classifier
# called a point 3.6mm outside a swept thread inside); a SLOT/GROOVE walled
# above a crossing void is graded above it, not failed as open; the gates have
# their own budget, and running out of it is that gate's failure, not TIMEOUT;
# min_wall (G4b, G4c) leaves out chords within a nozzle width of an edge under
# 100 deg whose surface 1.5mm further in is no longer thin (dovetail edges,
# thread runouts), reported as a sliver finding; a rib thin all along counts.
# 19 -> 20: a NUT_TRAP flat-normal ray that meets no wall short of the hex's
# corner (a drop slot, a crossing bolt hole, a squared-off floor) is a
# breakout and only rays that meet a wall are graded; G4c fdm reports
# bridge_span_mm and a "bridge" finding past 10mm.
GATES_VERSION = 20
# Tap drills and clearances come from the catalog, so a catalog edit changes
# verdicts too. Keyed by content, not by remembering to bump GATES_VERSION.
CATALOG_DIGEST = hashlib.sha256(
    (Path(__file__).resolve().parents[3] / "catalog" / "hardware.json").read_bytes()
).hexdigest()[:12]


def job_hash(*parts: Any) -> str:
    canonical = json.dumps(list(parts), sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf8")).hexdigest()[:16]


def import_stamp(import_dir: str, *codes: str) -> list[Any]:
    """The imported files this code reads, by name, size and mtime. import_dir
    was hashed as a path string, so a re-import that rewrote
    <project>/imports/piece-0.ply kept the same key and served the old GLB and
    verdict. Only files the code names, so re-importing one piece does not
    invalidate the others; size+mtime, because hashing a 300k-face PLY on every
    T0 slider move is the cost this cache exists to avoid."""
    if not import_dir:
        return []
    try:
        names = sorted(os.listdir(import_dir))
    except OSError:
        return []
    stamp = []
    for name in names:
        if any(name in code for code in codes):
            st = os.stat(os.path.join(import_dir, name))
            stamp.append([name, st.st_size, st.st_mtime_ns])
    return stamp


class ExecuteBody(BaseModel):
    code: str
    params: dict[str, Any] = Field(default_factory=dict)
    """Declared ports/envelope switch on the contract gates G3/G4 (verify pass)."""
    ports: list[dict[str, Any]] = Field(default_factory=list)
    envelope: list[dict[str, Any]] = Field(default_factory=list)
    """How many solids the part must be; None skips the count (registry hardware)."""
    solids: int | None = None
    """G4b spec-derived assertions from the contract (solids, volume_range, ...)."""
    assertions: list[dict[str, Any]] = Field(default_factory=list)
    """G4c: the fabricate process to DFM-check ({kind, tool_radius?, allow_undercuts?})."""
    process: dict[str, Any] | None = None
    """Directory holding imported piece meshes for load_import() node code."""
    import_dir: str = ""


class RenderBody(BaseModel):
    code: str
    params: dict[str, Any] = Field(default_factory=dict)
    import_dir: str = ""
    views: int = 6


class AssemblyPart(BaseModel):
    code: str
    params: dict[str, Any] = Field(default_factory=dict)
    """Column-major 4x4 world matrix from the assembly solver."""
    matrix: list[float] = Field(default_factory=list)


class ExportPart(AssemblyPart):
    """Named in the file (STEP label, 3MF object), so it says which node it is."""
    name: str = ""
    """One world matrix per placed copy; empty falls back to `matrix`."""
    matrices: list[list[float]] = Field(default_factory=list)


class ExportBody(BaseModel):
    parts: list[ExportPart] = Field(default_factory=list)
    format: str = "stl"
    import_dir: str = ""


class ImportBody(BaseModel):
    filename: str
    data_b64: str
    pieces: int = 1
    joints: str = "auto"  # auto | none | holes | pegs
    thread: str = "M4"
    # Feature points already in the mesh (a re-split piece's joints): auto
    # joint sites keep their columns clear of them.
    avoid: list[list[float]] = Field(default_factory=list)


class MeshFitBody(BaseModel):
    """A generated GLB to fit into one node's envelope (Phase 6.4)."""
    data_b64: str
    up: str = "y"  # glTF is Y-up
    box: dict[str, list[float]]  # {center, dims} in the node frame, mm
    flats: list[dict[str, Any]] = Field(default_factory=list)  # {name, origin, normal, size}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    from .pool import WorkerPool

    pool = WorkerPool(POOL_SIZE, str(CACHE_ROOT / "traces" / str(PORT)))
    print(f"[kernel] {POOL_SIZE} warm workers ready, cache at {CACHE_ROOT}")
    yield
    pool.shutdown()


app = FastAPI(lifespan=lifespan)

# The studio (a different localhost port) fetches GLBs straight from here.
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"ok": True, "workers": pool.stats(), "timeout_s": TIMEOUT_S, "gate_timeout_s": GATE_TIMEOUT_S}


@app.post("/execute")
async def execute(body: ExecuteBody):
    # The mesh is keyed on what shapes it; the verdict also on the contract.
    # Without contract gates the two keys are the same entry.
    stamp = import_stamp(body.import_dir, body.code)
    build_digest = job_hash(GATES_VERSION, body.code, body.params, body.import_dir, stamp)
    has_contract = bool(body.ports or body.envelope or body.assertions or body.process) or body.solids is not None
    digest = (job_hash(GATES_VERSION, CATALOG_DIGEST, body.code, body.params, body.ports, body.envelope, body.solids,
                         body.assertions, body.import_dir, stamp, body.process)
              if has_contract else build_digest)
    out_dir = CACHE_ROOT / digest
    meas_file = out_dir / "measurements.json"
    glb_file = CACHE_ROOT / build_digest / "mesh.glb"
    glb_url = f"/artifact/{build_digest}/mesh.glb"

    if meas_file.exists() and glb_file.exists():
        return {
            "ok": True,
            "hash": digest,
            "cached": True,
            "measurements": json.loads(meas_file.read_text("utf8")),
            "glb": glb_url,
        }

    job = {
        "code": body.code,
        "params": body.params,
        "ports": body.ports,
        "envelope": body.envelope,
        "solids": body.solids,
        "assertions": body.assertions,
        "process": body.process,
        "import_dir": body.import_dir,
        "out_dir": str(out_dir),
        "glb_dir": str(CACHE_ROOT / build_digest),
    }
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, TIMEOUT_S, GATE_TIMEOUT_S))

    if not result.get("ok"):
        return JSONResponse(status_code=422, content={"ok": False, "hash": digest, **result})
    return {
        "ok": True,
        "hash": digest,
        "cached": False,
        "measurements": result["measurements"],
        "elapsed_ms": result["elapsed_ms"],
        "glb": glb_url,
    }


@app.post("/render")
async def render(body: RenderBody):
    """Multi-view contact sheet for one part.

    Deliberately NOT part of /execute: rendering costs 100-300ms, and /execute
    is the T0 slider path where a part re-runs on every drag. Asking for a
    picture is a separate, rarer act, so it pays its own cost and gets its own
    content-addressed cache entry.
    """
    # The tag versions the sheet's LOOK: a cached v1 sheet (dark, no triad or
    # scale bar) would otherwise be served for any code rendered before.
    digest = job_hash("render-v2", body.code, body.params, body.import_dir, import_stamp(body.import_dir, body.code),
                      body.views)
    out_dir = CACHE_ROOT / digest
    sheet_file = out_dir / "sheet.png"
    if sheet_file.exists():
        return {"ok": True, "hash": digest, "cached": True, "sheet": f"/artifact/{digest}/sheet.png"}

    job = {
        "code": body.code,
        "params": body.params,
        "import_dir": body.import_dir,
        "out_dir": str(out_dir),
        "render_views": body.views,
    }
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, max(TIMEOUT_S, 60)))
    if not result.get("ok"):
        return JSONResponse(status_code=422, content={"ok": False, "hash": digest, **result})
    return {
        "ok": True,
        "hash": digest,
        "cached": False,
        "sheet": f"/artifact/{digest}/sheet.png",
        "render": result.get("render"),
        "elapsed_ms": result["elapsed_ms"],
    }


@app.post("/export")
async def export(body: ExportBody):
    """Geometry out: a mesh for a slicer, or STEP for another CAD tool."""
    # "export-v2": the exporters changed what they write, and the key had no
    # version, so a file exported before kept being served.
    digest = job_hash("export-v2", [p.model_dump() for p in body.parts], body.format, body.import_dir,
                      import_stamp(body.import_dir, *(p.code for p in body.parts)))
    out_dir = CACHE_ROOT / digest
    out_file = out_dir / f"export.{body.format}"
    meta_file = out_dir / "export.json"
    # A zero-byte file is a failed write, not a cache entry.
    if out_file.exists() and out_file.stat().st_size > 0 and meta_file.exists():
        return {
            "ok": True, "hash": digest, "cached": True,
            "file": f"/artifact/{digest}/export.{body.format}",
            "export": json.loads(meta_file.read_text("utf8")),
        }

    job = {
        "export": {"parts": [p.model_dump() for p in body.parts], "format": body.format},
        "import_dir": body.import_dir,
        "out_dir": str(out_dir),
    }
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, max(TIMEOUT_S, 120)))
    if not result.get("ok"):
        return JSONResponse(status_code=422, content={"ok": False, "hash": digest, **result})
    return {
        "ok": True,
        "hash": digest,
        "cached": False,
        "file": f"/artifact/{digest}/export.{body.format}",
        "export": result.get("export"),
        "elapsed_ms": result["elapsed_ms"],
    }


@app.get("/artifact/{digest}/export.{ext}")
async def export_artifact(digest: str, ext: str):
    path = CACHE_ROOT / digest / f"export.{ext}"
    if not path.exists():
        return JSONResponse(status_code=404, content={"error": "no export for that hash"})
    return FileResponse(path, media_type="application/octet-stream", filename=f"patchcad.{ext}")


class VendorBody(BaseModel):
    code: str
    params: dict[str, Any] = Field(default_factory=dict)
    import_dir: str = ""
    """Resolved contract ports (for hole callouts) and their G3 measurements."""
    ports: list[dict[str, Any]] = Field(default_factory=list)
    measured: list[dict[str, Any]] = Field(default_factory=list)
    """G4c process ({kind, tool_radius?, allow_undercuts?}); re-checked before packaging."""
    process: dict[str, Any] | None = None
    """Title block + RFQ: name, title, process, material, finish, qty, date, notes."""
    meta: dict[str, Any] = Field(default_factory=dict)


@app.post("/vendor-package")
async def vendor_package_endpoint(body: VendorBody):
    """STEP + DXF + PDF drawing + RFQ.md for one fabricated part, zipped.
    Served at /artifact/<digest>/vendor.zip; not cached across requests, it is
    rare and the date in its title block changes."""
    digest = job_hash(GATES_VERSION, "vendor-v1", body.model_dump(), import_stamp(body.import_dir, body.code))
    out_dir = CACHE_ROOT / digest
    job = {"code": body.code, "params": body.params, "import_dir": body.import_dir, "out_dir": str(out_dir),
           "vendor": {"ports": body.ports, "measured": body.measured, "process": body.process, "meta": body.meta}}
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, max(TIMEOUT_S, 120)))
    if not result.get("ok"):
        return JSONResponse(status_code=422, content={"ok": False, "hash": digest, **result})
    return {"ok": True, "hash": digest, "file": f"/artifact/{digest}/vendor.zip", "vendor": result["vendor"],
            "elapsed_ms": result["elapsed_ms"]}


@app.get("/artifact/{digest}/vendor.zip")
async def vendor_zip(digest: str):
    path = CACHE_ROOT / digest / "vendor.zip"
    if not path.exists() or "/" in digest or ".." in digest:
        return JSONResponse(status_code=404, content={"error": "no vendor package for that hash"})
    return FileResponse(path, media_type="application/zip", filename="vendor.zip")


class ClashPart(AssemblyPart):
    """A posed part, identified so a clash can name both sides."""
    key: str


class ClashBody(BaseModel):
    parts: list[ClashPart] = Field(default_factory=list)
    import_dir: str = ""
    """Node pairs designed to share material, with the volume they may share."""
    allow: list[dict[str, Any]] = Field(default_factory=list)
    """Mates to measure contact at: {edge, a, b, at, radius}."""
    contacts: list[dict[str, Any]] = Field(default_factory=list)
    """Kinematic joints whose moving parts are swept: {joint, type, origin, direction, limits, moving}."""
    sweeps: list[dict[str, Any]] = Field(default_factory=list)


@app.post("/clash")
async def clash_endpoint(body: ClashBody):
    """Do any two parts occupy the same space? Every gate before this one grades
    ONE part against its own contract, so none of them can see this: a collar
    can pass every probe and every envelope and still sit inside the base it is
    meant to rest on. Assembly-level, so it reports rather than failing a node —
    no single part is at fault."""
    if len(body.parts) < 2:
        return {"ok": True, "clash": {"parts": len(body.parts), "pairs_tested": 0, "clashes": []}}
    # "clash-v2": the boolean moved off trimesh's is_volume gate, and reports
    # cached under 12 still say "boolean failed" for pairs it now compares.
    # "clash-v3": moving parts are swept through their joints' travel.
    # "clash-v4": sweeps name the placed copies that move, each about its own axis.
    digest = job_hash(GATES_VERSION, "clash-v4", [p.model_dump() for p in body.parts], body.import_dir,
                      import_stamp(body.import_dir, *(p.code for p in body.parts)),
                      body.allow, body.contacts, body.sweeps)
    out_dir = CACHE_ROOT / digest
    cached_file = anyio.Path(out_dir / "clash.json")
    if await cached_file.exists():
        return {"ok": True, "hash": digest, "cached": True, "clash": json.loads(await cached_file.read_text("utf8"))}

    job = {"clash": [p.model_dump() for p in body.parts], "import_dir": body.import_dir,
           "allow": body.allow, "contacts": body.contacts, "sweeps": body.sweeps}
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, max(TIMEOUT_S, 60)))
    if not result.get("ok"):
        return JSONResponse(status_code=422, content={"ok": False, "hash": digest, **result})
    if result["clash"].get("errors"):
        # An uncompared pair is not a verdict: caching it would pin "skipped"
        # to this hash after whatever made it fail is fixed.
        return {"ok": True, "hash": digest, "cached": False, "clash": result["clash"]}
    await anyio.Path(out_dir).mkdir(parents=True, exist_ok=True)
    tmp = cached_file.with_suffix(".tmp")
    await tmp.write_text(json.dumps(result["clash"]), "utf8")
    await tmp.replace(cached_file)  # atomic: a half-written file would poison this hash
    return {"ok": True, "hash": digest, "cached": False, "clash": result["clash"]}


class InsertionBody(BaseModel):
    parts: list[ClashPart] = Field(default_factory=list)
    import_dir: str = ""
    """{id, moving: [key], still: [key], direction, clear_mm?}: direction is the way the moving parts travel
    IN; clear_mm how far they ride a placed shaft before they are free."""
    checks: list[dict[str, Any]] = Field(default_factory=list)
    allow: list[dict[str, Any]] = Field(default_factory=list)


@app.post("/instructions/insertions")
async def insertions_endpoint(body: InsertionBody):
    """Can each assembly step's new parts reach their pose? Each is swept in
    from outside along its approach against the parts already placed (G5's
    prismatic sweep); only overlap beyond what the pair shares at rest blocks."""
    digest = job_hash(GATES_VERSION, "insertion-v2", [p.model_dump() for p in body.parts], body.import_dir,
                      import_stamp(body.import_dir, *(p.code for p in body.parts)), body.checks, body.allow)
    cached_file = anyio.Path(CACHE_ROOT / digest / "insertions.json")
    if await cached_file.exists():
        return {"ok": True, "hash": digest, "cached": True, "insertions": json.loads(await cached_file.read_text("utf8"))}
    job = {"insertions": {"parts": [p.model_dump() for p in body.parts], "checks": body.checks, "allow": body.allow},
           "import_dir": body.import_dir}
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, max(TIMEOUT_S, 120)))
    if not result.get("ok"):
        return JSONResponse(status_code=422, content={"ok": False, "hash": digest, **result})
    if not result["insertions"].get("errors"):  # an uncompared pair is not a verdict
        await anyio.Path(CACHE_ROOT / digest).mkdir(parents=True, exist_ok=True)
        tmp = cached_file.with_suffix(".tmp")
        await tmp.write_text(json.dumps(result["insertions"]), "utf8")
        await tmp.replace(cached_file)
    return {"ok": True, "hash": digest, "cached": False, "insertions": result["insertions"]}


class InstructionsBody(BaseModel):
    """Posed copies (keys as in /clash) and the document instructions.ts wrote:
    title, steps (context keys, moving keys with directions, callouts, text),
    hardware items (each with its own code, drawn alone) and tools."""
    parts: list[ClashPart] = Field(default_factory=list)
    import_dir: str = ""
    document: dict[str, Any] = Field(default_factory=dict)


@app.post("/instructions/document")
async def instructions_endpoint(body: InstructionsBody):
    """Step pictures, the hardware page and every page as SVG, the PDF and an
    HTML copy, cached by everything that draws them."""
    digest = job_hash("instructions-v2", [p.model_dump() for p in body.parts], body.import_dir,
                      import_stamp(body.import_dir, *(p.code for p in body.parts)), body.document)
    out_dir = CACHE_ROOT / digest
    meta_file = out_dir / "instructions.json"

    def urls(info: dict[str, Any]) -> dict[str, Any]:
        base = f"/artifact/{digest}"
        return {"pages": [f"{base}/page-{i + 1}.svg" for i in range(info["pages"])],
                "pdf": f"{base}/instructions.pdf", "html": f"{base}/instructions.html"}

    if meta_file.exists():
        info = json.loads(meta_file.read_text("utf8"))
        return {"ok": True, "hash": digest, "cached": True, "document": info, **urls(info)}
    job = {"instructions": {"parts": [p.model_dump() for p in body.parts], "document": body.document},
           "import_dir": body.import_dir, "out_dir": str(out_dir)}
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, max(TIMEOUT_S, 180)))
    if not result.get("ok"):
        return JSONResponse(status_code=422, content={"ok": False, "hash": digest, **result})
    tmp = meta_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(result["instructions"]), "utf8")
    tmp.replace(meta_file)
    return {"ok": True, "hash": digest, "cached": False, "document": result["instructions"], **urls(result["instructions"])}



class ImagePrepBody(BaseModel):
    data_b64: str
    """auto = threshold on a plain backdrop, rembg otherwise; or force one."""
    method: str = "auto"


@app.post("/image/prep")
async def image_prep(body: ImagePrepBody):
    """A reference image, background removed, cropped and padded square, plus
    the normalized silhouette G6 compares the assembly against. Runs in the
    parent on a thread: no OCP, and the u2net session stays warm across calls."""
    digest = job_hash("image-prep-v2", body.method, hashlib.sha256(body.data_b64.encode()).hexdigest())
    cached_file = CACHE_ROOT / digest / "prep.json"
    if cached_file.exists():
        return {"ok": True, "hash": digest, "cached": True, **json.loads(cached_file.read_text("utf8"))}
    from .image_prep import prep_image

    try:
        prep = await anyio.to_thread.run_sync(lambda: prep_image(body.data_b64, body.method))
    except Exception as err:  # noqa: BLE001 — unreadable image or no subject: the caller decides
        return JSONResponse(status_code=422, content={"ok": False, "error": str(err)})
    cached_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = cached_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(prep), "utf8")
    tmp.replace(cached_file)
    return {"ok": True, "hash": digest, "cached": False, **prep}


class SilhouetteBody(BaseModel):
    parts: list[ClashPart] = Field(default_factory=list)
    import_dir: str = ""
    """One per labelled reference: {view, ref, mask_b64}."""
    views: list[dict[str, Any]] = Field(default_factory=list)


@app.post("/silhouette")
async def silhouette_endpoint(body: SilhouetteBody):
    """G6: IoU of the posed assembly's orthographic silhouette against each
    reference mask, plus which parts account for the disagreement."""
    digest = job_hash(GATES_VERSION, "silhouette-v1", [p.model_dump() for p in body.parts], body.import_dir,
                      import_stamp(body.import_dir, *(p.code for p in body.parts)), body.views)
    cached_file = CACHE_ROOT / digest / "silhouette.json"
    if cached_file.exists():
        return {"ok": True, "hash": digest, "cached": True, "silhouette": json.loads(cached_file.read_text("utf8"))}
    job = {"silhouette": [p.model_dump() for p in body.parts], "import_dir": body.import_dir, "views": body.views}
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, max(TIMEOUT_S, 60)))
    if not result.get("ok"):
        return JSONResponse(status_code=422, content={"ok": False, "hash": digest, **result})
    cached_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = cached_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(result["silhouette"]), "utf8")
    tmp.replace(cached_file)
    return {"ok": True, "hash": digest, "cached": False, "silhouette": result["silhouette"]}


@app.get("/artifact/{digest}/sheet.png")
async def sheet(digest: str):
    path = CACHE_ROOT / digest / "sheet.png"
    if not path.exists():
        return JSONResponse(status_code=404, content={"error": "no sheet for that hash"})
    return FileResponse(path, media_type="image/png")


@app.post("/import")
async def import_file(body: ImportBody):
    """Segment an uploaded STL/3MF/STEP into pieces + interface contracts.
    Runs in a worker (same isolation as node code); pieces land content-
    addressed like any other artifact."""
    digest = job_hash("import", body.filename, hashlib.sha256(body.data_b64.encode()).hexdigest(), body.pieces,
                      body.joints, body.thread, body.avoid)
    out_dir = CACHE_ROOT / f"import-{digest}"
    job = {
        "import_job": {
            "filename": body.filename,
            "data_b64": body.data_b64,
            "pieces": body.pieces,
            "joints": body.joints,
            "thread": body.thread,
            "avoid": body.avoid,
        },
        "out_dir": str(out_dir),
    }
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, max(TIMEOUT_S, 120)))
    if not result.get("ok"):
        return JSONResponse(status_code=422, content={"ok": False, **result})
    return {"ok": True, "dir": str(out_dir), **{k: v for k, v in result.items() if k != "ok"}}


@app.post("/mesh/fit")
async def mesh_fit(body: MeshFitBody):
    """Rotate, repair, scale and flat-cut a generated mesh into the node's
    frame. Content-addressed on the whole request, like a build."""
    # "mesh-fit-v2": opposite flats on one axis no longer move each other's cut.
    digest = job_hash("mesh-fit-v2", body.model_dump())
    out_dir = CACHE_ROOT / f"meshfit-{digest}"
    report = out_dir / "fit.json"
    if report.exists():
        return {"dir": str(out_dir), "cached": True, **json.loads(report.read_text("utf8"))}
    job = {"mesh_fit": body.model_dump(), "out_dir": str(out_dir)}
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, max(TIMEOUT_S, 120)))
    if not result.get("ok"):
        return JSONResponse(status_code=422, content={"ok": False, **result})
    tmp = report.with_suffix(".tmp")
    tmp.write_text(json.dumps(result), "utf8")
    tmp.replace(report)
    return {"dir": str(out_dir), "cached": False, **result}


@app.get("/artifact/{digest}/mesh.glb")
async def artifact(digest: str):
    path = CACHE_ROOT / digest / "mesh.glb"
    if not path.exists() or "/" in digest or ".." in digest:
        return JSONResponse(status_code=404, content={"error": "unknown artifact"})
    return FileResponse(path, media_type="model/gltf-binary")


@app.get("/artifact/{digest}/{name}")
async def instructions_file(digest: str, name: str):
    """Instruction pages, pictures, PDF and HTML. Declared after every other
    /artifact route so it never shadows one; anything else is a 404."""
    path = CACHE_ROOT / digest / name
    if not re.fullmatch(r"[0-9a-f]+", digest) or not INSTRUCTION_FILES.match(name) or not path.exists():
        return JSONResponse(status_code=404, content={"error": "no such instructions file"})
    return FileResponse(path, media_type=INSTRUCTION_TYPES[name.rsplit(".", 1)[1]])


INSTRUCTION_FILES = re.compile(r"^(page-\d+\.svg|step-\d+\.png|item-\d+\.png|instructions\.(pdf|html))$")
INSTRUCTION_TYPES = {"svg": "image/svg+xml", "png": "image/png", "pdf": "application/pdf", "html": "text/html"}


def run() -> None:
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    run()
