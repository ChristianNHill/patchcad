"""Worker process: one warm build123d interpreter per worker. The parent
process never imports OCP — a segfault here kills this process only, and the
pool respawns it.

Protocol over the Pipe:
  parent → worker: {"code", "params", "out_dir", "glb_dir", "trace_after_s", "phases"}
  worker → parent: {"phase": stage, "port"?} as each gate starts, when "phases"
                 then {"ok": True, "measurements", "elapsed_ms"}
                 | {"ok": False, "stage", "error", "hint", "failures", "measurements"?}
  worker → parent at boot: {"ready": True}

`trace_path` is a file the parent can read after it kills this worker on a
timeout: faulthandler dumps the stack there just before the deadline, so the
report can name the node line that was still running.
"""

from __future__ import annotations

import faulthandler
import json
import os
import time
from multiprocessing.connection import Connection

MEMORY_LIMIT_BYTES = 2 << 30  # 2 GB


def _apply_rlimits() -> None:
    # Best-effort: RLIMIT_AS is unreliable on macOS but harmless to attempt;
    # the parent's wall-clock SIGKILL is the hard backstop either way.
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES))
    except Exception:  # noqa: BLE001, S110 — best-effort by design, the SIGKILL is the backstop
        pass


def _registry_namespace() -> dict[str, object]:
    """Names the deterministic registry may build with, injected into the exec
    namespace instead of being importable.

    G0's allowlist stays {build123d, math} on purpose: these are standards-exact
    part classes the SERVER codegens, and a generator reaching for them would be
    inventing calls it has no cheat sheet for — the exact failure the registry
    exists to avoid. Injection lets registry code use them while an `import
    bd_warehouse` in generated code is still rejected at G0.

    bd_warehouse costs ~0.03s to import on top of build123d, and sys.modules
    caches it after the first job.
    """
    try:
        from bd_warehouse.gear import SpurGear
        from bd_warehouse.thread import IsoThread
    except Exception:  # noqa: BLE001 — absent dependency must not break plain parts
        return {}
    return {"SpurGear": SpurGear, "IsoThread": IsoThread}


def _namespace(job: dict) -> dict[str, object]:
    """Exec namespace for every part in this job: the registry classes, plus
    `load_import` bound to the job's import directory (and `cut_joints`, which
    cuts joint features into what it loads) when it has one."""
    ns: dict[str, object] = _registry_namespace()
    import_dir = job.get("import_dir")
    if import_dir:
        from .meshpart import cut_joints, load_import_part

        ns["load_import"] = lambda name, scale=1.0: load_import_part(import_dir, name, scale)
        ns["cut_joints"] = cut_joints
    return ns


def _build(part: dict, ns: dict[str, object]):
    """G0 then G1: the only way a shape is ever produced here."""
    from . import gates

    return gates.g1_execute(gates.g0_scan(part["code"]), part.get("params", {}), ns, part["code"])


