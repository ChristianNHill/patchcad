"""Verification gates, worker-side only (this module imports build123d,
which is heavy — the parent process must never import it).

G0  static AST scan: import allowlist, `build(p)` entrypoint present.
G1  execute `build(p)` and get a shape back.
G2  validity: ≥1 solid, positive volume, BRepCheck-valid, sane bounding box.

Every failure carries a `hint` templated for the repair prompt.
"""

from __future__ import annotations

import ast
import math
from typing import Any

ALLOWED_IMPORTS = {"build123d", "math"}

# The architect-facing sanity ceiling: parts larger than this are almost
# certainly a units mistake (meters where millimeters were meant).
MAX_DIMENSION_MM = 10_000.0


class GateError(Exception):
    def __init__(self, stage: str, error: str, hint: str = ""):
        super().__init__(error)
        self.stage = stage
        self.error = error
        self.hint = hint


class Params(dict):
    """Node convention is `def build(p)`; support both p.width and p["width"].
    Missing keys name the declared params — a repairable diagnostic instead of
    a bare KeyError the repair loop can't act on."""

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError:
            raise AttributeError(f"no param {name!r} — declared params: {sorted(self)}") from None

    def __missing__(self, name: str) -> Any:
        raise KeyError(f"no param {name!r} — declared params: {sorted(self)}")


