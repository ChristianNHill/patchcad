"""FastAPI service: POST /execute runs node code through the gated worker
pool; results are content-addressed by (code, params) so unchanged nodes are
instant cache hits (the T0 slider path re-executes only on new param values).
"""

from __future__ import annotations

import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import anyio
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

PORT = int(os.environ.get("PATCHCAD_KERNEL_PORT", "8621"))
TIMEOUT_S = float(os.environ.get("PATCHCAD_KERNEL_TIMEOUT", "20"))
POOL_SIZE = int(os.environ.get("PATCHCAD_KERNEL_WORKERS", "2"))
CACHE_ROOT = Path(os.environ.get("PATCHCAD_KERNEL_CACHE", str(Path.home() / ".patchcad" / "kernel-cache")))

pool = None  # set at startup; parent process stays OCP-free
executor = ThreadPoolExecutor(max_workers=POOL_SIZE)


def job_hash(*parts: Any) -> str:
    canonical = json.dumps(list(parts), sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf8")).hexdigest()[:16]


class ExecuteBody(BaseModel):
    code: str
    params: dict[str, Any] = Field(default_factory=dict)
    """Declared ports/envelope switch on the contract gates G3/G4 (verify pass)."""
    ports: list[dict[str, Any]] = Field(default_factory=list)
    envelope: list[dict[str, Any]] = Field(default_factory=list)
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


class ExportBody(BaseModel):
    parts: list[AssemblyPart] = Field(default_factory=list)
    format: str = "stl"
    import_dir: str = ""


class AssemblyRenderBody(BaseModel):
    parts: list[AssemblyPart] = Field(default_factory=list)
    import_dir: str = ""
    views: int = 4


class ImportBody(BaseModel):
    filename: str
    data_b64: str
    pieces: int = 1
    join_holes: bool = False  # legacy alias for joints="holes"
    joints: str = "none"  # none | holes | pegs
    thread: str = "M4"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    from .pool import WorkerPool

    pool = WorkerPool(POOL_SIZE)
    print(f"[kernel] {POOL_SIZE} warm workers ready, cache at {CACHE_ROOT}")
    yield
    pool.shutdown()


app = FastAPI(lifespan=lifespan)

# The studio (a different localhost port) fetches GLBs straight from here.
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"ok": True, "workers": pool.stats(), "timeout_s": TIMEOUT_S}


@app.post("/execute")
async def execute(body: ExecuteBody):
    digest = job_hash(body.code, body.params, body.ports, body.envelope, body.import_dir)
    out_dir = CACHE_ROOT / digest
    meas_file = out_dir / "measurements.json"
    glb_file = out_dir / "mesh.glb"

    if meas_file.exists() and glb_file.exists():
        return {
            "ok": True,
            "hash": digest,
            "cached": True,
            "measurements": json.loads(meas_file.read_text("utf8")),
            "glb": f"/artifact/{digest}/mesh.glb",
        }

    job = {
        "code": body.code,
        "params": body.params,
        "ports": body.ports,
        "envelope": body.envelope,
        "import_dir": body.import_dir,
        "out_dir": str(out_dir),
    }
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, TIMEOUT_S))

    if not result.get("ok"):
        return JSONResponse(status_code=422, content={"ok": False, "hash": digest, **result})
    return {
        "ok": True,
        "hash": digest,
        "cached": False,
        "measurements": result["measurements"],
        "elapsed_ms": result["elapsed_ms"],
        "glb": f"/artifact/{digest}/mesh.glb",
    }


@app.post("/render")
async def render(body: RenderBody):
    """Multi-view contact sheet for one part.

    Deliberately NOT part of /execute: rendering costs 100-300ms, and /execute
    is the T0 slider path where a part re-runs on every drag. Asking for a
    picture is a separate, rarer act, so it pays its own cost and gets its own
    content-addressed cache entry.
    """
    digest = job_hash("render", body.code, body.params, body.import_dir, body.views)
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
    digest = job_hash("export", [p.model_dump() for p in body.parts], body.format, body.import_dir)
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


@app.post("/render-assembly")
async def render_assembly_endpoint(body: AssemblyRenderBody):
    """The whole thing, posed. A part can satisfy every gate and still be wrong
    in company — sunk into its neighbour, floating clear of it, or a quarter
    turn out. Nothing per-part can see that, because nothing per-part ever
    looks at two parts at once."""
    digest = job_hash("assembly", [p.model_dump() for p in body.parts], body.import_dir, body.views)
    out_dir = CACHE_ROOT / digest
    sheet_file = out_dir / "sheet.png"
    if sheet_file.exists():
        return {"ok": True, "hash": digest, "cached": True, "sheet": f"/artifact/{digest}/sheet.png"}

    job = {
        "assembly": [p.model_dump() for p in body.parts],
        "import_dir": body.import_dir,
        "out_dir": str(out_dir),
        "render_views": body.views,
    }
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, max(TIMEOUT_S, 90)))
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
    digest = job_hash("import", body.filename, body.data_b64[:64], len(body.data_b64), body.pieces, body.join_holes, body.joints, body.thread)
    out_dir = CACHE_ROOT / f"import-{digest}"
    job = {
        "import_job": {
            "filename": body.filename,
            "data_b64": body.data_b64,
            "pieces": body.pieces,
            "join_holes": body.join_holes,
            "joints": body.joints,
            "thread": body.thread,
        },
        "out_dir": str(out_dir),
    }
    result = await anyio.to_thread.run_sync(lambda: pool.execute(job, max(TIMEOUT_S, 120)))
    if not result.get("ok"):
        return JSONResponse(status_code=422, content={"ok": False, **result})
    return {"ok": True, "dir": str(out_dir), **{k: v for k, v in result.items() if k != "ok"}}


@app.get("/artifact/{digest}/mesh.glb")
async def artifact(digest: str):
    path = CACHE_ROOT / digest / "mesh.glb"
    if not path.exists() or "/" in digest or ".." in digest:
        return JSONResponse(status_code=404, content={"error": "unknown artifact"})
    return FileResponse(path, media_type="model/gltf-binary")


def run() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    run()