def _write_json(path: str, data: object) -> None:
    """Write-then-rename, like every cache file: main.py treats existence as a
    cache hit, so a worker killed mid-write would pin a truncated file to the hash."""
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def worker_main(conn: Connection, trace_path: str) -> None:
    _apply_rlimits()
    trace = open(trace_path, "w", encoding="utf8")  # noqa: SIM115 — lives as long as the worker

    # Pay the heavy OCP import once, at spawn — requests then run warm.
    import build123d  # noqa: F401

    from . import gates

    conn.send({"ready": True})

    while True:
        try:
            job = conn.recv()
        except (EOFError, OSError):
            return
        if job is None:  # graceful shutdown
            return

        started = time.monotonic()
        measurements = None
        trace.seek(0)
        trace.truncate()
        if job.get("trace_after_s"):
            faulthandler.dump_traceback_later(job["trace_after_s"], file=trace)
        try:
            gates.reset_job_cache()
            if "import_job" in job:
                from .meshpart import run_import

                conn.send(run_import(job["import_job"] | {"out_dir": job["out_dir"]}))
                continue

            if "mesh_fit" in job:
                from .meshpart import run_mesh_fit

                conn.send(run_mesh_fit(job["mesh_fit"] | {"out_dir": job["out_dir"]}))
                continue

            if "export" in job:
                from .exporters import export_parts

                spec = job["export"]
                ns = _namespace(job)
                shapes = [
                    {"shape": _build(part, ns), "name": part.get("name") or f"part-{i + 1}",
                     "matrices": part.get("matrices") or [part.get("matrix", [])]}
                    for i, part in enumerate(spec["parts"])
                ]
                os.makedirs(job["out_dir"], exist_ok=True)
                out = os.path.join(job["out_dir"], f"export.{spec['format']}")
                info = export_parts(shapes, out, spec["format"])
                _write_json(os.path.join(job["out_dir"], "export.json"), info)
                conn.send({"ok": True, "export": info, "file": out,
                           "elapsed_ms": int((time.monotonic() - started) * 1000)})
                continue

            if "vendor" in job:
                from .dfm_process import g4c_process
                from .vendor import vendor_package

                spec = job["vendor"]
                shape = _build(job, _namespace(job))
                dfm = None
                if spec.get("process"):
                    dfm, dfm_failures = g4c_process(shape, spec["process"])
                    if dfm_failures:  # the package exists only for a part that passes
                        f = dfm_failures[0]
                        raise gates.GateError(f["stage"], f["error"], f["hint"], failures=dfm_failures)
                info = vendor_package(shape, spec.get("ports") or [], spec.get("meta") or {}, job["out_dir"],
                                      spec.get("measured"), dfm)
                conn.send({"ok": True, "vendor": info, "elapsed_ms": int((time.monotonic() - started) * 1000)})
                continue

            if "clash" in job:
                ns = _namespace(job)
                # Placed copies of one node share code and params: build once.
                built: dict[str, object] = {}
                posed = []
                for part in job["clash"]:
                    spec = json.dumps([part.get("code"), part.get("params")], sort_keys=True, default=str)
                    if spec not in built:
                        built[spec] = _build(part, ns)
                    posed.append((part.get("key", "?"), built[spec], part.get("matrix", [])))
                report = gates.g5_clash(posed, job.get("allow"), job.get("contacts"), job.get("sweeps"))
                conn.send({"ok": True, "clash": report,
                           "elapsed_ms": int((time.monotonic() - started) * 1000)})
                continue

            if "silhouette" in job:
                from .silhouette import silhouette_report

                ns = _namespace(job)
                built = {}
                posed = []
                for part in job["silhouette"]:
                    spec = json.dumps([part.get("code"), part.get("params")], sort_keys=True, default=str)
                    if spec not in built:
                        built[spec] = _build(part, ns)
                    posed.append((part.get("key", "?"), built[spec], part.get("matrix", [])))
                conn.send({"ok": True, "silhouette": silhouette_report(posed, job.get("views") or []),
                           "elapsed_ms": int((time.monotonic() - started) * 1000)})
                continue

            shape = _build(job, _namespace(job))

            def phase(stage: str, port: str | None = None, phases: bool = bool(job.get("phases"))) -> None:
                """The gates' budget starts at the first of these (pool.request)."""
                if phases:
                    faulthandler.cancel_dump_traceback_later()  # the trace names node lines only
                    conn.send({"phase": stage} | ({"port": port} if port else {}))

            phase("G2")
            measurements = gates.g2_validity(shape)
            out_dir = job["out_dir"]
            # A render request wants the picture, not the gate report, and not
            # the printability rays either.
            if job.get("render_views"):
                from .render import render_sheet

                os.makedirs(out_dir, exist_ok=True)
                render_info = render_sheet(shape, os.path.join(out_dir, "sheet.png"), job["render_views"])
                conn.send({"ok": True, "render": render_info, "measurements": measurements,
                           "elapsed_ms": int((time.monotonic() - started) * 1000)})
                continue
            # advisory DfAM signal (CADClamp-derived) — never a gate
            try:
                from .printability import measure_printability

                measurements["printability"] = measure_printability(shape)
            except Exception as err:  # noqa: BLE001 — advisory, but a silent gap reads as "nothing to report"
                measurements["printability"] = {"errors": [f"{type(err).__name__}: {err}"]}
            # The mesh depends on code+params only, so it is written under the
            # contract-free key BEFORE the contract gates: the viewport asks
            # without ports and must find it, even for a part whose ports fail.
            glb_dir = job.get("glb_dir") or out_dir
            os.makedirs(glb_dir, exist_ok=True)
            # Per-worker temp name: two workers building the same code+params
            # (one gear row per module, all on the same params) share glb_dir,
            # and one renamed the other's half-written temp out from under it.
            tmp_glb = os.path.join(glb_dir, f"mesh.{os.getpid()}.tmp.glb")
            gates.export_glb(shape, tmp_glb)
            os.replace(tmp_glb, os.path.join(glb_dir, "mesh.glb"))
            _write_json(os.path.join(glb_dir, "measurements.json"), measurements)
            # Contract gates run only when declarations are supplied (verify pass).
            if (job.get("ports") or job.get("envelope") or job.get("assertions") or job.get("process")
                    or job.get("solids") is not None):
                measurements |= gates.contract_gates(shape, job.get("ports") or [], job.get("envelope") or [],
                                                     job.get("assertions") or [], solids=job.get("solids"),
                                                     process=job.get("process"), progress=phase)
                # A G4c rule that threw is recorded as unchecked, not passed, so
                # this verdict is not one to cache: the next request re-runs it.
                if not (measurements.get("process") or {}).get("unchecked"):
                    os.makedirs(out_dir, exist_ok=True)
                    _write_json(os.path.join(out_dir, "measurements.json"), measurements)
            conn.send({
                "ok": True,
                "measurements": measurements,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
            })
        except gates.GateError as err:
            reply = {"ok": False, "stage": err.stage, "error": err.error, "hint": err.hint,
                     "failures": err.failures}
            if measurements is not None:  # G0–G2 passed; only the contract failed
                reply["measurements"] = measurements
            conn.send(reply)
        except Exception as err:  # noqa: BLE001 — unexpected, still a structured reply
            failure = {"stage": "G1", "error": f"unexpected kernel error: {type(err).__name__}: {err}", "hint": ""}
            conn.send({"ok": False, **failure, "failures": [failure]})
        finally:
            faulthandler.cancel_dump_traceback_later()
