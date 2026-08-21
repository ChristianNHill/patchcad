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
PROBE_INSET_MM = 0.3      # standoff from a declared edge; absolute, never a fraction
DEPTH_TOL_MM = 0.25       # channel floor tolerance; its own axis, its own number

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


def _march(shape: Any, frame, du: float, dv: float, w: float, max_r: float,
           find: str = "material") -> float | None:
    """Distance along (du, dv) at depth w to the first change of state, or None
    if it never changes within max_r. Outward step then 12 bisections, so the
    answer is good to max_r/2**12 regardless of the step.

    This is the one directional measurement primitive. It was inlined in
    _measure_hole_radius with the median-over-8-rays aggregation baked around
    it, which meant a rectangular feature — a slot with a width and a length —
    could not be measured at all without reimplementing march and bisect.

    Default finds the void→material crossing: a hole wall from inside the hole, a
    channel wall from inside the channel. `find="void"` inverts it, which is what
    a SHAFT needs: a peg is solid at its axis and the measurement wanted is where
    the material ENDS. A polarity flag lived here once with no caller and no
    test, and was removed for it — dead flexibility in the oracle is worse than
    none. This one has both.
    """
    o, x, y, z = frame
    step = 0.25
    want_material = find == "material"
    # The start must be the OPPOSITE of what is being sought, or there is no
    # crossing to find. Without this the bisection collapses toward zero and
    # reports a ~0 distance, which a caller reads as "the wall is right here",
    # i.e. a zero width or a zero-diameter shaft. Every caller checks the origin
    # itself before marching, so this guards the next one; the self-check pins
    # both polarities.
    if _in_material(shape, _at(o, x, y, z, 0.0, 0.0, w)) == want_material:
        return None
    lo, crossing, r = 0.0, None, step
    while r <= max_r:
        if _in_material(shape, _at(o, x, y, z, du * r, dv * r, w)) == want_material:
            crossing = r
            break
        lo = r
        r += step
    if crossing is None:
        return None
    hi = crossing
    for _ in range(12):
        mid = (lo + hi) / 2
        # Polarity applies to the bisection too. Testing raw material here would
        # converge on the wrong side of the boundary for find="void", returning
        # the last void sample instead of the last solid one.
        if _in_material(shape, _at(o, x, y, z, du * mid, dv * mid, w)) == want_material:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def _measure_hole_radius(shape: Any, frame, max_r: float, w: float) -> float:
    """Median over directions of the NEAREST void→material crossing. Directions
    where the probe leaves the part entirely (hole near an edge) see no crossing
    and are excluded rather than skewing the measurement."""
    radii: list[float] = []
    for k in range(PROBE_DIRECTIONS):
        theta = 2 * math.pi * k / PROBE_DIRECTIONS
        hit = _march(shape, frame, math.cos(theta), math.sin(theta), w, max_r)
        if hit is not None:
            radii.append(hit)
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

    result = {"key": port["key"], "type": port["type"], "measured_diameter": round(measured, 3)}

    # DEPTH, because a diameter at one plane does not make a hole. The probe
    # sampled a single slice 0.6mm down and compared its width, so a Ø8 dimple
    # 0.75mm deep reported "measured_diameter: 8.0" and passed as a clearance
    # hole a screw was supposed to go through.
    bbox = shape.bounding_box()
    reach = max(float(bbox.size.X), float(bbox.size.Y), float(bbox.size.Z)) + 2.0
    floor = _march_depth(shape, frame, reach)
    result["through"] = floor is None
    if floor is not None:
        result["measured_depth"] = round(floor, 3)

    # A CLEARANCE HOLE EXISTS FOR SOMETHING TO PASS THROUGH IT. That is the whole
    # defect this measurement was added for: a Ø8 pocket 0.75mm deep reported
    # measured_diameter 8.0 and passed as a clearance hole a screw was meant to
    # go through. Asserting `through` says the actual thing, where a minimum
    # depth only guessed at it.
    #
    # BORE and SCREW_SEAT are deliberately exempt. A seat IS shallow: a washer
    # face, a head recess and a shallow counterbore are all correct at well under
    # a millimetre, and a depth floor there rejects real parts to catch nothing.
    # Every BORE on disk is a blind seat, including the jointed-import sockets,
    # which resolve deterministically and have no repair path at all, so a false
    # fail on one is an unrecoverable error_code.
    #
    # A DECLARED depth is not enforced, on purpose. No hole port in any project
    # declares one, so the comparison would be dead code, and on a stepped hole
    # it is unsatisfiable: _march_depth follows the axis to the DEEPEST floor in
    # a coaxial stack, so a counterbore over a pilot measures the pilot. A
    # counterbore's own floor is an annulus and never lies on the axis. The
    # FLAT_FACE grid already taught what an unsatisfiable check costs. Both
    # numbers are still measured and reported, which is the part with value.
    if port["type"] == "CLEARANCE_HOLE" and floor is not None:
        raise GateError("G3", f'port "{port["key"]}" (CLEARANCE_HOLE): bottoms out at {floor:.2f}mm instead of passing through',
                        "cut it through the part, or declare it as a BORE or SCREW_SEAT if it is meant to be a blind seat")

    return result


