"""CAD-M1 acceptance suite, run against a live kernel:
    uv run python smoke.py
Covers the design doc's "done when" list: example node → mesh <3s, cache hit,
G0 import rejection, G2 catches bad geometry, `while True` killed at the
timeout, a hard native crash kills one worker while the service stays up.
"""

from __future__ import annotations

import math
import os
import pathlib
import subprocess
import sys
import tempfile
import time

import httpx

BASE = f"http://127.0.0.1:{os.environ.get('PATCHCAD_KERNEL_PORT', '8621')}"

PLATE = """
from build123d import *

def build(p):
    plate = Box(p.width, p.depth, p.thickness)
    hole = Cylinder(p.hole_diameter / 2, p.thickness)
    return plate - hole
"""

failures: list[str] = []


# Imported, not mirrored. A test carrying its own copy of the constant under
# test drifts silently, and the reason for the copy ("importing gates drags OCP
# into the test process") was false: gates imports ast, math and typing only,
# and build123d is lazy inside its __main__ block. Measured at 34ms, no OCP.
from patchcad_kernel.gates import CLASH_MIN_DEPTH_MM as CLASH_DEPTH_FLOOR


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{f' — {detail}' if detail else ''}")
    if not ok:
        failures.append(name)


def structural() -> None:
    """Ruff runs here so it runs at all. F811 is a name bound twice in one scope
    (a duplicate def silently shadows the copy the fix went into) and F821 is a
    name used but never bound (the signature of a deletion that took a
    neighbour with it) — the two defects a hand-rolled AST walker used to check.
    It is a pinned dev dependency, so this needs no network and no kernel: it
    goes first and costs milliseconds."""
    print("module structure")
    proc = subprocess.run(["uv", "run", "ruff", "check", "--select", "F811,F821", "src/"],
                          cwd=pathlib.Path(__file__).parent,
                          capture_output=True, text=True, check=False)
    ok = proc.returncode == 0
    # stdout is EMPTY exactly when ruff cannot run at all (not installed, bad
    # rule code, unreadable tree): that goes to stderr. Indexing [-1] blind
    # crashed the guard-for-the-guard with a trace naming this file.
    # `or ["no output"]` would be unreachable: [""] is truthy, so the middle arm
    # always yields one element. The default belongs inside it.
    detail = (proc.stdout.strip().splitlines()
              or [proc.stderr.strip() or "no output"])[-1]
    check("kernel source has no duplicate or unbound names", ok, "" if ok else detail)


PEG = """
from build123d import *

def build(p):
    return Box(30, 30, 6) + Pos(0, 0, 9) * Cylinder(p.peg_d / 2, 12)
"""


BRACKET = """
from build123d import *

def build(p):
    return Box(30, 20, 4) + Pos(-13, 0, 10) * Box(4, 20, 20)
"""

SCREW = """
from build123d import *

def build(p):
    return Cylinder(3.5, 4) + Pos(0, 0, -8) * Cylinder(2, 12)
"""


def _at(x: float, y: float, z: float) -> list[float]:
    """Column-major translation, the assembly solver's layout."""
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]


def exports(client: httpx.Client) -> None:
    """A cad-clamp-like assembly leaves as a STEP that re-imports with one
    named solid per placed copy, and as a 3MF with one object per part."""
    import tempfile

    import trimesh
    from build123d import import_step

    print("exports")
    plate = {"width": 50, "depth": 50, "thickness": 4, "hole_diameter": 4.5, "nonce": time.time()}
    parts = [
        {"name": "base-plate", "code": PLATE, "params": plate, "matrix": []},
        {"name": "bracket", "code": BRACKET, "params": {}, "matrix": _at(0, 0, 4)},
        # one node, two placed copies
        {"name": "screw", "code": SCREW, "params": {}, "matrix": _at(10, 0, 8),
         "matrices": [_at(10, 0, 8), _at(-10, 0, 8)]},
    ]
    tmp = pathlib.Path(tempfile.mkdtemp())

    def fetch(fmt: str) -> tuple[dict, pathlib.Path | None]:
        r = client.post("/export", json={"parts": parts, "format": fmt}, timeout=180)
        body = r.json()
        if not body.get("ok"):
            return body, None
        out = tmp / f"a.{fmt}"
        out.write_bytes(client.get(body["file"]).content)
        return body, out

    body, step = fetch("step")
    if step is None:
        check("assembly STEP exports", False, str(body)[:200])
    else:
        shape = import_step(str(step))
        names = sorted(c.label for c in shape.children)
        check("assembly STEP re-imports with a solid per placed copy",
              len(shape.solids()) == 4, f"{len(shape.solids())} solids")
        check("assembly STEP keeps part names", names == ["base-plate", "bracket", "screw", "screw"], str(names))
        zs = sorted(round(c.location.position.Z, 3) for c in shape.children)
        check("assembly STEP children carry their world pose", zs == [0, 4, 8, 8], str(zs))

    body, mf = fetch("3mf")
    if mf is None:
        check("assembly 3MF exports", False, str(body)[:200])
    else:
        scene = trimesh.load(str(mf))
        check("3MF writes one object per part", len(scene.geometry) == 3, str(list(scene.geometry)))
        check("3MF places every copy", len(scene.graph.nodes_geometry) == 4,
              f"{len(scene.graph.nodes_geometry)} build items")

    # An imported mesh has no B-rep: STEP leaves it out and SAYS so.
    from build123d import Box

    from src.patchcad_kernel.exporters import export_parts
    from src.patchcad_kernel.meshpart import MeshPart

    info = export_parts([{"shape": Box(5, 5, 5), "name": "printed", "matrices": [[]]},
                         {"shape": MeshPart(trimesh.creation.box((10, 10, 10))), "name": "scan", "matrices": [[]]}],
                        str(tmp / "mixed.step"), "step")
    check("STEP names the imported mesh it left out", info.get("skipped") == ["scan"] and info["solids"] == 1, str(info))

    body, stl = fetch("stl")
    check("STL stays one combined, watertight mesh",
          stl is not None and body["export"].get("watertight") and len(trimesh.load(str(stl)).split()) >= 4,
          str(body.get("export") or body)[:160])


