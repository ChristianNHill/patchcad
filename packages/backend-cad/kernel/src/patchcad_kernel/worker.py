"""Worker process: one warm build123d interpreter per worker. The parent
process never imports OCP — a segfault here kills this process only, and the
pool respawns it.

Protocol over the Pipe:
  parent → worker: {"code", "params", "out_dir"}
  worker → parent: {"ok": True, "measurements", "elapsed_ms"}
                 | {"ok": False, "stage", "error", "hint"}
  worker → parent at boot: {"ready": True}
"""

from __future__ import annotations

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
    except Exception:  # noqa: BLE001
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


def worker_main(conn: Connection) -> None:
    _apply_rlimits()

    # Pay the heavy OCP import once, at spawn — requests then run warm.
    from . import gates  # noqa: F401 — also pulls build123d via export path lazily
    import build123d  # noqa: F401

    conn.send({"ready": True})

    while True:
        try:
            job = conn.recv()
        except (EOFError, OSError):
            return
        if job is None:  # graceful shutdown
            return

        started = time.monotonic()
        try:
            if "import_job" in job:
                from .meshpart import run_import

                conn.send(run_import(job["import_job"] | {"out_dir": job["out_dir"]}))
                continue

            if "export" in job:
                from .exporters import export_parts

                spec = job["export"]
                extra_ns_e: dict[str, object] = _registry_namespace()
                if job.get("import_dir"):
                    from .meshpart import load_import_part

                    de = job["import_dir"]
                    extra_ns_e["load_import"] = lambda name, scale=1.0: load_import_part(de, name, scale)
                shapes = []
                for part in spec["parts"]:
                    tree_e = gates.g0_scan(part["code"])
                    shapes.append((gates.g1_execute(tree_e, part.get("params", {}), extra_ns_e), part.get("matrix", [])))
                os.makedirs(job["out_dir"], exist_ok=True)
                out = os.path.join(job["out_dir"], f"export.{spec['format']}")
                info = export_parts(shapes, out, spec["format"])
                with open(os.path.join(job["out_dir"], "export.json"), "w", encoding="utf8") as f:
                    json.dump(info, f)
                conn.send({"ok": True, "export": info, "file": out,
                           "elapsed_ms": int((time.monotonic() - started) * 1000)})
                continue

            if "clash" in job:
                extra_ns_c: dict[str, object] = _registry_namespace()
                if job.get("import_dir"):
                    from .meshpart import load_import_part

                    dc = job["import_dir"]
                    extra_ns_c["load_import"] = lambda name, scale=1.0: load_import_part(dc, name, scale)
                posed = []
                for part in job["clash"]:
                    tree_c = gates.g0_scan(part["code"])
                    shape_c = gates.g1_execute(tree_c, part.get("params", {}), extra_ns_c)
                    posed.append((part.get("key", "?"), shape_c, part.get("matrix", [])))
                conn.send({"ok": True, "clash": gates.g5_clash(posed),
                           "elapsed_ms": int((time.monotonic() - started) * 1000)})
                continue

            if "assembly" in job:
                from .render import render_assembly

                extra_ns_a: dict[str, object] = _registry_namespace()
                if job.get("import_dir"):
                    from .meshpart import load_import_part

                    d = job["import_dir"]
                    extra_ns_a["load_import"] = lambda name, scale=1.0: load_import_part(d, name, scale)
                built = []
                for part in job["assembly"]:
                    tree_p = gates.g0_scan(part["code"])
                    shape_p = gates.g1_execute(tree_p, part.get("params", {}), extra_ns_a)
                    built.append((shape_p, part.get("matrix", [])))
                os.makedirs(job["out_dir"], exist_ok=True)
                info = render_assembly(built, os.path.join(job["out_dir"], "sheet.png"), job.get("render_views", 4))
                conn.send({"ok": True, "render": info,
                           "elapsed_ms": int((time.monotonic() - started) * 1000)})
                continue

            extra_ns: dict[str, object] = _registry_namespace()
            if job.get("import_dir"):
                from .meshpart import load_import_part

                import_dir = job["import_dir"]
                extra_ns["load_import"] = lambda name, scale=1.0: load_import_part(import_dir, name, scale)

            tree = gates.g0_scan(job["code"])
            shape = gates.g1_execute(tree, job["params"], extra_ns)
            measurements = gates.g2_validity(shape)
            # Contract gates run only when declarations are supplied (verify pass).
            if job.get("ports"):
                measurements["ports"] = gates.g3_ports(shape, job["ports"])
            if job.get("envelope"):
                measurements["envelope"] = gates.g4_envelope(shape, job["envelope"])
            # advisory DfAM signal (CADClamp-derived) — never a gate
            try:
                from .printability import measure_printability

                measurements["printability"] = measure_printability(shape)
            except Exception:  # noqa: BLE001
                pass
            out_dir = job["out_dir"]
            os.makedirs(out_dir, exist_ok=True)
            # A render request wants the picture, not the gate report.
            if job.get("render_views"):
                from .render import render_sheet

                render_info = render_sheet(shape, os.path.join(out_dir, "sheet.png"), job["render_views"])
                conn.send({"ok": True, "render": render_info, "measurements": measurements,
                           "elapsed_ms": int((time.monotonic() - started) * 1000)})
                continue
            gates.export_glb(shape, os.path.join(out_dir, "mesh.glb"))
            with open(os.path.join(out_dir, "measurements.json"), "w", encoding="utf8") as f:
                json.dump(measurements, f, indent=1)
            conn.send({
                "ok": True,
                "measurements": measurements,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
            })
        except gates.GateError as err:
            conn.send({"ok": False, "stage": err.stage, "error": err.error, "hint": err.hint})
        except Exception as err:  # noqa: BLE001 — unexpected, still a structured reply
            conn.send({
                "ok": False,
                "stage": "G1",
                "error": f"unexpected kernel error: {type(err).__name__}: {err}",
                "hint": "",
            })