def _port_face_size(port: dict[str, Any]) -> float:
    """Same treatment hole diameters already get: accept the aliases models
    reach for, and report a miss instead of guessing.

    This used to default to 4.0 mm, which invented a requirement the contract
    never stated — a Ø5 ball declaring a 1.5 mm flat was silently graded
    against a 4 mm one and could never pass, with a report that named neither
    number. Failing here costs one repair round and says exactly what is missing.
    """
    params = port.get("params", {})
    for key in ("size", "faceSize", "face_size", "width", "flatWidth", "flat_width"):
        if key in params:
            try:
                return float(params[key])
            except (TypeError, ValueError):
                break
    raise GateError(
        "G3",
        f'port "{port.get("key", "?")}" (FLAT_FACE) declares no numeric face size (params: {sorted(params)})',
        "flat-face ports must carry params.size in mm — the width of the flat the mating part sits on "
        "(or params.ring_diameter for an annular seat)",
    )


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
        size = _port_face_size(port)
        if size < 1.0:  # sliver face: a grid would poke into air — center only
            samples = [(0.0, 0.0)]
            probed = {"probed_size": 0.0}
        else:
            # A DISC, NOT A SQUARE GRID. The grid put its four corners at
            # size*0.707 from the centre — outside any round or hexagonal face
            # of that width — so a truthful `size` could never pass and the only
            # way through the gate was to understate the face. A 75mm-wide hex
            # cup burned its whole repair budget on this, and a 5mm sphere's
            # bottom chord died the same way: the check was unsatisfiable, not
            # the geometry.
            #
            # The inset is ABSOLUTE, matching _probe_boss's `od / 2 - 0.3`. A
            # fractional inset (0.45 * size) looks equivalent and is not: it
            # asserts material only out to 90% of the declared radius, so it
            # accepts an 11% overstatement — and being fractional, the absolute
            # error grows with the part. A Ø50 face passed a declared 55.5, and
            # `probed_size` echoes the DECLARED number, so the inspector then
            # reported 55.5 mm as though it had been measured. Two rings, not
            # one: a single radius can be satisfied by spokes, and the old grid
            # had exactly one.
            outer = size / 2 - PROBE_INSET_MM
            samples = [(0.0, 0.0)]
            for r in (outer / 2, outer):
                samples += [
                    (r * math.cos(2 * math.pi * k / PROBE_DIRECTIONS),
                     r * math.sin(2 * math.pi * k / PROBE_DIRECTIONS))
                    for k in range(PROBE_DIRECTIONS)
                ]
            probed = {"probed_size": size}
    for u, v in samples:
        above = _at(o, x, y, z, u, v, PROBE_EPS_MM)
        below = _at(o, x, y, z, u, v, -PROBE_EPS_MM)
        if _in_material(shape, above):
            raise GateError("G3", f'port "{port["key"]}" (FLAT_FACE): material found above the declared face',
                            "the face must be exposed surface at the contract pose with +z pointing out of the material")
        if not _in_material(shape, below):
            raise GateError("G3", f'port "{port["key"]}" (FLAT_FACE): no material just below the declared face',
                            "the surface must exist (flat, at least the declared size) exactly at the contract "
                            "pose. If the edge is chamfered or filleted, declare the width of the FLAT that is "
                            "left, not the outer dimension — a Ø50 face with a 1mm chamfer has a 48mm flat.")
    return {"key": port["key"], "type": port["type"], **probed}