def main() -> None:
    structural()
    client = httpx.Client(base_url=BASE, timeout=60)

    health = client.get("/health").json()
    check("health", health["ok"], f"workers={health['workers']}")

    # 1. Example node cooks to a mesh in <3s (warm worker). The nonce keeps
    # repeat runs cache-cold for the "re-executes" checks while still letting
    # the within-run cache-hit check pass.
    #
    # WARM ONE WORKER FIRST, because this check said "warm worker" and measured a
    # cold one. export_gltf is imported lazily, so the first job on a freshly
    # spawned worker pays that cost: measured 3.02s against a 3.0s budget, then
    # 0.16s and 0.07s for everything after. So the check failed whenever the pool
    # was new, which a GATES_VERSION bump guarantees, and it was reporting import
    # latency as geometry latency. The budget is about the geometry.
    # The DIMENSIONS are what keep this independent of check 2, not the nonce:
    # both nonces are int(time.time()) on back-to-back calls, so they are usually
    # the same second and contribute nothing. Check 2 re-posts the timed body to
    # assert a cache hit, so making this warm-up use the same plate to "simplify"
    # would let that check pass for the wrong reason.
    warm = {"width": 10, "depth": 10, "thickness": 2, "hole_diameter": 2, "nonce": int(time.time())}
    cold_started = time.monotonic()
    client.post("/execute", json={"code": PLATE, "params": warm})
    cold = time.monotonic() - cold_started

    params = {"width": 60, "depth": 40, "thickness": 5, "hole_diameter": 8, "nonce": int(time.time())}
    started = time.monotonic()
    r = client.post("/execute", json={"code": PLATE, "params": params}).json()
    elapsed = time.monotonic() - started
    meas = r.get("measurements", {})
    check("plate executes", r["ok"], f"{elapsed*1000:.0f}ms volume={meas.get('volume_mm3', 0):.0f}mm³")
    check("mesh under 3s", elapsed < 3.0, f"{elapsed:.2f}s (first job on a cold worker was {cold:.2f}s)")
    expected = 60 * 40 * 5 - 3.14159 * 4 * 4 * 5
    check("volume plausible", abs(meas.get("volume_mm3", 0) - expected) < expected * 0.01)
    glb = client.get(r["glb"])
    check("glb served", glb.status_code == 200 and len(glb.content) > 1000, f"{len(glb.content)} bytes")

    # 2. Same job again → content-addressed cache hit.
    started = time.monotonic()
    r2 = client.post("/execute", json={"code": PLATE, "params": params}).json()
    check("cache hit", r2["ok"] and r2.get("cached") is True, f"{(time.monotonic()-started)*1000:.0f}ms")

    # 3. New param value → re-execute (the T0 slider path).
    r3 = client.post("/execute", json={"code": PLATE, "params": {**params, "hole_diameter": 12}}).json()
    check("param change re-executes", r3["ok"] and r3.get("cached") is False)
    check("param change changes volume", r3["measurements"]["volume_mm3"] < meas["volume_mm3"])

    # 4. G0: disallowed import rejected without executing.
    r4 = client.post("/execute", json={"code": "import os\n" + PLATE, "params": params})
    body4 = r4.json()
    check("G0 rejects import os", r4.status_code == 422 and body4.get("stage") == "G0", body4.get("error", ""))

    # 4b. Registry classes are INJECTED into the exec namespace, not importable.
    # Both halves matter: the server's codegen must be able to build a gear,
    # and generated code must still be refused the import — otherwise a model
    # starts inventing calls to an API it has no cheat sheet for.
    gear = (
        "from build123d import *\n\n"
        "def build(p):\n"
        "    return involute_gear(1, 12, 20, 4)\n"
    )
    r4b = client.post("/execute", json={"code": gear, "params": {}}).json()
    check(
        "registry gear builds from the injected namespace",
        r4b.get("ok") is True,
        f"Ø{r4b['measurements']['bbox']['size'][0]:.1f}" if r4b.get("ok") else r4b.get("error", ""),
    )
    r4c = client.post(
        "/execute",
        json={"code": "from patchcad_kernel.gear import involute_gear\n" + gear, "params": {}},
    )
    body4c = r4c.json()
    check(
        "G0 still rejects importing the registry's gear",
        r4c.status_code == 422 and body4c.get("stage") == "G0",
        body4c.get("error", ""),
    )

    # 4d. A flat face with no declared size must SAY so. It used to default to
    # 4.0 mm silently, grading a part against a number no contract stated.
    face_port = {
        "key": "seat", "type": "FLAT_FACE",
        "pose": {"origin": [0, 0, 1.5], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]},
        "params": {"seatDiameter": 5.3},
    }
    r4d = client.post("/execute", json={"code": PLATE, "params": params, "ports": [face_port]})
    body4d = r4d.json()
    check(
        "G3 names a missing face size instead of guessing 4mm",
        r4d.status_code == 422 and body4d.get("stage") == "G3" and "no numeric face size" in body4d.get("error", ""),
        body4d.get("error", ""),
    )

    # 4e. Contact sheet: a real PNG, from a real part, through the endpoint.
    r4e = client.post("/render", json={"code": PLATE, "params": params, "views": 6})
    body4e = r4e.json()
    check(
        "render endpoint returns a sheet",
        r4e.status_code == 200 and body4e.get("ok") and body4e.get("sheet"),
        f"{body4e.get('render', {}).get('triangles', '?')} tris in {body4e.get('elapsed_ms', '?')}ms",
    )
    if body4e.get("sheet"):
        png = client.get(body4e["sheet"])
        check(
            "sheet is a served PNG",
            png.status_code == 200 and png.content[:8] == b"\x89PNG\r\n\x1a\n",
            f"{len(png.content)} bytes",
        )
        # 3 columns x 2 rows of 220px tiles, unchanged by the triad, scale bar
        # and edge lines; and the light ground the judge's prompt describes.
        import io

        from PIL import Image
        img = Image.open(io.BytesIO(png.content)).convert("RGB")
        check(
            "sheet is 660x440 on a light ground",
            img.size == (660, 440) and body4e["render"]["size"] == [660, 440] and min(img.getpixel((200, 40))) > 200,
            f"{img.size}, ground {img.getpixel((200, 40))}",
        )
        check("second render is cached", client.post(
            "/render", json={"code": PLATE, "params": params, "views": 6}
        ).json().get("cached") is True)

    # 5. G2: zero-volume result caught with a hint.
    # Spelled out rather than patched out of PLATE: a fixture derived from
    # another fixture's source stops testing anything the moment that source is
    # edited, silently. One of the channel checks below was found doing exactly
    # that — its replacement had quietly become a no-op.
    gone = """from build123d import *

def build(p):
    plate = Box(p.width, p.depth, p.thickness)
    return plate - Box(p.width * 2, p.depth * 2, p.thickness * 2)
"""
    r5 = client.post("/execute", json={"code": gone, "params": params})
    body5 = r5.json()
    check("G2 catches empty boolean", r5.status_code == 422 and body5.get("stage") == "G2", body5.get("error", ""))

    # 6. while True → killed at the timeout, service stays healthy.
    loop = "def build(p):\n    while True:\n        pass\n"
    started = time.monotonic()
    r6 = client.post("/execute", json={"code": loop, "params": {}})
    elapsed = time.monotonic() - started
    body6 = r6.json()
    check("infinite loop killed", r6.status_code == 422 and body6.get("stage") == "TIMEOUT", f"{elapsed:.1f}s")
    # LOWER BOUND ONLY. This asserted `18 < elapsed < 30` and sat 0.6s from that
    # ceiling: measured 29.4, 29.4, 28.0, 29.1 against a 20s SIGKILL, so any
    # load tipped it and smoke exited 1 about half the time with nothing wrong.
    # A flake in the suite that gates the kernel teaches you to re-run until
    # green, which is how a real red gets ignored. The check above already
    # asserts it was killed rather than left hanging, so the content here is
    # "not killed early" and that is the lower bound alone. The 9s of overhead
    # over the 20s timeout is worth its own look, not a failing assertion.
    check("timeout not tripped early", elapsed > 18, f"{elapsed:.1f}s (20s SIGKILL + pool overhead)")
    # faulthandler dumps the stack a second before the kill, so the report can
    # say where the code was stuck instead of only that it was.
    check("timeout names the line still running",
          "line 2: while True:" in body6.get("error", "") or "line 3: pass" in body6.get("error", ""),
          body6.get("error", "").splitlines()[0] if body6.get("error") else "")

    # 7. Hard native crash → one worker dies, service survives, next job fine.
    crash = "import build123d\ndef build(p):\n    import ctypes\n    ctypes.string_at(0)\n"
    # ctypes isn't allowlisted — craft a crash without imports: recursion depth
    # segfault via a C-level recursion is unreliable; instead kill via os._exit
    # is blocked too. Use build123d itself? Simplest reliable native death:
    # exceed the pipe with a broken frame — fall back to ctypes through an
    # allowlist bypass is impossible, so test the crash path with sys.exit-like
    # abort available in math? Not possible — so test via a worker-level trick:
    crash = "def build(p):\n    exec(\"import ctypes; ctypes.string_at(0)\", {})\n"
    respawns = client.get("/health").json()["workers"]["respawns"]
    r7 = client.post("/execute", json={"code": crash, "params": {}})
    body7 = r7.json()
    health7 = client.get("/health").json()
    # KERNEL_CRASH and a respawn, both: accepting "G1" too let a crash that
    # never happened (the exec raising in Python) pass as one contained.
    check("native crash contained", r7.status_code == 422 and body7.get("stage") == "KERNEL_CRASH"
          and health7["workers"]["respawns"] > respawns,
          f"stage={body7.get('stage')} respawns {respawns} -> {health7['workers']['respawns']}")
    check("service alive after crash", health7["ok"], f"workers={health7['workers']}")
    r8 = client.post("/execute", json={"code": PLATE, "params": {**params, "width": 70}}).json()
    check("pool serves after crash", r8["ok"])

    # ---- CAD-M2: contract gates -------------------------------------------
    # Plate is a centered Box(60,40,5): top face z=+2.5, through-hole at center.
    hole_port = {
        "key": "mount_hole", "type": "CLEARANCE_HOLE",
        "pose": {"origin": [0, 0, 2.5], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]},
        "params": {"diameter": 8},
    }
    face_port = {
        "key": "base_face", "type": "FLAT_FACE",
        "pose": {"origin": [20, 10, 2.5], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]},
        "params": {"size": 6},
    }
    envelope = [{"kind": "box", "center": [0, 0, 0], "size": [60, 40, 5]}]

    # 8. Correct geometry passes G3 + G4 with a per-port report.
    r9 = client.post("/execute", json={
        "code": PLATE, "params": params, "ports": [hole_port, face_port], "envelope": envelope,
    }).json()
    port_report = r9.get("measurements", {}).get("ports", [])
    check("G3+G4 pass on correct part", r9["ok"], f"ports={[p.get('measured_diameter') or p.get('probed_size') for p in port_report]}")
    measured = next((p.get("measured_diameter") for p in port_report if p["key"] == "mount_hole"), None)
    check("G3 measures the bore", measured is not None and abs(measured - 8) < 0.25, f"measured Ø{measured}")

    # 9. Deliberately wrong bore: code drills Ø12 where the contract pins Ø8.
    r10 = client.post("/execute", json={
        "code": PLATE, "params": {**params, "hole_diameter": 12},
        "ports": [hole_port], "envelope": envelope,
    })
    body10 = r10.json()
    check("G3 catches wrong bore", r10.status_code == 422 and body10.get("stage") == "G3", body10.get("error", ""))
    check("G3 hint names both diameters",
          "8" in body10.get("error", "") and "12" in body10.get("error", ""), body10.get("hint", ""))

    # 10. Port pose that misses the geometry entirely.
    lost = {**hole_port, "pose": {"origin": [25, 15, 2.5], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]}}
    r11 = client.post("/execute", json={"code": PLATE, "params": params, "ports": [lost]})
    check("G3 catches missing hole", r11.status_code == 422 and "no hole" in r11.json().get("error", ""))

    # 11. G4: an envelope smaller than the part is a violation with location.
    tight = [{"kind": "box", "center": [0, 0, 0], "size": [40, 40, 5]}]
    r12 = client.post("/execute", json={"code": PLATE, "params": params, "envelope": tight})
    body12 = r12.json()
    check("G4 catches envelope escape", r12.status_code == 422 and body12.get("stage") == "G4", body12.get("error", "")[:80])

    # 11b. G1 names the line. "build(p) raised IndexError" sent the model to
    # guess which subscript; the line and its neighbours say.
    indexed = "from build123d import *\n\ndef build(p):\n    plate = Box(10, 10, 2)\n    edges = []\n    return plate - edges[3]\n"
    body11b = client.post("/execute", json={"code": indexed, "params": {}}).json()
    check("G1 reports the failing line", body11b.get("stage") == "G1"
          and "line 6: return plate - edges[3]" in body11b.get("error", ""),
          body11b.get("error", "")[:120])
    check("G1 failure carries the line structurally",
          (body11b.get("failures") or [{}])[0].get("line") == 6, str(body11b.get("failures")))

    # 11c. Every contract failure in ONE 422. G3 stopped at the first bad port
    # and G4 never ran after it, so each repair round uncovered one more.
    wrong_d = {**hole_port, "key": "wrong_d", "params": {"diameter": 5}}
    fresh = {**params, "width": 61.5 + time.time() % 1}  # never built before, so 11d proves the sharing
    r11c = client.post("/execute", json={
        "code": PLATE, "params": fresh, "ports": [wrong_d, lost], "envelope": tight,
    })
    body11c = r11c.json()
    got = [(f.get("stage"), f.get("port")) for f in body11c.get("failures", [])]
    check("one 422 lists both bad ports and the envelope escape",
          r11c.status_code == 422 and body11c.get("stage") == "G3"
          and got == [("G3", "wrong_d"), ("G3", "mount_hole"), ("G4", None)], str(got))
    first = (body11c.get("failures") or [{}])[0]
    check("a port failure carries expected vs measured",
          first.get("expected") == 5 and abs((first.get("measured") or 0) - 8) < 0.25, str(first))
    # The mesh is keyed without the contract, so the viewport's port-less ask
    # is a cache hit even though the contract failed.
    r11d = client.post("/execute", json={"code": PLATE, "params": fresh}).json()
    check("a contract failure still leaves the mesh for the viewport", r11d.get("cached") is True, str(r11d.get("glb")))

    # 12. SCREW_BOSS probe: boss with pilot hole, checked both good and bad.
    boss_code = """
from build123d import *

def build(p):
    base = Box(30, 30, 3)
    boss = Pos(0, 0, 1.5 + p.boss_h / 2) * Cylinder(p.boss_od / 2, p.boss_h)
    pilot = Pos(0, 0, 1.5 + p.boss_h / 2) * Cylinder(p.pilot / 2, p.boss_h)
    return base + boss - pilot
"""
    boss_port = {
        "key": "insert_boss", "type": "SCREW_BOSS",
        "pose": {"origin": [0, 0, 9.5], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]},
        "params": {"outer_diameter": 8, "pilot_diameter": 4},
    }
    r13 = client.post("/execute", json={
        "code": boss_code, "params": {"boss_od": 8, "boss_h": 8, "pilot": 4}, "ports": [boss_port],
    }).json()
    check("G3 boss probe passes", r13["ok"], str(r13.get("measurements", {}).get("ports")))
    r14 = client.post("/execute", json={
        "code": boss_code, "params": {"boss_od": 8, "boss_h": 8, "pilot": 5.5}, "ports": [boss_port],
    })
    body14 = r14.json()
    check("G3 catches wrong pilot", r14.status_code == 422 and "pilot" in body14.get("error", ""), body14.get("error", ""))

    # 15. FLAT_FACE on a ROUND face. The probe used to sample a square grid whose
    # corners sat at size*0.707 — off any disc or hexagon of that width — so a
    # truthful `size` could not pass and only an understated one could. Then the
    # first fix used a FRACTIONAL inset, which accepted an 11% overstatement and
    # got worse in absolute terms as parts grew. Both directions are pinned here:
    # truth passes, and an overstatement beyond the absolute standoff fails, at
    # two sizes an order of magnitude apart so a fractional regression shows up.
    round_code = (
        "from build123d import *\n"
        "def build(p):\n"
        "    with BuildPart() as bp:\n"
        "        Cylinder(radius=p['r'], height=10)\n"
        "    return bp.part\n"
    )

    def face(size, r):
        port = {
            "key": "seat", "type": "FLAT_FACE",
            "pose": {"origin": [0, 0, 5], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]},
            "params": {"size": size},
        }
        return client.post("/execute", json={"code": round_code, "params": {"r": r}, "ports": [port]})

    check("G3 accepts a truthful round face", face(50.0, 25).status_code == 200,
          "a Ø50 top declared as size 50 must pass")
    check("G3 rejects an 11% overstated face", face(55.5, 25).status_code == 422,
          "a Ø50 top declared as size 55.5 must fail")
    # The same relative overstatement on a 4x larger part. A fractional inset
    # passes this; an absolute one does not.
    check("G3 face tolerance does not scale with the part", face(202.4, 100).status_code == 422,
          "a Ø200 top declared as size 202.4 (+1.2%) must fail")
    check("G3 still accepts the truth on a large face", face(200.0, 100).status_code == 200,
          "a Ø200 top declared as size 200 must pass")

    # Two rings, not one: a single sampling radius is satisfied by spokes.
    spoke_code = (
        "from build123d import *\n"
        "def build(p):\n"
        "    with BuildPart() as bp:\n"
        "        Cylinder(radius=4, height=10)\n"
        "        with PolarLocations(22, 8):\n"
        "            Box(14, 5, 10)\n"
        "    return bp.part\n"
    )
    spoke_port = {
        "key": "seat", "type": "FLAT_FACE",
        "pose": {"origin": [0, 0, 5], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]},
        "params": {"size": 50.0},
    }
    r15 = client.post("/execute", json={"code": spoke_code, "params": {}, "ports": [spoke_port]})
    check("G3 rejects a spoked face that only spans one radius", r15.status_code == 422,
          "8 spokes reaching r=29 must not satisfy a solid 50mm seat")

    # 16. GROOVE / SLOT. These had no probe at all: g3_ports recorded them
    # "skipped" and returned ok, so a node whose ports were all channels passed
    # verify as a featureless block. A real shipped project did exactly that.
    groove_code = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    with BuildPart() as bp:\n"
        "        Box(60, 40, 10)\n"
        "        with Locations((0, 0, 5 - p['d'] / 2)):\n"
        "            Box(70, p['w'], p['d'], mode=Mode.SUBTRACT)\n"
        "    return bp.part\n"
    )
    top = {"origin": [0, 0, 5], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]}

    def channel(ptype, params, w=3.0, code=groove_code, pose=None, d=4.0):
        # THE NONCE IS LOAD-BEARING. /execute serves cached 200s before a worker
        # runs, so an assertion on a 200 can be satisfied by an entry written
        # under an earlier gate version — the check goes green with the probe
        # deleted. Failures are never cached, so the 422 assertions below are
        # self-verifying without it; the passing ones are not. Two checks in this
        # file were already found decorative for exactly this reason.
        port = {"key": "seat", "type": ptype, "pose": pose or top, "params": params}
        params_in = {"w": w, "d": d, "nonce": int(time.time())}
        return client.post("/execute", json={"code": code, "params": params_in, "ports": [port]})

    r16 = channel("GROOVE", {"width": 3.0})
    check("G3 measures a groove width", r16.status_code == 200,
          str(r16.json().get("measurements", {}).get("ports")))
    r16b = channel("GROOVE", {"width": 5.0})
    body16b = r16b.json()
    check("G3 catches a wrong groove width",
          r16b.status_code == 422 and "measured 3.00" in body16b.get("error", ""),
          body16b.get("error", ""))
    # THE CASE THAT USED TO PASS: the channel was never cut.
    # Spelled out, not derived from groove_code by string replacement: that
    # replacement silently stopped matching when groove_code was edited, so the
    # groove was still cut and this check asserted 422 against a part that
    # legitimately passed. A fixture built by patching another fixture's source
    # is a fixture that can quietly stop testing anything.
    solid = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = (p['nonce'], p['w'], p['d'])\n"
        "    with BuildPart() as bp:\n"
        "        Box(60, 40, 10)\n"
        "    return bp.part\n"
    )
    r16c = channel("GROOVE", {"width": 3.0}, code=solid)
    check("G3 catches a channel that was never cut",
          r16c.status_code == 422 and "no channel at the declared origin" in r16c.json().get("error", ""),
          r16c.json().get("error", ""))
    # A missing width must be a repairable G3, not a KeyError surfacing as G1.
    r16d = channel("SLOT", {})
    body16d = r16d.json()
    check("G3 names a missing channel width instead of raising",
          r16d.status_code == 422 and body16d.get("stage") == "G3"
          and "no numeric width" in body16d.get("error", ""),
          f'{body16d.get("stage")}: {body16d.get("error", "")}')
    # A channel measured across instead of along has no wall to find.
    across = {"origin": [0, 0, 5], "zAxis": [0, 0, 1], "xAxis": [0, 1, 0]}
    r16e = channel("GROOVE", {"width": 3.0}, pose=across)
    check("G3 catches a channel probed across its length",
          r16e.status_code == 422 and "no wall" in r16e.json().get("error", ""),
          r16e.json().get("error", ""))
    # Depth is optional: demanding a floor on a through-cut would fail correct
    # geometry, which is the mistake the FLAT_FACE grid made.
    through = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = (p['nonce'], p['d'])\n"
        "    with BuildPart() as bp:\n"
        "        Box(60, 40, 10)\n"
        "        Box(70, p['w'], 20, mode=Mode.SUBTRACT)\n"
        "    return bp.part\n"
    )
    r16f = channel("SLOT", {"width": 3.0}, code=through)
    check("G3 accepts a through-cut slot with no declared depth", r16f.status_code == 200,
          r16f.json().get("error", ""))
    r16g = channel("SLOT", {"width": 3.0, "depth": 4.0}, code=through)
    check("G3 catches a declared depth on a through-cut",
          r16g.status_code == 422 and "cuts straight through" in r16g.json().get("error", ""),
          r16g.json().get("error", ""))

    # Depth had only failure coverage. These two are the positive cases, and the
    # second is the one that catches `measured_depth` going back to echoing the
    # declared number instead of measuring the floor.
    r16h = channel("GROOVE", {"width": 3.0, "depth": 4.0}, d=4.0)
    check("G3 accepts a truthful channel depth", r16h.status_code == 200,
          str(r16h.json().get("measurements", {}).get("ports")))
    ports16h = r16h.json().get("measurements", {}).get("ports") or [{}]
    check("G3 reports the depth it measured, not the one declared",
          abs((ports16h[0].get("measured_depth") or 0) - 4.0) < 0.05,
          str(ports16h[0]))
    r16i = channel("GROOVE", {"width": 3.0, "depth": 4.0}, d=4.5)
    check("G3 catches a channel cut deeper than declared",
          r16i.status_code == 422 and "deeper than declared" in r16i.json().get("error", ""),
          r16i.json().get("error", ""))
    # A chamfered mouth is print-normal and must not read as a wider channel;
    # the same measurement must still reject a channel that is actually narrow.
    chamfered = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    with BuildPart() as bp:\n"
        "        Box(60, 40, 10)\n"
        "        with Locations((0, 0, 5 - p['d'] / 2)):\n"
        "            Box(70, p['w'], p['d'], mode=Mode.SUBTRACT)\n"
        "        chamfer(bp.edges().group_by(Axis.Z)[-1], length=1.0)\n"
        "    return bp.part\n"
    )
    r16j = channel("GROOVE", {"width": 3.0}, w=3.0, code=chamfered)
    check("G3 accepts a 3mm channel with a 1mm chamfered mouth", r16j.status_code == 200,
          r16j.json().get("error", ""))
    r16k = channel("GROOVE", {"width": 3.0}, w=2.2, code=chamfered)
    check("G3 still rejects a narrow channel hidden by a chamfer",
          r16k.status_code == 422 and "narrowest measured 2.2" in r16k.json().get("error", ""),
          r16k.json().get("error", ""))

    # 17. G5 clash. The failure that only exists BETWEEN parts: every gate
    # before this grades one part against its own contract, so a collar could
    # pass every probe and every envelope while sitting inside its base.
    cube = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    with BuildPart() as bp:\n"
        "        Box(20, 20, 10)\n"
        "    return bp.part\n"
    )

    def at(z):
        return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1]

    def clash(z):
        n = int(time.time())
        return client.post("/clash", json={"parts": [
            {"key": "base", "code": cube, "params": {"nonce": n}, "matrix": at(0)},
            {"key": "lid", "code": cube, "params": {"nonce": n}, "matrix": at(z)},
        ]}).json()

    # MATED PARTS TOUCH BY DESIGN. If contact reported, every correct assembly
    # would fail — the one outcome that makes this gate worse than not having it.
    #
    # CURVED contact, not planar: two flat faces intersect to exactly 0.0 with
    # zero faces, so a planar check passes at ANY threshold — including 1e-12 —
    # and pins nothing. A nominal peg in a nominal bore is where tessellation
    # noise actually lives, and its mean depth is what the threshold has to sit
    # above. This check is the reason CLASH_MIN_DEPTH_MM has a value.
    bore = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    with BuildPart() as bp:\n"
        "        Cylinder(30, 20)\n"
        "        Cylinder(10, 22, mode=Mode.SUBTRACT)\n"
        "    return bp.part\n"
    )
    peg = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    with BuildPart() as bp:\n"
        "        Cylinder(p['r'], 20)\n"
        "    return bp.part\n"
    )

    def fit(peg_r, clock_deg=7.0):
        n = int(time.time())
        c, sn = math.cos(math.radians(clock_deg)), math.sin(math.radians(clock_deg))
        rot = [c, sn, 0, 0, -sn, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        return client.post("/clash", json={"parts": [
            {"key": "bore", "code": bore, "params": {"nonce": n}, "matrix": at(0)},
            {"key": "peg", "code": peg, "params": {"nonce": n, "r": peg_r}, "matrix": rot},
        ]}).json()

    r17 = fit(10.0)
    check("G5 does not report a nominal peg in a nominal Ø60 bore",
          r17["ok"] and r17["clash"]["clashes"] == [],
          str(r17.get("clash")))
    r17x = fit(10.3)
    clx = (r17x.get("clash") or {}).get("clashes") or [{}]
    check("G5 catches 0.3mm of real interference on the same curved fit",
          r17x["ok"] and len(clx) == 1 and clx[0].get("depth_mm", 0) > CLASH_DEPTH_FLOOR,
          str(clx[0]))

    # A ROTATED part, because every other matrix here is an axis-aligned
    # translation with identity rotation — under which a transpose bug in
    # _posed_mesh is undetectable. That is the same blind spot the assembly
    # solver's tests had.
    n17 = int(time.time())
    c45, s45 = math.cos(math.radians(45)), math.sin(math.radians(45))
    rot_z = [c45, s45, 0, 0, -s45, c45, 0, 0, 0, 0, 1, 0, 0, 0, 6, 1]
    r17b = client.post("/clash", json={"parts": [
        {"key": "base", "code": cube, "params": {"nonce": n17}, "matrix": at(0)},
        {"key": "lid", "code": cube, "params": {"nonce": n17}, "matrix": rot_z},
    ]}).json()
    cl = (r17b.get("clash") or {}).get("clashes") or [{}]
    check("G5 catches interpenetration of a ROTATED part, with a depth",
          r17b["ok"] and len(cl) == 1 and cl[0].get("depth_mm", 0) > 1.0
          and cl[0].get("a") == "base" and cl[0].get("b") == "lid",
          str(cl[0]))
    r17c = clash(60.0)
    check("G5 skips the boolean for parts whose boxes are disjoint",
          r17c["ok"] and r17c["clash"]["pairs_tested"] == 0,
          str(r17c.get("clash")))
    r17d = client.post("/clash", json={"parts": [
        {"key": "only", "code": cube, "params": {"nonce": int(time.time())}, "matrix": at(0)}]}).json()
    # This one pins the ENDPOINT guard, not the gate: main.py returns before
    # hashing or touching a worker, so g5_clash never runs. Labelled honestly —
    # it would pass with the gate deleted.
    check("POST /clash short-circuits below two parts (endpoint guard, not the gate)",
          r17d["ok"] and r17d["clash"]["pairs_tested"] == 0 and r17d.get("hash") is None,
          str(r17d.get("clash")))

    # 17b. G5 is MATE-AWARE. The solver makes two ports coincide; only this
    # checks that each port sits on its part, so a lid whose port is posed 3mm
    # off its face floats 3mm in the air while every other gate passes.
    def mated(lid_z, extra=()):
        n = int(time.time())
        return client.post("/clash", json={
            "parts": [
                {"key": "base", "code": cube, "params": {"nonce": n}, "matrix": at(0)},
                {"key": "lid", "code": cube, "params": {"nonce": n}, "matrix": at(lid_z)},
                *extra,
            ],
            "contacts": [{"edge": "e1", "a": "base", "b": "lid", "at": [0, 0, 5]}],
        }).json()

    r17e = mated(10.0)
    gap_e = ((r17e.get("clash") or {}).get("contacts") or [{}])[0].get("gap_mm", -1)
    check("G5 contact: a seated lid touches its base at the mate point",
          r17e["ok"] and 0 <= gap_e < 0.1 and r17e["clash"]["clashes"] == [], str(r17e.get("clash")))
    r17f = mated(13.0)
    gap_f = ((r17f.get("clash") or {}).get("contacts") or [{}])[0].get("gap_mm", -1)
    check("G5 contact: a FLOATING mated lid reports its 3mm gap",
          r17f["ok"] and abs(gap_f - 3.0) < 0.05, str(r17f.get("clash")))

    # An INSTANCED copy is a part like any other. Before, only the primary pose
    # was compared, so a second copy could sit inside the base unreported.
    n17g = int(time.time())
    r17g = mated(10.0, extra=[{"key": "lid#1", "code": cube, "params": {"nonce": n17g}, "matrix": at(6)}])
    cg = (r17g.get("clash") or {}).get("clashes") or []
    check("G5 catches an instanced copy (lid#1) inside the base",
          r17g["ok"] and any(c.get("b") == "lid#1" and c.get("a") == "base" for c in cg)
          and not any(c.get("b") == "lid" for c in cg), str(cg))

    # A SCREW IN ITS NUT SHARES THE THREAD by design: major Ø4 through a Ø3.3
    # tap bore, pi/4 * (4² - 3.3²) * 3.2 = 12.8mm³. Allowed up to the declared
    # volume, and a clash again with no allowance, so the exemption is the
    # allowance and not the pair.
    screw = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    return Pos(0, 0, 2) * Cylinder(3.5, 4) + Pos(0, 0, -6) * Cylinder(2, 12)\n"
    )
    nut = (
        "from build123d import *\n"
        "import math\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    body = extrude(RegularPolygon(7 / math.sqrt(3), 6), 3.2)\n"
        "    return body - Pos(0, 0, 1.6) * Cylinder(1.65, 6.4)\n"
    )

    def bolted(allow):
        n = int(time.time())
        return client.post("/clash", json={
            "parts": [
                {"key": "screw", "code": screw, "params": {"nonce": n}, "matrix": at(0)},
                {"key": "nut", "code": nut, "params": {"nonce": n}, "matrix": at(-8)},
            ],
            "allow": allow,
        }).json()

    r17h = bolted([{"a": "nut", "b": "screw", "volume_mm3": 19.3}])
    ex = (r17h.get("clash") or {}).get("exempt") or [{}]
    check("G5 exempts a screw's thread inside its nut, up to the engagement volume",
          r17h["ok"] and r17h["clash"]["clashes"] == [] and abs(ex[0].get("volume_mm3", 0) - 12.8) < 0.5,
          str(r17h.get("clash")))
    r17i = bolted([])
    check("G5 still reports the same overlap with no allowance",
          r17i["ok"] and len(r17i["clash"]["clashes"]) == 1, str(r17i.get("clash")))
    r17j = bolted([{"a": "nut", "b": "screw", "volume_mm3": 5.0}])
    check("G5 reports an overlap beyond the allowance (an overlapping pair fails)",
          r17j["ok"] and len(r17j["clash"]["clashes"]) == 1, str(r17j.get("clash")))

    # A VALID SOLID WHOSE TESSELLATION IS NOT. OCP leaves split seams on
    # filleted and lofted faces, trimesh's boolean refuses anything failing its
    # is_volume check, and every pair with a helicopter's fuselage or cockpit
    # went "boolean failed" — uncompared. A filleted box reproduces it.
    rounded = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    b = Box(20, 20, 10)\n"
        "    return fillet(b.edges(), 3)\n"
    )

    def rounded_pair(z):
        n = int(time.time())
        return client.post("/clash", json={"parts": [
            {"key": "base", "code": rounded, "params": {"nonce": n}, "matrix": at(0)},
            {"key": "lid", "code": rounded, "params": {"nonce": n}, "matrix": at(z)},
        ]}).json()

    r17k = rounded_pair(6.0)
    ck = (r17k.get("clash") or {})
    check("G5 compares parts whose tessellation has split seams, and finds the overlap",
          r17k["ok"] and ck.get("errors") == [] and len(ck.get("clashes", [])) == 1
          and ck["clashes"][0].get("depth_mm", 0) > 1.0, str(ck))
    r17l = rounded_pair(10.0)
    cl17 = (r17l.get("clash") or {})
    check("G5 passes the same rounded parts stacked face to face, compared, not skipped",
          r17l["ok"] and cl17.get("errors") == [] and cl17.get("clashes") == [] and cl17.get("pairs_tested") == 1,
          str(cl17))

    # 18. Hole depth. The diameter was measured at one plane 0.6mm down, so a
    # Ø8 dimple 0.75mm deep reported "measured_diameter: 8.0" and passed as a
    # clearance hole a screw was meant to go through.
    dimple_code = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    with BuildPart() as bp:\n"
        "        Box(40, 40, 10)\n"
        "        with Locations((0, 0, 5 - p['d'] / 2)):\n"
        "            Cylinder(4, p['d'], mode=Mode.SUBTRACT)\n"
        "    return bp.part\n"
    )
    top_face = {"origin": [0, 0, 5], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]}

    def hole(depth, params=None):
        port = {"key": "bolt", "type": "CLEARANCE_HOLE", "pose": top_face,
                "params": {"diameter": 8.0, **(params or {})}}
        return client.post("/execute", json={
            "code": dimple_code, "params": {"d": depth, "nonce": int(time.time())}, "ports": [port],
        })

    r18 = hole(0.75)
    check("G3 catches a pocket declared as a clearance hole",
          r18.status_code == 422 and "instead of passing through" in r18.json().get("error", ""),
          r18.json().get("error", ""))
    r18b = hole(14.0)
    ports18b = (r18b.json().get("measurements", {}).get("ports") or [{}])[0]
    check("G3 passes a through hole and says it is through",
          r18b.status_code == 200 and ports18b.get("through") is True,
          str(ports18b))
    # A SEAT IS LEGITIMATELY SHALLOW. A washer face, a head recess and a shallow
    # counterbore are all correct well under a millimetre, so a depth floor here
    # rejects real parts to catch nothing. Every BORE on disk is a blind seat.
    def seat(depth, ptype):
        port = {"key": "seat", "type": ptype, "pose": top_face, "params": {"diameter": 8.0}}
        return client.post("/execute", json={
            "code": dimple_code, "params": {"d": depth, "nonce": int(time.time())}, "ports": [port],
        })

    for ptype in ("BORE", "SCREW_SEAT"):
        r = seat(0.8, ptype)
        m = (r.json().get("measurements", {}).get("ports") or [{}])[0]
        check(f"G3 accepts a 0.8mm {ptype} and measures its depth",
              r.status_code == 200 and abs((m.get("measured_depth") or 0) - 0.8) < 0.05,
              str(m) if r.status_code == 200 else r.json().get("error", ""))

    # The depth march follows the axis to the DEEPEST floor in a coaxial stack, so a
    # counterbore over a pilot measures the pilot. Reported, never enforced: a
    # counterbore's own floor is an annulus and never lies on the axis, so
    # comparing a declared depth against this would be unsatisfiable.
    stepped = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    with BuildPart() as bp:\n"
        "        Box(40, 40, 10)\n"
        "        with Locations((0, 0, 5 - 1.5)):\n"
        "            Cylinder(5, 3, mode=Mode.SUBTRACT)\n"
        "        with Locations((0, 0, 5 - 4)):\n"
        "            Cylinder(2.5, 8, mode=Mode.SUBTRACT)\n"
        "    return bp.part\n"
    )
    r18e = client.post("/execute", json={
        "code": stepped, "params": {"nonce": int(time.time())},
        "ports": [{"key": "cb", "type": "BORE", "pose": top_face, "params": {"diameter": 10.0}}],
    })
    check("G3 accepts a stepped hole rather than failing it unsatisfiably",
          r18e.status_code == 200, r18e.json().get("error", ""))

    # 19. The hole's CENTRE, not just its width. The median ray measured
    # distances from the declared origin, so a hole drilled 0.5mm off read as
    # the right diameter and passed while a mating screw missed it.
    offset_hole = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    return Box(40, 40, 10) - Pos(p['dx'], 0, 0) * Cylinder(4, 12)\n"
    )

    def off(dx):
        return client.post("/execute", json={
            "code": offset_hole, "params": {"dx": dx, "nonce": int(time.time())},
            "ports": [{"key": "bolt", "type": "CLEARANCE_HOLE", "pose": top_face, "params": {"diameter": 8.0}}],
        })

    r19 = off(0.1)
    check("G3 passes a hole 0.1mm off centre", r19.status_code == 200, r19.json().get("error", ""))
    r19b = off(0.5)
    f19 = (r19b.json().get("failures") or [{}])[0]
    check("G3 fails a hole 0.5mm off centre with measured/expected offset",
          r19b.status_code == 422 and "0.50mm off the declared origin" in f19.get("error", "")
          and f19.get("expected") == 0.0 and abs((f19.get("measured") or 0) - 0.5) < 0.02, str(f19))

    print()
    # G2 solid count, and G4 in the primitive's own frame. Both need a contract,
    # so they only run on a verify pass.
    print("G2 solids + G4 rotated envelope")
    two_bodies = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    return Box(10, 10, 10) + Pos(p['gap'], 0, 0) * Box(10, 10, 10)\n"
    )

    def bodies(gap, solids=1):
        return client.post("/execute", json={
            "code": two_bodies, "params": {"gap": gap, "nonce": int(time.time())}, "solids": solids,
        })

    r20 = bodies(25.0)
    b20 = r20.json()
    check("G2 fails two disjoint solids, naming each one",
          r20.status_code == 422 and b20.get("stage") == "G2" and "solid 1:" in b20.get("error", "")
          and "fuse" in b20.get("hint", ""), b20.get("error", "")[:160])
    r20b = bodies(8.0)
    check("G2 passes two boxes that overlap into one solid", r20b.status_code == 200, r20b.json().get("error", ""))
    r20c = bodies(25.0, solids=2)
    check("G2 passes two solids when the contract declares 2", r20c.status_code == 200, r20c.json().get("error", ""))
    r20d = client.post("/execute", json={"code": two_bodies, "params": {"gap": 25.0, "nonce": int(time.time())}})
    check("without a contract the build still serves the viewport", r20d.status_code == 200, r20d.json().get("error", ""))

    rod_code = (
        "from build123d import *\n"
        "def build(p):\n"
        "    _ = p['nonce']\n"
        "    rod = Cylinder(3, 40)\n"
        "    return Rot(0, 90, 0) * rod if p['lying'] else rod\n"
    )
    lying_env = [{"kind": "cylinder", "center": [0, 0, 0], "radius": 3.2, "height": 40.5,
                  "zAxis": [1, 0, 0], "xAxis": [0, 1, 0]}]

    def rod(lying):
        return client.post("/execute", json={
            "code": rod_code, "params": {"lying": lying, "nonce": int(time.time())}, "envelope": lying_env,
        })

    r21 = rod(True)
    check("G4 passes a horizontal rod in a zAxis [1,0,0] cylinder", r21.status_code == 200, r21.json().get("error", ""))
    r21b = rod(False)
    check("G4 fails a vertical rod in the same envelope",
          r21b.status_code == 422 and r21b.json().get("stage") == "G4", r21b.json().get("error", "")[:120])

    print()
    # SHAFT, the peg side of every imported peg joint. Nonce in params so each
    # assertion is cache-cold: /execute serves a cached 200 before a worker runs,
    # so a pass-asserting check can otherwise be green with the probe deleted.
    print("G3 SHAFT — the peg side of a peg joint")
    nonce = int(time.time())
    def shaft(peg_d, dia, length, n):
        return {
            "code": PEG,
            "params": {"peg_d": peg_d, "nonce": nonce + n},
            "ports": [{"key": "peg", "type": "SHAFT",
                       "pose": {"origin": [0, 0, 3], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]},
                       "params": {"diameter": dia, "length": length}}],
        }
    r = client.post("/execute", json=shaft(5.0, 5.0, 12, 0))
    ok = r.status_code == 200
    ports = (r.json().get("measurements") or {}).get("ports", []) if ok else []
    measured = ports[0].get("measured_diameter") if ports else None
    check("G3 measures a true Ø5 peg in the mesh", ok and abs((measured or 0) - 5.0) < 0.1,
          f"measured Ø{measured}" if ok else r.text[:120])
    r = client.post("/execute", json=shaft(5.0, 8.0, 12, 1))
    check("G3 catches a peg thinner than declared", r.status_code == 422 and "measured Ø5" in r.text,
          r.text[:140])
    r = client.post("/execute", json=shaft(5.0, 5.0, 25, 2))
    check("G3 catches a peg shorter than declared", r.status_code == 422 and "material ends at" in r.text,
          r.text[:140])
    r = client.post("/execute", json={**shaft(5.0, 5.0, 12, 3),
                                      "ports": [{"key": "peg", "type": "SHAFT",
                                                 "pose": {"origin": [10, 10, 3], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]},
                                                 "params": {"diameter": 5.0, "length": 12}}]})
    check("G3 catches a declared peg that was never built", r.status_code == 422 and "no peg" in r.text,
          r.text[:140])

    # ---- HOLE_PATTERN / BOSS_PATTERN: one port, each member probed ----------
    four_holes = """
from build123d import *

def build(p):
    part = Box(60, 60, 6)
    for x, y in ((-20, -20), (20, -20), (-20, 20), (20, 20))[:p.holes]:
        part = part - Pos(x, y, 0) * Cylinder(2.25, 8)
    return part
"""
    top = {"origin": [0, 0, 3], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]}
    pattern = {"key": "bolts", "type": "HOLE_PATTERN", "pose": top,
               "params": {"diameter": 4.5, "nx": 2, "ny": 2, "pitch_x": 40, "pitch_y": 40}}
    r = client.post("/execute", json={"code": four_holes, "params": {"holes": 4}, "ports": [pattern]})
    members = (r.json().get("measurements", {}).get("ports") or [{}])[0].get("members", [])
    check("HOLE_PATTERN of 4 passes with 4 measured members", r.status_code == 200 and len(members) == 4,
          r.text[:160])
    r = client.post("/execute", json={"code": four_holes, "params": {"holes": 3}, "ports": [pattern]})
    fl = r.json().get("failures", [])
    check("HOLE_PATTERN with one hole missing names that member",
          r.status_code == 422 and [(f.get("port"), f.get("member")) for f in fl] == [("bolts", 4)],
          str([f.get("error") for f in fl])[:200])

    two_bosses = """
from build123d import *

def build(p):
    part = Box(60, 30, 6)
    for x in (-15, 15):
        part = part + Pos(x, 0, 9) * Cylinder(4, 12) - Pos(x, 0, 9) * Cylinder(1.25, 14)
    return part
"""
    bosses = {"key": "standoffs", "type": "BOSS_PATTERN",
              "pose": {"origin": [0, 0, 15], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]},
              "params": {"outer_diameter": 8, "pilot_diameter": 2.5, "count": 2, "pcd": 30}}
    r = client.post("/execute", json={"code": two_bosses, "ports": [bosses]})
    check("BOSS_PATTERN on a polar layout passes", r.status_code == 200, r.text[:160])
    r = client.post("/execute", json={"code": two_bosses, "ports": [{**bosses, "params": {**bosses["params"], "pcd": 40}}]})
    check("BOSS_PATTERN on the wrong pitch circle fails both members",
          r.status_code == 422 and len(r.json().get("failures", [])) == 2, r.text[:160])

    r = client.post("/execute", json={"code": four_holes, "params": {"holes": 4},
                                      "ports": [{"key": "clip", "type": "SNAP_HOOK", "pose": top, "params": {}}]})
    check("an unprobed port type fails G3 instead of passing as skipped",
          r.status_code == 422 and r.json().get("stage") == "G3" and "no probe for SNAP_HOOK" in r.text, r.text[:160])

    # ---- hardware host features: a pass and a fail per type ---------------
    hw_part = """
from build123d import *
import math

def build(p):
    part = Box(60, 60, 20)
    top = 10
    def bore(d, depth, x=0, y=0):
        return Pos(x, y, top - depth / 2) * Cylinder(d / 2, depth)
    k = p.case
    if k == "tap":
        return part - bore(p.d, p.depth)
    if k == "insert_boss":
        return Pos(0, 0, -8) * Box(60, 60, 4) + Pos(0, 0, 0) * Cylinder(p.boss / 2, 20) - bore(p.d, p.depth)
    if k == "nut":
        hexa = Pos(0, 0, top - p.depth) * Rot(0, 0, p.rot) * extrude(RegularPolygon(p.af / math.sqrt(3), 6), p.depth)
        part = part - hexa - bore(3.4, 20)
        if p.side:
            part = part - Pos(15, 0, top - p.depth / 2) * Box(30, p.af, p.depth)
        return part
    if k == "round":
        return part - bore(p.d, p.depth) - bore(3.4, 20)
    if k == "cbore":
        return part - bore(p.d, p.depth) - bore(p.dt, 20)
    if k == "csk":
        h = (p.d - p.dt) / 2
        return part - Pos(0, 0, top - h / 2) * Cone(p.dt / 2, p.d / 2, h) - bore(p.dt, 20)
    if k == "seat":
        return part - bore(p.d, p.depth) - bore(p.lip, 20)
    if k == "motor":
        part = part - bore(p.d, 20)
        for sx in (-15.5, 15.5):
            for sy in (-15.5, 15.5):
                part = part - bore(3.4, 20, sx, sy)
        return part
    if k == "dbore":
        return part - (Pos(0, 0, top - 5) * Cylinder(p.d / 2, 10) & Pos(p.flat - 10, 0, top - 5) * Box(20, 20, 10))
    if k == "groove":
        return Pos(0, 0, top) * Cylinder(2.5, 40) - Pos(0, 0, top + p.at) * (Cylinder(3, p.w) - Cylinder(p.d / 2, p.w))
    if k == "rail":
        land = Box(120, 30, 20)
        for i in range(5):
            land = land - bore(4, 8, (i - 2) * 20)
        return land
    raise ValueError(k)
"""
    hw_top = {"origin": [0, 0, 10], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]}
    for label, hw_params, kind, port_params, want in [
        ("THREADED_HOLE M3 at Ø2.5, 10 deep", {"case": "tap", "d": 2.5, "depth": 10}, "THREADED_HOLE", {"thread": "M3", "depth": 8}, None),
        ("THREADED_HOLE M3 drilled to clearance", {"case": "tap", "d": 3.4, "depth": 10}, "THREADED_HOLE", {"thread": "M3", "depth": 8}, "expected Ø2.40..2.60"),
        ("THREADED_HOLE too shallow", {"case": "tap", "d": 2.5, "depth": 4}, "THREADED_HOLE", {"thread": "M3", "depth": 8}, "needs 8mm of depth"),
        ("INSERT_POCKET Ø4 x 7 in a slab", {"case": "tap", "d": 4.0, "depth": 7}, "INSERT_POCKET", {"diameter": 4.0, "depth": 5.8}, None),
        ("INSERT_POCKET with no melt room", {"case": "tap", "d": 4.0, "depth": 5.8}, "INSERT_POCKET", {"diameter": 4.0, "depth": 5.8}, "needs 6.1mm"),
        ("INSERT_POCKET in a 1mm-wall boss", {"case": "insert_boss", "d": 4.0, "depth": 7, "boss": 6.0}, "INSERT_POCKET", {"diameter": 4.0, "depth": 5.8}, "wall under 1.2mm"),
        ("NUT_TRAP M3 aligned", {"case": "nut", "af": 5.7, "depth": 2.6, "rot": 0, "side": 0}, "NUT_TRAP", {"af": 5.5, "depth": 2.4, "entry": "axial"}, None),
        ("NUT_TRAP rotated 30°", {"case": "nut", "af": 5.7, "depth": 2.6, "rot": 30, "side": 0}, "NUT_TRAP", {"af": 5.5, "depth": 2.4, "entry": "axial"}, "across the flats"),
        ("NUT_TRAP that is a round pocket", {"case": "round", "d": 5.7, "depth": 2.6}, "NUT_TRAP", {"af": 5.5, "depth": 2.4}, "across the corners"),
        ("NUT_TRAP side entry along +x", {"case": "nut", "af": 5.7, "depth": 2.6, "rot": 0, "side": 1}, "NUT_TRAP", {"af": 5.5, "depth": 2.4, "entry": "side"}, None),
        ("NUT_TRAP declared side, cut axial", {"case": "nut", "af": 5.7, "depth": 2.6, "rot": 0, "side": 0}, "NUT_TRAP", {"af": 5.5, "depth": 2.4, "entry": "side"}, "side entry is closed"),
        ("COUNTERBORE M3", {"case": "cbore", "d": 6.0, "depth": 3.0, "dt": 3.4}, "COUNTERBORE", {"diameter": 6.0, "depth": 3.0, "through_diameter": 3.4}, None),
        ("COUNTERBORE too shallow", {"case": "cbore", "d": 6.0, "depth": 1.5, "dt": 3.4}, "COUNTERBORE", {"diameter": 6.0, "depth": 3.0, "through_diameter": 3.4}, "steps at 1.50mm"),
        ("COUNTERSINK 90°", {"case": "csk", "d": 6.5, "dt": 3.4}, "COUNTERSINK", {"diameter": 6.5, "angle": 90, "through_diameter": 3.4}, None),
        ("COUNTERSINK declared 60°", {"case": "csk", "d": 6.5, "dt": 3.4}, "COUNTERSINK", {"diameter": 6.5, "angle": 60, "through_diameter": 3.4}, "expected Ø6.5 at the face"),
        ("DOWEL_HOLE press at Ø3.95", {"case": "tap", "d": 3.95, "depth": 10}, "DOWEL_HOLE", {"diameter": 4, "depth": 8, "fit": "press"}, None),
        ("DOWEL_HOLE press hole declared slip", {"case": "tap", "d": 3.95, "depth": 10}, "DOWEL_HOLE", {"diameter": 4, "depth": 8, "fit": "slip"}, "expected Ø4.05..4.25"),
        ("DOWEL_HOLE slip at Ø4.15", {"case": "tap", "d": 4.15, "depth": 10}, "DOWEL_HOLE", {"diameter": 4, "depth": 8, "fit": "slip"}, None),
        ("DOWEL_HOLE slip hole declared press", {"case": "tap", "d": 4.15, "depth": 10}, "DOWEL_HOLE", {"diameter": 4, "depth": 8, "fit": "press"}, "expected Ø3.90..4.00"),
        ("BEARING_SEAT 608 press with a lip", {"case": "seat", "d": 21.95, "depth": 7, "lip": 19}, "BEARING_SEAT", {"od": 22, "width": 7, "fit": "press"}, None),
        ("BEARING_SEAT with no shoulder", {"case": "seat", "d": 21.95, "depth": 7, "lip": 21.95}, "BEARING_SEAT", {"od": 22, "width": 7, "fit": "press"}, "no shoulder"),
        ("BEARING_SEAT shallower than the bearing", {"case": "seat", "d": 21.95, "depth": 5, "lip": 19}, "BEARING_SEAT", {"od": 22, "width": 7, "fit": "press"}, "the seat is 5.00mm deep"),
        ("BUSHING_BORE Ø10 x 12", {"case": "tap", "d": 9.95, "depth": 12}, "BUSHING_BORE", {"od": 10, "length": 10}, None),
        ("BUSHING_BORE cut slip", {"case": "tap", "d": 10.15, "depth": 12}, "BUSHING_BORE", {"od": 10, "length": 10}, "expected Ø9.90..10.00"),
        ("MOTOR_MOUNT NEMA17", {"case": "motor", "d": 22.15}, "MOTOR_MOUNT", {"pilot_diameter": 22, "hole_diameter": 3.4, "pitch_x": 31, "pitch_y": 31}, None),
        ("MOTOR_MOUNT on the wrong pitch", {"case": "motor", "d": 22.15}, "MOTOR_MOUNT", {"pilot_diameter": 22, "hole_diameter": 3.4, "pitch_x": 26, "pitch_y": 26}, "member"),
        ("MAGNET_POCKET Ø6.1 for a Ø6 magnet", {"case": "tap", "d": 6.1, "depth": 3.2}, "MAGNET_POCKET", {"diameter": 6, "depth": 3}, None),
        ("MAGNET_POCKET with no clearance", {"case": "tap", "d": 6.0, "depth": 3.2}, "MAGNET_POCKET", {"diameter": 6, "depth": 3}, "expected Ø6.05..6.20"),
        ("HUB_BORE Ø5 D-bore", {"case": "dbore", "d": 5.15, "flat": 2.0}, "HUB_BORE", {"diameter": 5, "flat": 2.0}, None),
        ("HUB_BORE flat in the wrong place", {"case": "dbore", "d": 5.15, "flat": 2.0}, "HUB_BORE", {"diameter": 5, "flat": 1.5}, "the flat at 2.00mm"),
        ("HUB_BORE round", {"case": "tap", "d": 5.15, "depth": 10}, "HUB_BORE", {"diameter": 5}, None),
        ("HUB_BORE D-bore deep enough", {"case": "dbore", "d": 5.15, "flat": 2.0}, "HUB_BORE", {"diameter": 5, "flat": 2.0, "depth": 8}, None),
        ("HUB_BORE D-bore shorter than its shaft", {"case": "dbore", "d": 5.15, "flat": 2.0}, "HUB_BORE", {"diameter": 5, "flat": 2.0, "depth": 14}, "the shaft runs 14mm in"),
        ("HUB_BORE round, shorter than its shaft", {"case": "tap", "d": 5.15, "depth": 10}, "HUB_BORE", {"diameter": 5, "depth": 14}, "14mm"),
        ("HUB_BORE right through, shaft longer than the part", {"case": "tap", "d": 5.15, "depth": 20}, "HUB_BORE", {"diameter": 5, "depth": 24}, None),
        ("HUB_BORE pressed onto its axle", {"case": "tap", "d": 4.95, "depth": 10}, "HUB_BORE", {"diameter": 5, "fit": "press"}, None),
        ("HUB_BORE press hub cut slip", {"case": "tap", "d": 5.15, "depth": 10}, "HUB_BORE", {"diameter": 5, "fit": "press"}, "expected Ø4.90..5.00"),
        ("LINEAR_BEARING_SEAT LM6UU over a lip", {"case": "seat", "d": 11.95, "depth": 19.5, "lip": 8}, "LINEAR_BEARING_SEAT", {"od": 12, "length": 19, "fit": "press"}, None),
        ("LINEAR_BEARING_SEAT shorter than its bushing", {"case": "seat", "d": 11.95, "depth": 15, "lip": 8}, "LINEAR_BEARING_SEAT", {"od": 12, "length": 19, "fit": "press"}, "the seat is 15.00mm deep"),
        ("CLIP_GROOVE Ø4 e-clip groove on a Ø5 shaft", {"case": "groove", "d": 4, "w": 0.74, "at": 0}, "CLIP_GROOVE", {"diameter": 4, "width": 0.74, "shaft_diameter": 5}, None),
        ("CLIP_GROOVE 0.3mm off its place", {"case": "groove", "d": 4, "w": 0.74, "at": 0.3}, "CLIP_GROOVE", {"diameter": 4, "width": 0.74, "shaft_diameter": 5}, "groove's middle"),
        ("RAIL_MOUNT MGN9 land, five holes at 20", {"case": "rail"}, "RAIL_MOUNT", {"width": 9, "length": 100, "pitch": 20, "count": 5, "hole_diameter": 4, "depth": 6}, None),
        ("RAIL_MOUNT declared on a 25 pitch", {"case": "rail"}, "RAIL_MOUNT", {"width": 9, "length": 100, "pitch": 25, "count": 5, "hole_diameter": 4, "depth": 6}, "member"),
    ]:
        r = client.post("/execute", json={"code": hw_part, "params": hw_params,
                                          "ports": [{"key": "host", "type": kind, "pose": hw_top, "params": port_params}]})
        if want is None:
            check(f"G3 {label} passes", r.status_code == 200, r.text[:200])
        else:
            check(f"G3 {label} fails", r.status_code == 422 and r.json().get("stage") == "G3" and want in r.text,
                  r.text[:200])

    # ---- G4b: spec-derived assertions, a pass and a fail per kind ----------
    cup = """
from build123d import *

def build(p):
    return Cylinder(20, 30) - Pos(0, 0, 3) * Cylinder(20 - p.wall, 30)
"""
    lugged = """
from build123d import *

def build(p):
    return Box(60, 60, 6) + Pos(18, 0, 8) * Box(20, 20, 10)
"""
    two = """
from build123d import *

def build(p):
    return Box(10, 10, 10) + Pos(30, 0, 0) * Box(10, 10, 10)
"""
    slot = """
from build123d import *

def build(p):
    return Box(40, 30, 10) - Pos(-5, 0, 0) * Cylinder(3, 12) - Pos(5, 0, 0) * Cylinder(3, 12) - Box(10, 6, 12)
"""
    filleted = """
from build123d import *

def build(p):
    step = Box(40, 40, 20) - Pos(10, 0, 5) * Box(20, 50, 10)
    return fillet(step.edges().filter_by(Axis.Y).sort_by_distance((0, 0, 0))[0], 3)
"""
    plate4 = (four_holes, {"holes": 4})
    for label, (code, prm), assertion, want in (
        ("solids", plate4, {"kind": "solids", "count": 1}, None),
        ("solids", (two, {}), {"kind": "solids", "count": 1}, "2 separate solids"),
        ("volume_range", plate4, {"kind": "volume_range", "min": 20000, "max": 21600}, None),
        ("volume_range", plate4, {"kind": "volume_range", "min": 30000, "max": 40000}, 'assertion "volume_range"'),
        ("bbox_axis", plate4, {"kind": "bbox_axis", "axis": "x", "min": 59.5, "max": 60.5}, None),
        ("bbox_axis", plate4, {"kind": "bbox_axis", "axis": "z", "max": 4}, "at most 4 mm along z"),
        ("hole_count", plate4, {"kind": "hole_count", "min": 4, "max": 4}, None),
        ("hole_count", (four_holes, {"holes": 3}), {"kind": "hole_count", "min": 4}, "measured 3"),
        # A D-bore's wall closes ~78% of a turn and its flat closes the rest:
        # one hole. A slot's ends and a fillet close half and a quarter: none.
        ("hole_count", (hw_part, {"case": "dbore", "d": 5.15, "flat": 2.0}), {"kind": "hole_count", "min": 1, "max": 1}, None),
        ("hole_count", (slot, {}), {"kind": "hole_count", "min": 1}, "measured 0"),
        ("hole_count", (filleted, {}), {"kind": "hole_count", "min": 1}, "measured 0"),
        ("symmetry", plate4, {"kind": "symmetry", "plane": "yz"}, None),
        ("symmetry", (lugged, {}), {"kind": "symmetry", "plane": "yz"}, 'assertion "symmetry yz"'),
        ("min_wall", (cup, {"wall": 2.0}), {"kind": "min_wall", "mm": 1.6}, None),
        ("min_wall", (cup, {"wall": 0.4}), {"kind": "min_wall", "mm": 1.2}, 'assertion "min_wall"'),
    ):
        r = client.post("/execute", json={"code": code, "params": prm, "assertions": [assertion]})
        if want is None:
            check(f"G4b {label} passes", r.status_code == 200, r.text[:160])
        else:
            body = r.json()
            fl = body.get("failures") or [{}]
            check(f"G4b {label} fails with expected/measured",
                  # a solids assertion is the G2 count, reported as G2
                  r.status_code == 422 and body.get("stage") == ("G2" if label == "solids" else "G4b")
                  and want in body.get("error", "")
                  and "measured" in fl[0] and "expected" in fl[0], body.get("error", r.text)[:160])

    # ---- render decimation must not shred the mesh -------------------------
    # OCP tessellation is unwelded, and fast_simplification collapses EDGES,
    # so simplifying it directly destroyed the part instead of coarsening it:
    # a 90x90x3 plate went 17243mm2 -> 910mm2 of surface and rendered as
    # scattered slivers. Only meshes over MAX_TRIANGLES were hit, which is why
    # it looked random. The contact sheet feeds the vision pass, so a wrong
    # render is a wrong judgement, not a cosmetic bug.
    import numpy as _np

    from src.patchcad_kernel.render import MAX_TRIANGLES, _decimate, _surface_area

    _n, _side = 60, 100.0  # 7200 unwelded triangles over a known 10000mm2
    _xs = _np.linspace(0, _side, _n + 1)
    _tris = []
    for _i in range(_n):
        for _j in range(_n):
            _a = (_xs[_i], _xs[_j], 0.0)
            _b = (_xs[_i + 1], _xs[_j], 0.0)
            _c = (_xs[_i + 1], _xs[_j + 1], 0.0)
            _d = (_xs[_i], _xs[_j + 1], 0.0)
            _tris += [[_a, _b, _c], [_a, _c, _d]]
    _v = _np.asarray(_tris, dtype=_np.float64).reshape(-1, 3)
    _t = _np.arange(len(_v), dtype=_np.int64).reshape(-1, 3)
    _before = _surface_area(_v, _t)
    _dv, _dt = _decimate(_v, _t)
    _after = _surface_area(_dv, _dt)
    check(f"render decimation preserves the part ({len(_t)} tris > {MAX_TRIANGLES})",
          len(_t) > MAX_TRIANGLES and _after > 0.9 * _before,
          f"area {_before:.0f} -> {_after:.0f}mm2 over {len(_dt)} tris")

    exports(client)
    fabricate(client)
    reference_images(client)
    swept(client)
    gear_mesh(client)
    instructions(client)
    audit_fixes(client)
    bench_fixes(client)
    segmentation()
    catalog_parts()

    if failures:
        print(f"{len(failures)} FAILURE(S): {failures}")
        sys.exit(1)
    print("all checks passed")