def g0_scan(code: str) -> ast.Module:
    try:
        tree = ast.parse(code)
    except SyntaxError as err:
        raise GateError("G0", f"syntax error: {err}", "fix the Python syntax error at the reported line") from None

    for node in ast.walk(tree):
        roots: list[str] = []
        if isinstance(node, ast.Import):
            roots = [alias.name.split(".")[0] for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            roots = [(node.module or "").split(".")[0]]
        for root in roots:
            if root not in ALLOWED_IMPORTS:
                raise GateError(
                    "G0",
                    f"import of {root!r} is not allowed",
                    f"only these imports are permitted: {sorted(ALLOWED_IMPORTS)} — express the node with build123d alone",
                )

    has_build = any(
        isinstance(n, ast.FunctionDef) and n.name == "build" for n in tree.body
    )
    if not has_build:
        raise GateError(
            "G0",
            "no top-level `def build(p)` function",
            "the node must define exactly `def build(p):` returning a build123d Part",
        )
    return tree


def g1_execute(tree: ast.Module, params: dict[str, Any], extra_ns: dict[str, Any] | None = None) -> Any:
    namespace: dict[str, Any] = dict(extra_ns or {})
    try:
        exec(compile(tree, "<node>", "exec"), namespace)  # noqa: S102 — sandboxed by worker rlimits/timeout
    except Exception as err:  # noqa: BLE001 — anything the code raises is a G1 report
        raise GateError("G1", f"module-level execution failed: {type(err).__name__}: {err}",
                        "move all logic inside build(p); module level should only import and define") from None

    build = namespace.get("build")
    try:
        shape = build(Params(params))
    except Exception as err:  # noqa: BLE001
        raise GateError("G1", f"build(p) raised {type(err).__name__}: {err}",
                        _repair_hint_for(err)) from None
    if shape is None:
        raise GateError("G1", "build(p) returned None", "return the final Part from build(p)")
    return shape


def _repair_hint_for(err: Exception) -> str:
    """Targeted hints for the hallucination classes weak models actually
    produce — fuzzy did-you-mean against the REAL build123d namespace."""
    import difflib
    import re

    msg = str(err)
    if isinstance(err, NameError):
        m = re.search(r"name '(\w+)'", msg)
        if m:
            import build123d

            candidates = [n for n in dir(build123d) if not n.startswith("_")]
            close = difflib.get_close_matches(m.group(1), candidates, n=2, cutoff=0.5)
            if close:
                return f"'{m.group(1)}' does not exist in build123d — did you mean {' or '.join(close)}? Use `from build123d import *`"
            return f"'{m.group(1)}' does not exist in build123d — stick to the documented API (Box, Cylinder, Pos, Rot, fillet, chamfer)"
    if isinstance(err, AttributeError):
        if re.search(r"drill|hole|cut", msg, re.IGNORECASE):
            return "shapes have no drill/hole methods — cut holes by subtracting: shape - Pos(x, y, 0) * Cylinder(r, depth)"
        m = re.search(r"has no attribute '(\w+)'", msg)
        if m:
            return f"'{m.group(1)}' is not a shape method — compose with + - & operators and Pos/Rot placement instead"
    if "Align" in msg or "align" in msg:
        return "omit align arguments — primitives are centered at the origin; place them with Pos(x, y, z) * shape"
    return "check parameter names against the contract and build123d call signatures"


def g2_validity(shape: Any) -> dict[str, Any]:
    solids = shape.solids() if hasattr(shape, "solids") else []
    if len(solids) == 0:
        raise GateError("G2", "result contains no solids",
                        "the expression must produce solid geometry (e.g. extrude sketches, use Box/Cylinder)")

    volume = float(shape.volume)
    if not (volume > 0) or math.isnan(volume):
        raise GateError("G2", f"non-positive volume ({volume:.3f} mm³)",
                        "booleans likely subtracted everything — check feature positions and sizes")

    # build123d ≤0.9 exposes is_valid() as a method, ≥0.11 as a property.
    validity = getattr(shape, "is_valid", True)
    if callable(validity):
        validity = validity()
    if not validity:
        raise GateError("G2", "BRep validity check failed",
                        "a boolean or fillet produced corrupt topology — simplify or reorder the failing feature")

    bbox = shape.bounding_box()
    size = [float(bbox.size.X), float(bbox.size.Y), float(bbox.size.Z)]
    if max(size) > MAX_DIMENSION_MM:
        raise GateError("G2", f"bounding box {size} mm exceeds {MAX_DIMENSION_MM} mm",
                        "dimensions look like a unit mistake — build123d works in millimeters")
    if max(size) <= 0:
        raise GateError("G2", "degenerate (zero-size) bounding box",
                        "the result has no extent — check that sketches are extruded")

    return {
        "volume_mm3": volume,
        "area_mm2": float(shape.area),
        "solids": len(solids),
        "bbox": {
            "min": [float(bbox.min.X), float(bbox.min.Y), float(bbox.min.Z)],
            "max": [float(bbox.max.X), float(bbox.max.Y), float(bbox.max.Z)],
            "size": size,
        },
    }


def export_glb(shape: Any, path: str) -> None:
    if hasattr(shape, "export_glb"):  # imported MeshPart exports itself
        shape.export_glb(path)
        return
    from build123d import export_gltf  # deferred: import cost paid once per worker

    export_gltf(shape, path, binary=True)


# ---------------------------------------------------------------------------
# G3 — port-geometry consistency probes.
#
# A port is a declaration in the part's LOCAL frame: {key, type, pose, params}
# with pose = {origin, zAxis, xAxis} and the convention that +z points OUT of
# the material. Probes classify a handful of points against the actual solid
# and, for hole-like ports, binary-search the real diameter so the failure
# hint can say "expected Ø4.5, measured Ø6.0".
# ---------------------------------------------------------------------------

PROBE_DEPTH_MM = 0.6      # how far below the surface hole probes sample
PROBE_EPS_MM = 0.2        # how far above/below a face the face probes sample
DIAMETER_TOL_MM = 0.25    # measurement resolution + acceptable modeling slop
PROBE_DIRECTIONS = 8

HOLE_LIKE = {"CLEARANCE_HOLE", "BORE", "SCREW_SEAT"}


def _unit(v: list[float]) -> list[float]:
    n = math.sqrt(sum(c * c for c in v))
    if n < 1e-9:
        raise GateError("G3", "port pose has a zero-length axis", "declare unit-ish zAxis/xAxis vectors")
    return [c / n for c in v]


def _frame(pose: dict[str, Any]) -> tuple[list[float], list[float], list[float], list[float]]:
    o = [float(c) for c in pose["origin"]]
    z = _unit([float(c) for c in pose["zAxis"]])
    x = _unit([float(c) for c in pose["xAxis"]])
    # re-orthonormalize x against z, then y = z × x
    dot = sum(a * b for a, b in zip(x, z))
    x = _unit([a - dot * b for a, b in zip(x, z)])
    y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
    return o, x, y, z


def _at(o: list[float], x: list[float], y: list[float], z: list[float],
        u: float, v: float, w: float) -> tuple[float, float, float]:
    return (
        o[0] + x[0] * u + y[0] * v + z[0] * w,
        o[1] + x[1] * u + y[1] * v + z[1] * w,
        o[2] + x[2] * u + y[2] * v + z[2] * w,
    )


def _in_material(shape: Any, p: tuple[float, float, float]) -> bool:
    return bool(shape.is_inside(p))


def _measure_hole_radius(shape: Any, frame, max_r: float, w: float) -> float:
    """Median over directions of the NEAREST void→material crossing. An
    outward march (then bisection) finds the hole wall itself; directions
    where the probe leaves the part entirely (hole near an edge) see no
    crossing and are excluded rather than skewing the measurement."""
    o, x, y, z = frame
    step = 0.25
    radii: list[float] = []
    for k in range(PROBE_DIRECTIONS):
        theta = 2 * math.pi * k / PROBE_DIRECTIONS
        du, dv = math.cos(theta), math.sin(theta)
        lo = 0.0
        crossing: float | None = None
        r = step
        while r <= max_r:
            if _in_material(shape, _at(o, x, y, z, du * r, dv * r, w)):
                crossing = r
                break
            lo = r
            r += step
        if crossing is None:
            continue  # probe exited the part — this direction sees the rim, not the wall
        hi = crossing
        for _ in range(12):
            mid = (lo + hi) / 2
            if _in_material(shape, _at(o, x, y, z, du * mid, dv * mid, w)):
                hi = mid
            else:
                lo = mid
        radii.append((lo + hi) / 2)
    if len(radii) < 3:
        return max_r  # unmeasurable — surfaces as an implausible diameter
    radii.sort()
    return radii[len(radii) // 2]


def _port_diameter(port: dict[str, Any]) -> float:
    """Models name this key inconsistently; accept the common aliases and turn
    a miss into a repairable G3 report instead of a raw KeyError."""
    params = port.get("params", {})
    for key in ("diameter", "dia", "holeDia", "hole_diameter", "d", "boreDia"):
        if key in params:
            try:
                return float(params[key])
            except (TypeError, ValueError):
                break
    raise GateError(
        "G3",
        f'port "{port.get("key", "?")}" ({port.get("type", "?")}) declares no numeric diameter (params: {sorted(params)})',
        "hole-like ports must carry params.diameter in mm",
    )


def _probe_hole(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    d = _port_diameter(port)
    frame = _frame(port["pose"])
    o, x, y, z = frame
    w = -PROBE_DEPTH_MM

    if _in_material(shape, _at(o, x, y, z, 0, 0, w)):
        raise GateError("G3", f'port "{port["key"]}" ({port["type"]}): no hole found at the declared origin',
                        "cut the hole exactly at the contract pose, or fix the pose the code assumes")

    measured = 2 * _measure_hole_radius(shape, frame, max_r=d * 1.5 + 2.0, w=w)
    if abs(measured - d) > DIAMETER_TOL_MM:
        raise GateError("G3", f'port "{port["key"]}" ({port["type"]}): expected Ø{d:g}, measured Ø{measured:.2f}',
                        f"change the hole feature to Ø{d:g} as pinned in the contract")
    return {"key": port["key"], "type": port["type"], "measured_diameter": round(measured, 3)}


def _probe_flat_face(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """Square-grid probe by default; `ring_diameter` switches to an annular
    probe for faces with a void center (a screw head's seat, a boss rim)."""
    params = port.get("params", {})
    o, x, y, z = _frame(port["pose"])
    ring_d = params.get("ring_diameter")
    if ring_d is not None:
        r = float(ring_d) / 2
        samples = [(r * math.cos(2 * math.pi * k / PROBE_DIRECTIONS),
                    r * math.sin(2 * math.pi * k / PROBE_DIRECTIONS))
                   for k in range(PROBE_DIRECTIONS)]
        probed = {"ring_diameter": float(ring_d)}
    else:
        size = float(params.get("size", 4.0))
        if size < 1.0:  # sliver face: a grid would poke into air — center only
            samples = [(0.0, 0.0)]
            probed = {"probed_size": 0.0}
        else:
            s = size / 2
            samples = [(u, v) for u in (-s, 0.0, s) for v in (-s, 0.0, s)]
            probed = {"probed_size": size}
    for u, v in samples:
        above = _at(o, x, y, z, u, v, PROBE_EPS_MM)
        below = _at(o, x, y, z, u, v, -PROBE_EPS_MM)
        if _in_material(shape, above):
            raise GateError("G3", f'port "{port["key"]}" (FLAT_FACE): material found above the declared face',
                            "the face must be exposed surface at the contract pose with +z pointing out of the material")
        if not _in_material(shape, below):
            raise GateError("G3", f'port "{port["key"]}" (FLAT_FACE): no material just below the declared face',
                            "the surface must exist (flat, at least the declared size) exactly at the contract pose")
    return {"key": port["key"], "type": port["type"], **probed}


def _probe_boss(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    params = port["params"]
    od = float(params["outer_diameter"])
    pilot = float(params.get("pilot_diameter", 0))
    frame = _frame(port["pose"])
    o, x, y, z = frame
    w = -PROBE_DEPTH_MM

    ring_r = od / 2 - 0.3
    hits = 0
    for k in range(PROBE_DIRECTIONS):
        theta = 2 * math.pi * k / PROBE_DIRECTIONS
        if _in_material(shape, _at(o, x, y, z, ring_r * math.cos(theta), ring_r * math.sin(theta), w)):
            hits += 1
    if hits < PROBE_DIRECTIONS - 1:
        raise GateError("G3", f'port "{port["key"]}" (SCREW_BOSS): boss wall missing (Ø{od:g} ring {hits}/{PROBE_DIRECTIONS} in material)',
                        f"model a boss of outer Ø{od:g} centered at the contract pose")

    result = {"key": port["key"], "type": port["type"], "ring_hits": hits}
    if pilot > 0:
        if _in_material(shape, _at(o, x, y, z, 0, 0, w)):
            raise GateError("G3", f'port "{port["key"]}" (SCREW_BOSS): pilot hole Ø{pilot:g} missing',
                            f"cut a Ø{pilot:g} pilot at the boss center")
        measured = 2 * _measure_hole_radius(shape, frame, max_r=od / 2, w=w)
        if abs(measured - pilot) > DIAMETER_TOL_MM:
            raise GateError("G3", f'port "{port["key"]}" (SCREW_BOSS): expected pilot Ø{pilot:g}, measured Ø{measured:.2f}',
                            f"change the pilot hole to Ø{pilot:g} as pinned in the contract")
        result["measured_pilot"] = round(measured, 3)
    return result


def g3_ports(shape: Any, ports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    report: list[dict[str, Any]] = []
    for port in ports:
        ptype = port.get("type", "")
        if ptype in HOLE_LIKE:
            report.append(_probe_hole(shape, port))
        elif ptype == "FLAT_FACE":
            report.append(_probe_flat_face(shape, port))
        elif ptype == "SCREW_BOSS":
            report.append(_probe_boss(shape, port))
        else:
            report.append({"key": port.get("key", "?"), "type": ptype, "skipped": "no probe for this type yet"})
    return report


# ---------------------------------------------------------------------------
# G4 — envelope containment: every tessellation vertex must lie inside the
# union of the declared primitives (part-local frame), inflated by margin.
# ---------------------------------------------------------------------------

ENVELOPE_MARGIN_MM = 0.5
TESSELLATION_TOL = 0.5


def _inside_primitive(p: Any, prim: dict[str, Any], margin: float) -> bool:
    c = prim["center"]
    if prim["kind"] == "box":
        s = prim["size"]
        return all(abs(float(p[i]) - float(c[i])) <= float(s[i]) / 2 + margin for i in range(3))
    if prim["kind"] == "cylinder":  # axis-aligned +z, v1
        r = float(prim["radius"]) + margin
        h = float(prim["height"]) / 2 + margin
        dx, dy = float(p[0]) - float(c[0]), float(p[1]) - float(c[1])
        return dx * dx + dy * dy <= r * r and abs(float(p[2]) - float(c[2])) <= h
    return False


def g4_envelope(shape: Any, envelope: list[dict[str, Any]]) -> dict[str, Any]:
    vertices, _tris = shape.tessellate(TESSELLATION_TOL)
    worst: tuple[float, Any] | None = None
    violations = 0
    for vec in vertices:
        p = (float(vec.X), float(vec.Y), float(vec.Z))
        if not any(_inside_primitive(p, prim, ENVELOPE_MARGIN_MM) for prim in envelope):
            violations += 1
            # crude severity: distance beyond the nearest primitive center box
            excess = min(
                max(
                    (abs(p[i] - float(prim["center"][i])) - (float(prim["size"][i]) / 2 if prim["kind"] == "box" else float(prim.get("radius", 0))))
                    for i in range(3)
                )
                for prim in envelope
            ) if envelope else 0.0
            if worst is None or excess > worst[0]:
                worst = (excess, p)
    if violations:
        excess, p = worst  # type: ignore[misc]
        raise GateError(
            "G4",
            f"{violations} mesh vertices escape the declared envelope "
            f"(worst ≈{max(excess, 0):.1f} mm beyond, near [{p[0]:.1f}, {p[1]:.1f}, {p[2]:.1f}])",
            "shrink the offending feature to fit the envelope, or request an envelope expansion from the architect",
        )
    return {"vertices_checked": len(vertices), "violations": 0}