def _probe_boss(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    # ALIAS-TOLERANT, and not a raw index. `params["outer_diameter"]` raised
    # KeyError on a missing key, which surfaced as an unexpected failure under
    # stage G1 instead of a repairable G3, so the model was told nothing it
    # could act on. _port_dim's own docstring recorded this defect by name and
    # pointed at this line; it went unfixed until an audit of which probed types
    # the plan-time lints cover turned SCREW_BOSS up as the last one missing.
    od = _port_dim(
        port, OUTER_D_KEYS, "outer diameter",
        "declare params.outer_diameter in mm — the boss wall diameter the probe measures",
    )
    pilot = _port_dim_opt(port, PILOT_D_KEYS) or 0.0
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


# NO bare "diameter" here. A boss has two, so a bare `diameter` is ambiguous
# between the wall and the pilot, and resolving it to the wall measures the wrong
# feature while sounding confident: a model writing {diameter: 3} for the pilot
# got "expected outer Ø3, measured Ø10", whose repair is to shrink the boss.
# Without the alias it gets "declares no numeric outer diameter", which names the
# fix. A clear error beats a wrong reading, which is the same argument that
# replaced the raw index here in the first place.
OUTER_D_KEYS = ("outer_diameter", "outerDiameter", "od", "boss_diameter", "bossDiameter")
PILOT_D_KEYS = ("pilot_diameter", "pilotDiameter", "pilot", "pilot_hole_diameter")
LENGTH_TOL_MM = 0.5  # a peg is a slip fit; half a millimetre short still seats
DIAMETER_KEYS = ("diameter", "dia", "shaftDiameter", "shaft_diameter", "pegDiameter", "peg_diameter")
LENGTH_KEYS = ("length", "len", "shaftLength", "shaft_length", "pegLength", "peg_length")


def _probe_shaft(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """SHAFT: a peg standing OUT of the mating face, the inverse of a hole.

    Emitted by the import path for every peg joint (main.ts), which never passes
    through the plan-time probed-ports lint, so until now the peg side of a peg
    joint was unverifiable by construction while its socket (a BORE) was
    measured. --score-projects found 14 of these on disk, all reporting "no
    probe for this type yet".

    Measured the same way as a hole and in the opposite direction: the axis is
    SOLID here, so the marches look for where material ends. Diameter is the
    median over 8 rays, which tolerates a chamfered or filleted tip the way the
    hole probe tolerates one at a mouth.
    """
    key = port.get("key", "?")
    d = _port_dim(port, DIAMETER_KEYS, "diameter",
                  "declare params.diameter in mm — the peg diameter at its base")
    declared_len = _port_dim_opt(port, LENGTH_KEYS)
    frame = _frame(port["pose"])
    o, x, y, z = frame

    # +z points OUT of the mating face, so the peg body is at POSITIVE w.
    # Existence is checked just clear of the face, NOT at mid-declared-length:
    # a peg shorter than declared put that sample past the tip and reported "no
    # peg" for a peg that is simply short, which is a misleading message on a
    # real defect. The self-check pins that case.
    near = 0.25
    if not _in_material(shape, _at(o, x, y, z, 0.0, 0.0, near)):
        raise GateError(
            "G3",
            f'port "{key}" (SHAFT): no material {near}mm out from the pose, so there is no peg',
            f"grow a Ø{d:g} peg standing out of the mating face at the contract pose",
        )

    # The tip first, so the diameter is measured at the middle of the ACTUAL peg
    # rather than wherever the declaration guessed.
    reach = (declared_len * 2 + 4.0) if declared_len else (d * 4 + 20.0)
    tip, step, t = None, 0.25, near
    while t <= reach:
        if not _in_material(shape, _at(o, x, y, z, 0.0, 0.0, t)):
            tip = t
            break
        t += step
    if tip is None and declared_len:
        # Reach exhausted with a declared length. Returning a diameter and no
        # length here was indistinguishable from "no length was declared", so a
        # 200mm column declared 12mm passed with a shrug.
        raise GateError(
            "G3",
            f'port "{key}" (SHAFT): material continues past {reach:.1f}mm, so this is not a {declared_len:g}mm peg',
            f"the peg must end: build it {declared_len:g}mm long standing out of the mating face",
        )

    # LENGTH BEFORE DIAMETER, because it is the more specific diagnosis and the
    # diameter probe cannot survive a bad pose. A pose sunk into the parent body
    # puts "near the base" inside that body, so the rays find no edge and the
    # honest complaint ("this is 13.25mm, not 12") came out as "0/8 rays".
    #
    # TWO-SIDED: a short peg misses its socket, a long one bottoms out and stops
    # the joint seating. Only the short case was checked, so a sunk pose inflated
    # the length and passed.
    if declared_len and tip is not None and abs(tip - declared_len) > LENGTH_TOL_MM:
        raise GateError(
            "G3",
            f'port "{key}" (SHAFT): expected length {declared_len:g}mm, material ends at {tip:.2f}mm',
            f"build the peg {declared_len:g}mm long: short of that it misses its socket, "
            f"over it the joint bottoms out before seating",
        )

    # NEAR THE BASE, not at mid-height. A declared diameter is the diameter at
    # the base, and any draft makes the midpoint a different number by
    # construction: 2 degrees over 12mm loses 0.42mm against a 0.25 tolerance,
    # so measuring the middle false-failed the better part. Draft is good
    # practice on a slip fit. Still clear of a base fillet by PROBE_DEPTH_MM.
    w = min(near + PROBE_DEPTH_MM, tip / 2) if tip else max(near, PROBE_DEPTH_MM)

    radii = []
    for k in range(8):
        theta = 2 * math.pi * k / 8
        r = _march(shape, frame, math.cos(theta), math.sin(theta), w, max_r=d * 2 + 4.0, find="void")
        if r is not None:
            radii.append(r)
    if len(radii) < 8:
        raise GateError(
            "G3",
            f'port "{key}" (SHAFT): could not measure a diameter, {len(radii)}/8 rays found an edge within {d * 2 + 4:.1f}mm',
            "the peg must be a bounded solid standing proud of the face, not a merged mass",
        )
    radii.sort()
    measured = 2 * radii[len(radii) // 2]
    # EVERY ray, not a median over five. A Ø5 peg fused to a slab across three
    # rays reported a perfect Ø5: the median took the free side and the mass on
    # the other side cannot enter a socket at all. There is no chamfer to
    # forgive at this depth, so the slack was paying for a problem that does not
    # exist while hiding one that does.
    spread = 2 * radii[-1] - 2 * radii[0]
    if spread > 2 * DIAMETER_TOL_MM:
        raise GateError(
            "G3",
            f'port "{key}" (SHAFT): not round, rays span Ø{2 * radii[0]:.2f} to Ø{2 * radii[-1]:.2f}',
            "the peg must stand free of surrounding material, so a socket can receive it",
        )
    if abs(measured - d) > DIAMETER_TOL_MM:
        raise GateError(
            "G3",
            f'port "{key}" (SHAFT): expected Ø{d:g}, measured Ø{measured:.2f}',
            f"resize the peg to Ø{d:g} as pinned in the contract",
        )

    result: dict[str, Any] = {"key": key, "type": port["type"], "measured_diameter": round(measured, 3)}
    if tip is not None:
        result["measured_length"] = round(tip, 3)
    # A peg shorter than declared cannot reach its socket, which a slip-fit joint
    # shows as a gap. Only enforced against a declaration.
    return result


CHANNEL_LIKE = {"GROOVE", "SLOT"}
WIDTH_KEYS = ("width", "slotWidth", "slot_width", "grooveWidth", "groove_width", "channelWidth")
DEPTH_KEYS = ("depth", "slotDepth", "slot_depth", "grooveDepth", "groove_depth")


def _port_dim(port: dict[str, Any], keys: tuple[str, ...], label: str, hint: str) -> float:
    """Alias-tolerant numeric param, following _port_diameter. Deliberately NOT
    raw params["x"]: _probe_boss used to index outer_diameter that way and a
    missing key surfaced as an unexpected KeyError under stage G1 instead of a
    repairable G3, so the model was told nothing it could act on. This docstring
    named that defect and pointed at the line for two commits before anyone
    fixed it. Every probe reads its dimensions through here now."""
    params = port.get("params", {})
    for k in keys:
        v = params.get(k)
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                break
    raise GateError(
        "G3",
        f'port "{port.get("key", "?")}" ({port.get("type", "?")}) declares no numeric {label} (params: {sorted(params)})',
        hint,
    )


def _port_dim_opt(port: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    """Alias-tolerant optional numeric param. DEPTH_KEYS existed but nothing read
    it — the probe indexed params["depth"] directly, so a model writing slotDepth
    got its floor check silently skipped, which is the unverified-port outcome
    this probe exists to close. A declared 99mm floor on a 10mm plate passed."""
    params = port.get("params", {})
    for k in keys:
        v = params.get(k)
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                continue  # a garbage value must not shadow a valid alias, nor
                          # silently skip the check the caller is about to make
    return None


def _march_depth(shape: Any, frame, max_d: float) -> float | None:
    """Distance straight down -z from the port origin to the floor, or None if
    the cut passes through. Same march-then-bisect as _march, along the axis
    rather than in-plane."""
    o, x, y, z = frame
    step = 0.25
    lo, crossing, d = 0.0, None, step
    while d <= max_d:
        if _in_material(shape, _at(o, x, y, z, 0.0, 0.0, -d)):
            crossing = d
            break
        lo = d
        d += step
    if crossing is None:
        return None
    hi = crossing
    for _ in range(12):
        mid = (lo + hi) / 2
        if _in_material(shape, _at(o, x, y, z, 0.0, 0.0, -mid)):
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def _probe_channel(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """GROOVE / SLOT: a channel cut into the mating face, receiving a tongue or
    a plate. Both are used the same way by real contracts, so both are measured
    the same way — and the width is what a mating part actually depends on.

    Frame convention: +z out of the mating face, and the channel RUNS ALONG the
    port's xAxis, so its width is measured across the frame's y axis.

    Width is the NARROWEST gap, sampled at several depths. A single slice at one
    fixed depth graded whatever happened to sit at that plane and broke in both
    directions: a print-friendly chamfered mouth read WIDER than the channel and
    false-failed, while a channel genuinely too narrow but chamfered read exactly
    right and PASSED — a 2.2mm gap certified as 3.0mm, which the old hint
    ("change the channel to 3mm across") actively drove a repair toward.

    Depth is checked only when declared: a SLOT is often cut straight through,
    and demanding a floor there would fail correct geometry — the mistake the
    FLAT_FACE square grid made.
    """
    key, ptype = port["key"], port["type"]
    width = _port_dim(port, WIDTH_KEYS, "width",
                      "channel ports must carry params.width in mm — the gap a tongue sits in")
    frame = _frame(port["pose"])
    o, x, y, z = frame
    declared_depth = _port_dim_opt(port, DEPTH_KEYS)

    # Inside the channel there must be void. Material here means it was never
    # cut — or that the channel is shallower than this probe reaches, which is a
    # different problem and must not be reported as the first one.
    if _in_material(shape, _at(o, x, y, z, 0, 0, -PROBE_DEPTH_MM)):
        if not _in_material(shape, _at(o, x, y, z, 0, 0, -PROBE_EPS_MM)):
            raise GateError("G3", f'port "{key}" ({ptype}): the channel is shallower than the {PROBE_DEPTH_MM}mm this probe measures at',
                            f"cut the channel at least {PROBE_DEPTH_MM * 2:g}mm deep, or express a feature this shallow as a FLAT_FACE rather than a channel")
        raise GateError("G3", f'port "{key}" ({ptype}): no channel at the declared origin — material found where the gap should be',
                        f"cut a {width:g}mm-wide channel centred exactly on the contract pose, running along the port's xAxis")

    # The floor first, because it bounds where width may be sampled. A declared
    # depth deeper than the part used to send the width probe below the solid
    # into open air, where it found no wall and reported THAT — a true failure
    # with a misleading message, which in a repair loop is worse than a slow one.
    # The search depth must NOT derive from the declaration it is checking. A
    # channel truly 4mm deep declared as 0.5mm searched only 3mm, missed the
    # floor, and reported "cuts straight through" with a hint to drop
    # params.depth — which makes it pass. Bound it by the part instead, so a
    # wrong declaration reads as "deeper than declared" either way round.
    bbox = shape.bounding_box()
    reach_down = max(float(bbox.size.X), float(bbox.size.Y), float(bbox.size.Z)) + 2.0
    floor = _march_depth(shape, frame, reach_down)

    if declared_depth and declared_depth > 0:
        # MEASURE the floor, never echo the declaration. Handing back the
        # declared number as `measured_depth` is the defect this file already
        # records for probed_size: the inspector renders it as a measurement, so
        # a channel truly 4.2mm deep read back "4 mm deep" because that is what
        # the contract said. Its own tolerance — a different axis, and
        # PROBE_EPS_MM is a sampling standoff, not an engineering tolerance.
        if floor is None:
            raise GateError("G3", f'port "{key}" ({ptype}): declares a {declared_depth:g}mm floor but the channel cuts straight through',
                            f"either stop the cut at {declared_depth:g}mm, or drop params.depth — a through-cut declares no depth")
        if abs(floor - declared_depth) > DEPTH_TOL_MM:
            direction = "deeper" if floor > declared_depth else "shallower"
            raise GateError("G3", f'port "{key}" ({ptype}): expected depth {declared_depth:g}, measured {floor:.2f} ({direction} than declared)',
                            f"cut the channel floor {declared_depth:g}mm from the face; a mating part seats on this number")

    # SAMPLING, NOT A BOUND. Three depths cannot see a constriction that falls
    # between them: a 3mm channel pinched to 2.4mm over a 0.5mm band still
    # passes. No finite sample set closes that, and one slice was strictly
    # worse — but the failure hint says "make the channel 3mm at its tightest
    # point", which is more than the gate can actually verify.
    reach = width * 3 + 2.0
    span_to = (floor - PROBE_EPS_MM) if floor is not None else PROBE_DEPTH_MM * 3
    depths = sorted({PROBE_DEPTH_MM, max(PROBE_DEPTH_MM, span_to / 2), max(PROBE_DEPTH_MM, span_to)})
    measured: float | None = None
    at_depth: float | None = None
    for probe_w in depths:
        if _in_material(shape, _at(o, x, y, z, 0, 0, -probe_w)):
            continue  # past the floor or into a rib — not a slice of this channel
        left = _march(shape, frame, 0.0, 1.0, -probe_w, reach)
        right = _march(shape, frame, 0.0, -1.0, -probe_w, reach)
        if left is None or right is None:
            raise GateError("G3", f'port "{key}" ({ptype}): no wall within {reach:.1f}mm at {probe_w:.1f}mm depth — the channel is open, not a {width:g}mm gap',
                            "the channel must be bounded on both sides across its width; check the pose's xAxis points ALONG the channel, not across it")
        span = left + right
        if measured is None or span < measured:
            measured, at_depth = span, probe_w

    if measured is None or at_depth is None:
        raise GateError("G3", f'port "{key}" ({ptype}): no open channel below the declared face',
                        f"cut a {width:g}mm-wide channel centred on the contract pose")

    if abs(measured - width) > DIAMETER_TOL_MM:
        raise GateError("G3", f'port "{key}" ({ptype}): expected width {width:g}, narrowest measured {measured:.2f} (at {at_depth:g}mm depth)',
                        f"the declared width is the NARROWEST gap, because that is what a mating tongue must fit through — make the channel {width:g}mm at its tightest point. A chamfered or drafted mouth is fine and is not what gets measured, so do not widen the channel to compensate for one.")

    result: dict[str, Any] = {"key": key, "type": ptype, "measured_width": round(measured, 3)}
    if floor is not None:
        result["measured_depth"] = round(floor, 3)
    return result


# ---------------------------------------------------------------------------
# G5 — clash. Every gate before this one grades ONE part against its own
# contract, so none of them can see the failure that only exists between two
# parts: they interpenetrate. A collar can satisfy every probe and every
# envelope and still sit 1.5mm inside the base it is supposed to rest on, with
# the assembly reporting clean, because nothing ever looked at two parts at
# once.
#
# Assembly-level, so it reports through globalCheck rather than failing a node's
# verify — no single node is at fault, and failing one arbitrarily would send a
# generator to fix code that is correct.

CLASH_MIN_DEPTH_MM = 0.02
"""MEAN PENETRATION DEPTH, 2V/A — not a volume. A volume threshold is a
function of contact area wearing an absolute number's clothes, which is the
mistake _probe_flat_face already made once with a fractional inset.

Planar contact is exact (two 400x400 faces intersect to volume 0.0 with zero
faces, at any size), so flat mates were never the problem. Curved and mesh
contact is: the same nominal Ø5 peg-in-bore reports 0.000, but at Ø60 it reports
8.7 and at Ø150 54.4 — identical fit, identical tessellation tolerance, only the
radius changed. A 1mm³ threshold therefore both invented a clash on a real
split-seam (16.9mm³ across a 146x143mm interface, mean depth 0.005mm) and missed
a Ø1.5 pin sunk a full 0.5mm into a plate (0.88mm³).

Depth separates them by construction. Measured over every real and synthetic
case: noise 0.001-0.0115mm, genuine interference 0.0495-1.333mm. 0.02 sits ~4x
above the worst noise and ~2.5x below the tightest real case, and is about 1/5
of the 0.1 tessellation tolerance in _posed_mesh — keep those two in step."""

TESSELLATION_TOL_CLASH = 0.1
"""Deviation for the meshes G5 compares. CLASH_MIN_DEPTH_MM is calibrated
against this; changing one without the other moves the noise floor."""


def _posed_mesh(shape: Any, matrix: list[float]) -> Any:
    """Tessellate and place, as one welded trimesh. Mesh rather than B-rep on
    purpose: it is the same path render_assembly takes, it costs one
    tessellation instead of an OCP boolean per pair, and it works unchanged on
    imported MeshParts."""
    import numpy as np
    import trimesh

    # A build123d shape has a .mesh METHOD; a MeshPart's .mesh IS a Trimesh. The
    # callable check is the discriminator — hasattr alone would send every part
    # down the mesh branch.
    if hasattr(shape, "mesh") and not callable(getattr(shape, "mesh")):
        mesh = shape.mesh.copy()  # MeshPart — already a volume; copy so posing
        if not mesh.is_watertight:  # does not mutate the caller's part
            # This branch is where a non-watertight mesh can actually arrive:
            # an imported STL. The repair used to sit on the build123d branch,
            # where process=True has already welded and b3d tessellates closed
            # anyway — guarding the case that could not happen.
            mesh.merge_vertices(merge_tex=True, merge_norm=True)
            trimesh.repair.fill_holes(mesh)
    else:
        verts, faces = shape.tessellate(TESSELLATION_TOL_CLASH)
        # Welding is not optional: raw OCP tessellation duplicates vertices per
        # face, and a boolean against an unwelded shell returns nonsense.
        mesh = trimesh.Trimesh(
            vertices=[(v.X, v.Y, v.Z) for v in verts],
            faces=[tuple(f) for f in faces],
            process=True,
        )
    if matrix:
        m = np.asarray(matrix, dtype=np.float64).reshape(4, 4).T  # column-major in
        mesh.apply_transform(m)
    return mesh


def g5_clash(parts: list[tuple[str, Any, list[float]]]) -> dict[str, Any]:
    """Posed parts, pairwise. Cheap AABB pass first, then a real boolean only on
    the pairs whose boxes actually overlap — n is small, but a boolean is not,
    and most pairs in an assembly are nowhere near each other.

    Returns a report; raises nothing. A clash is a fact about the assembly, and
    the caller decides what it costs."""
    import trimesh

    meshes = [(key, _posed_mesh(shape, matrix)) for key, shape, matrix in parts]
    clashes: list[dict[str, Any]] = []
    errors: list[str] = []
    pairs_tested = 0
    for i in range(len(meshes)):
        for j in range(i + 1, len(meshes)):
            key_a, mesh_a = meshes[i]
            key_b, mesh_b = meshes[j]
            a_min, a_max = mesh_a.bounds
            b_min, b_max = mesh_b.bounds
            if any(a_min[k] > b_max[k] or b_min[k] > a_max[k] for k in range(3)):
                continue  # boxes disjoint — no boolean needed
            pairs_tested += 1
            try:
                overlap = trimesh.boolean.intersection([mesh_a, mesh_b], engine="manifold")
            except Exception as err:  # noqa: BLE001
                # A boolean that will not compute is not evidence of no clash.
                # Swallowing it would report every pair clean forever if the
                # engine were missing — an all-clear from a gate that never ran.
                errors.append(f"{key_a} vs {key_b}: boolean failed ({type(err).__name__})")
                continue
            if overlap is None or not len(overlap.faces):
                continue
            volume = float(abs(overlap.volume))
            area = float(overlap.area)
            # Mean penetration depth of the shared lens. A seam disagreement is
            # a wide, vanishingly thin sheet; real interference is thick.
            depth = (2 * volume / area) if area > 1e-9 else 0.0
            if depth > CLASH_MIN_DEPTH_MM:
                centre = overlap.centroid
                clashes.append({
                    "a": key_a,
                    "b": key_b,
                    "volume_mm3": round(volume, 3),
                    "depth_mm": round(depth, 4),
                    "at": [round(float(c), 2) for c in centre],
                })
    return {"parts": len(meshes), "pairs_tested": pairs_tested,
            "clashes": clashes, "errors": errors}


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
        elif ptype == "SHAFT":
            report.append(_probe_shaft(shape, port))
        elif ptype in CHANNEL_LIKE:
            report.append(_probe_channel(shape, port))
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


def _escape_distance(p: Any, prim: dict[str, Any], margin: float) -> float:
    """How far outside the margin-inflated primitive `p` lies, 0.0 when inside.

    This is reported to the model as the amount to shrink by, so it has to be
    the real overshoot. The previous version measured every axis against
    `radius`, including z — so a vertex escaping axially from a wide, flat
    cylinder was compared against the RADIUS and came back negative, printing
    "worst ≈0.0 mm beyond" for a genuine miss and telling the model its part
    was already the right size.
    """
    c = prim["center"]
    dz = abs(float(p[2]) - float(c[2]))
    if prim["kind"] == "box":
        s = prim["size"]
        return max(
            abs(float(p[i]) - float(c[i])) - (float(s[i]) / 2 + margin) for i in range(3)
        )
    if prim["kind"] == "cylinder":
        dx, dy = float(p[0]) - float(c[0]), float(p[1]) - float(c[1])
        radial = math.hypot(dx, dy) - (float(prim["radius"]) + margin)
        axial = dz - (float(prim["height"]) / 2 + margin)
        return max(radial, axial)
    return 0.0


def g4_envelope(shape: Any, envelope: list[dict[str, Any]]) -> dict[str, Any]:
    vertices, _tris = shape.tessellate(TESSELLATION_TOL)
    worst: tuple[float, Any] | None = None
    violations = 0
    for vec in vertices:
        p = (float(vec.X), float(vec.Y), float(vec.Z))
        if not any(_inside_primitive(p, prim, ENVELOPE_MARGIN_MM) for prim in envelope):
            violations += 1
            # Nearest primitive wins: the union is what must contain the part.
            excess = (
                min(_escape_distance(p, prim, ENVELOPE_MARGIN_MM) for prim in envelope)
                if envelope
                else 0.0
            )
            if worst is None or excess > worst[0]:
                worst = (excess, p)
    if violations:
        excess, p = worst  # type: ignore[misc]
        raise GateError(
            "G4",
            f"{violations} mesh vertices escape the declared envelope "
            f"(worst {max(excess, 0):.2f} mm past the {ENVELOPE_MARGIN_MM} mm tolerance, "
            f"near [{p[0]:.1f}, {p[1]:.1f}, {p[2]:.1f}])",
            "shrink the offending feature to fit the envelope, or request an envelope expansion from the architect",
        )
    return {"vertices_checked": len(vertices), "violations": 0}


def _raise_selfcheck(msg: str) -> None:
    raise GateError("self-check", msg, "")

# ---------------------------------------------------------------------------
# Self-check: `uv run python -m patchcad_kernel.gates`
#
# The probes are the oracle, and the only test they had was smoke.py — which
# needs a running service, goes over HTTP, and tells you a call 422'd without
# telling you the sampling maths is wrong. This runs the probe functions
# directly against shapes built here, so a bad radius or a flipped polarity
# fails in a second with a line number. There is no pytest in this package.
if __name__ == "__main__":  # pragma: no cover
    from build123d import Axis, Box, BuildPart, Cone, Cylinder, Locations, Mode, Pos, chamfer

    fails: list[str] = []

    def expect(label: str, fn, want_error: str | None = None) -> None:
        try:
            fn()
            ok, detail = want_error is None, "passed"
        except GateError as err:
            ok = want_error is not None and want_error in err.error
            detail = f"{err.stage}: {err.error}"
        print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"  <- {detail}"))
        if not ok:
            fails.append(label)

    def pose(origin, z=(0, 0, 1), x=(1, 0, 0)):
        return {"origin": list(origin), "zAxis": list(z), "xAxis": list(x)}

    with BuildPart() as plate:
        Box(60, 40, 10)
        with Locations((0, 0, 3)):
            Box(70, 3, 4, mode=Mode.SUBTRACT)
    grooved = plate.part

    with BuildPart() as disc:
        Cylinder(radius=25, height=10)
    round_top = disc.part

    print("FLAT_FACE — an absolute inset, so tolerance must not scale")
    for size, want in ((50.0, None), (50.4, None), (55.5, "no material"), (200.0, "no material")):
        expect(f"Ø50 top, size={size}",
               lambda s=size: _probe_flat_face(round_top, {"key": "f", "type": "FLAT_FACE", "pose": pose((0, 0, 5)), "params": {"size": s}}),
               want)

    print("GROOVE / SLOT — width across the frame's y axis")
    expect("3mm groove declared 3.0",
           lambda: _probe_channel(grooved, {"key": "g", "type": "GROOVE", "pose": pose((0, 0, 5)), "params": {"width": 3.0}}))
    expect("3mm groove declared 5.0", 
           lambda: _probe_channel(grooved, {"key": "g", "type": "GROOVE", "pose": pose((0, 0, 5)), "params": {"width": 5.0}}),
           "measured 3.00")
    expect("groove on a solid disc",
           lambda: _probe_channel(round_top, {"key": "g", "type": "GROOVE", "pose": pose((0, 0, 5)), "params": {"width": 3.0}}),
           "no channel at the declared origin")
    expect("groove probed across its length",
           lambda: _probe_channel(grooved, {"key": "g", "type": "GROOVE", "pose": pose((0, 0, 5), x=(0, 1, 0)), "params": {"width": 3.0}}),
           "no wall")
    expect("groove with no width",
           lambda: _probe_channel(grooved, {"key": "g", "type": "GROOVE", "pose": pose((0, 0, 5)), "params": {}}),
           "no numeric width")

    print("_march_depth — the floor, measured not echoed")
    for true_d, declared, want in ((4.0, 4.0, None), (4.5, 4.0, "deeper than declared"),
                                   (3.5, 4.0, "shallower than declared"),
                                   (4.0, 0.5, "deeper than declared"),
                                   (4.0, 99.0, "shallower than declared")):
        with BuildPart() as bp:
            Box(60, 40, 10)
            with Locations((0, 0, 5 - true_d / 2)):
                Box(70, 3, true_d, mode=Mode.SUBTRACT)
        expect(f"true {true_d}mm floor declared {declared}mm",
               lambda sh=bp.part, dd=declared: _probe_channel(sh, {"key": "g", "type": "GROOVE", "pose": pose((0, 0, 5)), "params": {"width": 3.0, "depth": dd}}),
               want)

    print("width is the NARROWEST gap, so a chamfered mouth is not the measurement")
    with BuildPart() as cbp:
        Box(60, 40, 10)
        with Locations((0, 0, 3)):
            Box(70, 3.0, 4, mode=Mode.SUBTRACT)
        chamfer(cbp.edges().group_by(Axis.Z)[-1], length=1.0)
    wide_mouth = cbp.part
    with BuildPart() as nbp:
        Box(60, 40, 10)
        with Locations((0, 0, 3)):
            Box(70, 2.2, 4, mode=Mode.SUBTRACT)
        chamfer(nbp.edges().group_by(Axis.Z)[-1], length=1.0)
    narrow_mouth = nbp.part
    expect("3.0 channel with a 1mm chamfer declared 3.0",
           lambda: _probe_channel(wide_mouth, {"key": "g", "type": "GROOVE", "pose": pose((0, 0, 5)), "params": {"width": 3.0}}))
    expect("2.2 channel with a 1mm chamfer declared 3.0",
           lambda: _probe_channel(narrow_mouth, {"key": "g", "type": "GROOVE", "pose": pose((0, 0, 5)), "params": {"width": 3.0}}),
           "narrowest measured 2.20")

    print("_port_dim_opt — every alias, and garbage must not shadow a valid one")
    grooved4 = grooved
    # 99.0 for the same reason as the garbage case below: the fixture's real
    # floor IS 4.0, so declaring 4.0 passes whether the alias was read or
    # ignored entirely. Deleting the alias lookup used to pass all five.
    for k in ("depth", "slotDepth", "slot_depth", "grooveDepth", "groove_depth"):
        expect(f"depth alias {k}",
               lambda kk=k: _probe_channel(grooved4, {"key": "g", "type": "GROOVE", "pose": pose((0, 0, 5)), "params": {"width": 3.0, kk: 99.0}}),
               "expected depth 99")
    # 99.0, not 4.0: the fixture's real floor IS 4.0, so a valid-looking value
    # cannot tell "resolved the later alias" from "gave up and skipped the
    # check". A wrong value discriminates.
    expect("a garbage depth does not shadow a valid alias",
           lambda: _probe_channel(grooved4, {"key": "g", "type": "GROOVE", "pose": pose((0, 0, 5)), "params": {"width": 3.0, "depth": "abc", "slotDepth": 99.0}}),
           "expected depth 99")

    print("SHAFT — a peg standing out of the mating face")
    # Algebra mode, so the peg's extent is arithmetic rather than an alignment
    # enum: plate spans z -3..3, peg spans 3..15, so the face is z=3.
    pegged = Box(30, 30, 6) + Pos(0, 0, 9) * Cylinder(2.5, 12)
    # The face is z=3 (top of the box) and +z points out of it, so the peg body
    # is at positive w exactly as the probe assumes.
    peg_pose = pose((0, 0, 3))
    expect("a Ø5 x 12 peg measures Ø5",
           lambda: _probe_shaft(pegged, {"key": "p", "type": "SHAFT", "pose": peg_pose,
                                         "params": {"diameter": 5.0, "length": 12}}))
    expect("a Ø5 peg declared Ø8 is caught",
           lambda: _probe_shaft(pegged, {"key": "p", "type": "SHAFT", "pose": peg_pose,
                                         "params": {"diameter": 8.0, "length": 12}}),
           "expected Ø8, measured Ø5")
    expect("a declared peg that is not there is caught",
           lambda: _probe_shaft(pegged, {"key": "p", "type": "SHAFT", "pose": pose((10, 10, 3)),
                                         "params": {"diameter": 5.0, "length": 12}}),
           "there is no peg")
    expect("a peg shorter than declared is caught",
           lambda: _probe_shaft(pegged, {"key": "p", "type": "SHAFT", "pose": peg_pose,
                                         "params": {"diameter": 5.0, "length": 25}}),
           "material ends at")
    expect("a peg with no declared length still measures its diameter",
           lambda: _probe_shaft(pegged, {"key": "p", "type": "SHAFT", "pose": peg_pose,
                                         "params": {"diameter": 5.0}}))
    expect("a diameter alias is read",
           lambda: _probe_shaft(pegged, {"key": "p", "type": "SHAFT", "pose": peg_pose,
                                         "params": {"peg_diameter": 5.0, "length": 12}}))
    expect("no diameter at all fails with a repairable hint",
           lambda: _probe_shaft(pegged, {"key": "p", "type": "SHAFT", "pose": peg_pose,
                                         "params": {"length": 12}}),
           "declares no numeric diameter")
    # A SHAFT pose pointing INTO the solid has no peg out front. Without this the
    # probe would read the box itself as an enormous peg.
    # The four defects review found, each proven by the case that failed it.
    import math as _m
    def _drafted(deg):
        r = _m.radians(deg)
        return Box(30, 30, 6) + Pos(0, 0, 9) * Cone(2.5, max(2.5 - 12 * _m.tan(r), 0.05), 12)
    expect("a 3 degree drafted peg is NOT false-failed (nominal is the base Ø)",
           lambda: _probe_shaft(_drafted(3), {"key": "p", "type": "SHAFT", "pose": peg_pose,
                                              "params": {"diameter": 5.0, "length": 12}}))
    expect("a 5 degree drafted peg is not false-failed either",
           lambda: _probe_shaft(_drafted(5), {"key": "p", "type": "SHAFT", "pose": peg_pose,
                                              "params": {"diameter": 5.0, "length": 12}}))
    fused = Box(30, 30, 6) + Pos(0, 0, 9) * Cylinder(2.5, 12) + Pos(6, 0, 9) * Box(8, 6, 12)
    expect("a peg fused to a slab cannot enter a socket, so it fails",
           lambda: _probe_shaft(fused, {"key": "p", "type": "SHAFT", "pose": peg_pose,
                                        "params": {"diameter": 5.0, "length": 12}}),
           "not round")
    expect("a peg LONGER than declared bottoms out, so it fails too",
           lambda: _probe_shaft(pegged, {"key": "p", "type": "SHAFT",
                                         "pose": pose((0, 0, 2.0)),
                                         "params": {"diameter": 5.0, "length": 12}}),
           "material ends at")
    column = Box(30, 30, 6) + Pos(0, 0, 103) * Cylinder(2.5, 200)
    expect("a 200mm column declared 12mm is not a peg",
           lambda: _probe_shaft(column, {"key": "p", "type": "SHAFT", "pose": peg_pose,
                                         "params": {"diameter": 5.0, "length": 12}}),
           "material continues past")

    expect("a pose facing into the block reports no peg",
           lambda: _probe_shaft(pegged, {"key": "p", "type": "SHAFT",
                                         "pose": {"origin": [0, 0, -3], "zAxis": [0, 0, -1], "xAxis": [1, 0, 0]},
                                         "params": {"diameter": 5.0, "length": 12}}),
           "there is no peg")

    print("SCREW_BOSS — dimensions read through the alias helper, not a raw index")
    # Boss standing on a plate: plate z -3..3, boss spans 3..15, so the mating
    # face is its top at z=15 with +z pointing out of it.
    bossed = Box(30, 30, 6) + Pos(0, 0, 9) * Cylinder(5, 12) - Pos(0, 0, 9) * Cylinder(1.5, 14)
    boss_pose = pose((0, 0, 15))
    expect("canonical keys measure the pilot",
           lambda: _probe_boss(bossed, {"key": "b", "type": "SCREW_BOSS", "pose": boss_pose,
                                        "params": {"outer_diameter": 10.0, "pilot_diameter": 3.0}}))
    expect("aliases are read too",
           lambda: _probe_boss(bossed, {"key": "b", "type": "SCREW_BOSS", "pose": boss_pose,
                                        "params": {"od": 10.0, "pilot": 3.0}}))
    # The defect this replaced: a raw index raised KeyError, which reached the
    # model as a stage-G1 surprise rather than something it could repair.
    expect("a missing outer diameter is a repairable G3, not a KeyError",
           lambda: _probe_boss(bossed, {"key": "b", "type": "SCREW_BOSS", "pose": boss_pose,
                                        "params": {"pilot_diameter": 3.0}}),
           "declares no numeric outer diameter")
    expect("a bare `diameter` is NOT an outer-diameter alias, because a boss has two",
           lambda: _probe_boss(bossed, {"key": "b", "type": "SCREW_BOSS", "pose": boss_pose,
                                        "params": {"diameter": 10.0}}),
           "declares no numeric outer diameter")
    expect("a wrong pilot is still caught",
           lambda: _probe_boss(bossed, {"key": "b", "type": "SCREW_BOSS", "pose": boss_pose,
                                        "params": {"outer_diameter": 10.0, "pilot_diameter": 6.0}}),
           "expected pilot Ø6")

    print("_march — the shared directional primitive")
    frame = _frame(pose((0, 0, 5)))
    half = _march(grooved, frame, 0.0, 1.0, -PROBE_DEPTH_MM, 12.0)
    expect(f"half-width of a 3mm groove measures {half}",
           lambda: None if half and abs(half - 1.5) < 0.01 else _raise_selfcheck(f"expected 1.5, got {half}"))
    none_case = _march(round_top, frame, 0.0, 1.0, -PROBE_DEPTH_MM, 5.0)
    expect("a start already in material returns None, not a ~0 distance",
           lambda: None if none_case is None else _raise_selfcheck(f"expected None, got {none_case}"))

    print()
    if fails:
        print(f"{len(fails)} FAILURE(S): {fails}")
        raise SystemExit(1)
    print("gates self-check passed")