def reference_images(client: httpx.Client) -> None:
    """Phase 6: /image/prep must find a dark shape on white, and /silhouette
    must score a posed part against a mask in the same normalized frame."""
    import base64
    import io

    import numpy as np
    from PIL import Image, ImageDraw

    from patchcad_kernel.image_prep import decode_mask, iou, normalize_mask, png_b64

    # An L on white, off-centre, so cropping and padding both have work to do.
    im = Image.new("RGB", (640, 480), "white")
    poly = [(120, 90), (220, 90), (220, 330), (420, 330), (420, 410), (120, 410)]
    ImageDraw.Draw(im).polygon(poly, fill=(35, 38, 44))
    truth = Image.new("L", im.size, 0)
    ImageDraw.Draw(truth).polygon(poly, fill=255)
    expected = normalize_mask(np.asarray(truth) > 127)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    data = base64.b64encode(buf.getvalue()).decode()
    for method in ("auto", "rembg"):
        r = client.post("/image/prep", json={"data_b64": data, "method": method}, timeout=180).json()
        got = decode_mask(r["mask_b64"]) if r.get("ok") else np.zeros_like(expected)
        score = iou(got, expected)
        check(f"/image/prep ({method}) recovers a dark L on white: mask IoU >= 0.95",
              r.get("ok") and score >= 0.95 and abs(r["aspect"] - 300 / 320) < 0.02,
              f"method={r.get('method')} IoU={score:.3f} aspect={r.get('aspect')}")
    again = client.post("/image/prep", json={"data_b64": data, "method": "auto"}).json()
    check("/image/prep caches by image hash", again.get("cached") is True)

    # A 40 x 10 x 20 box seen from the front is a 2:1 rectangle.
    box = "from build123d import *\ndef build(p):\n    return Box(p.x, p.y, p.z)\n"
    ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    front_ref = png_b64(normalize_mask(np.ones((300, 600), dtype=bool)))
    part = {"key": "body", "code": box, "params": {"x": 40, "y": 10, "z": 20}, "matrix": ident}
    r = client.post("/silhouette", json={"parts": [part], "views": [
        {"view": "front", "ref": "r1", "mask_b64": front_ref},
        {"view": "side", "ref": "r1", "mask_b64": front_ref},
    ]}).json()
    views = (r.get("silhouette") or {}).get("views") or [{}, {}]
    check("silhouette IoU: matching front view >= 0.95, wrong (side) view < 0.6",
          r.get("ok") and views[0].get("iou", 0) >= 0.95 and views[1].get("iou", 1) < 0.6,
          f"front={views[0].get('iou')} side={views[1].get('iou')}")

    # A second part the reference does not have takes the blame.
    moved = list(ident)
    moved[12] = 35.0
    extra = {"key": "tail", "code": box, "params": {"x": 30, "y": 6, "z": 6}, "matrix": moved}
    r2 = client.post("/silhouette", json={"parts": [part, extra], "views": [
        {"view": "front", "ref": "r1", "mask_b64": front_ref}]}).json()
    v2 = ((r2.get("silhouette") or {}).get("views") or [{}])[0]
    blamed = (v2.get("parts") or [{}])[0].get("key")
    check("silhouette attributes the disagreement to the part the reference lacks",
          r2.get("ok") and v2.get("iou", 1) < 0.8 and blamed == "tail",
          f"IoU={v2.get('iou')} parts={v2.get('parts')}")


