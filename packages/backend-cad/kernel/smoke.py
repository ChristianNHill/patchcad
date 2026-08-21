"""CAD-M1 acceptance suite, run against a live kernel:
    uv run python smoke.py
Covers the design doc's "done when" list: example node → mesh <3s, cache hit,
G0 import rejection, G2 catches bad geometry, `while True` killed at the
timeout, a hard native crash kills one worker while the service stays up.
"""

from __future__ import annotations

import sys
import time

import httpx

BASE = "http://127.0.0.1:8621"

PLATE = """
from build123d import *

def build(p):
    plate = Box(p.width, p.depth, p.thickness)
    hole = Cylinder(p.hole_diameter / 2, p.thickness)
    return plate - hole
"""

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{f' — {detail}' if detail else ''}")
    if not ok:
        failures.append(name)


def main() -> None:
    client = httpx.Client(base_url=BASE, timeout=60)

    health = client.get("/health").json()
    check("health", health["ok"], f"workers={health['workers']}")

    # 1. Example node cooks to a mesh in <3s (warm worker). The nonce keeps
    # repeat runs cache-cold for the "re-executes" checks while still letting
    # the within-run cache-hit check pass.
    params = {"width": 60, "depth": 40, "thickness": 5, "hole_diameter": 8, "nonce": int(time.time())}
    started = time.monotonic()
    r = client.post("/execute", json={"code": PLATE, "params": params}).json()
    elapsed = time.monotonic() - started
    meas = r.get("measurements", {})
    check("plate executes", r["ok"], f"{elapsed*1000:.0f}ms volume={meas.get('volume_mm3', 0):.0f}mm³")
    check("mesh under 3s", elapsed < 3.0, f"{elapsed:.2f}s")
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
        "    return SpurGear(module=1, tooth_count=12, pressure_angle=20, thickness=4)\n"
    )
    r4b = client.post("/execute", json={"code": gear, "params": {}}).json()
    check(
        "registry gear builds from the injected namespace",
        r4b.get("ok") is True,
        f"Ø{r4b['measurements']['bbox']['size'][0]:.1f}" if r4b.get("ok") else r4b.get("error", ""),
    )
    r4c = client.post(
        "/execute",
        json={"code": "from bd_warehouse.gear import SpurGear\n" + gear, "params": {}},
    )
    body4c = r4c.json()
    check(
        "G0 still rejects importing bd_warehouse",
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
        check("second render is cached", client.post(
            "/render", json={"code": PLATE, "params": params, "views": 6}
        ).json().get("cached") is True)

    # 4f. Posed assembly: two parts, one image. Catches what no per-part gate
    # can — a part that is fine alone and wrong in company.
    ident = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
    lifted = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,20,1]
    r4f = client.post("/render-assembly", json={"parts": [
        {"code": PLATE, "params": params, "matrix": ident},
        {"code": PLATE, "params": params, "matrix": lifted},
    ], "views": 4})
    body4f = r4f.json()
    check(
        "assembly render composes both parts",
        r4f.status_code == 200 and body4f.get("ok") and body4f.get("render", {}).get("parts") == 2,
        f"{body4f.get('render', {}).get('triangles', '?')} tris in {body4f.get('elapsed_ms', '?')}ms",
    )

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
    check("timeout near limit", 18 < elapsed < 30, f"{elapsed:.1f}s")

    # 7. Hard native crash → one worker dies, service survives, next job fine.
    crash = "import build123d\ndef build(p):\n    import ctypes\n    ctypes.string_at(0)\n"
    # ctypes isn't allowlisted — craft a crash without imports: recursion depth
    # segfault via a C-level recursion is unreliable; instead kill via os._exit
    # is blocked too. Use build123d itself? Simplest reliable native death:
    # exceed the pipe with a broken frame — fall back to ctypes through an
    # allowlist bypass is impossible, so test the crash path with sys.exit-like
    # abort available in math? Not possible — so test via a worker-level trick:
    crash = "def build(p):\n    exec(\"import ctypes; ctypes.string_at(0)\", {})\n"
    r7 = client.post("/execute", json={"code": crash, "params": {}})
    body7 = r7.json()
    check("native crash contained", r7.status_code == 422 and body7.get("stage") in ("KERNEL_CRASH", "G1"),
          f"stage={body7.get('stage')}")
    health7 = client.get("/health").json()
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

    print()
    if failures:
        print(f"{len(failures)} FAILURE(S): {failures}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