FAB = {
    # cnc: a filleted pocket passes; a sharp one fails the corner rule.
    "cnc": ("cnc", "return Box(40, 30, 12) - Pos(0, 0, 3) * fillet(Box(20, 12, 6.01).edges().filter_by(Axis.Z), 2)",
            "return Box(40, 30, 12) - Pos(0, 0, 3) * Box(20, 12, 6.01)", "internal_corner"),
    "cnc-undercut": ("cnc", "return Box(40, 30, 12) - Pos(0, 0, 3) * fillet(Box(20, 12, 6.01).edges().filter_by(Axis.Z), 2)",
                     "return Box(40, 30, 12) - Rot(0, 90, 0) * Cylinder(2, 50)", "undercut"),
    "cnc-pocket": ("cnc", "return Box(40, 30, 24) - Pos(0, 0, 2) * fillet(Box(30, 12, 20.01).edges().filter_by(Axis.Z), 2)",
                   "return Box(40, 30, 24) - Pos(0, 0, 2) * fillet(Box(30, 4, 20.01).edges().filter_by(Axis.Z), 1.9)",
                   "pocket_depth"),
    "sheet_metal": ("sheet_metal", "return BENT(2.0, 10)", "return BENT(0.5, 10)", "bend_radius"),
    "sheet-hole": ("sheet_metal", "return BENT(2.0, 10)", "return BENT(2.0, 4)", "hole_edge"),
    "sheet-gauge": ("sheet_metal", "return BENT(2.0, 10)", "return BENT(2.0, 10) + Pos(25, 0, 3.5) * Cylinder(4, 3)",
                    "constant_thickness"),
    "laser_cut": ("laser_cut", "return extrude(Rectangle(60, 30) - Pos(15, 0) * Circle(3), 3)",
                  "return chamfer(extrude(Rectangle(60, 30), 3).edges().group_by(Axis.Z)[-1], 0.8)", "planar_profile"),
    "sls": ("sls", "return Box(20, 20, 20) - Pos(0, 0, 1) * Box(17, 17, 20)",
            "return Box(20, 20, 20) - Pos(0, 0, 1) * Box(19.4, 19.4, 20)", "min_wall"),
    "mjf": ("mjf", "return Box(20, 20, 20) - Pos(0, 0, 1) * Box(17, 17, 20)",
            "return Box(20, 20, 20) - Pos(0, 0, 1) * Box(19.4, 19.4, 20)", "min_wall"),
    "resin": ("resin", "return Box(20, 20, 20) - Pos(0, 0, 5) * Box(10, 10, 10.01)",
              "return Box(20, 20, 20) - Box(10, 10, 10)", "enclosed_void"),
}

#: A 2 mm L-bracket with a real inner bend radius `ri` and a Ø5 hole `off`
#: from the end of its foot.
BENT = """
def BENT(ri, off, t=2.0):
    ro = ri + t
    foot = Pos(20 + ro / 2, 0, t / 2) * Box(40 - ro, 30, t)
    wall = Pos(t / 2, 0, 20 + ro / 2) * Box(t, 30, 40 - ro)
    bend = Pos(ro, 0, ro) * Rot(90, 0, 0) * (Cylinder(ro, 30) - Cylinder(ri, 30)) & Pos(ro / 2, 0, ro / 2) * Box(ro, 30, ro)
    return foot + wall + bend - Pos(40 - off, 0, t / 2) * Cylinder(2.5, 2 * t)
"""


def _fab_code(body: str) -> str:
    return f"from build123d import *\n{BENT}\ndef build(p):\n    {body}\n"


def fabricate(client: httpx.Client) -> None:
    """G4c process DFM: one pass and one fail per rule family, through
    /execute, then the vendor package for each flat-or-bent kind."""
    import io
    import re
    import tempfile
    import zipfile

    import ezdxf

    print("fabricate: G4c process DFM + vendor package")
    nonce = time.time()
    for label, (kind, good, bad, rule) in FAB.items():
        ok = client.post("/execute", json={"code": _fab_code(good), "params": {"n": nonce},
                                            "process": {"kind": kind}}, timeout=60)
        no = client.post("/execute", json={"code": _fab_code(bad), "params": {"n": nonce},
                                            "process": {"kind": kind}}, timeout=60)
        nb = no.json()
        rules = [f.get("rule") for f in nb.get("failures") or []]
        check(f"G4c {label}: passes the good part, fails the bad one on {rule}",
              ok.status_code == 200 and no.status_code == 422 and nb.get("stage") == "G4c" and rule in rules,
              f"good={ok.json().get('error', 'ok')[:90]} bad={nb.get('stage')} {rules}")
    allowed = client.post("/execute", json={"code": _fab_code(FAB["cnc-undercut"][2]), "params": {"n": nonce},
                                             "process": {"kind": "cnc", "allow_undercuts": True}})
    check("G4c cnc: a flagged second setup allows the side hole", allowed.status_code == 200,
          allowed.json().get("error", "")[:120])

    ports = [{"key": "mount", "type": "CLEARANCE_HOLE", "params": {"diameter": 5.0},
              "pose": {"origin": [30, 0, 2], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]}}]
    tmp = pathlib.Path(tempfile.mkdtemp())

    def package(kind: str, body: str) -> tuple[dict, zipfile.ZipFile | None]:
        r = client.post("/vendor-package", json={
            "code": _fab_code(body), "params": {"n": nonce}, "ports": ports, "process": {"kind": kind},
            "meta": {"name": "bracket", "title": "Motor bracket", "process": kind, "material": "Al 5052-H32",
                     "finish": "bead blast", "qty": 4, "date": "2026-10-02"}}, timeout=120)
        body_ = r.json()
        if not body_.get("ok"):
            return body_, None
        return body_, zipfile.ZipFile(io.BytesIO(client.get(body_["file"]).content))

    def pages(pdf: bytes) -> int:
        return len(re.findall(rb"/Type\s*/Page(?![s\w])", pdf))

    expected = {"bracket.step", "bracket.dxf", "bracket-drawing.pdf", "RFQ.md"}
    body, z = package("sheet_metal", "return BENT(2.0, 10)")
    if z is None:
        check("sheet-metal vendor package builds", False, str(body)[:200])
    else:
        names = set(z.namelist())
        check("sheet-metal vendor zip holds STEP, DXF, PDF and RFQ.md", names == expected, str(sorted(names)))
        step = z.read("bracket.step").decode()
        check("vendor STEP is AP242, named, in mm",
              "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING" in step and "PRODUCT('bracket'" in step
              and "SI_UNIT(.MILLI.,.METRE.)" in step)
        check("vendor drawing PDF is one sheet", pages(z.read("bracket-drawing.pdf")) == 1)
        (tmp / "bent.dxf").write_bytes(z.read("bracket.dxf"))
        doc = ezdxf.readfile(tmp / "bent.dxf")
        check("bent-part DXF parses with three projected views",
              {"FRONT", "TOP", "RIGHT"} <= {e.dxf.layer for e in doc.modelspace()}, str(len(doc.modelspace())))
        rfq = z.read("RFQ.md").decode()
        check("RFQ says no flat pattern for a bent part, and carries material, qty and the hole",
              body["vendor"]["flat_pattern"] is False and "NO FLAT PATTERN" in rfq and "Al 5052-H32" in rfq
              and "Quantity: 4" in rfq and "Ø5 THRU" in rfq, rfq[:160])

    body, z = package("laser_cut", "return extrude(Rectangle(60, 30) - Pos(15, 0) * Circle(3), 3)")
    if z is None:
        check("laser vendor package builds", False, str(body)[:200])
    else:
        (tmp / "laser.dxf").write_bytes(z.read("bracket.dxf"))
        kinds = sorted(e.dxftype() for e in ezdxf.readfile(tmp / "laser.dxf").modelspace())
        check("laser DXF is the profile: an outline and the Ø6 hole", kinds.count("CIRCLE") == 1 and "LINE" in kinds,
              str(kinds))

    body, z = package("cnc", "return Box(40, 30, 12) - Pos(0, 0, 3) * Box(20, 12, 6.01)")
    check("no vendor package for a part that fails G4c", z is None and body.get("stage") == "G4c",
          str(body.get("error", ""))[:120])

    # A NEMA 17 plate: the drawing calls out the pilot with the limits G3 held
    # it to, the screw square about it, and the slot's length read off the part.
    up = {"zAxis": [0, 0, 1], "xAxis": [1, 0, 0]}
    ports[:] = [{"key": "motor", "type": "MOTOR_MOUNT", "pose": {"origin": [0, 0, 4], **up},
                 "params": {"pilot_diameter": 22, "hole_diameter": 3.4, "pitch_x": 31, "pitch_y": 31}},
                *({"key": f"slot{i}", "type": "SLOT", "pose": {"origin": [x, -20, 4], **up}, "params": {"width": 4.5}}
                  for i, x in enumerate((-18, 18)))]
    nema = ("b = Pos(0, 0, 2) * Box(60, 50, 4) - Pos(0, 0, 2) * Cylinder(11.0125, 6)\n"
            "    for x in (-15.5, 15.5):\n        for y in (-15.5, 15.5):\n"
            "            b -= Pos(x, y, 2) * Cylinder(1.7, 6)\n"
            "    for x in (-18, 18):\n        b -= Pos(x, -20, 2) * extrude(SlotCenterToCenter(12, 4.5), 3, both=True)\n"
            "    return b")
    body, z = package("cnc", nema)
    rfq = z.read("RFQ.md").decode() if z else str(body)[:200]
    check("cnc drawing calls out the motor pilot limits, the 31 square and both slots as one",
          "Ø22 +0.050/+0.000 THRU" in rfq and "4x Ø3.4 THRU ON 31 x 31 SQUARE ABOUT THE PILOT" in rfq
          and "2x SLOT 4.5 WIDE x 16.5 LONG THRU" in rfq, rfq[rfq.find("## Critical"):][:400])


def swept(client: httpx.Client) -> None:
    """G5 sweeps a moving part through its joint's travel. A rotor whose blades
    rest along x misses a strut standing at +y, so the static check is clean
    both times; turned through its full revolution, the rotor with a strut
    inside its blade circle hits it and the one with the strut outside does
    not. A slider runs into a stop the same way along its stroke."""
    print("swept clearance")
    n = int(time.time())
    rotor = ("from build123d import *\ndef build(p):\n    _ = p['nonce']\n"
             "    return Pos(0, 0, 20) * Cylinder(8, 6) + Pos(30, 0, 20) * Box(60, 10, 3) + Pos(-30, 0, 20) * Box(60, 10, 3)\n")
    strut = "from build123d import *\ndef build(p):\n    return Pos(0, p['r'], 15) * Box(4, 4, 30)\n"
    revolve = {"joint": "j1", "type": "revolute", "origin": [0, 0, 0], "direction": [0, 0, 1], "limits": [-180, 180], "moving": ["rotor"]}

    def spin(r):
        return client.post("/clash", json={"parts": [
            {"key": "rotor", "code": rotor, "params": {"nonce": n}, "matrix": []},
            {"key": "strut", "code": strut, "params": {"r": r}, "matrix": []},
        ], "sweeps": [revolve]}).json()

    hit = spin(45.0)
    found = (hit.get("clash") or {}).get("swept") or []
    check("swept G5: a rotor that clears at rest but hits a strut a quarter turn on fails, naming the joint",
          hit["ok"] and hit["clash"]["clashes"] == [] and len(found) == 1 and found[0]["joint"] == "j1"
          and found[0]["a"] == "rotor" and found[0]["b"] == "strut" and abs(abs(found[0]["travel"]) - 90) < 10,
          str(hit.get("clash"))[:300])
    clear = spin(70.0)
    check("swept G5: the same rotor with the strut outside its blade circle is clean",
          clear["ok"] and clear["clash"]["clashes"] == [] and clear["clash"].get("swept") == [], str(clear.get("clash"))[:300])

    box = "from build123d import *\ndef build(p):\n    _ = p['nonce']\n    return Box(10, 10, 10)\n"
    stop = "from build123d import *\ndef build(p):\n    return Pos(p['x'], 0, 0) * Box(4, 20, 20)\n"

    def slide(x):
        return client.post("/clash", json={"parts": [
            {"key": "slider", "code": box, "params": {"nonce": n}, "matrix": []},
            {"key": "stop", "code": stop, "params": {"x": x}, "matrix": []},
        ], "sweeps": [{"joint": "p1", "type": "prismatic", "origin": [0, 0, 0], "direction": [1, 0, 0],
                       "limits": [0, 50], "moving": ["slider"]}]}).json()

    into = (slide(40.0).get("clash") or {}).get("swept") or []
    past = (slide(70.0).get("clash") or {}).get("swept")
    check("swept G5: a slider meets a stop inside its stroke, and not one past it",
          len(into) == 1 and into[0]["b"] == "stop" and past == [], f"{into} / {past}")

    # A wheel rolling on a rail (the linear actuator's V-wheels): turned about
    # its own axis it is its rest pose, so the sweep is skipped and the rest
    # contact is the static check's alone. A lug makes it not round, and the
    # lug swings down into the rail.
    wheel = ("from build123d import *\ndef build(p):\n    _ = p['nonce']\n"
             "    w = Pos(0, 0, p['z']) * Rot(90, 0, 0) * Cylinder(15, 8)\n"
             "    return w + Pos(0, 0, p['z'] + 15.5) * Box(4, 8, 3) if p['lug'] else w\n")
    rail = "from build123d import *\ndef build(p):\n    return Pos(0, 0, -5) * Box(80, 20, 10)\n"

    def roll(z, lug):
        return client.post("/clash", json={"parts": [
            {"key": "wheel", "code": wheel, "params": {"nonce": n, "z": z, "lug": lug}, "matrix": []},
            {"key": "rail", "code": rail, "params": {}, "matrix": []},
        ], "sweeps": [{"joint": "w1", "type": "revolute", "origin": [0, 0, z], "direction": [0, 1, 0],
                       "limits": [-180, 180], "moving": ["wheel"]}]}).json()

    on = roll(15.0, False)
    check("swept G5: a round wheel resting on its rail sweeps nothing and is clean",
          on["ok"] and on["clash"]["clashes"] == [] and on["clash"].get("swept") == [], str(on.get("clash"))[:300])
    sunk = roll(14.0, False).get("clash") or {}
    check("swept G5: a round wheel 1mm into its rail is the static check's finding only (no sweep of it)",
          [(c["a"], c["b"]) for c in sunk.get("clashes", [])] in ([("wheel", "rail")], [("rail", "wheel")]) and sunk.get("swept") == [],
          str(sunk)[:300])
    lug = (roll(15.0, True).get("clash") or {})
    found = lug.get("swept") or []
    check("swept G5: the same wheel with a lug still sweeps, and the lug hits the rail",
          lug.get("clashes") == [] and len(found) == 1 and found[0]["joint"] == "w1" and found[0]["a"] == "wheel",
          str(lug)[:300])


# t4-006 as committed by the benchmark cook: a sphere cavity whose bottom pole
# exported as an open edge until meshpart.weld dropped the collapsed sliver.
BALL_SOCKET = """
from build123d import *

def build(p):
    plate = Pos(0, 0, 2.5) * Box(44, 30, 5)
    body = Pos(0, 0, 5 + 14) * Cylinder(13, 28)
    part = plate + body
    for sx in (-1, 1):
        part = part - Pos(sx * 17, 0, 2.5) * Cylinder(2.25, 20)
    part = part - Pos(0, 0, 22) * Sphere(10.4)
    part = part - Pos(0, 0, 22 + 6.5) * Cylinder(8.5, 13)
    return part
"""

THREAD = """
from build123d import *

def build(p):
    core = Pos(0, 0, 8) * Cylinder(4.05, 16)
    if not p['thread']:
        return Pos(0, 0, 8) * Cylinder(5, 16)
    prof = Plane.XZ * Polygon((3.7, -0.7), (5, -0.15), (5, 0.15), (3.7, 0.7), align=None)
    return core + sweep(prof, Helix(2.0, 12.0, 4.0, center=(0, 0, 2.0)), is_frenet=True)
"""

# prompts.ts THREADS, verbatim: an M8 x 1.25 x 30 groove cut under a thumb
# screw's head (the threaded-thumb-screw eval), and the same thread as the
# fused swept tooth that cost that eval three G2 repair rounds.
GROOVE_THREAD = """
from build123d import *

def groove(pitch, length, r_from, r_to, h=0.25, c=0.1):
    s = 1 if r_to > r_from else -1
    a, b = r_from - 0.3 * s, r_from + 0.05 * s
    pts = [(a, -h * pitch), (b, -h * pitch), (r_to, -c * pitch), (r_to, c * pitch), (b, h * pitch), (a, h * pitch)]
    return sweep(Plane.XZ * Polygon(*pts[::-s], align=None), Helix(pitch, length, a), is_frenet=True)

def build(p):
    _ = p['nonce']
    L, pitch = 30, 1.25
    r_maj, r_min = 4 - 0.1, 4 - 0.6134 * pitch - 0.1
    head = Pos(0, 0, 4) * Cylinder(10, 8)
    shank = Pos(0, 0, -L / 2) * Cylinder(r_maj, L)
    shank = shank - Pos(0, 0, -L - pitch) * groove(pitch, L + pitch - 0.5, r_maj, r_min)
    shank = shank - Pos(0, 0, -L - pitch / 2) * groove(pitch, pitch, r_maj, r_min - 0.05, 0.48, 0.48)
    return head + shank
"""
FUSED_THREAD = """
from build123d import *

def build(p):
    _ = p['nonce']
    head = Pos(0, 0, 4) * Cylinder(10, 8)
    core = Pos(0, 0, -14.75) * Cylinder(3.2, 30.5)
    core = chamfer(core.edges().group_by(Axis.Z)[0], 0.6)
    prof = Plane.XZ * Polygon((3.0, -0.6), (3.9, -0.25), (3.9, 0.25), (3.0, 0.6), align=None)
    thread = Pos(0, 0, -29.4) * sweep(prof, Helix(1.25, 30.4, 3.0), is_frenet=True)
    return head + core + thread
"""


# CADClamp t4-009's dovetail block, as generated.
DOVETAIL_T4_009 = """
from build123d import *
import math

def build(p):
    _ = p['nonce']
    length, width, height = 60.0, 40.0, 20.0
    dovetail_width, dovetail_height, slide_clearance = 12.0, 8.0, 0.3
    t = math.tan(math.radians(14))
    rail_top_w = dovetail_width + 2.0 * dovetail_height * t
    block = Pos(0, 0, height / 2) * Box(length, width, height)
    block = chamfer(block.edges().group_by(Axis.Z)[0], 0.4)
    block = chamfer(block.edges().group_by(Axis.Z)[-1], 0.4)
    ext = 1.0
    hb, ht = dovetail_width / 2 - ext * t, rail_top_w / 2
    rail_pts = [(-hb, height - ext), (hb, height - ext), (ht, height + dovetail_height), (-ht, height + dovetail_height)]
    block = block + Pos(-length / 2, 0, 0) * extrude(Plane.YZ * Polygon(*rail_pts, align=None), length)
    so = (dovetail_width + 2 * slide_clearance) / 2 - ext * t
    sr = (rail_top_w + 2 * slide_clearance) / 2
    sock_depth = dovetail_height + slide_clearance
    sock_pts = [(-so, -ext), (so, -ext), (sr, sock_depth), (-sr, sock_depth)]
    block = block - Pos(-length / 2 - 1, 0, 0) * extrude(Plane.YZ * Polygon(*sock_pts, align=None), length + 2)
    hole = Pos(0, 0, height / 2) * Cylinder(2.5, height + 2)
    return block - [Pos(sx * 22, sy * 14, 0) * hole for sx in (-1, 1) for sy in (-1, 1)]
"""

# A spigot thread cut off by its lead-in chamfer, the way t4-007's was.
RUNOUT_THREAD = """
from build123d import *

def build(p):
    _ = p['nonce']
    tooth = Plane.XZ * Polygon((10.2, -1.07), (12, -0.2), (12, 0.2), (10.2, 1.07), align=None)
    spigot = Pos(0, 0, 10) * Cylinder(10.5, 22) + Pos(0, 0, -1) * sweep(tooth, Helix(3, 24, 10.5), is_frenet=True)
    lead = revolve(Plane.XZ * Polygon((0, -1), (12.5, -1), (12.5, 18.5), (11, 20), (0, 20), align=None), Axis.Z, 360)
    return Pos(0, 0, -5) * Cylinder(17, 10) + (spigot & lead) - Pos(0, 0, 5) * Cylinder(9, 40)
"""

HONEYCOMB = """
from build123d import *

def build(p):
    _ = p['nonce']
    w, rib = 8.0, p['rib']
    cell = extrude(RegularPolygon(w / 3 ** 0.5, 6, rotation=30), 4)
    panel = Pos(0, 0, 1) * Box(70, 56, 2)
    dx, dy = w + rib, (w + rib) * 3 ** 0.5 / 2
    cells = [Pos(c * dx + (dx / 2 if r % 2 else 0), r * dy, -1) * cell for r in range(-2, 3) for c in range(-2, 3)]
    return panel - cells
"""

THREADED_STUD = """
from build123d import *

def build(p):
    _ = p['nonce']
    tooth = Plane.XZ * Polygon((8.4, -1.0), (10, -0.15), (10, 0.15), (8.4, 1.0), align=None)
    part = Pos(0, 0, 3) * Cylinder(18, 6) + Pos(0, 0, 12) * Cylinder(8.5, 12)
    part += Pos(0, 0, 6) * sweep(tooth, Helix(2.5, 10.5, 8.4), is_frenet=True)
    part -= Pos(0, 0, 10) * Cylinder(4.2, 40)
    return part - [Pos(x, 0, 3) * Cylinder(2.25, 8) for x in (-13, 13)]
"""


def bench_fixes(client: httpx.Client) -> None:
    """CADClamp benchmark zeros: a hole breaking out into a cavity, a keyed
    bore, a sphere's pole in the export mesh, a thread inside try/except: pass,
    and the FDM process rules."""
    print("benchmark regressions")
    n = time.time()

    def run(code, **body):
        return client.post("/execute", json={"code": code, "params": {"nonce": n, **body.pop("params", {})}, **body},
                           timeout=60)

    clamp = ("from build123d import *\ndef build(p):\n    _ = p['nonce']\n"
             "    c = Pos(30, 0, 40) * Box(60, 20, 80) - Pos(40, 0, 40) * Box(40, 30, 50)\n"
             "    return c - Pos(50, 0, 80 - p['depth'] / 2) * Cylinder(5.25, p['depth'] + 0.01)\n")
    port = {"key": "screw_hole", "type": "CLEARANCE_HOLE", "pose": {"origin": [50, 0, 80], "zAxis": [0, 0, 1],
            "xAxis": [1, 0, 0]}, "params": {"diameter": 10.5}}
    through = run(clamp, params={"depth": 16}, ports=[port])
    got = (through.json().get("measurements", {}).get("ports") or [{}])[0]
    check("G3: a C-clamp screw hole through the top arm into the jaw is through, with its breakout depth",
          through.status_code == 200 and got.get("through") is True and abs(got.get("breakout_depth", 0) - 65) < 0.1,
          str(got or through.json().get("error")))
    blind = run(clamp, params={"depth": 8}, ports=[port])
    check("G3: a blind hole in the same arm still bottoms out",
          blind.status_code == 422 and "bottoms out" in blind.json().get("error", ""), blind.json().get("error", ""))

    hub = ("from build123d import *\ndef build(p):\n    _ = p['nonce']\n"
           "    h = Pos(0, 0, 10) * Cylinder(20, 20) - Pos(0, 0, 10) * Cylinder(6, 22)\n"
           "    if p['kind'] == 'key':\n        h = h - Pos(0, 6, 10) * Box(4, 3, 22)\n"
           "    if p['kind'] == 'd':\n        h = h + Pos(0, 5.75, 10) * Box(12, 1.5, 20)\n    return h\n")
    bore = {"key": "bore", "type": "BORE", "pose": {"origin": [0, 0, 20], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]},
            "params": {"diameter": 12}}
    for kind in ("plain", "key", "d"):
        r = run(hub, params={"kind": kind}, ports=[bore])
        got = (r.json().get("measurements", {}).get("ports") or [{}])[0]
        check(f"G3: a {kind} Ø12 bore reads its centre within 0.05 and Ø12",
              r.status_code == 200 and got.get("center_offset", 1) <= 0.05
              and abs(got.get("measured_diameter", 0) - 12) <= 0.05, str(got or r.json().get("error")))

    socket = run(BALL_SOCKET)
    check("G2: the t4-006 ball socket's export mesh is watertight once the pole sliver is welded away",
          socket.status_code == 200, socket.json().get("error", "")[:160])
    touching = run("from build123d import *\ndef build(p):\n    _ = p['nonce']\n"
                   "    return Box(10, 10, 10) + Pos(10, 10, 0) * Box(10, 10, 10)\n")
    check("G2: bodies touching along an edge fail as a non-manifold export, located",
          touching.status_code == 422 and touching.json().get("stage") == "G2"
          and "non-manifold edge(s) at [5.00, 5.00" in touching.json().get("error", ""),
          touching.json().get("error", "")[:160])
    sphere_stl = client.post("/export", json={"parts": [{"code": "from build123d import *\ndef build(p):\n"
                                                         "    return Sphere(10)\n", "params": {"nonce": n},
                                                         "name": "ball", "matrix": []}], "format": "stl"}, timeout=60)
    check("STL of a sphere is watertight (its poles welded)",
          (sphere_stl.json().get("export") or {}).get("watertight") is True, str(sphere_stl.json())[:160])

    optional = THREAD.replace("    return core + sweep(", "    try:\n        core = core + sweep(").replace(
        "is_frenet=True)\n", "is_frenet=True)\n    except Exception:\n        pass\n    return core\n")
    r = run(optional, params={"thread": True})
    check("G0 rejects a thread swept inside try/except: pass",
          r.status_code == 422 and r.json().get("stage") == "G0" and "may not be optional" in r.json().get("hint", ""),
          r.json().get("error", ""))

    thread_asserts = [{"kind": "helix", "radius": 4.5, "z": [3, 13], "pitch": 2.0},
                      {"kind": "line_count", "from": [4.5, 0, 3], "to": [4.5, 0, 13], "crossings_min": 5,
                       "crossings_max": 5}]
    real = run(THREAD, params={"thread": True}, assertions=thread_asserts)
    check("G4b: a real right-hand thread passes helix and line_count", real.status_code == 200,
          real.json().get("error", "")[:200])
    plain = run(THREAD, params={"thread": False}, assertions=thread_asserts)
    errors = [f.get("error", "") for f in plain.json().get("failures") or []]
    check("G4b: a plain cylinder fails both helix and line_count",
          plain.status_code == 422 and any('"helix"' in e for e in errors) and any('"line_count"' in e for e in errors),
          str(errors)[:200])

    screw = run(GROOVE_THREAD, assertions=[{"kind": "helix", "radius": 3.65, "z": [-30, 0], "pitch": 1.25}],
                process={"kind": "fdm"})
    check("the cheat sheet's THREADS groove: M8x1.25x30 is one watertight solid, a helix, and printable",
          screw.status_code == 200, screw.json().get("error", "")[:200])
    fused = run(FUSED_THREAD)
    check("G2: a swept thread fused onto its core is named in the hint, with the groove to use instead",
          fused.status_code == 422 and fused.json().get("stage") == "G2"
          and "swept thread fused onto a core" in fused.json().get("hint", ""), fused.json().get("hint", "")[:200])

    # t4-003: the bore probe alone took 28s on a swept thread (31s on this
    # shorter one) and the job died as "loops forever". The gates' share is the
    # same job's time minus a build-only run of it.
    stud_ports = [{"key": "center_bore", "type": "BORE", "pose": {"origin": [0, 0, 18], "zAxis": [0, 0, 1],
                   "xAxis": [1, 0, 0]}, "params": {"diameter": 8.4}},
                  {"key": "flange_holes", "type": "HOLE_PATTERN", "pose": {"origin": [0, 0, 0], "zAxis": [0, 0, -1],
                   "xAxis": [1, 0, 0]}, "params": {"diameter": 4.5, "count": 2, "pcd": 26, "start_angle": 0}}]
    built = run(THREADED_STUD)
    gated = run(THREADED_STUD, ports=stud_ports)
    gate_s = (gated.json().get("elapsed_ms", 1e6) - built.json().get("elapsed_ms", 0)) / 1000
    check("G3: a swept-thread stud's bore and flange holes probe in under 3s", gated.status_code == 200
          and gate_s < 3, f"gates {gate_s:.1f}s of {gated.json().get('elapsed_ms', 0) / 1000:.1f}s"
          if gated.status_code == 200 else gated.json().get("error", "")[:200])
    from patchcad_kernel.pool import WorkerPool

    with tempfile.TemporaryDirectory() as tmp:
        solo = WorkerPool(1, tmp)
        try:
            slow = solo.execute({"code": THREADED_STUD, "params": {"nonce": n}, "ports": stud_ports, "out_dir": tmp},
                                20, gate_timeout_s=0.2)
        finally:
            solo.shutdown()
    check("a gate out of time is that gate's failure, never code that loops forever",
          slow.get("stage") == "G2" and "timed out on this geometry" in slow.get("error", "")
          and "loops forever" not in slow.get("hint", ""), f"{slow.get('stage')}: {slow.get('error', '')[:160]}")

    fdm = {"kind": "fdm"}
    plate = run("from build123d import *\ndef build(p):\n    _ = p['nonce']\n    return Box(40, 30, p['t'])\n",
                params={"t": 3}, process=fdm)
    check("G4c fdm: a 3mm plate passes", plate.status_code == 200, plate.json().get("error", "")[:160])
    fin = run("from build123d import *\ndef build(p):\n    _ = p['nonce']\n"
              "    return Box(40, 30, 3) + Pos(0, 0, 6.5) * Box(0.3, 20, 4)\n", process=fdm)
    rules = [f.get("rule") for f in fin.json().get("failures") or []]
    check("G4c fdm: a 0.3mm fin fails wall", fin.status_code == 422 and "wall" in rules, str(rules))
    # CADClamp t4-009 and t4-007: chords of 0.01-0.28mm beside 76 deg dovetail
    # edges and along a thread's runout are slivers a slicer drops, not walls.
    dovetail = run(DOVETAIL_T4_009, process=fdm)
    check("G4c fdm: the t4-009 dovetail's 76deg edges are not thin walls", dovetail.status_code == 200,
          dovetail.json().get("error", "")[:160])
    runout = run(RUNOUT_THREAD, process=fdm)
    found = [f.get("message", "") for f in (runout.json().get("measurements", {}).get("process") or {}).get("findings") or []]
    check("G4c fdm: a thread's feathered runout passes, its slivers a finding",
          runout.status_code == 200 and any("slivers" in m for m in found), str(found or runout.json().get("error")))
    # A pen cup's honeycomb: its ribs are thin along their whole length, which
    # no acute edge excuses. 0.6mm ribs print.
    ribs = {rib: run(HONEYCOMB, params={"rib": rib}, process=fdm) for rib in (0.25, 0.6)}
    rules = [f.get("rule") for f in ribs[0.25].json().get("failures") or []]
    check("G4c fdm: a honeycomb with 0.25mm ribs fails wall, with 0.6mm ribs passes",
          ribs[0.25].status_code == 422 and "wall" in rules and ribs[0.6].status_code == 200,
          f"{rules or ribs[0.25].json().get('error')} / {ribs[0.6].json().get('error', 'pass')[:80]}")
    tower = run("from build123d import *\ndef build(p):\n    _ = p['nonce']\n"
                "    return Pos(0, 0, 15) * Box(4, 4, 30) + Pos(30, 0, 28) * Box(60, 4, 4)\n", process=fdm)
    found = [f.get("rule") for f in (tower.json().get("measurements", {}).get("process") or {}).get("findings") or []]
    check("G4c fdm: a part that tips over is a stability FINDING, never a failure",
          "stability" in found and tower.json().get("stage") != "G4c", str(found or tower.json().get("error")))


def audit_fixes(client: httpx.Client) -> None:
    """Kernel audit regressions: instanced rotors sweep about their own axes,
    a re-import is a new build, screw holes go through, opposite flats both
    land on their planes."""
    print("audit regressions")
    import base64
    import tempfile

    import trimesh

    n = int(time.time())
    rotor = ("from build123d import *\ndef build(p):\n    _ = p['nonce']\n"
             "    return Pos(0, 0, 20) * Cylinder(8, 6) + Pos(30, 0, 20) * Box(60, 10, 3) + Pos(-30, 0, 20) * Box(60, 10, 3)\n")
    strut = "from build123d import *\ndef build(p):\n    return Pos(p['x'], p['y'], 15) * Box(4, 4, 30)\n"

    def spin(y):
        # Two placed copies of one rotor node, 200mm apart, each turning about
        # its own axis: one sweep per copy, `moving` naming the copy.
        sweep = {"joint": "j1", "type": "revolute", "direction": [0, 0, 1], "limits": [-180, 180]}
        return client.post("/clash", json={"parts": [
            {"key": "rotor", "code": rotor, "params": {"nonce": n}, "matrix": []},
            {"key": "rotor#1", "code": rotor, "params": {"nonce": n}, "matrix": _at(200, 0, 0)},
            {"key": "strut", "code": strut, "params": {"x": 200, "y": y}, "matrix": []},
        ], "sweeps": [sweep | {"origin": [0, 0, 0], "moving": ["rotor"]},
                      sweep | {"origin": [200, 0, 0], "moving": ["rotor#1"]}]}).json()

    clear = spin(70.0)
    check("swept G5: the second rotor copy turns about its own axis, not the first copy's",
          clear.get("ok") and clear["clash"]["clashes"] == [] and clear["clash"].get("swept") == [],
          str(clear.get("clash"))[:300])
    hit = (spin(45.0).get("clash") or {}).get("swept") or []
    check("swept G5: ... and still hits a strut inside its own blade circle",
          len(hit) == 1 and hit[0]["a"] == "rotor#1" and hit[0]["b"] == "strut", str(hit)[:300])

    imports = pathlib.Path(tempfile.mkdtemp())
    piece = "def build(p):\n    return load_import('piece-0.ply')\n"

    def cook(size):
        trimesh.creation.box((size, size, size)).export(imports / "piece-0.ply")
        return client.post("/execute", json={"code": piece, "params": {}, "import_dir": str(imports)}).json()

    missing = client.post("/execute", json={"code": "def build(p):\n    try:\n        return load_import('nope.step')\n"
                                                "    except FileNotFoundError:\n        return load_import('piece-0.ply')\n",
                                        "params": {}, "import_dir": str(imports)}).json() if cook(5) else {}
    check("load_import raises FileNotFoundError for a missing file, so code can fall back",
          missing.get("ok") and abs(missing["measurements"]["volume_mm3"] - 125) < 1, str(missing)[:200])
    first, second = cook(10), cook(20)
    check("a re-import into the same file is a new build, not the cached old one",
          first.get("ok") and second.get("ok") and second.get("cached") is False
          and abs(second["measurements"]["volume_mm3"] - 8000) < 1, f"{first.get('measurements', {}).get('volume_mm3')} -> "
          f"{second.get('measurements', {}).get('volume_mm3')} cached={second.get('cached')}")

    dimples = ("from build123d import *\ndef build(p):\n    part = Box(60, 60, 6)\n"
               "    for x, y in ((-20, -20), (20, -20), (-20, 20), (20, 20)):\n"
               "        part -= Pos(x, y, 2.625) * Cylinder(2.25, p['deep'])\n    return part\n")
    pattern = [{"key": "bolts", "type": "HOLE_PATTERN", "pose": {"origin": [0, 0, 3], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]},
                "params": {"diameter": 4.5, "nx": 2, "ny": 2, "pitch_x": 40, "pitch_y": 40}}]
    r = client.post("/execute", json={"code": dimples, "params": {"deep": 0.75}, "ports": pattern})
    check("G3 rejects four dimples declared as a bolt pattern", r.status_code == 422 and "bottoms out" in r.json().get("error", ""),
          r.json().get("error", "")[:120])
    cbore = ("from build123d import *\ndef build(p):\n"
             "    return Box(40, 40, 10) - Pos(0, 0, 3.3) * Cylinder(3.25, 3.4) - Pos(0, 0, p['z']) * Cylinder(1.7, p['h'])\n")
    head = [{"key": "cb", "type": "COUNTERBORE", "pose": {"origin": [0, 0, 5], "zAxis": [0, 0, 1], "xAxis": [1, 0, 0]},
             "params": {"diameter": 6.5, "depth": 3.4, "through_diameter": 3.4}}]
    blind = client.post("/execute", json={"code": cbore, "params": {"z": 0.6, "h": 2}, "ports": head})
    through = client.post("/execute", json={"code": cbore, "params": {"z": 0, "h": 12}, "ports": head})
    check("G3 holds the bore under a counterbore to passing through",
          blind.status_code == 422 and "bottoms out" in blind.json().get("error", "") and through.status_code == 200,
          f"{blind.json().get('error', '')[:100]} / {through.status_code}")

    glb = trimesh.Scene([trimesh.creation.icosphere(subdivisions=4, radius=1.0)]).export(file_type="glb")
    fit = client.post("/mesh/fit", json={
        "data_b64": base64.b64encode(glb).decode(), "up": "z", "box": {"center": [0, 0, 0], "dims": [20, 20, 20]},
        "flats": [{"name": "top", "origin": [0, 0, 10], "normal": [0, 0, 1], "size": 6},
                  {"name": "bottom", "origin": [0, 0, -10], "normal": [0, 0, -1], "size": 6}],
    }, timeout=120).json()
    bbox = fit.get("bbox") or {}
    check("/mesh/fit: opposite flats both land on their planes",
          abs(bbox.get("max", [0, 0, 0])[2] - 10) < 0.05 and abs(bbox.get("min", [0, 0, 0])[2] + 10) < 0.05, str(bbox))


def gear_mesh(client: httpx.Client) -> None:
    """A spur pair at m·(z1+z2)/2 meshes: its flanks touch and share, at most,
    what a 0.1mm backlash band would (g5.ts GEAR_MESH_BAND_MM, allowance
    0.2·band·m·t·1.5). Half a tooth out of phase, or 0.3mm too close, it shares
    far more and is a clash. Swept, the pair turns coupled at the ratio and
    stays in mesh; turned the same way, or with the pinion frozen, it does not."""
    print("gear mesh")
    n = int(time.time())
    gear = ("from build123d import *\ndef build(p):\n    _ = p['nonce']\n"
            "    g = involute_gear(1, int(p['teeth']), 20, 8, p['phase'])\n"
            "    return g - Cylinder(2.5, 16)\n")
    centre = 1 * (17 + 34) / 2
    allow = [{"a": "pinion", "b": "wheel", "volume_mm3": 0.2 * 0.1 * 1 * 8 * 1.5}]

    def at(x: float) -> list[float]:
        return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]

    def pair(phase: float, x: float = centre, sweeps: list | None = None) -> dict:
        return client.post("/clash", json={"parts": [
            {"key": "pinion", "code": gear, "params": {"nonce": n, "teeth": 17, "phase": 0}, "matrix": []},
            {"key": "wheel", "code": gear, "params": {"nonce": n, "teeth": 34, "phase": phase}, "matrix": at(x)},
        ], "allow": allow, "sweeps": sweeps or []}, timeout=120).json()

    meshed = pair(180 / 34)
    cm = meshed.get("clash") or {}
    check("G5 gear mesh: a pair at m(z1+z2)/2, half a tooth apart, is not a clash",
          meshed["ok"] and cm.get("clashes") == [] and cm.get("errors") == [], str(cm)[:300])
    wrong = (pair(0).get("clash") or {}).get("clashes") or []
    check("G5 gear mesh: the same pair tooth-on-tooth is a clash past the allowance",
          len(wrong) == 1 and wrong[0]["volume_mm3"] > 10, str(wrong)[:200])
    close = (pair(180 / 34, centre - 0.3).get("clash") or {}).get("clashes") or []
    check("G5 gear mesh: 0.3mm inside the centre distance is a clash", len(close) == 1, str(close)[:200])

    # hand-winch: 15T driving 45T at m1.5, past bd_warehouse's z <= 41. An
    # odd wheel already has a gap facing the pinion; turned half a tooth it does not.
    big = gear.replace("involute_gear(1,", "involute_gear(1.5,")

    def winch(phase: float) -> list:
        return (client.post("/clash", json={"parts": [
            {"key": "pinion", "code": big, "params": {"nonce": n, "teeth": 15, "phase": 0}, "matrix": []},
            {"key": "wheel", "code": big, "params": {"nonce": n, "teeth": 45, "phase": phase}, "matrix": at(1.5 * 60 / 2)},
        ], "allow": [{"a": "pinion", "b": "wheel", "volume_mm3": 0.2 * 0.1 * 1.5 * 8 * 1.5}], "sweeps": []}, timeout=120).json()
            .get("clash") or {}).get("clashes")
    meshed45, wrong45 = winch(0), winch(4)
    check("G5 gear mesh: 15T on a 45T m1.5 wheel in phase is clean, half a tooth off clashes",
          meshed45 == [] and len(wrong45 or []) == 1, f"{meshed45} / {wrong45}"[:300])

    def turn(ratio: float | None) -> dict:
        sweep = {"joint": "g1", "type": "revolute", "origin": [centre, 0, 0], "direction": [0, 0, 1], "limits": [0, 20], "moving": ["wheel"]}
        if ratio is not None:
            sweep["coupled"] = [{"origin": [0, 0, 0], "direction": [0, 0, 1], "ratio": ratio, "moving": ["pinion"]}]
        return pair(180 / 34, sweeps=[sweep]).get("clash") or {}

    coupled = turn(-34 / 17)
    check("swept G5: a gear pair turned together at -z2/z1 stays in mesh",
          coupled.get("swept") == [] and coupled.get("errors") == [], str(coupled.get("swept"))[:300])
    backwards = turn(34 / 17).get("swept") or []
    frozen = turn(None).get("swept") or []
    check("swept G5: turned the same way, or with the pinion frozen, the teeth collide",
          len(backwards) == 1 and len(frozen) == 1 and backwards[0]["joint"] == "g1", f"{backwards} / {frozen}"[:300])


def segmentation() -> None:
    """Joint mode "auto": sites, not cuts. Every site is a disk of the width the
    widest fastening rule needs, with a column of material behind it into both
    pieces; a neck too thin for any of them offers no site at all, rather than
    a hole with 0.75mm walls. Then the features the server's rules ask for are
    cut by `cut_joints` and the G3 probes pass them."""
    print("segmentation joints")
    import trimesh

    from patchcad_kernel.gates import GateError, _probe_port
    from patchcad_kernel.meshpart import MeshPart, _joint_need, cut_joints, segment

    need = _joint_need("M3")
    _, itfs = segment([trimesh.creation.box((120, 40, 30))], 2, "auto", "M3")
    sites = itfs[0].candidates if itfs else []
    check("auto joints report sites with walls, and cut nothing",
          len(sites) == 2 and all(c["wallA"] >= 50 and c["wallB"] >= 50 and c["face_size"] == need for c in sites)
          and itfs[0].holes == [] and itfs[0].pegs == [], str(sites)[:300])
    a = trimesh.creation.box((40, 40, 40))
    a.apply_translation([-30, 0, 0])
    b = trimesh.creation.box((40, 40, 40))
    b.apply_translation([30, 0, 0])
    neck = trimesh.creation.box((22, 6, 6))
    _, itfs = segment([trimesh.boolean.union([a, b, neck], engine="manifold")], 2, "auto", "M3")
    check(f"a 6mm neck offers no joint site (needs Ø{need:g})", len(itfs) == 1 and itfs[0].candidates == [],
          str([i.candidates for i in itfs]))

    # A 20mm slab, cut face at z=0 (+z out), back face at z=-20.
    slab = MeshPart(trimesh.creation.box(bounds=[[-20, -20, -20], [20, 20, 0]]))
    up, down, x = [0, 0, 1], [0, 0, -1], [1, 0, 0]
    cut = cut_joints(slab, [
        {"o": [-8, 0, 0], "z": up, "x": x, "kind": "round", "d": 4.0, "depth": 6.3},
        {"o": [8, 0, -20], "z": down, "x": x, "kind": "round", "d": 6.5, "depth": 3.4, "through": 3.4, "access": 6.5},
        {"o": [0, 10, -20], "z": down, "x": x, "kind": "hex", "d": 5.7, "depth": 2.6, "access": 7.0},
    ])
    ports = [
        {"key": "pocket", "type": "INSERT_POCKET", "pose": {"origin": [-8, 0, 0], "zAxis": up, "xAxis": x},
         "params": {"diameter": 4.0, "depth": 5.8}},
        {"key": "cbore", "type": "COUNTERBORE", "pose": {"origin": [8, 0, -20], "zAxis": down, "xAxis": x},
         "params": {"diameter": 6.5, "depth": 3.4, "through_diameter": 3.4}},
        {"key": "trap", "type": "NUT_TRAP", "pose": {"origin": [0, 10, -20], "zAxis": down, "xAxis": x},
         "params": {"af": 5.5, "depth": 2.4}},
    ]
    for port in ports:
        try:
            _probe_port(cut, port)
            check(f"cut_joints cuts a {port['type']} its probe passes", True)
        except GateError as err:
            check(f"cut_joints cuts a {port['type']} its probe passes", False, str(err))
    check("cut_joints leaves a watertight piece", cut.is_valid)


def catalog_parts() -> None:
    """Every catalog family's registry code, built here and held to G2. The code
    is TypeScript codegen (src/registry.ts), so the live vitest that owns it
    runs against this kernel rather than smoke.py carrying a copy of it."""
    print("catalog parts")
    from patchcad_kernel.meshpart import _catalog_clearance
    check("kernel reads ISO 273 clearances from the shared catalog",
          (_catalog_clearance("M3"), _catalog_clearance("M8")) == (3.4, 9.0))
    pkg = pathlib.Path(__file__).parent.parent
    proc = subprocess.run([str(pkg / "node_modules" / ".bin" / "vitest"), "run", "src/registry.kernel.test.ts"],
                          cwd=pkg, capture_output=True, text=True, check=False,
                          env={**os.environ, "PATCHCAD_KERNEL_LIVE": "1",
                               "PATCHCAD_KERNEL_PORT": BASE.rsplit(":", 1)[1]})
    tail = (proc.stdout + proc.stderr).strip().splitlines()
    check("every catalog family and size builds one valid solid", proc.returncode == 0,
          next((ln.strip() for ln in tail if "Tests" in ln), tail[-1] if tail else "no output"))


def instructions(client: httpx.Client) -> None:
    """Assembly instructions. A pin dropped into a plate's hole clears; a cap
    already over the hole blocks it, and a pin that clashes at rest blocks
    nothing it did not already share there (that is G5's finding). Then one
    step drawn: its picture, an SVG page per page, the PDF and the HTML, served
    back, and a cache hit the second time."""
    print("assembly instructions")
    n = int(time.time())
    plate = ("from build123d import *\ndef build(p):\n    _ = p['nonce']\n"
             "    return Box(40, 40, 6) - Cylinder(3.2, 6)\n")
    pin = "from build123d import *\ndef build(p):\n    return Pos(0, 0, p['z']) * Cylinder(3, 12)\n"
    cap = "from build123d import *\ndef build(p):\n    return Pos(0, 0, 14) * Box(20, 20, 4)\n"
    parts = [{"key": "plate", "code": plate, "params": {"nonce": n}, "matrix": []},
             {"key": "pin", "code": pin, "params": {"z": 3}, "matrix": []},
             {"key": "cap", "code": cap, "params": {}, "matrix": []}]

    def sweep(still: list[str]) -> dict:
        return client.post("/instructions/insertions", json={"parts": parts, "checks": [
            {"id": "1:0", "moving": ["pin"], "still": still, "direction": [0, 0, -1]}]}).json()

    clear = sweep(["plate"])
    blocked = sweep(["plate", "cap"])
    hit = ((blocked.get("insertions") or {}).get("checks") or [{}])[0].get("blocked") or []
    check("instructions: a pin drops into its hole, and a cap already over it blocks the way in",
          clear["ok"] and clear["insertions"]["checks"][0]["blocked"] == [] and len(hit) == 1
          and hit[0]["part"] == "pin" and hit[0]["by"] == "cap", f"{clear.get('insertions')} / {blocked.get('insertions')}")
    fat = "from build123d import *\ndef build(p):\n    return Pos(0, 0, 3) * Cylinder(4, 12)\n"
    rest = client.post("/instructions/insertions", json={"parts": [parts[0], {"key": "pin", "code": fat, "params": {}, "matrix": []}],
                                                         "checks": [{"id": "1:0", "moving": ["pin"], "still": ["plate"],
                                                                     "direction": [0, 0, -1]}]}).json()
    check("instructions: overlap a pair already has at rest is G5's, not a blocked path",
          rest["ok"] and rest["insertions"]["checks"][0]["blocked"] == [], str(rest)[:300])

    document = {"title": "Pin in a plate", "subtitle": "1 step.", "summary": "1 made part, 1 bought part, 1 step.",
                "tools": ["2 mm hex key"], "problems": [], "made": [{"label": "Plate (fdm, PLA)", "qty": 1}],
                "items": [{"id": "PIN-6x12", "label": "Ø6×12 pin", "qty": 1, "gauge_mm": 12, "code": pin, "params": {"z": 0}}],
                "steps": [{"n": 1, "title": "Press the pin into the Plate", "notes": ["Start with the Plate."],
                           "context": ["plate"], "moving": [{"key": "pin", "direction": [0, 0, -1]}],
                           "callouts": [], "hardware": [{"label": "Ø6×12 pin", "item": "PIN-6x12", "qty": 1}]}]}
    body = {"parts": parts[:2], "document": document}
    first = client.post("/instructions/document", json=body, timeout=120).json()
    pages = first.get("pages") or []
    served = [client.get(u) for u in [*pages, first.get("pdf", "/none"), first.get("html", "/none")]]
    check("instructions: cover, hardware and step pages drawn, as SVG, PDF and HTML",
          first.get("ok") and len(pages) == 3 and all(r.status_code == 200 for r in served)
          and served[-2].content[:5] == b"%PDF-" and b"<svg" in served[-1].content and b"Press the pin" in served[2].content,
          str(first)[:300])
    picture = client.get(pages[0].replace("page-1.svg", "step-1.png")) if pages else None
    check("instructions: the step picture is a PNG", picture is not None and picture.content[:4] == b"\x89PNG")
    again = client.post("/instructions/document", json=body).json()
    check("instructions: the same document is a cache hit", again.get("cached") is True and again.get("pdf") == first.get("pdf"))
    check("instructions: only instruction files are served from the cache directory",
          client.get(pages[0].replace("page-1.svg", "instructions.json")).status_code == 404 if pages else False)

    # Inside-out: a bearing seated in the INNER face of a frame's side plate is
    # pressed outward from the cavity. Through the plate it is blocked; from
    # inside it backs out into the cavity, and it can get there sideways only
    # if the frame is open somewhere it fits through.
    frame = ("from build123d import *\ndef build(p):\n    _ = p['nonce']\n"
             "    f = Pos(27, 0, 0) * Box(6, 40, 40) + Pos(-27, 0, 0) * Box(6, 40, 40) + Pos(0, 0, -23) * Box(60, 40, 6)\n"
             "    if p['closed']:\n"
             "        f = f + Pos(0, 0, 23) * Box(60, 40, 6) + Pos(0, 23, 0) * Box(60, 6, 52) + Pos(0, -23, 0) * Box(60, 6, 52)\n"
             "    return f - Pos(26, 0, 0) * Rot(0, 90, 0) * Cylinder(8.1, 4)\n")
    bearing = "from build123d import *\ndef build(p):\n    return Pos(25, 0, 0) * Rot(0, 90, 0) * Cylinder(8, 6)\n"

    def inside(closed: bool) -> list[dict]:
        parts = [{"key": "frame", "code": frame, "params": {"nonce": n, "closed": closed}, "matrix": []},
                 {"key": "brg", "code": bearing, "params": {}, "matrix": []}]
        return client.post("/instructions/insertions", json={"parts": parts, "checks": [
            {"id": "through", "moving": ["brg"], "still": ["frame"], "direction": [-1, 0, 0]},
            {"id": "inside", "moving": ["brg"], "still": ["frame"], "direction": [1, 0, 0]}]},
            timeout=180).json()["insertions"]["checks"]

    u_frame, box = inside(False), inside(True)
    check("instructions: a bearing in a U-frame's inner face is blocked through the plate, pressed from inside is reachable",
          u_frame[0]["blocked"] != [] and u_frame[1]["blocked"] == [] and u_frame[1].get("enters") is not None,
          str(u_frame)[:300])
    check("instructions: the same bearing in a fully closed box cannot be reached from inside",
          box[1]["blocked"] != [] and all(b.get("enclosed") for b in box[1]["blocked"]), str(box)[:300])


if __name__ == "__main__":
    main()
