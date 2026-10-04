"""Verification gates, worker-side only (this module imports build123d,
which is heavy — the parent process must never import it).

G0  static AST scan: import allowlist, `build(p)` entrypoint present.
G1  execute `build(p)` and get a shape back.
G2  validity: ≥1 solid, positive volume, BRepCheck-valid, sane bounding box;
    the solid count when the contract declares one.
G3  port probes against the solid (g3_ports): holes by a fitted circle at the
    narrowest of several slices, with centre offset, axis tilt and through-ness;
    faces, bosses, shafts, channels, patterns member by member, and the
    hardware host features against process-dependent fit bands.
G4  envelope containment of surface samples, each primitive in its own frame.
G4b spec assertions (solids, volume, bbox, hole count, symmetry, min wall).
G4c process DFM (dfm_process.py) for fabricated parts.
G5  posed clash, mate contact and swept travel across an assembly (g5_clash).

contract_gates runs G2-count, G3, G4, G4b and G4c together and raises one
GateError naming every failure; a declaration no gate can read fails as stage
CONTRACT. Every failure carries a `hint` templated for the repair prompt.
Changing what any gate passes means bumping main.GATES_VERSION.
"""

from __future__ import annotations

import ast
import itertools
import math
from typing import Any

ALLOWED_IMPORTS = {"build123d", "math"}

# The architect-facing sanity ceiling: parts larger than this are almost
# certainly a units mistake (meters where millimeters were meant).
MAX_DIMENSION_MM = 10_000.0


class GateError(Exception):
    """`detail` carries what the gate measured when it knows it (port,
    expected, measured, line). `failures` is every failure behind this error:
    the contract gates report all of them at once, so a repair round fixes
    three ports instead of discovering them one attempt at a time."""

    def __init__(self, stage: str, error: str, hint: str = "",
                 failures: list[dict[str, Any]] | None = None, **detail: Any):
        super().__init__(error)
        self.stage = stage
        self.error = error
        self.hint = hint
        self.detail = detail
        self.failures = failures if failures is not None else [self.as_failure()]

    def as_failure(self) -> dict[str, Any]:
        return {"stage": self.stage, "error": self.error, "hint": self.hint, **self.detail}


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

    _no_optional_features(tree)
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


# Calls that construct a feature; fillet and chamfer are not among them; the
# cheat sheet says to guard those, since a cosmetic edge may fail and be dropped.
FEATURE_CALLS = {"sweep", "loft", "revolve", "Helix", "fuse", "cut", "intersect"}
SOLID_CALLS = {"extrude", "sweep", "loft", "revolve", "mirror", "offset", "split"}
BOOLEAN_OPS = (ast.Add, ast.Sub, ast.BitAnd)


def _call_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Call):
        f = node.func
        return f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None
    return None


def _is_solid(node: ast.AST) -> bool:
    """`Cylinder(..)`, `extrude(..)` or `Pos(..) * shape`: an operand that is
    certainly a shape. `psi(r)` and `part.edges()` are not."""
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
        return _is_solid(node.left) or _is_solid(node.right)
    name = _call_name(node) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) else None
    return bool(name) and (name[0].isupper() or name in SOLID_CALLS)


def _builds_feature(stmts: list[ast.stmt]) -> bool:
    """A boolean, sweep, loft, revolve or helix anywhere in `stmts`. A boolean
    is told from arithmetic by its shape: `a & b`, `part -= cut`, `part = part
    - cut`, or `+`/`-` with a shape constructor or a `Pos(..) * shape` as an
    operand. `h = r_maj - r_min` is arithmetic and is left alone, and so is
    `edges() + edges()` in a chamfer guard."""
    for stmt in stmts:
        for node in ast.walk(stmt):
            if _call_name(node) in FEATURE_CALLS:
                return True
            if isinstance(node, ast.AugAssign) and isinstance(node.op, BOOLEAN_OPS) \
                    and not isinstance(node.value, ast.Constant):
                return True
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitAnd):
                return True
            if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub)) \
                    and any(_is_solid(o) for o in (node.left, node.right)):
                return True
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.BinOp) \
                    and isinstance(node.value.op, BOOLEAN_OPS) and isinstance(node.value.left, ast.Name) \
                    and any(isinstance(t, ast.Name) and t.id == node.value.left.id for t in node.targets) \
                    and not isinstance(node.value.right, ast.Constant):
                return True
    return False


def _swallows(handler: ast.ExceptHandler) -> bool:
    """A handler that lets the program carry on as if the feature were never
    asked for: `pass`, `continue`, or only assigning constants (`ridge = None`).
    A handler that raises, or builds a fallback, is not one."""
    return all(isinstance(s, (ast.Pass, ast.Continue))
               or (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))
               or (isinstance(s, ast.Assign) and isinstance(s.value, ast.Constant))
               for s in handler.body)


def _no_optional_features(tree: ast.Module) -> None:
    """A stated feature may not be optional. A thread swept inside
    `try: ... except Exception: pass`, or added only `if ridge.volume > 1.0`,
    passes every gate when the sweep fails: the part ships without its
    thread and no repair round ever sees why."""
    hint = ("a stated feature may not be optional; let it fail so repair sees the error. Remove the try/except "
            "(or the volume test) around it; guard only a cosmetic fillet or chamfer that way")
    for node in ast.walk(tree):
        if isinstance(node, ast.Try) and any(_swallows(h) for h in node.handlers) and _builds_feature(node.body):
            raise GateError("G0", f"line {node.lineno}: a try/except silently skips a feature when it fails",
                            hint, line=node.lineno)
        if isinstance(node, ast.If) and any(isinstance(n, ast.Attribute) and n.attr == "volume"
                                            for n in ast.walk(node.test)) \
                and (_builds_feature(node.body) or _builds_feature(node.orelse)):
            raise GateError("G0", f"line {node.lineno}: a feature is added only if a volume test passes",
                            hint, line=node.lineno)


def g1_execute(tree: ast.Module, params: dict[str, Any], extra_ns: dict[str, Any] | None = None,
               source: str = "") -> Any:
    namespace: dict[str, Any] = dict(extra_ns or {})
    try:
        exec(compile(tree, "<node>", "exec"), namespace)  # noqa: S102 — sandboxed by worker rlimits/timeout
    except Exception as err:  # noqa: BLE001 — anything the code raises is a G1 report
        raise _g1_error(err, "module-level execution failed", source,
                        "move all logic inside build(p); module level should only import and define") from None

    build = namespace.get("build")
    try:
        shape = build(Params(params))
    except Exception as err:  # noqa: BLE001
        raise _g1_error(err, "build(p) raised", source, _repair_hint_for(err)) from None
    if shape is None:
        raise GateError("G1", "build(p) returned None", "return the final Part from build(p)")
    return shape


def node_line(err: BaseException) -> int | None:
    """Innermost line of the node's own code in the traceback — the frame the
    model wrote, not the build123d internals below it."""
    import traceback

    lines = [f.lineno for f in traceback.extract_tb(err.__traceback__) if f.filename == "<node>"]
    return lines[-1] if lines else None


def source_context(source: str, line: int, radius: int = 2) -> str:
    """`line N: <code>` plus a few lines either side, the failing one marked.
    OCP-free on purpose: the pool calls it from the parent for timeouts."""
    rows = source.splitlines()
    if not 1 <= line <= len(rows):
        return f"line {line}"
    out = [f"line {line}: {rows[line - 1].strip()}"]
    for n in range(max(1, line - radius), min(len(rows), line + radius) + 1):
        out.append(f"{'>' if n == line else ' '} {n:4d} | {rows[n - 1]}")
    return "\n".join(out)


def _is_occt_failure(err: Exception) -> bool:
    """Raw OCP exceptions, or build123d's wrappers around a failed algorithm
    ("Failed creating a fillet…", "Failed to create valid loft")."""
    msg = str(err)
    return (type(err).__name__.startswith(("StdFail", "Standard_"))
            or "command not done" in msg or msg.startswith("Failed"))


def _occt_call(source_line: str) -> str | None:
    """The build123d call on a line OCCT failed on, e.g. `fillet` — the model
    can act on "fillet failed", not on StdFail_NotDone."""
    import re

    import build123d

    for name in re.findall(r"([A-Za-z_]\w*)\s*\(", source_line):
        if not name.startswith("_") and hasattr(build123d, name):
            return name
    return None


def _g1_error(err: Exception, what: str, source: str, hint: str) -> GateError:
    message = f"{what} {type(err).__name__}: {err}"
    line = node_line(err)
    if line is None or not source:
        return GateError("G1", message, hint)
    if _is_occt_failure(err):
        rows = source.splitlines()
        call = _occt_call(rows[line - 1]) if line <= len(rows) else None
        if call:
            message = f"{what} {type(err).__name__} — OCCT could not compute {call}(): {err}"
            hint = (f"the geometry kernel failed inside {call}() on line {line} — reduce radii/sizes, "
                    f"select fewer edges, or reorder features so {call} runs on simpler geometry")
    return GateError("G1", f"{message}\n{source_context(source, line)}", hint, line=line)


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

    if getattr(shape, "wrapped", None) is not None:  # an imported MeshPart is its own mesh
        _g2_watertight(shape)

    # An enclosed void is a second shell inside one solid. It may be meant (a
    # sealed float), so it is a warning, never a failure.
    shells = [len(s.shells()) for s in solids if hasattr(s, "shells")]
    out: dict[str, Any] = {
        "volume_mm3": volume,
        "area_mm2": float(shape.area),
        "solids": len(solids),
        "shells": shells,
        "bbox": {
            "min": [float(bbox.min.X), float(bbox.min.Y), float(bbox.min.Z)],
            "max": [float(bbox.max.X), float(bbox.max.Y), float(bbox.max.Z)],
            "size": size,
        },
    }
    voids = [f"solid {i} encloses {n - 1} internal void(s)" for i, n in enumerate(shells) if n > 1]
    if voids:
        out["warnings"] = voids
    return out


HELIX_SEAM_EDGES = 50  # bad edges on one radius before G2 names a fused thread


def _g2_watertight(shape: Any) -> None:
    """The B-rep can be valid while its tessellation is not closed: a
    sphere's pole on a boolean seam left one open edge in a ball socket, and
    the STL every slicer and benchmark reads was not a solid (that one was the
    weld, fixed in meshpart.weld). Welded the way exporters.py welds, on the
    job's 0.2mm tessellation that printability and min_wall reuse: open and
    non-manifold edges come from topology, not deflection, and meshing at the
    export's 0.05 first doubled a rotor's verify (OCCT keeps the finer mesh,
    so every later ray test ran on it)."""
    import numpy as np

    from .meshpart import to_trimesh, weld

    mesh = weld(to_trimesh(shape, 0.2).copy())
    if mesh.is_watertight:
        return
    edges, counts = np.unique(mesh.edges_sorted, axis=0, return_counts=True)
    rows = []
    for label, bad in (("open", edges[counts == 1]), ("non-manifold", edges[counts > 2])):
        if len(bad):
            mids = mesh.vertices[bad].mean(axis=1)
            at = "; ".join("[" + ", ".join(f"{c:.2f}" for c in m) + "]" for m in mids[:3])
            rows.append(f"{len(bad)} {label} edge(s) at {at}{' …' if len(bad) > 3 else ''}")
    hint = ("a sphere/revolve pole meets a boolean seam: rotate the sphere so its pole is off the cut, "
            "or build the cavity as a revolve. Bodies touching along an edge or a point are non-manifold "
            "too: overlap them or move them apart")
    # A swept thread fused onto its core fails along the whole helix: many bad
    # edges, all one radius about Z, spread over several mm of Z.
    mids = mesh.vertices[edges[counts != 2]].mean(axis=1)
    radii = np.hypot(mids[:, 0], mids[:, 1])
    if len(mids) >= HELIX_SEAM_EDGES and np.ptp(mids[:, 2]) > 2.0 and np.percentile(radii, 90) - np.percentile(radii, 10) < 0.2:
        hint = (f"the bad edges lie on one radius ({float(np.median(radii)):.2f}mm about Z) along "
                f"{float(np.ptp(mids[:, 2])):.0f}mm of Z: a swept thread fused onto a core. Cut a helical groove "
                "into a plain cylinder instead (the cheat sheet's THREADS recipe); the fuse fails this way often")
    raise GateError("G2", "the exported mesh is not watertight although the B-rep is valid: " + "; ".join(rows), hint)


def g2_solid_count(shape: Any, expected: int) -> None:
    """One part is one solid unless the contract says otherwise. A boss that
    floats 0.01mm off its body, or two bodies returned without a fuse, passes
    every other gate and prints as loose pieces."""
    solids = shape.solids()
    if len(solids) == expected:
        return
    rows = []
    for i, s in enumerate(solids):
        bb = s.bounding_box()
        lo = ", ".join(f"{c:.1f}" for c in (bb.min.X, bb.min.Y, bb.min.Z))
        hi = ", ".join(f"{c:.1f}" for c in (bb.max.X, bb.max.Y, bb.max.Z))
        rows.append(f"  solid {i}: {float(s.volume):.0f} mm³, bbox [{lo}] to [{hi}]")
    hint = ("fuse the pieces into one solid with `+` (or fuse()), and make sure bosses, ribs and tabs actually "
            "overlap or touch the body: a feature that floats even 0.01mm away stays a separate solid. "
            "Compare the bboxes above to find the piece that does not meet the rest."
            if len(solids) > expected else
            f"the contract declares {expected} separate bodies; return them as a Compound, not fused together")
    raise GateError(
        "G2",
        f"result is {len(solids)} separate solids, the contract expects {expected}:\n" + "\n".join(rows),
        hint, expected=expected, measured=len(solids),
    )


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
HOLE_CENTER_TOL_MM = 0.2
HOLE_TILT_TOL_DEG = 2.0
TILT_BASELINE_MM = 1.0    # two slices closer than this cannot resolve an angle


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


_JOB_CACHE: dict[tuple[int, str], tuple[Any, Any]] = {}


def _cached(shape: Any, what: str, make) -> Any:
    """One OCCT helper per shape per job. build123d's is_inside builds a fresh
    BRepClass3d_SolidClassifier for every point, and a probe asks thousands of
    points of one shape: reusing it measured 8.4x faster. The shape is held
    beside its helper so a recycled id() can never hand one shape another's."""
    hit = _JOB_CACHE.get((id(shape), what))
    if hit is None or hit[0] is not shape:
        hit = _JOB_CACHE[(id(shape), what)] = (shape, make())
    return hit[1]


def reset_job_cache() -> None:
    """Called by the worker before each job, so helpers never outlive the shapes
    of the job that made them."""
    from .meshpart import reset_mesh_memo

    _JOB_CACHE.clear()
    reset_mesh_memo()


# Rays for _in_material, off every axis so a ray along a port axis or a box
# edge is never the one asked.
CONTAINMENT_RAYS = ((0.5773, 0.5774, 0.5775), (-0.7, 0.3, 0.649), (0.21, -0.88, 0.43))


def _in_material(shape: Any, p: tuple[float, float, float]) -> bool:
    """Inside or on the solid. The nearest face a ray from p meets says it:
    leaving through that face (the ray along its outward normal) means p is in
    material, and no face at all means p is outside. That is the test
    BRepClass3d_SolidClassifier makes, but the classifier rebuilds its ray
    work every point: 38ms a point on a swept thread, and a bore probe asking
    736 points took 28s and timed the job out. The face intersector here is
    loaded once per shape (_line_hits shares it). A ray whose nearest hit is
    on an edge or grazes its face is ambiguous and the next ray is asked; three
    ambiguous rays fall back to the classifier."""
    if getattr(shape, "wrapped", None) is None:  # an imported MeshPart classifies itself
        return bool(shape.is_inside(p))
    from OCP.BRepGProp import BRepGProp_Face
    from OCP.gp import gp_Dir, gp_Lin, gp_Pnt, gp_Vec
    from OCP.IntCurveSurface import IntCurveSurface_Tangent
    from OCP.TopAbs import TopAbs_ON

    it = _intersector(shape)
    reach = _cached(shape, "reach", lambda: shape.bounding_box().diagonal + 2.0)
    for d in CONTAINMENT_RAYS:
        it.Perform(gp_Lin(gp_Pnt(*p), gp_Dir(*d)), -CONTAINMENT_TOL_MM, reach)
        if it.NbPnt() == 0:
            return False
        i = min(range(1, it.NbPnt() + 1), key=it.WParameter)
        if abs(it.WParameter(i)) <= CONTAINMENT_TOL_MM:
            return True
        if it.State(i) == TopAbs_ON or it.Transition(i) == IntCurveSurface_Tangent:
            continue
        normal = gp_Vec()
        BRepGProp_Face(it.Face(i)).Normal(it.UParameter(i), it.VParameter(i), gp_Pnt(), normal)
        dot = normal.Dot(gp_Vec(*d))
        if abs(dot) > 1e-3 * normal.Magnitude():
            return dot > 0
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.TopAbs import TopAbs_IN

    classifier = _cached(shape, "classifier", lambda: BRepClass3d_SolidClassifier(shape.wrapped))
    classifier.Perform(gp_Pnt(*p), CONTAINMENT_TOL_MM)
    return classifier.State() == TopAbs_IN or classifier.IsOnAFace()


CONTAINMENT_TOL_MM = 1e-6


def _intersector(shape: Any) -> Any:
    from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector

    def load() -> Any:
        it = IntCurvesFace_ShapeIntersector()
        it.Load(shape.wrapped, 1e-7)
        return it

    return _cached(shape, "lines", load)


CROSSING_EPS_MM = 1e-3


def _line_hits(shape: Any, start: tuple[float, float, float], direction: list[float], reach: float) -> list[float]:
    """Where the line from `start` along `direction` meets the B-rep's faces,
    as sorted distances in [0, reach]. Exact, where a 0.25mm march costs four
    classifier calls per millimetre of depth and steps over a thinner floor."""
    from OCP.gp import gp_Dir, gp_Lin, gp_Pnt

    it = _intersector(shape)
    it.Perform(gp_Lin(gp_Pnt(*start), gp_Dir(*direction)), 0.0, reach)
    return sorted(it.WParameter(i) for i in range(1, it.NbPnt() + 1))


def _march(shape: Any, frame, du: float, dv: float, w: float, max_r: float,
           find: str = "material", dw: float = 0.0) -> float | None:
    """Distance along (du, dv, dw) from depth w to the first change of state, or
    None if it never changes within max_r. Outward step then 12 bisections, so
    the answer is good to max_r/2**12 regardless of the step.

    `dw` marches along the frame's z rather than in its plane: du=dv=0, dw=-1 is
    the depth probe that follows the axis down to a channel or hole floor. It
    was a second function, _march_depth, identical but for the sample point. On
    a B-rep it intersects the line with the faces instead of stepping.

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
    #
    # IN-PLANE ONLY, deliberately. The depth probe starts AT the port origin,
    # which lies on the mating face — a point the containment test may call
    # either way. _march_depth never had this guard, and a guard that fires on a
    # boundary sample would turn a real floor into None, which reads as "the cut
    # passes through". The depth path never had the guard and still has none.
    if dw == 0.0 and _in_material(shape, _at(o, x, y, z, 0.0, 0.0, w)) == want_material:
        return None
    if getattr(shape, "wrapped", None) is not None:
        # On a B-rep: every face the line meets, each crossing confirmed by the
        # classifier just past it (a grazing hit changes nothing). 0.0 first,
        # so a depth march already in the sought state reads ~0 as before. In
        # the plane too since GATES_VERSION 22: the helix-tolerant hole rays
        # cast a few hundred lines, which stepping at 0.25mm made seconds.
        start = _at(o, x, y, z, 0.0, 0.0, w)
        d = [x[i] * du + y[i] * dv + z[i] * dw for i in range(3)]
        for t in [0.0, *_line_hits(shape, start, d, max_r)]:
            p = tuple(start[i] + d[i] * (t + CROSSING_EPS_MM) for i in range(3))
            if _in_material(shape, p) == want_material:
                return t
        return None
    lo, crossing, r = 0.0, None, step
    while r <= max_r:
        if _in_material(shape, _at(o, x, y, z, du * r, dv * r, w + dw * r)) == want_material:
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
        if _in_material(shape, _at(o, x, y, z, du * mid, dv * mid, w + dw * mid)) == want_material:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def _fit_circle(pts: list[tuple[float, float]]) -> tuple[float, float, float] | None:
    """Least-squares circle (Kåsa): solve u²+v² + a·u + b·v + c = 0 for a, b, c
    and return (cu, cv, r), or None when the points are collinear."""
    n = float(len(pts))
    su = sum(u for u, _ in pts)
    sv = sum(v for _, v in pts)
    suu = sum(u * u for u, _ in pts)
    svv = sum(v * v for _, v in pts)
    suv = sum(u * v for u, v in pts)
    szu = sum((u * u + v * v) * u for u, v in pts)
    szv = sum((u * u + v * v) * v for u, v in pts)
    sz = suu + svv

    def det(m: list[list[float]]) -> float:
        return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))

    m = [[suu, suv, su], [suv, svv, sv], [su, sv, n]]
    rhs = [-szu, -szv, -sz]
    d = det(m)
    if abs(d) < 1e-9:
        return None
    a, b, c = (det([[rhs[i] if j == col else m[i][j] for j in range(3)] for i in range(3)]) / d
               for col in range(3))
    cu, cv = -a / 2, -b / 2
    r2 = cu * cu + cv * cv - c
    return (cu, cv, math.sqrt(r2)) if r2 > 0 else None


def _hole_slice(shape: Any, frame, max_r: float, w: float,
                cu0: float = 0.0, cv0: float = 0.0,
                window: tuple[float, float] | None = None) -> tuple[float, float, float] | None:
    """Circle fitted through the nearest void→material crossing of rays cast
    from (cu0, cv0) at depth w: (cu, cv, r) in the port frame, or None when
    fewer than 3 rays meet a wall.

    A fit, not the median ray it replaced. Rays from an off-centre origin still
    land on the wall, so the fit recovers the true centre and diameter where a
    median of distances from the wrong point read neither. Rays that leave the
    part (a hole near an edge) see no crossing and simply drop out. A ray that
    escapes through a notch and lands on some farther wall is an outlier a
    least-squares fit cannot absorb (one of 8 put a real socket 2.2mm off), so
    hits far from the median ray are dropped before fitting: the robustness the
    median had. The band is wide, so an off-centre origin keeps its rays, and
    dropping a good point costs nothing because the rest still lie on the wall.

    `window` (depths, positive) is for a slice whose crossings do not all lie
    on its circle: each ray then reads its NEAREST wall over that window. One
    slice of a thread is crests on half the circle and groove on the rest,
    and the circle through some of each read a straight M28 socket 9.3
    degrees tilted; over half a pitch every ray meets a crest. A round slice
    never pays for it."""
    o, x, y, z = frame
    start = (list(_at(o, x, y, z, cu0, cv0, 0.0)), x, y, z)
    thetas = _thetas(SLICE_RAYS if _brep(shape) else PROBE_DIRECTIONS)

    def ray(theta: float, depths: list[float]) -> float | None:
        hits = [h for h in (_march(shape, start, math.cos(theta), math.sin(theta), -d, max_r) for d in depths)
                if h is not None]
        return min(hits) if hits else None

    def fit(hits: list[tuple[float, float]]) -> tuple[float, float, float] | None:
        if len(hits) < 3:
            return None
        med = sorted(h for _, h in hits)[len(hits) // 2]
        pts = [(cu0 + h * math.cos(t), cv0 + h * math.sin(t)) for t, h in hits
               if abs(h - med) <= max(1.0, med / 2)]
        return _robust_circle(pts, EXACT_FIT_TOL_MM if _brep(shape) else DIAMETER_TOL_MM) if len(pts) >= 3 else None

    hits = [(t, h) for t in thetas if (h := ray(t, [-w])) is not None]
    circle = fit(hits)
    if circle is None or window is None or not _brep(shape):
        return circle
    cu, cv, r = circle
    if all(math.hypot(cu0 + h * math.cos(t) - cu, cv0 + h * math.sin(t) - cv) <= r + DIAMETER_TOL_MM
           for t, h in hits):
        return circle
    depths = sorted({-w, *_window(*window)})
    return fit([(t, h) for t in thetas if (h := ray(t, depths)) is not None])


EXACT_FIT_TOL_MM = 0.05
"""How far a crossing may sit off the circle it votes for on a B-rep, where a
round wall's crossings are exact. DIAMETER_TOL_MM let a circle 0.16mm wider
gather a square-shouldered roof's corners and a round half at once."""


def _robust_circle(pts: list[tuple[float, float]], tol: float) -> tuple[float, float, float] | None:
    """The circle most crossings agree on (within `tol`), refitted through
    them and read as the INSCRIBED circle (the smallest kept radius). A
    keyway's crossing pulled a plain fit 0.74mm off centre and read a Ø12 bore
    as Ø12.52; a key, a flat or a D-bore moves neither the centre nor the
    diameter, and what a shaft must pass is the smallest circle anyway.

    Consensus over every triple, not trimming from a first fit: a slice of a
    thread has its groove over ~3 of 8 rays, the first fit through all 8 sat
    0.8mm toward it, and trimming from there kept the groove and dropped the
    crests, so a straight M28 socket read 9.3 degrees tilted. The circle wins
    that the most crossings lie on, less the crossings well INSIDE it (fewest
    squared residuals on a tie): a bore is the circle every other feature lies
    outside of. 560 triples of 16 points."""
    best: tuple[int, float, list[tuple[float, float]]] | None = None
    for tri in itertools.combinations(pts, 3):
        fit = _fit_circle(list(tri))
        if fit is None:
            continue
        res = [math.hypot(u - fit[0], v - fit[1]) - fit[2] for u, v in pts]
        keep = [p for p, e in zip(pts, res) if abs(e) <= tol]
        inside = sum(e < -DIAMETER_TOL_MM for e in res)
        score = (len(keep) - inside, -sum(e * e for e in res if abs(e) <= tol))
        if best is None or score > best[:2]:
            best = (*score, keep)
    if best is None:
        return None
    fit = _fit_circle(best[2])
    if fit is None:
        return None
    cu, cv, _ = fit
    return cu, cv, min(math.hypot(u - cu, v - cv) for u, v in best[2])


HELIX_WINDOW_MM = 4.0
"""Depth window a thread-tolerant measurement spans. Every ray of a slice
meets a thread's crest within half a pitch, so this covers pitches to ~7mm
(ISO coarse M30 is 3.5, t4-007's socket 4)."""
HELIX_STEP_MM = 0.25
"""Spacing of that window's slices: under half the finest pitch it must see
(M3, 0.5)."""
ROUND_RAYS = 24
"""Rays around a bore for the roundness check, at half-step offsets so none
lies on a teardrop's equator or apex."""
SLICE_RAYS = 16
"""Rays a hole slice fits its circle through on a B-rep."""


def _brep(shape: Any) -> bool:
    """A B-rep casts exact lines; an imported MeshPart steps a classifier and
    cannot afford the windowed measurements."""
    return getattr(shape, "wrapped", None) is not None


def _thetas(n: int, offset: float = 0.0) -> list[float]:
    return [2 * math.pi * (k + offset) / n for k in range(n)]


def _window(lo: float, hi: float) -> list[float]:
    """Depths lo..hi at HELIX_STEP_MM; just lo when the window is empty."""
    if hi <= lo:
        return [lo]
    return [lo + k * HELIX_STEP_MM for k in range(int((hi - lo) / HELIX_STEP_MM + 1e-9) + 1)]


def _bulge(shape: Any, frame, cu: float, cv: float, r: float, depth: float,
           window: tuple[float, float], max_r: float) -> tuple[float, float] | None:
    """None when the bore wall about (cu, cv) stays within r + DIAMETER_TOL_MM
    over a contiguous half of the circle (13 of 24 rays, 180 degrees from the
    first to the last), else (that longest arc in degrees, the widest wall
    radius). A slice that fails is re-read with each ray at its NEAREST wall
    over `window`: a thread's groove passes every ray within half a pitch, and
    a teardrop is the same at every depth. A ray that meets no wall (a
    crossing channel open to the outside) does not break the arc."""
    o, x, y, z = frame
    start = (list(_at(o, x, y, z, cu, cv, 0.0)), x, y, z)

    def arc(depths: list[float]) -> tuple[float, float] | None:
        walls: list[float | None] = []
        for t in _thetas(ROUND_RAYS, 0.5):
            hits = [h for h in (_march(shape, start, math.cos(t), math.sin(t), -d, max_r) for d in depths)
                    if h is not None]
            walls.append(min(hits) if hits else None)
        good = [h is None or h <= r + DIAMETER_TOL_MM for h in walls]
        if all(good):
            return None
        k = good.index(False)
        run = longest = 0
        for g in good[k:] + good[:k]:
            run = run + 1 if g else 0
            longest = max(longest, run)
        if longest > ROUND_RAYS // 2:
            return None
        return max(longest - 1, 0) * 360 / ROUND_RAYS, max(h for h in walls if h is not None)

    found = arc([depth])
    return found if found is None else arc(sorted({depth, *_window(*window)}))


FASTENER_HOLES = {"CLEARANCE_HOLE", "HOLE_PATTERN"}


def _fastener_seat(d: float) -> tuple[str, float] | None:
    """(thread, SHCS head Ø) for the catalog thread whose ISO 273 clearance a
    Ø d hole is, or None for a hole no stocked screw clears that way (a Ø10
    fluid channel), whose roundness is its function."""
    from .meshpart import _catalog

    cat = _catalog()
    heads = cat["families"]["shcs"]["dims"]
    for thread, row in cat["threads"].items():
        if abs(float(row["clearance"]) - d) <= DIAMETER_TOL_MM and thread in heads:
            return thread, float(heads[thread]["headD"])
    return None


def _axial_depth(shape: Any, frame, u: float, v: float, reach: float, find: str = "material") -> float | None:
    """Depth below the face at which the line through (u, v) parallel to the
    port axis changes state, marching down from PROBE_DEPTH_MM."""
    o, x, y, z = frame
    t = _march(shape, (list(_at(o, x, y, z, u, v, 0.0)), x, y, z), 0.0, 0.0, -PROBE_DEPTH_MM, reach,
               find=find, dw=-1.0)
    return None if t is None else PROBE_DEPTH_MM + t


def _breaks_out(shape: Any, frame, cu: float, cv: float, r: float, floor: float) -> bool:
    """True when the material the axis meets at `floor` is the far side of a
    cavity the hole opened into, not the hole's own bottom: the ring just
    outside the bore, just above that floor, is mostly void. A blind bottom has
    its wall all round it there. A C-clamp's screw hole runs through the top
    arm into the jaw and meets the bottom arm; reading that as "bottoms out"
    sent repair to drill the bottom arm too."""
    o, x, y, z = frame
    w = -(floor - PROBE_DEPTH_MM / 2)
    void = sum(not _in_material(shape, _at(o, x, y, z, cu + r * math.cos(t), cv + r * math.sin(t), w))
               for t in (2 * math.pi * k / PROBE_DIRECTIONS for k in range(PROBE_DIRECTIONS)))
    return void * 2 >= PROBE_DIRECTIONS


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


def _probe_hole(shape: Any, port: dict[str, Any], band: tuple[float, float] | None = None,
                through: bool | None = None) -> dict[str, Any]:
    """`band` replaces the ±DIAMETER_TOL_MM window with an explicit [lo, hi]:
    a press or slip fit is a one-sided band 0.1mm wide, which the default
    tolerance would pass on both sides at once. `through` says the hole must
    pass through the part; it defaults to true for a CLEARANCE_HOLE only."""
    d = _port_diameter(port)
    key, ptype = port["key"], port["type"]
    if through is None:
        through = ptype == "CLEARANCE_HOLE"
    frame = _frame(port["pose"])
    o, x, y, z = frame
    max_r = d * 1.5 + 2.0

    if _in_material(shape, _at(o, x, y, z, 0, 0, -PROBE_DEPTH_MM)):
        raise GateError("G3", f'port "{key}" ({ptype}): no hole found at the declared origin',
                        "cut the hole exactly at the contract pose, or fix the pose the code assumes")
    mouth = _hole_slice(shape, frame, max_r, -PROBE_DEPTH_MM)
    if mouth is None:
        raise GateError("G3", f'port "{key}" ({ptype}): no hole wall found around the port origin '
                              f'(fewer than 3 of {PROBE_DIRECTIONS} rays met material within {max_r:.1f}mm)',
                        f"the origin sits in open space, not inside a hole: cut a Ø{d:g} hole centred on the "
                        f"contract pose, or move the pose onto the hole")
    cu, cv, r_mouth = mouth

    # DEPTH, because a diameter at one plane does not make a hole. The probe
    # sampled a single slice 0.6mm down and compared its width, so a Ø8 dimple
    # 0.75mm deep reported "measured_diameter: 8.0" and passed as a clearance
    # hole a screw was supposed to go through.
    bbox = shape.bounding_box()
    reach = max(float(bbox.size.X), float(bbox.size.Y), float(bbox.size.Z)) + 2.0
    floor = _march(shape, frame, 0.0, 0.0, 0.0, reach, dw=-1.0)
    breakout = floor is not None and _breaks_out(shape, frame, cu, cv, r_mouth + PROBE_INSET_MM, floor)

    # HOW FAR THE HOLE RUNS bounds where it is sliced. A blind hole ends at its
    # floor. A through hole's axis never meets material, so its length is read
    # off the wall beside it. A seat also ends at an annular step: the pilot
    # under a counterbore is a different feature, and the narrowest slice of
    # the stack would grade the counterbore against the pilot's diameter.
    # A clearance hole gets no such bound, because a screw has to pass the
    # narrowest point of the whole bore.
    span = None if breakout else floor
    if span is None:
        walls = []
        for k in range(0, PROBE_DIRECTIONS, 2):
            theta = 2 * math.pi * k / PROBE_DIRECTIONS
            wu, wv = cu + (r_mouth + PROBE_INSET_MM) * math.cos(theta), cv + (r_mouth + PROBE_INSET_MM) * math.sin(theta)
            if _in_material(shape, _at(o, x, y, z, wu, wv, -PROBE_DEPTH_MM)):
                t = _axial_depth(shape, frame, wu, wv, reach, find="void")
                if t is not None:
                    walls.append(t)
        span = sorted(walls)[len(walls) // 2] if walls else PROBE_DEPTH_MM * 3
    if not through:
        r_in = d / 2 - DIAMETER_TOL_MM
        if _in_material(shape, _at(o, x, y, z, cu + r_in, cv, -PROBE_DEPTH_MM)):
            span = PROBE_DEPTH_MM
        else:
            step = _axial_depth(shape, frame, cu + r_in, cv, reach)
            if step is not None:
                span = min(span, step)

    # NARROWEST over several depths, the way _probe_channel measures a width:
    # a chamfered mouth reads wide at 0.6mm, and a hole too narrow under that
    # chamfer read exactly right at that one slice.
    # Each slice may widen to a window of depths inside the hole when its
    # crossings disagree (a thread: see _hole_slice), so the mouth is re-read.
    def window(depth: float) -> tuple[float, float]:
        lo = max(PROBE_DEPTH_MM, min(depth - HELIX_WINDOW_MM / 2, span - PROBE_DEPTH_MM - HELIX_WINDOW_MM))
        return lo, max(lo, min(span - PROBE_DEPTH_MM, lo + HELIX_WINDOW_MM))

    slices = []
    for depth in sorted({PROBE_DEPTH_MM, max(PROBE_DEPTH_MM, span / 2), max(PROBE_DEPTH_MM, span - PROBE_DEPTH_MM)}):
        fit = _hole_slice(shape, frame, max_r, -depth, cu, cv, window(depth))
        if fit is not None:
            slices.append((depth, fit))
    if not slices:
        slices = [(PROBE_DEPTH_MM, mouth)]
    at_depth, (_, _, r_min) = min(slices, key=lambda s: s[1][2])
    measured = 2 * r_min
    if band and not band[0] - FIT_EPS_MM <= measured <= band[1] + FIT_EPS_MM:
        lo, hi = band
        raise GateError("G3", f'port "{key}" ({ptype}): expected Ø{lo:.2f}..{hi:.2f}, measured Ø{measured:.2f}',
                        f"cut the bore to Ø{(lo + hi) / 2:.2f}: the fit allows only Ø{lo:.2f}..{hi:.2f}, "
                        f"and a bore outside it either will not assemble or will not hold",
                        expected=round((lo + hi) / 2, 3), measured=round(measured, 3))
    if not band and abs(measured - d) > DIAMETER_TOL_MM:
        where = f" (narrowest, at {at_depth:g}mm depth)" if len(slices) > 1 else ""
        hint = f"change the hole feature to Ø{d:g} as pinned in the contract"
        if through and measured < d:
            hint += (f". A through hole must be Ø{d:g} all the way through; a counterbore above it "
                     f"is a SCREW_SEAT port of its own")
        raise GateError("G3", f'port "{key}" ({ptype}): expected Ø{d:g}, measured Ø{measured:.2f}{where}',
                        hint, expected=d, measured=round(measured, 3))

    offset = math.hypot(cu, cv)
    if offset > HOLE_CENTER_TOL_MM:
        centre = _at(o, x, y, z, cu, cv, 0.0)
        raise GateError(
            "G3",
            f'port "{key}" ({ptype}): hole centre is {offset:.2f}mm off the declared origin '
            f'(measured [{", ".join(f"{c:.2f}" for c in centre)}], expected [{", ".join(f"{c:g}" for c in o)}])',
            f"move the hole {offset:.2f}mm so its axis passes through the contract origin exactly; "
            f"a mating screw or pin is placed at the origin, not at the hole",
            expected=0.0, measured=round(offset, 3),
        )

    # ROUND ON AT LEAST HALF ITS CIRCLE. The diameter is the inscribed circle,
    # so a bore cut wider than it on one side passes that check by design (a
    # keyway, a D-flat, a teardrop roof). A 45-degree Box teardrop widened a
    # Ø10 channel to Ø14 at its equator and passed three cooks running
    # (t3-002). What must hold is the round side: the wall stays on the circle
    # over a contiguous half of it. A teardrop or a flat roof bulges above the
    # axis only; that Box bulged at both ends of the equator.
    finding = hint = ""
    if _brep(shape):
        bulge = None
        for depth, (su, sv, sr) in slices:
            bulge = _bulge(shape, frame, su, sv, sr, depth, window(depth), max_r)
            if bulge is None:
                break
        if bulge is not None:
            arc, widest = bulge
            error = (f'port "{key}" ({ptype}): not round — the wall stays on the Ø{measured:.2f} circle over only '
                     f'{arc:.0f}° of it and reaches Ø{2 * widest:.2f} elsewhere; at least 180° must be round')
            hint = ("cut the bore as a true circle. An FDM teardrop keeps the full circle and adds only a 45° roof "
                    "above it, tangent to the circle at ±45°: union the round cutter with a square of side r turned "
                    "45° about the bore axis whose corners sit on the axis and r·√2 above it. A Box rotated 45° "
                    "spans r·√2 each side of the axis and widens the hole at its equator")
            # A screw only passes a clearance hole: a bulge is slop until it
            # reaches the head's bearing face. t3-010 and t5-002 cut M4/M5
            # holes this way and CADClamp passed them.
            seat = _fastener_seat(d) if ptype in FASTENER_HOLES else None
            if seat is not None and 2 * widest < seat[1]:
                finding = f"{error}, short of the {seat[0]} head's Ø{seat[1]:g} bearing face"
            else:
                if seat is not None:
                    error += f", past the {seat[0]} head's Ø{seat[1]:g} bearing face"
                raise GateError("G3", error, hint, expected=d, measured=round(2 * widest, 3))

    result: dict[str, Any] = {"key": key, "type": ptype, "measured_diameter": round(measured, 3),
                              "center_offset": round(offset, 3)}
    if finding:
        result["finding"] = f"{finding}. {hint}"
    (w0, (u0, v0, _)), (w1, (u1, v1, _)) = slices[0], max(slices, key=lambda s: s[0])
    if w1 - w0 >= TILT_BASELINE_MM:
        drift = math.hypot(u1 - u0, v1 - v0)
        tilt = math.degrees(math.atan2(drift, w1 - w0))
        if tilt > HOLE_TILT_TOL_DEG:
            raise GateError(
                "G3",
                f'port "{key}" ({ptype}): hole axis tilted {tilt:.1f}° from the declared zAxis '
                f'(centre drifts {drift:.2f}mm over {w1 - w0:.1f}mm of depth)',
                "cut the hole straight along the port's zAxis: check the Rot on the cutter, or the pose's "
                "zAxis if the hole is meant to be angled",
                expected=0.0, measured=round(tilt, 2),
            )
        result["tilt_deg"] = round(tilt, 2)

    result["through"] = floor is None or breakout
    if breakout:
        result["breakout_depth"] = round(floor, 3)
    elif floor is not None:
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
    # it is unsatisfiable: the depth march follows the axis to the DEEPEST floor in
    # a coaxial stack, so a counterbore over a pilot measures the pilot. A
    # counterbore's own floor is an annulus and never lies on the axis. The
    # FLAT_FACE grid already taught what an unsatisfiable check costs. Both
    # numbers are still measured and reported, which is the part with value.
    if through and not result["through"]:
        raise GateError("G3", f'port "{key}" ({ptype}): bottoms out at {floor:.2f}mm instead of passing through',
                        "cut it through the part, or declare it as a BORE or SCREW_SEAT if it is meant to be a blind seat"
                        if ptype == "CLEARANCE_HOLE" else
                        "cut it through the part, or declare params.depth on the port if it is meant to be blind")

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
        raise GateError("G3", f'port "{port["key"]}" ({port["type"]}): boss wall missing (Ø{od:g} ring {hits}/{PROBE_DIRECTIONS} in material)',
                        f"model a boss of outer Ø{od:g} centered at the contract pose")

    result = {"key": port["key"], "type": port["type"], "ring_hits": hits}
    if pilot > 0:
        if _in_material(shape, _at(o, x, y, z, 0, 0, w)):
            raise GateError("G3", f'port "{port["key"]}" ({port["type"]}): pilot hole Ø{pilot:g} missing',
                            f"cut a Ø{pilot:g} pilot at the boss center")
        fit = _hole_slice(shape, frame, od / 2, w)
        if fit is None:
            raise GateError("G3", f'port "{port["key"]}" (SCREW_BOSS): no pilot wall found around the port origin',
                            f"cut a Ø{pilot:g} pilot centred on the boss at the contract pose")
        measured = 2 * fit[2]
        if abs(measured - pilot) > DIAMETER_TOL_MM:
            raise GateError("G3", f'port "{port["key"]}" ({port["type"]}): expected pilot Ø{pilot:g}, measured Ø{measured:.2f}',
                            f"change the pilot hole to Ø{pilot:g} as pinned in the contract",
                            expected=pilot, measured=round(measured, 3))
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
    # A HOLLOW peg is still a peg: a threaded spigot with a flow passage up its
    # axis read "no material 0.25mm out, so there is no peg" (t4-007). Void on
    # the axis is a tube when a wall surrounds it inside the declared Ø.
    bore_r: float | None = None
    if not _in_material(shape, _at(o, x, y, z, 0.0, 0.0, near)):
        inner = [r for r in (_march(shape, frame, math.cos(t), math.sin(t), near, d / 2) for t in _thetas(8))
                 if r is not None]
        if len(inner) < 6:
            raise GateError(
                "G3",
                f'port "{key}" (SHAFT): no material {near}mm out from the pose, so there is no peg',
                f"grow a Ø{d:g} peg standing out of the mating face at the contract pose",
            )
        bore_r = sorted(inner)[len(inner) // 2]

    def radius(theta: float, w: float) -> float | None:
        """Where the peg's material ends along theta at depth w; on a tube,
        past its bore wall."""
        c, s = math.cos(theta), math.sin(theta)
        if bore_r is None:
            return _march(shape, frame, c, s, w, max_r=d * 2 + 4.0, find="void")
        wall = _march(shape, frame, c, s, w, d / 2 + DIAMETER_TOL_MM)
        if wall is None:
            return None
        t0 = wall + CROSSING_EPS_MM
        out = _march(shape, (list(_at(o, x, y, z, c * t0, s * t0, 0.0)), x, y, z), c, s, w,
                     max_r=d * 2 + 4.0, find="void")
        return None if out is None else t0 + out

    # The tip first, so the diameter is measured at the middle of the ACTUAL peg
    # rather than wherever the declaration guessed. A tube's tip is followed
    # up its wall, the furthest of two lines a fifth and half way out from the
    # bore: a thread's groove cut the outer line short 1.7mm up a 20mm spigot.
    reach = (declared_len * 2 + 4.0) if declared_len else (d * 4 + 20.0)
    lines = [0.0]
    if bore_r is not None:
        outs = [r for r in (radius(t, near) for t in _thetas(8)) if r is not None]
        lines = [bore_r + f * (min(outs) - bore_r) for f in (0.2, 0.5)] if outs else [bore_r]
    rises = [_march(shape, (list(_at(o, x, y, z, u, 0.0, 0.0)), x, y, z), 0.0, 0.0, near, reach,
                    find="void", dw=1.0) for u in lines]
    tip = None if None in rises else near + max(rises)
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
            expected=declared_len, measured=round(tip, 3),
        )

    # NEAR THE BASE, not at mid-height. A declared diameter is the diameter at
    # the base, and any draft makes the midpoint a different number by
    # construction: 2 degrees over 12mm loses 0.42mm against a 0.25 tolerance,
    # so measuring the middle false-failed the better part. Draft is good
    # practice on a slip fit. Still clear of a base fillet by PROBE_DEPTH_MM.
    w = min(near + PROBE_DEPTH_MM, tip / 2) if tip else max(near, PROBE_DEPTH_MM)

    # Each ray's LARGEST radius over a window of depths, the envelope a socket
    # must accept. One slice of a threaded spigot is a crest on half the circle
    # and a root on the other, which read "not round" on a correct thread; over
    # half a pitch or more every ray meets a crest. Draft only shrinks upward,
    # so the base still sets the number, and a slab fused to the peg is wide at
    # every depth and still fails.
    top = (tip - PROBE_DEPTH_MM) if tip else w
    depths = _window(w, min(w + HELIX_WINDOW_MM, top)) if _brep(shape) else [w]
    radii = []
    for theta in _thetas(8):
        rs = [r for r in (radius(theta, dw_) for dw_ in depths) if r is not None]
        if len(rs) == len(depths):
            radii.append(max(rs))
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
            expected=d, measured=round(measured, 3),
        )

    result: dict[str, Any] = {"key": key, "type": port["type"], "measured_diameter": round(measured, 3)}
    if tip is not None:
        result["measured_length"] = round(tip, 3)
    if bore_r is not None:
        result["bore_diameter"] = round(2 * bore_r, 3)
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
        # A channel of the declared width in FRONT of the origin: the pose sits
        # on its floor. t3-004's keyway port did, and the generator read the
        # depth as running on past it and cut the keyway 2mm too deep.
        reach = width * 3 + 2.0
        left = _march(shape, frame, 0.0, 1.0, PROBE_DEPTH_MM, reach)
        right = _march(shape, frame, 0.0, -1.0, PROBE_DEPTH_MM, reach)
        if left is not None and right is not None and abs(left + right - width) <= DIAMETER_TOL_MM:
            raise GateError("G3", f'port "{key}" ({ptype}): a {left + right:.2f}mm channel lies in front of the declared '
                                  f"origin, which sits on its floor instead of at its mouth",
                            "a SLOT/GROOVE origin is on the face the channel opens through, +z out of it, with "
                            "params.depth running INTO the material along -z. If this channel is where the spec "
                            "puts it, the pose is the contract's mistake: keep the channel as specified rather "
                            "than cutting past its floor to meet the pose")
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
    floor = _march(shape, frame, 0.0, 0.0, 0.0, reach_down, dw=-1.0)

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
                            f"cut the channel floor {declared_depth:g}mm from the face; a mating part seats on this number",
                            expected=declared_depth, measured=round(floor, 3))

    # SAMPLING, NOT A BOUND. Five depths cannot see a constriction that falls
    # between them: a 3mm channel pinched to 2.4mm over a 0.5mm band still
    # passes. No finite sample set closes that, and one slice was strictly
    # worse — but the failure hint says "make the channel 3mm at its tightest
    # point", which is more than the gate can actually verify.
    reach = width * 3 + 2.0
    span_to = (floor - PROBE_EPS_MM) if floor is not None else PROBE_DEPTH_MM * 3
    depths = sorted({max(PROBE_DEPTH_MM, PROBE_DEPTH_MM + (span_to - PROBE_DEPTH_MM) * k / 4) for k in range(5)})
    measured: float | None = None
    at_depth: float | None = None
    breakout: float | None = None
    for probe_w in depths:
        if _in_material(shape, _at(o, x, y, z, 0, 0, -probe_w)):
            continue  # past the floor or into a rib — not a slice of this channel
        left = _march(shape, frame, 0.0, 1.0, -probe_w, reach)
        right = _march(shape, frame, 0.0, -1.0, -probe_w, reach)
        if (left is None or right is None) and measured is not None:
            # BREAKOUT, the channel's version of _breaks_out: walled above, open
            # here, so the channel ran into a void crossing it. A nut drop slot
            # meets the bolt hole that crosses its nut pocket, and grading the
            # slice inside that hole failed a correct part as "open". The width
            # is held wherever the walls exist, which is above this.
            breakout = probe_w
            break
        if left is None or right is None:
            # Open before any slice found both walls. At the MOUTH the walls may
            # exist deeper down but are gone where the mating part enters. The
            # one that keeps happening: a Box rotated 45 deg and subtracted as a
            # chamfer spans leg*sqrt(2) in each rotated axis, so a flare sized
            # against the wall thickness quietly eats the entire wall.
            if probe_w <= PROBE_DEPTH_MM:
                hint = ("a wall is missing at the channel MOUTH but may exist deeper. Suspect an "
                        "over-cut lead-in/chamfer: a Box rotated 45 deg spans leg*1.414 in each "
                        "rotated axis, so a flare sized to the wall thickness cuts the wall away "
                        "entirely. Use chamfer(edges, length) or fillet(edges, radius) on the mouth "
                        "edges instead of subtracting a rotated Box. If you meant no lead-in at all, "
                        "check the pose's xAxis points ALONG the channel, not across it")
            else:
                hint = ("the channel must be bounded on both sides across its width; "
                        "check the pose's xAxis points ALONG the channel, not across it")
            raise GateError("G3", f'port "{key}" ({ptype}): no wall within {reach:.1f}mm at {probe_w:.1f}mm depth — the channel is open, not a {width:g}mm gap',
                            hint)
        span = left + right
        if measured is None or span < measured:
            measured, at_depth = span, probe_w

    if measured is None or at_depth is None:
        raise GateError("G3", f'port "{key}" ({ptype}): no open channel below the declared face',
                        f"cut a {width:g}mm-wide channel centred on the contract pose")

    if abs(measured - width) > DIAMETER_TOL_MM:
        raise GateError("G3", f'port "{key}" ({ptype}): expected width {width:g}, narrowest measured {measured:.2f} (at {at_depth:g}mm depth)',
                        f"the declared width is the NARROWEST gap, because that is what a mating tongue must fit through — make the channel {width:g}mm at its tightest point. A chamfered or drafted mouth is fine and is not what gets measured, so do not widen the channel to compensate for one.",
                        expected=width, measured=round(measured, 3))

    result: dict[str, Any] = {"key": key, "type": ptype, "measured_width": round(measured, 3)}
    if breakout is not None:
        result["breakout_depth"] = round(breakout, 3)
    elif floor is not None:
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

CONTACT_RADIUS_MM = 5.0
"""Default ball around a mate point that G5's contact check looks inside. The
caller widens it to the mated features' own size."""

CONTACT_SAMPLES = 2000
"""Surface samples per part inside that ball. Flat contact is exact at any
density; this only bounds how finely a curved approach is resolved."""


def _posed_mesh(shape: Any, matrix: list[float]) -> Any:
    """Tessellate and place, as one welded trimesh. Mesh rather than B-rep on
    purpose: it costs one tessellation instead of an OCP boolean per pair, and
    it works unchanged on imported MeshParts."""
    import numpy as np
    import trimesh

    from .meshpart import MeshPart, to_trimesh

    # Copied: to_trimesh's mesh is shared (the part's own, or the job's memo),
    # and posing mutates. Two copies of one node would otherwise move it twice.
    mesh = to_trimesh(shape, TESSELLATION_TOL_CLASH).copy()  # welds the b3d branch
    if isinstance(shape, MeshPart) and not mesh.is_watertight:
        # This branch is where a non-watertight mesh can actually arrive:
        # an imported STL. The repair used to sit on the build123d branch,
        # where process=True has already welded and b3d tessellates closed
        # anyway — guarding the case that could not happen.
        mesh.merge_vertices(merge_tex=True, merge_norm=True)
        trimesh.repair.fill_holes(mesh)
    if matrix:
        m = np.asarray(matrix, dtype=np.float64).reshape(4, 4).T  # column-major in
        mesh.apply_transform(m)
    return mesh


def _node_of(key: str) -> str:
    """Instances of one node are keyed `node#i`; the node is what owns them."""
    return key.split("#", 1)[0]


def _surface_near(mesh: Any, at: Any, radius: float) -> Any:
    """Points on the mesh surface within `radius` of `at`: vertices plus an
    even sample of every triangle that comes that close. Vertices alone miss a
    big flat face, which tessellates to two triangles with corners far away."""
    import numpy as np
    import trimesh

    closest = trimesh.triangles.closest_point(mesh.triangles, np.tile(at, (len(mesh.faces), 1)))
    near = np.nonzero(np.linalg.norm(closest - at, axis=1) <= radius)[0]
    if not len(near):
        return np.empty((0, 3))
    sub = mesh.submesh([near], append=True)
    pts = np.vstack([sub.vertices, sub.sample(CONTACT_SAMPLES), closest[near]])
    return pts[np.linalg.norm(pts - at, axis=1) <= radius]


def _contact_gap(mesh_a: Any, mesh_b: Any, at: Any, radius: float) -> float:
    """Smallest distance between two posed parts in the ball around a mate
    point; 0.0 when they touch or interpenetrate there. A part whose surface
    never comes within the ball is at least that far away, so the gap is its
    distance from the mate point."""
    import numpy as np
    import trimesh

    near_a = _surface_near(mesh_a, at, radius)
    near_b = _surface_near(mesh_b, at, radius)
    if not len(near_a) or not len(near_b):
        far = mesh_b if len(near_a) else mesh_a
        _, dist, _ = trimesh.proximity.closest_point(far, [at])
        return float(dist[0])
    # Interpenetration is contact. Checked first because the unsigned distance
    # from a point buried inside the other part is to its far surface, not 0.
    for mesh, pts in ((mesh_a, near_b), (mesh_b, near_a)):
        if mesh.is_watertight and bool(np.any(mesh.contains(pts))):
            return 0.0
    _, d_ab, _ = trimesh.proximity.closest_point(mesh_a, near_b)
    _, d_ba, _ = trimesh.proximity.closest_point(mesh_b, near_a)
    return float(min(d_ab.min(), d_ba.min()))


def _manifold(mesh: Any) -> Any:
    """A posed mesh as a manifold3d solid, merging split seams if it has to.

    Called directly because trimesh's own wrapper refuses any mesh that fails
    its `is_volume` check. A lofted fuselage is a valid closed B-rep solid, but
    OCP tessellates its loft seams with 14 unmatched edges, so trimesh calls it
    "not a volume" and every pair involving it went uncompared — both
    helicopters lost the cockpit and fuselage from G5 entirely. manifold3d
    builds those same triangles into a closed solid within 0.5% of the B-rep
    volume."""
    import manifold3d
    import numpy as np

    raw = manifold3d.Mesh(vert_properties=np.asarray(mesh.vertices, dtype=np.float32),
                          tri_verts=np.asarray(mesh.faces, dtype=np.uint32))
    solid = manifold3d.Manifold(raw)
    if solid.status() != manifold3d.Error.NoError:
        raw.merge()  # in place: welds vertices the seams left split
        solid = manifold3d.Manifold(raw)
    if solid.status() != manifold3d.Error.NoError:
        raise ValueError(f"mesh is not a closed manifold ({solid.status()})")
    return solid


def _brep_overlap(shape_a: Any, matrix_a: list[float], shape_b: Any, matrix_b: list[float]) -> tuple[float, float, list[float]]:
    """Exact fallback: intersect the posed B-reps. Slow on curved parts, so it
    only runs when the mesh route cannot."""
    import numpy as np
    from build123d import Compound, Location
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.gp import gp_Trsf

    def posed(shape: Any, matrix: list[float]) -> Any:
        if not matrix:
            return shape
        m = np.asarray(matrix, dtype=np.float64).reshape(4, 4).T  # column-major in
        t = gp_Trsf()
        t.SetValues(*m[0], *m[1], *m[2])
        return shape.moved(Location(t))

    # BRepAlgoAPI directly, not `&`: a boolean that fails comes back from `&`
    # as an empty or broken shape, whose volume reads 0, which reads as "no
    # clash". This route runs for the pairs the mesh route already gave up on,
    # which is exactly where a failure is likely.
    op = BRepAlgoAPI_Common(posed(shape_a, matrix_a).wrapped, posed(shape_b, matrix_b).wrapped)
    if not op.IsDone() or not BRepCheck_Analyzer(op.Shape()).IsValid():
        raise ValueError("the B-rep intersection failed or came back invalid")
    overlap = Compound(op.Shape())
    centre = overlap.center() if overlap.volume > 0 else None
    return float(overlap.volume), float(overlap.area), [centre.X, centre.Y, centre.Z] if centre else [0.0, 0.0, 0.0]


def _overlap(a: tuple[str, Any, list[float], Any], b: tuple[str, Any, list[float], Any]) -> tuple[float, float, list[float]]:
    """(volume, area, centroid) shared by two posed parts. Raises only when no
    route could compare them, and the caller reports that pair by name."""
    import trimesh

    from .meshpart import MeshPart

    (_, shape_a, matrix_a, mesh_a), (_, shape_b, matrix_b, mesh_b) = a, b
    try:
        shared = (_manifold(mesh_a) ^ _manifold(mesh_b)).to_mesh()
        overlap = trimesh.Trimesh(vertices=shared.vert_properties[:, :3], faces=shared.tri_verts, process=False)
        if not len(overlap.faces):
            return 0.0, 0.0, [0.0, 0.0, 0.0]
        return float(abs(overlap.volume)), float(overlap.area), [float(c) for c in overlap.centroid]
    except Exception:
        if isinstance(shape_a, MeshPart) or isinstance(shape_b, MeshPart):
            raise
        return _brep_overlap(shape_a, matrix_a, shape_b, matrix_b)


SWEEP_CHORD_MM = 3.0
"""Largest step a swept sample may take at the moving part's outermost point.
Between two samples the part jumps no further than this, so only an obstacle
thinner than it AND a moving feature narrower than it can slip through unseen;
blades and arms are wider than 3mm."""

SWEEP_SAMPLES = (24, 1000)
"""Bounds on the sample count: a short rotor still turns in 15° steps. The top
was 120, which held a 300mm disc to a 7.8mm chord while reporting 3mm; it is a
runaway guard now, affordable because the boxes of every sample are tested at
once and a boolean runs only on a sample whose boxes meet. Each swept finding
reports the chord its sweep actually achieved (`chord_mm`)."""


def _turn(o: Any, d: Any, deg: float) -> Any:
    """4x4 rotation by `deg` about the axis through `o` along unit `d`."""
    import numpy as np

    a = math.radians(deg)
    k_x = np.array([[0, -d[2], d[1]], [d[2], 0, -d[0]], [-d[1], d[0], 0]])
    r = np.eye(3) + math.sin(a) * k_x + (1 - math.cos(a)) * (k_x @ k_x)
    t = np.eye(4)
    t[:3, :3] = r
    t[:3, 3] = o - r @ o
    return t


def _axis(spec: dict[str, Any]) -> tuple[Any, Any]:
    import numpy as np

    d = np.asarray(spec["direction"], dtype=np.float64)
    return np.asarray(spec["origin"], dtype=np.float64), d / np.linalg.norm(d)


def _axis_reach(meshes: list[Any], o: Any, d: Any) -> float:
    """Outermost distance of any vertex from an axis."""
    import numpy as np

    r = 0.0
    for mesh in meshes:
        rel = mesh.vertices - o
        if len(rel):
            r = max(r, float(np.linalg.norm(rel - np.outer(rel @ d, d), axis=1).max()))
    return r


def _sweep_groups(sweep: dict[str, Any], meshes: list[tuple[str, Any]]) -> tuple[list[float], list[tuple[set[str], Any]], float]:
    """The travel samples of one joint, and each group of nodes that moves
    with it as (nodes, travel -> 4x4 world transform). The first group is the
    joint's own: rotations about its axis in degrees for a revolute joint,
    translations along it in mm for a prismatic one. Each `coupled` group turns
    about its own axis by `ratio` degrees per unit of the joint's travel: a
    motor's gear against the driven one (negative: external gears counter-
    rotate), a pulley, a lead screw. The scene pose is the joint at 0, so every
    sample is relative to it. Last, the chord: how far the outermost moving
    point travels between two samples."""
    o, d = _axis(sweep)
    lo, hi = (float(v) for v in sweep["limits"])
    lo_n, hi_n = SWEEP_SAMPLES
    revolute = sweep["type"] == "revolute"
    main = set(sweep.get("moving") or [])

    def own(travel: float) -> Any:
        import numpy as np

        if revolute:
            return _turn(o, d, travel)
        t = np.eye(4)
        t[:3, 3] = d * travel
        return t

    groups: list[tuple[set[str], Any]] = [(main, own)]
    chord = (hi - lo) if not revolute else math.radians(hi - lo) * _axis_reach([m for k, m in meshes if k in main], o, d)
    for c in sweep.get("coupled") or []:
        co, cd = _axis(c)
        ratio = float(c["ratio"])
        nodes = set(c.get("moving") or [])
        groups.append((nodes, lambda travel, co=co, cd=cd, ratio=ratio: _turn(co, cd, ratio * travel)))
        chord = max(chord, math.radians(abs(ratio) * (hi - lo)) * _axis_reach([m for k, m in meshes if k in nodes], co, cd))
    full = revolute and hi - lo >= 360 - 1e-6
    n = min(hi_n, max(lo_n if revolute else 2, math.ceil(chord / SWEEP_CHORD_MM)))
    travels = [lo + (hi - lo) * k / n for k in range(n if full else n + 1)]
    return [round(t, 2 if revolute else 3) for t in travels], groups, chord / n


def _axisymmetric(solid: Any, mesh: Any, o: Any, d: Any) -> bool:
    """Whether a part turned about (o, d) is itself: a revolved wheel or
    roller sweeps exactly its rest pose, so the static check already judged
    it (rolling contact on a rail is a contact, not a swept clash). Two odd
    angles, so a part with 2-, 3-, 4- or 6-fold symmetry is not mistaken
    for round."""
    own = abs(float(mesh.volume))
    if own <= 0:
        return False
    return all(_shared(solid.transform(_turn(o, d, deg)[:3, :].astype("float32")), solid)[0] >= 0.99 * own for deg in (37.0, 113.0))


def _shared(a: Any, b: Any) -> tuple[float, float, list[float]]:
    """(volume, area, centroid) of two manifolds' intersection."""
    import trimesh

    shared = (a ^ b).to_mesh()
    overlap = trimesh.Trimesh(vertices=shared.vert_properties[:, :3], faces=shared.tri_verts, process=False)
    if not len(overlap.faces):
        return 0.0, 0.0, [0.0, 0.0, 0.0]
    return float(abs(overlap.volume)), float(overlap.area), [float(c) for c in overlap.centroid]


def g5_swept(meshes: list[tuple[str, Any]], sweeps: list[dict[str, Any]],
             allowance: dict[frozenset, float]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Each moving part through its joint's travel, against every part that
    holds still and every part that moves differently.

    A static clash check sees a rotor at rest, where its blades may happen to
    miss a strut they will hit a quarter turn later. So the moving parts are
    posed at samples of the travel and each pose is compared like any other
    solid; the worst pose is the verdict. Pose by pose rather than one unioned
    swept solid: the union of a hundred overlapping copies tessellates to
    hundreds of thousands of triangles and took seconds per pair, while each
    single pose is the part's own few hundred. Groups name placed copies
    (`node`, `node#1`), so each copy of an instanced rotor turns about its own
    axis. Parts in the same group
    (`moving`, or one `coupled` group) are left out against each other, since
    they turn together; two groups are compared pose by pose, both moved, which
    is how a gear pair is checked in mesh rather than each gear against the
    other one frozen. Allowances apply per node pair, as in the static check."""
    import numpy as np

    clashes: list[dict[str, Any]] = []
    exempt: list[dict[str, Any]] = []
    errors: list[str] = []
    solids: dict[str, Any] = {}

    def solid(key: str, mesh: Any) -> Any:
        if key not in solids:
            solids[key] = _manifold(mesh)
        return solids[key]

    def corners(mesh: Any) -> Any:
        return np.array([[x, y, z, 1.0] for x in mesh.bounds[:, 0] for y in mesh.bounds[:, 1] for z in mesh.bounds[:, 2]])

    def boxes(mesh: Any, ts: Any) -> tuple[Any, Any]:
        """The posed bounding box at every sample at once: (n, 3) mins, maxes."""
        pts = np.einsum("nij,kj->nki", ts, corners(mesh))[:, :, :3]
        return pts.min(axis=1), pts.max(axis=1)

    for sweep in sweeps:
        travels, groups, chord = _sweep_groups(sweep, meshes)
        axis = _axis(sweep)
        symmetric: dict[str, bool] = {}

        def round_key(key: str, mesh: Any, axis: Any = axis, symmetric: dict = symmetric) -> bool:
            if key not in symmetric:
                symmetric[key] = _axisymmetric(solid(key, mesh), mesh, *axis)
            return symmetric[key]

        poses = [np.stack([move(t) for t in travels]) for _, move in groups]
        still = np.repeat(np.eye(4)[None], len(travels), axis=0)

        def group_of(key: str, groups: list = groups) -> int | None:
            return next((g for g, (nodes, _) in enumerate(groups) if key in nodes), None)

        for key_m, mesh_m in meshes:
            g_m = group_of(key_m)
            if g_m is None:
                continue
            for key_o, mesh_o in meshes:
                g_o = group_of(key_o)
                if g_o is not None and g_o <= g_m:
                    continue  # same group, or this pair was taken the other way round
                if g_o is None and g_m == 0 and sweep["type"] == "revolute" and round_key(key_m, mesh_m):
                    continue  # turns into itself: every pose is the rest pose
                move_o = groups[g_o][1] if g_o is not None else None
                ts_m, ts_o = poses[g_m], (poses[g_o] if g_o is not None else still)
                (m_min, m_max), (o_min, o_max) = boxes(mesh_m, ts_m), boxes(mesh_o, ts_o)
                # The swept AABB prefilter: only samples whose boxes meet pay a boolean.
                meet = np.nonzero(np.all(o_min <= m_max, axis=1) & np.all(m_min <= o_max, axis=1))[0]
                worst = None
                try:
                    for i in meet:
                        travel, t_m, t_o = travels[i], ts_m[i], ts_o[i]
                        posed_m = solid(key_m, mesh_m).transform(t_m[:3, :].astype(np.float32))
                        posed_o = solid(key_o, mesh_o).transform(t_o[:3, :].astype(np.float32)) if move_o else solid(key_o, mesh_o)
                        volume, area, centre = _shared(posed_m, posed_o)
                        if volume > 0 and (worst is None or volume > worst[0]):
                            worst = (volume, area, centre, travel)
                except Exception as err:  # noqa: BLE001
                    errors.append(f"sweep {sweep.get('joint', '?')}: {key_m} vs {key_o} could not be compared ({type(err).__name__}: {err})")
                    continue
                if worst is None:
                    continue
                volume, area, centre, travel = worst
                depth = (2 * volume / area) if area > 1e-9 else 0.0
                if depth <= CLASH_MIN_DEPTH_MM:
                    continue
                found = {"joint": sweep.get("joint", ""), "a": key_m, "b": key_o, "volume_mm3": round(volume, 3),
                         "depth_mm": round(depth, 4), "at": [round(float(c), 2) for c in centre], "travel": travel,
                         "chord_mm": round(chord, 2)}
                limit = allowance.get(frozenset((_node_of(key_m), _node_of(key_o))))
                if limit is not None and volume <= limit:
                    exempt.append(found | {"allowed_mm3": round(limit, 3)})
                else:
                    clashes.append(found)
    return clashes, exempt, errors


def g5_clash(parts: list[tuple[str, Any, list[float]]],
             allow: list[dict[str, Any]] | None = None,
             contacts: list[dict[str, Any]] | None = None,
             sweeps: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Posed parts, pairwise. Cheap AABB pass first, then a real boolean only on
    the pairs whose boxes actually overlap — n is small, but a boolean is not,
    and most pairs in an assembly are nowhere near each other.

    `allow` names node pairs DESIGNED to share material — a screw and its nut
    share the thread — with the volume they may share. An overlap within it is
    reported under `exempt`, not `clashes`; beyond it, it is a clash like any
    other, because a nut driven into a screw head is a real defect.

    `contacts` asks, per mate, whether the two mated parts actually touch near
    the point their ports meet. The solver makes the PORTS coincide; nothing
    before this checks that each port sits on its part's surface, so a port
    posed 3mm off its face places a part floating 3mm in the air, clean.

    `sweeps` are the kinematic joints ({joint, type, origin, direction, limits,
    moving, coupled?}): each moving part's swept volume is checked too
    (g5_swept), and `coupled` groups turn with it at a ratio.

    Parts are keyed `node#i` per placed copy; `allow` and `contacts` name nodes
    and apply to every copy. Returns a report; raises nothing. A clash is a
    fact about the assembly, and the caller decides what it costs."""
    import numpy as np

    posed = [(key, shape, matrix, _posed_mesh(shape, matrix)) for key, shape, matrix in parts]
    meshes = [(key, mesh) for key, _, _, mesh in posed]
    allowance = {frozenset((a["a"], a["b"])): float(a["volume_mm3"]) for a in allow or []}
    exempt: list[dict[str, Any]] = []
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
                volume, area, centre = _overlap(posed[i], posed[j])
            except Exception as err:  # noqa: BLE001
                # A boolean that will not compute is not evidence of no clash.
                # Swallowing it would report every pair clean forever if the
                # engine were missing — an all-clear from a gate that never ran.
                errors.append(f"{key_a} vs {key_b}: no boolean could compare them ({type(err).__name__}: {err})")
                continue
            if volume <= 0:
                continue
            # Mean penetration depth of the shared lens. A seam disagreement is
            # a wide, vanishingly thin sheet; real interference is thick.
            depth = (2 * volume / area) if area > 1e-9 else 0.0
            if depth > CLASH_MIN_DEPTH_MM:
                found = {
                    "a": key_a,
                    "b": key_b,
                    "volume_mm3": round(volume, 3),
                    "depth_mm": round(depth, 4),
                    "at": [round(float(c), 2) for c in centre],
                }
                limit = allowance.get(frozenset((_node_of(key_a), _node_of(key_b))))
                if limit is not None and volume <= limit:
                    exempt.append(found | {"allowed_mm3": round(limit, 3)})
                else:
                    clashes.append(found)

    gaps: list[dict[str, Any]] = []
    for c in contacts or []:
        at = np.asarray(c["at"], dtype=np.float64)
        radius = float(c.get("radius", CONTACT_RADIUS_MM))
        side_a = [m for k, m in meshes if _node_of(k) == c["a"]]
        side_b = [m for k, m in meshes if _node_of(k) == c["b"]]
        if not side_a or not side_b:
            continue
        try:
            # Every copy against every copy: only the pair this mate placed is
            # near the mate point, so the minimum is that pair's gap.
            gap = min(_contact_gap(ma, mb, at, radius) for ma in side_a for mb in side_b)
        except Exception as err:  # noqa: BLE001
            errors.append(f"contact {c['a']} vs {c['b']}: distance query failed ({type(err).__name__})")
            continue
        gaps.append({"edge": c.get("edge", ""), "a": c["a"], "b": c["b"],
                     "gap_mm": round(gap, 4), "at": [round(float(v), 2) for v in at]})
    swept, swept_exempt, sweep_errors = g5_swept(meshes, sweeps or [], allowance)
    return {"parts": len(meshes), "pairs_tested": pairs_tested,
            "clashes": clashes, "exempt": exempt, "contacts": gaps, "errors": errors + sweep_errors,
            "swept": swept, "swept_exempt": swept_exempt}


# What _probe_port can measure. index.ts derives the architect's allowed types
# and the CadPortType enum from its own PROBED_PORT_TYPES, and a vitest reads
# this tuple to keep the two lists identical.
PROBED_PORT_TYPES = (
    "CLEARANCE_HOLE", "BORE", "SCREW_SEAT", "SCREW_BOSS", "FLAT_FACE",
    "GROOVE", "SLOT", "SHAFT", "HOLE_PATTERN", "BOSS_PATTERN",
    "THREADED_HOLE", "INSERT_POCKET", "NUT_TRAP", "COUNTERBORE", "COUNTERSINK", "DOWEL_HOLE",
    "BEARING_SEAT", "BUSHING_BORE", "MOTOR_MOUNT", "MAGNET_POCKET", "HUB_BORE",
    "LINEAR_BEARING_SEAT", "CLIP_GROOVE", "RAIL_MOUNT",
)


def _probe_port(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    ptype = port.get("type", "")
    if ptype == "HOLE_PATTERN":
        return _probe_pattern(shape, port, _probe_screw_hole)
    if ptype == "BOSS_PATTERN":
        return _probe_pattern(shape, port, _probe_boss)
    if ptype in HOLE_LIKE:
        return _probe_hole(shape, port)
    if ptype == "FLAT_FACE":
        return _probe_flat_face(shape, port)
    if ptype == "SCREW_BOSS":
        return _probe_boss(shape, port)
    if ptype == "SHAFT":
        return _probe_shaft(shape, port)
    if ptype in CHANNEL_LIKE:
        return _probe_channel(shape, port)
    if ptype in HARDWARE_PROBES:
        return HARDWARE_PROBES[ptype](shape, port)
    # A FAILURE, not a skip. A skipped port counted as a pass, so a node built
    # from unprobed ports was verified by nothing and a featureless block
    # satisfied it. The plan-time lint rejects these types; this catches
    # whatever reaches the kernel anyway (hand-edited or legacy graphs).
    raise GateError("G3", f'port "{port.get("key", "?")}": no probe for {ptype}',
                    f"no code change can pass this: {ptype} cannot be measured, so the contract must re-express "
                    f"the port as one of {', '.join(PROBED_PORT_TYPES)}")


MALFORMED = (KeyError, TypeError, ValueError, IndexError)


def _unreadable(stage: str, what: str, err: Exception) -> dict[str, Any]:
    """A gate that raised something other than a GateError. It used to escape
    contract_gates and come back as "G1 unexpected kernel error" with no
    failures, which blamed code that was correct. A declaration the gate could
    not read (a hole_count with only `max`, a symmetry plane that is not one, a
    box with no size) is the CONTRACT's fault: no code change passes it. Any
    other error is the gate's own, reported against the thing it was measuring."""
    if isinstance(err, MALFORMED):
        return GateError("CONTRACT", f"{what} is malformed: {type(err).__name__}: {err}",
                         "no code change can pass this: the contract declaration is missing or misspells a field, "
                         "and the architect must re-declare it").as_failure()
    return GateError(stage, f"{what} could not be measured: {type(err).__name__}: {err}",
                     "the geometry kernel failed on this check; simplify the feature it measures").as_failure()


def g3_ports(shape: Any, ports: list[dict[str, Any]],
             progress=lambda stage, port=None: None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Every port is probed, failing or not: (report of passes, failures)."""
    report: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for port in ports:
        progress("G3", port.get("key", "?"))
        try:
            report.append(_probe_port(shape, port))
        except GateError as err:
            # A pattern port fails once per bad member; all of them carry the
            # pattern's key so a score counts the port once.
            failures += [f | {"port": port.get("key", "?")} for f in err.failures]
        except Exception as err:  # noqa: BLE001 — reported per port, see _unreadable
            failures.append(_unreadable("G3", f'port "{port.get("key", "?")}" ({port.get("type", "?")})', err)
                            | {"port": port.get("key", "?")})
    return report, failures


def contract_gates(shape: Any, ports: list[dict[str, Any]], envelope: list[dict[str, Any]],
                   assertions: list[dict[str, Any]] | None = None, solids: int | None = None,
                   process: dict[str, Any] | None = None, progress=lambda stage, port=None: None) -> dict[str, Any]:
    """G3, G4, G4b and G4c together, raising ONE GateError naming every failure.
    Stopping at the first bad port spent a whole repair round per port: the
    model fixed the one it was shown and the next attempt revealed the next.
    The error's stage is the earliest that failed: G3, then G4, G4b, G4c.
    The solid count needs the contract, so it runs here, and as a G2 failure
    it comes first. A CONTRACT failure (a declaration no gate could read)
    outranks all of them: it is the one no repair of the code can fix."""
    measured: dict[str, Any] = {}
    failures: list[dict[str, Any]] = []
    if solids is not None:
        try:
            g2_solid_count(shape, solids)
        except GateError as err:
            failures.append(err.as_failure())
    if ports:
        if process:
            ports = [{**p, "process": process.get("kind")} for p in ports]
        measured["ports"], port_failures = g3_ports(shape, ports, progress)
        failures += port_failures
    if envelope:
        progress("G4")
        try:
            measured["envelope"] = g4_envelope(shape, envelope)
        except GateError as err:
            failures.append(err.as_failure())
        except Exception as err:  # noqa: BLE001 — see _unreadable
            failures.append(_unreadable("G4", "the envelope", err))
    if assertions:
        progress("G4b")
        measured["assertions"], assertion_failures = g4b_assertions(shape, assertions)
        failures += assertion_failures
    if process:
        from .dfm_process import g4c_process

        progress("G4c")
        measured["process"], process_failures = g4c_process(shape, process)
        failures += process_failures
    if not failures:
        return measured
    failures.sort(key=lambda f: f["stage"] != "CONTRACT")
    if len(failures) == 1:
        f = failures[0]
        raise GateError(f["stage"], f["error"], f["hint"], failures=failures)
    error = f"{len(failures)} contract failures:\n" + "\n".join(f"- {f['error']}" for f in failures)
    hint = "\n".join(dict.fromkeys(f["hint"] for f in failures if f["hint"]))
    raise GateError(failures[0]["stage"], error, hint, failures=failures)


# ---------------------------------------------------------------------------
# G4 — envelope containment: every surface sample must lie inside the union of
# the declared primitives (part-local frame), inflated by margin. Each primitive
# carries its own pose, so a horizontal cylinder is horizontal here too.
# ---------------------------------------------------------------------------

ENVELOPE_MARGIN_MM = 0.5
TESSELLATION_TOL = 0.5
ENVELOPE_KINDS = ("box", "cylinder")


def _envelope_frame(prim: dict[str, Any]) -> tuple[list[float], list[float], list[float], list[float]]:
    """Centre and orthonormal axes of a primitive. Without axes it is
    axis-aligned. A cylinder's xAxis carries no meaning, so one parallel to
    its zAxis is replaced rather than rejected."""
    if prim.get("kind") not in ENVELOPE_KINDS:
        raise GateError("G4", f"unknown envelope primitive kind {prim.get('kind')!r}",
                        f"envelope volumes must be one of {list(ENVELOPE_KINDS)}")
    z = _unit([float(c) for c in prim.get("zAxis", (0, 0, 1))])
    x = [float(c) for c in prim.get("xAxis", (1, 0, 0))]
    if abs(sum(a * b for a, b in zip(x, z))) > 0.999 * math.sqrt(sum(c * c for c in x)):
        x = [1.0, 0.0, 0.0] if abs(z[0]) < 0.9 else [0.0, 1.0, 0.0]
    dot = sum(a * b for a, b in zip(x, z))
    x = _unit([a - dot * b for a, b in zip(x, z)])
    y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
    return [float(c) for c in prim["center"]], x, y, z


def _escape_distance(p: Any, prim: dict[str, Any], frame, margin: float) -> float:
    """How far outside the margin-inflated primitive `p` lies; ≤ 0 when inside.

    This is reported to the model as the amount to shrink by, so it has to be
    the real overshoot. The previous version measured every axis against
    `radius`, including z — so a vertex escaping axially from a wide, flat
    cylinder was compared against the RADIUS and came back negative, printing
    "worst ≈0.0 mm beyond" for a genuine miss and telling the model its part
    was already the right size.
    """
    c, x, y, z = frame
    d = [float(p[i]) - c[i] for i in range(3)]
    local = [sum(d[i] * axis[i] for i in range(3)) for axis in (x, y, z)]
    if prim["kind"] == "box":
        return max(abs(local[i]) - (float(prim["size"][i]) / 2 + margin) for i in range(3))
    radial = math.hypot(local[0], local[1]) - (float(prim["radius"]) + margin)
    axial = abs(local[2]) - (float(prim["height"]) / 2 + margin)
    return max(radial, axial)


def _surface_samples(shape: Any) -> list[tuple[float, float, float]]:
    """Tessellation vertices, plus edge midpoints and a point on every face.
    Vertices alone skip a straight edge's middle and a flat face's interior,
    which is where a primitive's corner can cut into the part unseen."""
    vertices, _tris = shape.tessellate(TESSELLATION_TOL)
    points = [(float(v.X), float(v.Y), float(v.Z)) for v in vertices]
    if hasattr(shape, "edges"):  # a B-rep; an imported mesh's vertices are its whole surface
        for e in shape.edges():
            v = e.position_at(0.5)
            points.append((float(v.X), float(v.Y), float(v.Z)))
        for f in shape.faces():
            # The middle of the face's parameter range, kept only when it is ON
            # the face: on an L-shaped face it falls in the notch, in air.
            v = f.position_at(0.5, 0.5)
            if f.distance_to(v) < 1e-3:
                points.append((float(v.X), float(v.Y), float(v.Z)))
    return points


def g4_envelope(shape: Any, envelope: list[dict[str, Any]]) -> dict[str, Any]:
    frames = [_envelope_frame(prim) for prim in envelope]
    points = _surface_samples(shape)
    worst: tuple[float, Any] | None = None
    violations = 0
    for p in points:
        # Nearest primitive wins: the union is what must contain the part.
        excess = min(_escape_distance(p, prim, f, ENVELOPE_MARGIN_MM) for prim, f in zip(envelope, frames))
        if excess > 1e-6:  # a sample exactly on the inflated boundary is inside
            violations += 1
            if worst is None or excess > worst[0]:
                worst = (excess, p)
    if violations:
        excess, p = worst  # type: ignore[misc]
        raise GateError(
            "G4",
            f"{violations} surface points escape the declared envelope "
            f"(worst {excess:.2f} mm past the {ENVELOPE_MARGIN_MM} mm tolerance, "
            f"near [{p[0]:.1f}, {p[1]:.1f}, {p[2]:.1f}])",
            "shrink the offending feature to fit the envelope, or request an envelope expansion from the architect",
            expected=0.0, measured=round(excess, 3),
        )
    return {"vertices_checked": len(points), "violations": 0}


# ---------------------------------------------------------------------------
# HOLE_PATTERN / BOSS_PATTERN — one port, N features, each probed on its own.
#
# Params are scalars because port params are a flat record of numbers:
#   polar: count, pcd (bolt-circle DIAMETER), start_angle (deg from xAxis, default 0)
#   grid:  nx, ny, pitch_x, pitch_y, centred on the port origin, x along xAxis
# A pattern that declares `pcd` is polar; otherwise it must be a full grid.
# ---------------------------------------------------------------------------

MAX_PATTERN_MEMBERS = 64
GRID_KEYS = ("nx", "ny", "pitch_x", "pitch_y")


def _pattern_offsets(port: dict[str, Any]) -> list[tuple[float, float]]:
    params = port.get("params", {})
    shape_hint = ("declare a polar pattern {count, pcd, start_angle?} or a grid "
                  "{nx, ny, pitch_x, pitch_y} centred on the port origin")
    if "pcd" in params:
        n = int(_port_dim(port, ("count",), "member count", shape_hint))
        r = _port_dim(port, ("pcd",), "pitch-circle diameter", shape_hint) / 2
        a0 = math.radians(_port_dim_opt(port, ("start_angle",)) or 0.0)
        offsets = [(r * math.cos(a0 + 2 * math.pi * k / max(n, 1)), r * math.sin(a0 + 2 * math.pi * k / max(n, 1)))
                   for k in range(n)]
    else:
        nx, ny, px, py = (_port_dim(port, (k,), k, shape_hint) for k in GRID_KEYS)
        offsets = [((i - (nx - 1) / 2) * px, (j - (ny - 1) / 2) * py)
                   for j in range(int(ny)) for i in range(int(nx))]
    if not 1 <= len(offsets) <= MAX_PATTERN_MEMBERS:
        raise GateError("G3", f'port "{port.get("key", "?")}" ({port.get("type")}) expands to {len(offsets)} members',
                        f"a pattern holds 1 to {MAX_PATTERN_MEMBERS} features; {shape_hint}")
    return offsets


def _probe_screw_hole(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """A hole a screw or pin goes through: a HOLE_PATTERN member, a motor
    mount's screw holes, the bore under a counterbore or countersink. Only
    CLEARANCE_HOLE used to be held to passing through, so twelve Ø5 dimples
    0.75mm deep passed as a bolt pattern. Through, unless the port declares
    params.depth, and then at least that deep."""
    depth = _port_dim_opt(port, DEPTH_KEYS)
    result = _probe_hole(shape, port, through=depth is None)
    if depth is not None:
        _require_depth(shape, port, result, depth, _port_diameter(port) / 2)
    return result


def _bore_depth(port: dict[str, Any]) -> dict[str, float]:
    """A counterbore's or countersink's `bore_depth`, as the depth of the bore
    under it: `depth` already names the head recess."""
    bd = _port_dim_opt(port, ("bore_depth", "boreDepth"))
    return {} if bd is None else {"depth": bd}


def _probe_pattern(shape: Any, port: dict[str, Any], probe) -> dict[str, Any]:
    """Expand the pattern into member ports and run the single-feature probe on
    each. Every failing member is reported, with where it should have been."""
    o, x, y, z = _frame(port["pose"])
    offsets = _pattern_offsets(port)
    members: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for i, (u, v) in enumerate(offsets):
        member = {**port, "key": f'{port["key"]} #{i + 1}/{len(offsets)}',
                  "pose": {"origin": list(_at(o, x, y, z, u, v, 0.0)), "zAxis": z, "xAxis": x}}
        try:
            members.append(probe(shape, member))
        except GateError as err:
            where = f" (member {i + 1} of {len(offsets)}, at u={u:.2f} v={v:.2f} in the port frame)"
            failures += [f | {"error": f["error"] + where, "member": i + 1} for f in err.failures]
    if failures:
        raise GateError(failures[0]["stage"], failures[0]["error"], failures[0]["hint"], failures=failures)
    return {"key": port["key"], "type": port["type"], "count": len(offsets), "members": members}


# ---------------------------------------------------------------------------
# Hardware host features: the pocket, seat or trap a catalog part goes into.
# Each one is a bore measured by _probe_hole against a fit band, plus whatever
# that part needs from the material around it: a depth, a wall, a shoulder, a
# hex. Same frame as every probe: origin on the face, +z out of the material.
# ---------------------------------------------------------------------------

TAP_TOL_MM = 0.1
INSERT_TOL_MM = 0.1
FIT_EPS_MM = 0.02             # resolution of a bisected march on an exact B-rep
INSERT_EXTRA_DEPTH_MM = 0.3   # room below a heat-set insert for the melt it displaces
INSERT_MIN_WALL_MM = 1.2
NUT_TRAP_SLOP_MM = 0.4
SHOULDER_INSET_MM = 0.5       # how far inside a seat's wall its shoulder is looked for
COUNTERSINK_D_TOL_MM = 0.2
COUNTERSINK_ANGLE_TOL_DEG = 5.0
D_FLAT_TOL_MM = 0.1
# Diameter bands relative to the part that goes in. Press: up to 0.1 under,
# never over. Slip: FDM clearance, enough to assemble, not enough to rattle.
# The generator is told to cut at each band's midpoint (grounding.ts
# FDM_FIT_CUT_MM, pinned by grounding.test.ts): move a band, move that too.
FIT_BANDS = {"press": (-0.1, 0.0), "slip": (0.05, 0.25), "magnet": (0.05, 0.2)}
# A machined bore is held to a few hundredths, so an FDM allowance there is a
# wrong cut: a CNC slip bore cut at nominal is right and failed the FDM band.
MACHINED_FIT_BANDS = {"press": (-0.05, 0.0), "slip": (0.0, 0.05), "magnet": (0.0, 0.1)}
MACHINED = {"cnc", "sheet_metal", "laser_cut"}
THROUGH_D_KEYS = ("through_diameter", "throughDiameter", "through_d")
AF_KEYS = ("af", "across_flats", "acrossFlats")


def _reach(shape: Any) -> float:
    bbox = shape.bounding_box()
    return max(float(bbox.size.X), float(bbox.size.Y), float(bbox.size.Z)) + 2.0


def _tap_drill(port: dict[str, Any]) -> float:
    """From the catalog the registry builds hardware from, so a tapped hole
    and the screw in it read one table."""
    from .meshpart import _catalog_threads

    threads = {k.upper(): v for k, v in _catalog_threads().items()}
    thread = str(port.get("params", {}).get("thread", "")).upper()
    if thread not in threads:
        raise GateError("G3", f'port "{port.get("key", "?")}" (THREADED_HOLE) declares no known thread ({thread!r})',
                        f"declare params.thread as one of {', '.join(threads)}")
    return float(threads[thread]["tapDrill"])


def _fit_band(port: dict[str, Any], nominal: float) -> tuple[float, float]:
    fit = port.get("params", {}).get("fit")
    if fit not in ("press", "slip"):
        raise GateError("G3", f'port "{port.get("key", "?")}" ({port.get("type")}) declares fit {fit!r}',
                        'declare params.fit as "press" or "slip": the bore diameter depends on it')
    return _band(port, nominal, fit)


def _band(port: dict[str, Any], nominal: float, fit: str) -> tuple[float, float]:
    """The fit band for the process that makes this part. contract_gates tags
    each port with a vendor process; untagged is FDM."""
    lo, hi = (MACHINED_FIT_BANDS if port.get("process") in MACHINED else FIT_BANDS)[fit]
    return nominal + lo, nominal + hi


def _banded(shape: Any, port: dict[str, Any], band: tuple[float, float]) -> dict[str, Any]:
    """_probe_hole graded against a band, centred on it so its step search
    starts inside the bore whichever end of the band the cut landed on."""
    return _probe_hole(shape, {**port, "params": {"diameter": sum(band) / 2}}, band)


def _require_depth(shape: Any, port: dict[str, Any], result: dict[str, Any], need: float, r: float) -> None:
    """A blind bore's floor must be at least `need` down. A through bore is as
    deep as the material beside it, read off the wall just outside its radius:
    the median over several sides, because one ray on the side a neighbouring
    hole or the part's edge happens to sit read that feature's depth instead."""
    got = result.get("measured_depth")
    if got is None:
        frame, reach, rr = _frame(port["pose"]), _reach(shape), r + PROBE_INSET_MM
        sides = []
        for k in range(0, PROBE_DIRECTIONS, 2):
            a = 2 * math.pi * k / PROBE_DIRECTIONS
            t = _axial_depth(shape, frame, rr * math.cos(a), rr * math.sin(a), reach, find="void")
            if t is not None:
                sides.append(t)
        if not sides:
            return
        got = sorted(sides)[len(sides) // 2]
    result["measured_depth"] = round(got, 3)
    if got < need - FIT_EPS_MM:
        raise GateError("G3", f'port "{port["key"]}" ({port["type"]}): needs {need:g}mm of depth, measured {got:.2f}',
                        f"cut it at least {need:g}mm deep from the port face; the part that goes in is that long",
                        expected=need, measured=round(got, 3))


def _probe_threaded_hole(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    d = _tap_drill(port)
    depth = _port_dim(port, DEPTH_KEYS, "depth", "declare params.depth in mm: the thread length the screw engages")
    result = _banded(shape, port, (d - TAP_TOL_MM, d + TAP_TOL_MM))
    _require_depth(shape, port, result, depth, d / 2)
    return result


def _probe_insert_pocket(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """A heat-set insert melts its knurl into the wall, so the wall has to be
    there: a ring INSERT_MIN_WALL_MM outside the measured bore, every ray in
    material, at the mouth and near the bottom of the insert."""
    d = _port_diameter(port)
    depth = _port_dim(port, DEPTH_KEYS, "depth", "declare params.depth in mm: the insert length")
    result = _banded(shape, port, (d - INSERT_TOL_MM, d + INSERT_TOL_MM))
    _require_depth(shape, port, result, depth + INSERT_EXTRA_DEPTH_MM, d / 2)
    o, x, y, z = _frame(port["pose"])
    r = result["measured_diameter"] / 2 + INSERT_MIN_WALL_MM - FIT_EPS_MM
    for w in sorted({PROBE_DEPTH_MM, max(PROBE_DEPTH_MM, depth - PROBE_DEPTH_MM)}):
        hits = sum(_in_material(shape, _at(o, x, y, z, r * math.cos(2 * math.pi * k / PROBE_DIRECTIONS),
                                           r * math.sin(2 * math.pi * k / PROBE_DIRECTIONS), -w))
                   for k in range(PROBE_DIRECTIONS))
        if hits < PROBE_DIRECTIONS:
            raise GateError("G3", f'port "{port["key"]}" (INSERT_POCKET): wall under {INSERT_MIN_WALL_MM:g}mm around the pocket '
                                  f'({hits}/{PROBE_DIRECTIONS} points in material on a Ø{2 * r:.1f} ring at {w:g}mm depth)',
                            f"leave at least {INSERT_MIN_WALL_MM:g}mm of material around the Ø{d:g} pocket for its whole "
                            f"depth: a boss of Ø{d + 2 * INSERT_MIN_WALL_MM + 0.4:g} or more")
    result["min_wall"] = INSERT_MIN_WALL_MM
    return result


def _probe_nut_trap(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """A hex section at half depth, clocked by xAxis the way the registry nut
    is: a CORNER on +x, flats facing ±y. Flats are read along their normals
    (30°, 90°, 150° from xAxis), corners along theirs; a trap rotated 30° puts
    its corners on the flat normals and fails here, because the nut would.

    entry "side" means the nut slides in along +x through a channel at least
    af wide, so rays toward +x are not walls and are left out."""
    key = port.get("key", "?")
    af = _port_dim(port, AF_KEYS, "across-flats", "declare params.af in mm: the nut's across-flats")
    depth = _port_dim(port, DEPTH_KEYS, "depth", "declare params.depth in mm: the nut height the trap holds")
    side = port.get("params", {}).get("entry") == "side"
    frame = _frame(port["pose"])
    o, x, y, z = frame
    w = -depth / 2
    if _in_material(shape, _at(o, x, y, z, 0.0, 0.0, w)):
        raise GateError("G3", f'port "{key}" (NUT_TRAP): material at the declared origin, {depth / 2:g}mm down',
                        f"cut a hex trap {af:g}mm across the flats, {depth:g}mm deep, centred on the contract pose")
    reach = af * 2 + 4.0

    def radius(deg: float, open_ok: bool = False) -> float | None:
        t = math.radians(deg)
        if side and math.cos(t) > 0.01:
            return None
        hit = _march(shape, frame, math.cos(t), math.sin(t), w, reach)
        if hit is None and open_ok:
            return math.inf
        if hit is None:
            raise GateError("G3", f'port "{key}" (NUT_TRAP): no wall within {reach:.1f}mm at {deg:g}° from xAxis',
                            'the trap must hold the nut on every side; only a side-entry trap (params.entry "side") '
                            "opens, and only toward +x")
        return hit

    def across(deg: float, limit: float = math.inf) -> float | None:
        open_ok = limit < math.inf
        sides = [h for h in (radius(deg, open_ok), radius(deg + 180, open_ok)) if h is not None and h <= limit]
        return sum(sides) if len(sides) == 2 else 2 * sides[0] if sides else None

    # A flat-normal ray that meets no wall short of the widest hex's corner
    # has left the pocket: up a drop slot, into a crossing bolt hole, along a
    # squared-off floor. That is a breakout, not a flat, and only rays that
    # meet a wall are graded. A hex rotated 30° puts its corners, inside this
    # limit, on these rays, so it still fails.
    breakout = (af + NUT_TRAP_SLOP_MM) / math.sqrt(3) + NUT_TRAP_SLOP_MM
    flats = [f for f in (across(deg, breakout) for deg in (30, 90, 150)) if f is not None]
    if not flats:
        raise GateError("G3", f'port "{key}" (NUT_TRAP): no flat within {breakout:.2f}mm of the axis along any flat normal',
                        f"cut the hex {af + NUT_TRAP_SLOP_MM / 2:g}mm across the flats, centred on the contract pose")
    worst = max(flats, key=lambda f: abs(f - (af + NUT_TRAP_SLOP_MM / 2)))
    if not af - FIT_EPS_MM <= worst <= af + NUT_TRAP_SLOP_MM + FIT_EPS_MM:
        raise GateError("G3", f'port "{key}" (NUT_TRAP): across the flats measured {min(flats):.2f}..{max(flats):.2f} '
                              f'along the flat normals, expected {af:g}..{af + NUT_TRAP_SLOP_MM:g}',
                        f"cut the hex {af + NUT_TRAP_SLOP_MM / 2:g}mm across the flats with a CORNER on the port's xAxis "
                        f"and flats facing ±y, which is how RegularPolygon(r, 6) comes out unrotated. A hex rotated "
                        f"30° measures across its corners here",
                        expected=af, measured=round(worst, 3))
    corners = min(c for c in (across(deg) for deg in (0, 60, 120)) if c is not None)
    if corners < af * 2 / math.sqrt(3) - FIT_EPS_MM:
        raise GateError("G3", f'port "{key}" (NUT_TRAP): across the corners measured {corners:.2f}, '
                              f'a {af:g}mm nut needs {af * 2 / math.sqrt(3):.2f}',
                        "the trap must be a hex: a round or square pocket the width of the flats does not take the corners",
                        expected=round(af * 2 / math.sqrt(3), 3), measured=round(corners, 3))

    # Depth beside the bolt hole, inside the hex: the axis falls into the bore.
    floor = _axial_depth(shape, frame, 0.0, 0.85 * af / 2, _reach(shape))
    if floor is not None and floor < depth - FIT_EPS_MM:
        raise GateError("G3", f'port "{key}" (NUT_TRAP): {floor:.2f}mm deep, the nut is {depth:g}',
                        f"cut the trap {depth:g}mm deep so the nut sits below the face",
                        expected=depth, measured=round(floor, 3))
    result: dict[str, Any] = {"key": key, "type": "NUT_TRAP", "measured_af": round(worst, 3),
                              "measured_corners": round(corners, 3)}
    if floor is not None:
        result["measured_depth"] = round(floor, 3)
    if side:
        if _march(shape, frame, 1.0, 0.0, w, _reach(shape)) is not None:
            raise GateError("G3", f'port "{key}" (NUT_TRAP): side entry is closed, material along +x at {depth / 2:g}mm depth',
                            f"open a channel {af:g}mm wide from the trap out through the part along +xAxis")
        for u in (af, af * 1.5):
            start = (list(_at(o, x, y, z, u, 0.0, 0.0)), x, y, z)
            left = _march(shape, start, 0.0, 1.0, w, reach)
            right = _march(shape, start, 0.0, -1.0, w, reach)
            if left is not None and right is not None and left + right < af - FIT_EPS_MM:
                raise GateError("G3", f'port "{key}" (NUT_TRAP): side-entry channel {left + right:.2f}mm wide at {u:g}mm along +x, the nut is {af:g} across the flats',
                                f"widen the entry channel to at least {af:g}mm (match the trap's flats)",
                                expected=af, measured=round(left + right, 3))
    return result


def _probe_counterbore(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """Two coaxial steps. The head recess is graded on its own step, the way a
    SCREW_SEAT is; then the through bore from that step's floor."""
    key = port.get("key", "?")
    d = _port_diameter(port)
    depth = _port_dim(port, DEPTH_KEYS, "depth", "declare params.depth in mm: the head recess depth")
    dt = _port_dim(port, THROUGH_D_KEYS, "through diameter", "declare params.through_diameter in mm: the bore under the recess")
    result = _probe_hole(shape, port)
    frame = _frame(port["pose"])
    o, x, y, z = frame
    step = _axial_depth(shape, frame, (d + dt) / 4, 0.0, _reach(shape))
    if step is None or abs(step - depth) > DEPTH_TOL_MM:
        got = "runs through, with no step" if step is None else f"steps at {step:.2f}mm"
        raise GateError("G3", f'port "{key}" (COUNTERBORE): the Ø{d:g} recess {got}, expected {depth:g}mm deep',
                        f"cut the Ø{d:g} recess {depth:g}mm deep, then the Ø{dt:g} bore from its floor",
                        expected=depth, **({} if step is None else {"measured": round(step, 3)}))
    through = _probe_screw_hole(shape, {"key": key, "type": "COUNTERBORE through bore", "params": {"diameter": dt, **_bore_depth(port)},
                                        "pose": {"origin": list(_at(o, x, y, z, 0.0, 0.0, -step)), "zAxis": z, "xAxis": x}})
    return result | {"measured_depth": round(step, 3), "measured_through_diameter": through["measured_diameter"]}


def _probe_countersink(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """The cone from two slices: its slope gives the angle, extrapolated to
    the face it gives the mouth. Then the through bore under the cone."""
    key = port.get("key", "?")
    d = _port_diameter(port)
    angle = _port_dim(port, ("angle", "csk_angle"), "angle", "declare params.angle in degrees: 90 for ISO 10642")
    dt = _port_dim(port, THROUGH_D_KEYS, "through diameter", "declare params.through_diameter in mm: the bore under the cone")
    frame = _frame(port["pose"])
    o, x, y, z = frame
    h = (d - dt) / 2 / math.tan(math.radians(angle / 2))
    w1, w2 = 0.15 * h, 0.75 * h
    fits = [_hole_slice(shape, frame, d + 2.0, -w) for w in (w1, w2)]
    if fits[0] is None or fits[1] is None:
        raise GateError("G3", f'port "{key}" (COUNTERSINK): no cone wall around the declared origin',
                        f"cut a {angle:g}° countersink, Ø{d:g} at the face, centred on the contract pose")
    slope = (fits[0][2] - fits[1][2]) / (w2 - w1)
    measured_angle = 2 * math.degrees(math.atan(slope))
    mouth = 2 * (fits[0][2] + w1 * slope)
    if abs(mouth - d) > COUNTERSINK_D_TOL_MM:
        raise GateError("G3", f'port "{key}" (COUNTERSINK): expected Ø{d:g} at the face, measured Ø{mouth:.2f}',
                        f"size the countersink Ø{d:g} where it meets the face", expected=d, measured=round(mouth, 3))
    if abs(measured_angle - angle) > COUNTERSINK_ANGLE_TOL_DEG:
        raise GateError("G3", f'port "{key}" (COUNTERSINK): expected a {angle:g}° cone, measured {measured_angle:.1f}°',
                        f"cut the cone at {angle:g}° included, the head's angle", expected=angle, measured=round(measured_angle, 2))
    through = _probe_screw_hole(shape, {"key": key, "type": "COUNTERSINK through bore", "params": {"diameter": dt, **_bore_depth(port)},
                                        "pose": {"origin": list(_at(o, x, y, z, 0.0, 0.0, -h)), "zAxis": z, "xAxis": x}})
    return {"key": key, "type": "COUNTERSINK", "measured_diameter": round(mouth, 3),
            "measured_angle": round(measured_angle, 2), "measured_through_diameter": through["measured_diameter"]}


def _probe_dowel_hole(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    d = _port_diameter(port)
    depth = _port_dim(port, DEPTH_KEYS, "depth", "declare params.depth in mm: how far the dowel goes in")
    result = _banded(shape, port, _fit_band(port, d))
    _require_depth(shape, port, result, depth, d / 2)
    return result


def _probe_bearing_seat(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """A pocket the bearing's outer ring sits in, and a shoulder under it: just
    inside the seat wall, every axial line must meet material below the seat,
    or the bearing falls through."""
    od = _port_dim(port, OUTER_D_KEYS, "outer diameter", "declare params.od in mm: the bearing's outer diameter")
    width = _port_dim(port, ("width", "w"), "width", "declare params.width in mm: the bearing's width")
    return _shouldered(shape, port, _banded(shape, port, _fit_band(port, od)), od, width, "the bearing is {:g} wide")


def _shouldered(shape: Any, port: dict[str, Any], result: dict[str, Any], od: float, width: float, says: str) -> dict[str, Any]:
    """The shoulder under a seat of Ø`od`, at least `width` down."""
    key, kind = port.get("key", "?"), port.get("type")
    frame = _frame(port["pose"])
    r = od / 2 - SHOULDER_INSET_MM
    floors = [_axial_depth(shape, frame, r * math.cos(2 * math.pi * k / PROBE_DIRECTIONS),
                           r * math.sin(2 * math.pi * k / PROBE_DIRECTIONS), _reach(shape))
              for k in range(PROBE_DIRECTIONS)]
    found = [f for f in floors if f is not None]
    if len(found) < PROBE_DIRECTIONS - 1:
        raise GateError("G3", f'port "{key}" ({kind}): no shoulder under the seat '
                              f'({len(found)}/{PROBE_DIRECTIONS} points {SHOULDER_INSET_MM:g}mm inside the wall meet material below it)',
                        f"leave a 1-2mm lip or a floor under the seat so the part cannot pass through: "
                        f"the bore below the seat must be Ø{od - 2:g} or smaller")
    seat = min(found)
    if seat < width - FIT_EPS_MM:
        raise GateError("G3", f'port "{key}" ({kind}): the seat is {seat:.2f}mm deep, {says.format(width)}',
                        f"cut the seat at least {width:g}mm deep down to its shoulder", expected=width, measured=round(seat, 3))
    return result | {"measured_depth": round(seat, 3)}


def _probe_linear_bearing_seat(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """An LM-UU's pocket: Ø`od` at the fit, the bushing's whole `length` deep,
    and held. `retention: "lip"` (the default) is a shoulder under it, as a
    BEARING_SEAT has; `"clip"` lets the bore run through, a retaining ring in
    the bushing's own groove taking the load, so only the depth is checked."""
    od = _port_dim(port, OUTER_D_KEYS, "outer diameter", "declare params.od in mm: the linear bearing's outer diameter")
    length = _port_dim(port, LENGTH_KEYS, "length", "declare params.length in mm: the linear bearing's length")
    retention = port.get("params", {}).get("retention", "lip")
    if retention not in ("lip", "clip"):
        raise GateError("G3", f'port "{port.get("key", "?")}" (LINEAR_BEARING_SEAT) declares retention {retention!r}',
                        'declare params.retention as "lip" (a shoulder under it) or "clip" (a ring in its groove)')
    result = _banded(shape, port, _fit_band(port, od))
    if retention == "lip":
        return _shouldered(shape, port, result, od, length, "the bearing is {:g} long")
    _require_depth(shape, port, result, length, od / 2)
    return result


CLIP_GROOVE_TOL_MM = 0.1   # groove Ø either way: a ring springs into it
CLIP_WIDTH_SLOP_MM = 0.2   # a groove may be this much wider than declared, never narrower


def _probe_clip_groove(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """A retaining-ring groove ON a shaft. The frame's origin is on the shaft
    axis at the groove's middle, z along the shaft. The groove Ø is where the
    material ends, marched out from the axis; its width and middle are found
    from inside it, halfway between the groove floor and the shaft surface,
    marching both ways along the shaft to the flanks."""
    key = port.get("key", "?")
    d = _port_diameter(port)
    width = _port_dim(port, WIDTH_KEYS, "width", "declare params.width in mm: the groove width (the ring's thickness plus clearance)")
    shaft = _port_dim(port, ("shaft_diameter", "shaftDiameter"), "shaft diameter", "declare params.shaft_diameter in mm")
    frame = _frame(port["pose"])
    o, x, y, z = frame
    if not _in_material(shape, _at(o, x, y, z, 0.0, 0.0, 0.0)):
        raise GateError("G3", f'port "{key}" (CLIP_GROOVE): no shaft at the declared origin',
                        "put the port on the shaft's axis, at the middle of the groove")
    radii = [_march(shape, frame, math.cos(2 * math.pi * k / PROBE_DIRECTIONS), math.sin(2 * math.pi * k / PROBE_DIRECTIONS),
                    0.0, shaft, find="void") for k in range(PROBE_DIRECTIONS)]
    if any(r is None for r in radii):
        raise GateError("G3", f'port "{key}" (CLIP_GROOVE): the shaft is wider than Ø{shaft:g} at the groove',
                        f"cut the groove to Ø{d:g} at the port origin")
    measured = 2 * sorted(radii)[len(radii) // 2]
    if abs(measured - d) > CLIP_GROOVE_TOL_MM:
        raise GateError("G3", f'port "{key}" (CLIP_GROOVE): expected Ø{d:g}±{CLIP_GROOVE_TOL_MM:g} at the groove, measured Ø{measured:.2f}',
                        f"cut the groove to Ø{d:g}: the ring grips the groove floor", expected=d, measured=round(measured, 3))
    rr = (measured + shaft) / 4
    inside = (list(_at(o, x, y, z, rr, 0.0, 0.0)), x, y, z)
    up = _march(shape, inside, 0.0, 0.0, 0.0, 4 * width + 2, dw=1.0)
    down = _march(shape, inside, 0.0, 0.0, 0.0, 4 * width + 2, dw=-1.0)
    if up is None or down is None:
        raise GateError("G3", f'port "{key}" (CLIP_GROOVE): no groove flank {"above" if up is None else "below"} the origin',
                        f"cut a {width:g}mm groove, not a step: the ring needs a flank on both sides")
    got, middle = up + down, (up - down) / 2
    if not width - FIT_EPS_MM <= got <= width + CLIP_WIDTH_SLOP_MM:
        raise GateError("G3", f'port "{key}" (CLIP_GROOVE): expected a {width:g}mm groove, measured {got:.2f}',
                        f"cut the groove {width:g} to {width + CLIP_WIDTH_SLOP_MM:g}mm wide", expected=width, measured=round(got, 3))
    if abs(middle) > HOLE_CENTER_TOL_MM:
        raise GateError("G3", f'port "{key}" (CLIP_GROOVE): the groove\'s middle is {middle:+.2f}mm along the shaft from the port',
                        "put the groove where the contract says: the ring locates the part on it",
                        expected=0.0, measured=round(middle, 3))
    return {"key": key, "type": "CLIP_GROOVE", "measured_diameter": round(measured, 3), "measured_width": round(got, 3)}


def _probe_rail_mount(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """A profile rail's land: flat, exposed, `width` across and `length` along
    xAxis, with `count` fixing holes of Ø`hole_diameter` on xAxis at `pitch`,
    centred as the rail's own holes are. The land is sampled at its long edges
    and between the holes, never over one."""
    key = port.get("key", "?")
    hint = "declare params.{} in mm"
    width = _port_dim(port, WIDTH_KEYS, "width", hint.format("width"))
    length = _port_dim(port, LENGTH_KEYS, "length", hint.format("length"))
    pitch = _port_dim(port, ("pitch",), "pitch", hint.format("pitch"))
    count = int(_port_dim(port, ("count",), "count", "declare params.count: the rail's fixing holes"))
    hole = _port_dim(port, ("hole_diameter", "holeDiameter"), "hole diameter", hint.format("hole_diameter"))
    o, x, y, z = _frame(port["pose"])
    us = [(k - (count - 2) / 2) * pitch for k in range(count - 1)] + [-length / 2 + PROBE_INSET_MM, length / 2 - PROBE_INSET_MM]
    vs = (-(width / 2 - PROBE_INSET_MM), width / 2 - PROBE_INSET_MM)
    samples = [(u, v) for u in us for v in vs] + [(u, 0.0) for u in us[:-2]]
    for u, v in samples:
        if _in_material(shape, _at(o, x, y, z, u, v, PROBE_EPS_MM)) or not _in_material(shape, _at(o, x, y, z, u, v, -PROBE_EPS_MM)):
            raise GateError("G3", f'port "{key}" (RAIL_MOUNT): no flat land at u={u:.1f} v={v:.1f} '
                                  f"(the rail is {width:g} wide and {length:g} long along xAxis)",
                            f"leave a flat, exposed land at least {width:g} x {length:g} under the rail, centred on the port")
    depth = _port_dim_opt(port, DEPTH_KEYS)

    def member(s: Any, p: dict[str, Any]) -> dict[str, Any]:
        result = _banded(s, p, (hole - TAP_TOL_MM, hole + TAP_TOL_MM))
        if depth is not None:
            _require_depth(s, p, result, depth, hole / 2)
        return result
    holes = _probe_pattern(shape, {**port, "params": {"nx": count, "ny": 1, "pitch_x": pitch, "pitch_y": 1.0}}, member)
    return {"key": key, "type": "RAIL_MOUNT", "probed_size": width, "holes": holes["members"]}


def _probe_bushing_bore(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    od = _port_dim(port, OUTER_D_KEYS, "outer diameter", "declare params.od in mm: the bushing's outer diameter")
    length = _port_dim(port, LENGTH_KEYS, "length", "declare params.length in mm: the bushing length")
    result = _banded(shape, port, _band(port, od, "press"))
    _require_depth(shape, port, result, length, od / 2)
    return result


def _probe_motor_mount(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """A slip-fit pilot bore at the origin and the screw pattern around it,
    expanded like HOLE_PATTERN: polar with pcd, else a grid (2x2 by default,
    the NEMA and brushless layouts)."""
    pilot = _port_dim(port, PILOT_D_KEYS, "pilot diameter", "declare params.pilot_diameter in mm: the motor's pilot boss")
    hole = _port_dim(port, ("hole_diameter", "holeDiameter"), "hole diameter", "declare params.hole_diameter in mm: the screw clearance")
    result = _banded(shape, port, _band(port, pilot, "slip"))
    params = port.get("params", {})
    layout = {k: params[k] for k in ("count", "pcd", "start_angle", *GRID_KEYS) if k in params}
    if "pcd" not in layout:
        layout = {"nx": 2, "ny": 2} | layout
    depth = _port_dim_opt(port, DEPTH_KEYS)
    holes = _probe_pattern(shape, {**port, "params": {"diameter": hole, **layout, **({} if depth is None else {"depth": depth})}},
                           _probe_screw_hole)
    return result | {"holes": holes["members"]}


def _probe_magnet_pocket(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    d = _port_diameter(port)
    depth = _port_dim(port, DEPTH_KEYS, "depth", "declare params.depth in mm: the magnet thickness")
    result = _banded(shape, port, _band(port, d, "magnet"))
    _require_depth(shape, port, result, depth, d / 2)
    return result


def _probe_hub_bore(shape: Any, port: dict[str, Any]) -> dict[str, Any]:
    """A bore for a shaft, slip unless params.fit says press (a wheel pressed
    onto its axle). With params.flat it is a D-bore: the flat sits `flat` mm
    from the axis along +xAxis, so the circle is fitted on the -x half only and
    the flat is measured on its own."""
    key = port.get("key", "?")
    d = _port_diameter(port)
    fit = "press" if port.get("params", {}).get("fit") == "press" else "slip"
    band = _band(port, d, fit)
    flat = _port_dim_opt(port, ("flat", "flat_distance"))
    if flat is None:
        return _banded(shape, port, band)
    frame = _frame(port["pose"])
    o, x, y, z = frame
    w = -PROBE_DEPTH_MM
    if _in_material(shape, _at(o, x, y, z, 0.0, 0.0, w)):
        raise GateError("G3", f'port "{key}" (HUB_BORE): no bore at the declared origin',
                        f"cut a Ø{d:g} D-bore centred on the contract pose")
    pts = []
    for k in range(7):
        t = math.radians(90 + 30 * k)
        hit = _march(shape, frame, math.cos(t), math.sin(t), w, d + 2.0)
        if hit is not None:
            pts.append((hit * math.cos(t), hit * math.sin(t)))
    circle = _fit_circle(pts) if len(pts) >= 3 else None
    if circle is None:
        raise GateError("G3", f'port "{key}" (HUB_BORE): no bore wall around the declared origin',
                        f"cut a Ø{d:g} D-bore centred on the contract pose")
    cu, cv, r = circle
    measured = 2 * r
    if not band[0] - FIT_EPS_MM <= measured <= band[1] + FIT_EPS_MM:
        raise GateError("G3", f'port "{key}" (HUB_BORE): expected Ø{band[0]:.2f}..{band[1]:.2f}, measured Ø{measured:.2f}',
                        f"cut the bore Ø{sum(band) / 2:.2f}, a {fit} fit on the Ø{d:g} shaft, with the D-flat "
                        f"along +xAxis only: a flat on another side reads as a smaller bore",
                        expected=round(sum(band) / 2, 3), measured=round(measured, 3))
    if math.hypot(cu, cv) > HOLE_CENTER_TOL_MM:
        raise GateError("G3", f'port "{key}" (HUB_BORE): bore centre is {math.hypot(cu, cv):.2f}mm off the declared origin',
                        "centre the bore on the contract origin", expected=0.0, measured=round(math.hypot(cu, cv), 3))
    at = _march(shape, frame, 1.0, 0.0, w, d + 2.0)
    if at is None or abs(at - flat) > D_FLAT_TOL_MM:
        got = "no flat" if at is None else f"the flat at {at:.2f}mm"
        raise GateError("G3", f'port "{key}" (HUB_BORE): {got} along +xAxis, expected it {flat:g}mm from the axis',
                        f"cut the D-flat {flat:g}mm from the bore axis, facing +xAxis",
                        expected=flat, **({} if at is None else {"measured": round(at, 3)}))
    return {"key": key, "type": "HUB_BORE", "measured_diameter": round(measured, 3), "measured_flat": round(at, 3)}


HARDWARE_PROBES = {
    "THREADED_HOLE": _probe_threaded_hole,
    "INSERT_POCKET": _probe_insert_pocket,
    "NUT_TRAP": _probe_nut_trap,
    "COUNTERBORE": _probe_counterbore,
    "COUNTERSINK": _probe_countersink,
    "DOWEL_HOLE": _probe_dowel_hole,
    "BEARING_SEAT": _probe_bearing_seat,
    "BUSHING_BORE": _probe_bushing_bore,
    "MOTOR_MOUNT": _probe_motor_mount,
    "MAGNET_POCKET": _probe_magnet_pocket,
    "HUB_BORE": _probe_hub_bore,
    "LINEAR_BEARING_SEAT": _probe_linear_bearing_seat,
    "CLIP_GROOVE": _probe_clip_groove,
    "RAIL_MOUNT": _probe_rail_mount,
}


# ---------------------------------------------------------------------------
# G4b — spec-derived assertions: the numbers the user actually stated (overall
# size, how many holes, symmetric or not), pinned in the contract by the
# architect and measured here. Ports and envelope say where features are and
# what the part may not exceed; neither says "this is a 4-hole 80mm plate".
# ---------------------------------------------------------------------------

AXIS_INDEX = {"x": 0, "y": 1, "z": 2}
PLANE_NORMAL = {"yz": 0, "xz": 1, "xy": 2}
SYMMETRY_GRID = 10        # samples per bbox axis; mirror pairs are grid pairs
SYMMETRY_TOL = 0.02       # default allowed fraction of mismatched samples
HOLE_CLOSURE = 0.95       # fraction of a full turn a hole's wall must close
HOLE_CLOSURE_KEYED = 0.70  # ... or this much, when a flat or key closes the rest
MIN_WALL_TOL_MM = 0.1     # the wall measurement runs on a 0.2mm tessellation
BBOX_TOL_MM = 0.25
AXIS_TOL_MM = 0.01        # two hole walls closer than this in axis and radius are one bore


def _count_holes(shape: Any) -> int:
    """Holes = distinct axes carrying a concave cylindrical wall that closes at
    least HOLE_CLOSURE of a turn. Concave is decided by the solid itself (void
    just inside the radius, material just outside), so face orientation never
    matters. Spans of faces sharing an axis and radius add up: OCCT splits a
    wall at seams and wherever another cut crosses it. A counterbore over a
    pilot is one axis, so one hole. Fillets (a quarter turn), slot ends (half a
    turn) and a hole breaking out of the side never close, so never count.
    Blind and through holes both count. A D-bore or a keyed bore counts once:
    its wall closes HOLE_CLOSURE_KEYED of a turn and the solid closes the gap
    (_gap_closed), where a breakout leaves it open to the air."""
    from build123d import GeomType
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    if not hasattr(shape, "faces"):
        raise GateError("G4b", 'assertion "hole_count": holes cannot be counted on an imported mesh',
                        "hole_count needs B-rep geometry; drop the assertion for imported parts")
    groups: list[dict[str, Any]] = []  # one per (axis, radius): its walls and their summed turn
    for face in shape.faces():
        if face.geom_type != GeomType.CYLINDER:
            continue
        surf = BRepAdaptor_Surface(face.wrapped)
        cyl = surf.Cylinder()
        r = cyl.Radius()
        ax = cyl.Axis()
        d = [ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z()]
        if max(d, key=abs) < 0:
            d = [-c for c in d]
        loc = [ax.Location().X(), ax.Location().Y(), ax.Location().Z()]
        u0, u1 = surf.FirstUParameter(), surf.LastUParameter()
        vm = (surf.FirstVParameter() + surf.LastVParameter()) / 2
        p = surf.Value((u0 + u1) / 2, vm)
        p = [p.X(), p.Y(), p.Z()]
        t = sum((p[i] - loc[i]) * d[i] for i in range(3))
        foot = [loc[i] + t * d[i] for i in range(3)]
        radial = _unit([p[i] - foot[i] for i in range(3)])
        eps = min(0.1, r / 4)
        inward = tuple(p[i] - radial[i] * eps for i in range(3))
        outward = tuple(p[i] + radial[i] * eps for i in range(3))
        if _in_material(shape, inward) or not _in_material(shape, outward):
            continue
        s = sum(foot[i] * d[i] for i in range(3))
        on_axis = [foot[i] - s * d[i] for i in range(3)]  # axis point nearest the origin
        # Clustered within a tolerance, never by rounding: two walls of one
        # bore whose axis sits at x.xx5 round to either side of it, and a 45°
        # bore through a split wall counted as two or three holes.
        g = next((g for g in groups if abs(g["r"] - r) < AXIS_TOL_MM and _same_axis(g, d, on_axis)), None)
        if g is None:
            g = {"d": d, "on_axis": on_axis, "r": r, "span": 0.0, "walls": []}
            groups.append(g)
        g["span"] += u1 - u0
        g["walls"].append((surf, foot))
    axes: list[dict[str, Any]] = []
    for g in groups:
        if any(_same_axis(a, g["d"], g["on_axis"]) for a in axes):
            continue  # a counterbore over its pilot: one axis, one hole
        if (g["span"] >= HOLE_CLOSURE * 2 * math.pi
                or (g["span"] >= HOLE_CLOSURE_KEYED * 2 * math.pi
                    and _gap_closed(shape, (g["d"], g["on_axis"], g["r"]), g["walls"]))):
            axes.append(g)
    return len(axes)


def _same_axis(g: dict[str, Any], d: list[float], on_axis: list[float]) -> bool:
    return (abs(sum(a * b for a, b in zip(g["d"], d))) > 1 - 1e-6
            and math.dist(g["on_axis"], on_axis) < AXIS_TOL_MM)


def _gap_closed(shape: Any, key: tuple, faces: list) -> bool:
    """True when the arc a bore's cylindrical wall leaves open is closed by the
    solid: a D-flat's chord inside the circle, a keyway's floor just outside
    it. Marches out from the axis through the middle and both ends of the gap
    at the wall's mid-height; each ray must meet material within 2r. A
    breakout meets air."""
    d, _, r = key
    _, foot = faces[0]
    x = _unit([1.0, 0.0, 0.0] if abs(d[0]) < 0.9 else [0.0, 1.0, 0.0])
    x = _unit([a - sum(p * q for p, q in zip(x, d)) * b for a, b in zip(x, d)])
    frame = _frame({"origin": foot, "zAxis": list(d), "xAxis": x})
    o, fx, fy, _ = frame
    bins = [False] * 72
    for s, _foot in faces:
        u0, u1 = s.FirstUParameter(), s.LastUParameter()
        vm = (s.FirstVParameter() + s.LastVParameter()) / 2
        for k in range(97):
            p = s.Value(u0 + (u1 - u0) * k / 96, vm)
            rel = [c - oc for c, oc in zip((p.X(), p.Y(), p.Z()), o)]
            a = math.atan2(sum(a * b for a, b in zip(rel, fy)), sum(a * b for a, b in zip(rel, fx)))
            bins[int((a % (2 * math.pi)) / (2 * math.pi) * 72) % 72] = True
    if all(bins) or not any(bins):
        return False
    # The longest run of open bins, walked around the circle from a covered one.
    start = bins.index(True)
    runs, run = [], []
    for i in range(1, 73):
        b = (start + i) % 72
        if bins[b]:
            if run:
                runs.append(run)
            run = []
        else:
            run.append(b)
    gap = max(runs, key=len)
    for b in (gap[0], gap[len(gap) // 2], gap[-1]):
        t = (b + 0.5) * 2 * math.pi / 72
        if _march(shape, frame, math.cos(t), math.sin(t), 0.0, 2 * r) is None:
            return False
    return True


def _symmetry_mismatch(shape: Any, plane: str) -> float:
    """Fraction of in-material samples whose mirror is void, mirrored through
    the plane at the BOUNDING-BOX CENTRE (parts are often modelled base-at-origin,
    so the frame's own plane would call every plate asymmetric in z). A sampled
    test, not a boolean: intersecting a symmetric part with its own mirror is
    all coincident faces, the case OCCT booleans handle worst."""
    a = PLANE_NORMAL[plane]
    bb = shape.bounding_box()
    lo = [float(bb.min.X), float(bb.min.Y), float(bb.min.Z)]
    hi = [float(bb.max.X), float(bb.max.Y), float(bb.max.Z)]
    c = (lo[a] + hi[a]) / 2
    inside = mismatched = 0
    n = SYMMETRY_GRID
    for i in range(n):
        for j in range(n):
            for k in range(n):
                p = [lo[m] + (idx + 0.5) * (hi[m] - lo[m]) / n for m, idx in enumerate((i, j, k))]
                if not _in_material(shape, tuple(p)):
                    continue
                inside += 1
                p[a] = 2 * c - p[a]
                if not _in_material(shape, tuple(p)):
                    mismatched += 1
    return mismatched / inside if inside else 0.0


def _assertion_failure(label: str, expected: float, measured: float, says: str, hint: str) -> GateError:
    return GateError("G4b", f'assertion "{label}": expected {says}, measured {measured:g}', hint,
                     expected=expected, measured=round(measured, 3))


def _check_assertion(shape: Any, a: dict[str, Any]) -> dict[str, Any]:
    kind = a.get("kind")
    if kind == "solids":
        # The G2 count, so both ways of declaring it report the same per-solid
        # bboxes that let a repair find the piece that does not meet the rest.
        g2_solid_count(shape, int(a["count"]))
        return {"kind": kind, "measured": len(shape.solids())}
    if kind == "volume_range":
        vol = float(shape.volume)
        lo, hi = float(a["min"]), float(a["max"])
        if not lo <= vol <= hi:
            bound = lo if vol < lo else hi
            raise _assertion_failure("volume_range", bound, vol, f"{lo:g}..{hi:g} mm³",
                                     f"the part holds {'too little' if vol < lo else 'too much'} material for the "
                                     "stated spec: check wall thicknesses, hollowing and cut sizes against the "
                                     "contract (Cylinder takes a RADIUS)")
        return {"kind": kind, "measured": round(vol, 3)}
    if kind == "bbox_axis":
        axis = a["axis"]
        bb = shape.bounding_box()
        size = float((bb.size.X, bb.size.Y, bb.size.Z)[AXIS_INDEX[axis]])
        lo, hi = a.get("min"), a.get("max")
        label = f"bbox_axis {axis}"
        if lo is not None and size < float(lo) - BBOX_TOL_MM:
            raise _assertion_failure(label, float(lo), size, f"at least {float(lo):g} mm along {axis}",
                                     f"the part is too small along {axis.upper()}: the spec states this overall "
                                     f"size, so build the body to it (a centred Box spans its full size, ±half)")
        if hi is not None and size > float(hi) + BBOX_TOL_MM:
            raise _assertion_failure(label, float(hi), size, f"at most {float(hi):g} mm along {axis}",
                                     f"the part is too big along {axis.upper()}: find the feature that sticks out "
                                     "and trim it to the stated overall size")
        return {"kind": kind, "axis": axis, "measured": round(size, 3)}
    if kind == "hole_count":
        got = _count_holes(shape)
        lo, hi = int(a["min"]), a.get("max")
        if got < lo or (hi is not None and got > int(hi)):
            says = f"{lo}" if hi is not None and int(hi) == lo else f"{lo}..{hi if hi is not None else '∞'}"
            raise _assertion_failure("hole_count", float(lo if got < lo else hi), got, f"{says} holes",
                                     "cut every hole as a full round bore (subtract a Cylinder), not a slot or a "
                                     "notch, and keep each one clear of the edge so its wall closes all the way "
                                     "round. Coaxial steps count as one hole")
        return {"kind": kind, "measured": got}
    if kind == "symmetry":
        plane = a["plane"]
        tol = float(a.get("tol", SYMMETRY_TOL))
        got = _symmetry_mismatch(shape, plane)
        if got > tol:
            raise _assertion_failure(f"symmetry {plane}", tol, got, f"mirror mismatch ≤ {tol:g}",
                                     f"the part must be mirror-symmetric about the {plane.upper()} plane through "
                                     "its bounding-box centre: model one half and mirror it, or place every "
                                     "off-centre feature as a ± pair")
        return {"kind": kind, "plane": plane, "measured": round(got, 4)}
    if kind == "min_wall":
        from .meshpart import to_trimesh
        from .printability import thin_wall_mm

        want = float(a["mm"])
        got = thin_wall_mm(to_trimesh(shape, 0.2))
        if got is not None and got < want - MIN_WALL_TOL_MM:
            raise _assertion_failure("min_wall", want, got, f"walls of at least {want:g} mm",
                                     f"a wall is thinner than {want:g} mm: thicken it, or move cuts apart so the "
                                     "material left between them is at least that thick")
        return {"kind": kind, "measured": None if got is None else round(got, 3)}
    if kind == "helix":
        return _check_helix(shape, a)
    if kind == "line_count":
        start, end = [float(c) for c in a["from"]], [float(c) for c in a["to"]]
        got = _material_runs(shape, start, end)
        lo, hi = int(a["crossings_min"]), a.get("crossings_max")
        if got < lo or (hi is not None and got > int(hi)):
            says = f"{lo}" if hi is not None and int(hi) == lo else f"{lo}..{hi if hi is not None else '∞'}"
            raise _assertion_failure("line_count", float(lo if got < lo else hi), got,
                                     f"{says} material crossings from {start} to {end}",
                                     "the stated ribs, fins or thread crests are not all there along this line: "
                                     "build each one as solid material the line passes through, separated by gaps")
        return {"kind": kind, "measured": got}
    raise GateError("G4b", f"assertion kind {kind!r} is not known", "use solids, volume_range, bbox_axis, "
                    "hole_count, symmetry, min_wall, helix or line_count")


HELIX_MIN_AMPLITUDE = 0.12  # |c_n| of the solid/void pattern; a 50% square wave has 1/pi
HELIX_ANGLES = 360
HELIX_PITCH_TOL = 0.15      # relative


def _material_runs(shape: Any, start: list[float], end: list[float]) -> int:
    """Separate stretches of material along the segment. On a B-rep, exact:
    the segment's crossings with the faces, each span between them classified
    at its midpoint (a grazing hit splits nothing, so equal neighbours merge)."""
    length = math.dist(start, end)
    d = [(e - s) / length for s, e in zip(start, end)]
    if getattr(shape, "wrapped", None) is not None:
        ts = [0.0, *(t for t in _line_hits(shape, tuple(start), d, length) if 0.0 < t < length), length]
    else:
        ts = [length * i / max(200, int(length / 0.1)) for i in range(max(200, int(length / 0.1)) + 1)]
    states = [_in_material(shape, tuple(start[i] + d[i] * (t0 + t1) / 2 for i in range(3)))
              for t0, t1 in itertools.pairwise(ts) if t1 - t0 > 1e-9]
    return sum(1 for i, m in enumerate(states) if m and (i == 0 or not states[i - 1]))


def _helix(shape: Any, a: dict[str, Any]) -> dict[str, Any]:
    """The helix a thread traces at `radius` about the part's Z through
    `center`: Z sections every pitch/8 over `z`, each sampled round the
    circle; the lowest strong Fourier harmonic of that solid/void pattern is
    the number of starts, and the drift of its phase with Z gives the hand and
    the pitch (median step, so one stray section cannot flip it). Stacked
    rings and a plain cylinder have no angular pattern: starts 0. Ported from
    CADClamp's helix probe (prompts._helix, Apache-2.0, the same author)."""
    import numpy as np
    from shapely import contains_xy

    from .meshpart import EXPORT_TOL_MM, to_trimesh

    mesh = to_trimesh(shape, EXPORT_TOL_MM)
    cx, cy = (float(c) for c in (a.get("center") or [0.0, 0.0])[:2])
    r = float(a["radius"])
    lo, hi = (float(z) for z in (a.get("z") or mesh.bounds[:, 2]))
    step = float(a.get("pitch") or (hi - lo) / 8) / 8
    ang = np.linspace(0, 2 * np.pi, HELIX_ANGLES, endpoint=False)
    xs, ys = cx + r * np.cos(ang), cy + r * np.sin(ang)
    harmonics = np.arange(1, 7)
    basis = np.exp(-1j * np.outer(harmonics, ang))
    coeffs, heights = [], []
    # a small odd offset keeps the planes off the levels a CAD kernel tends to
    # put vertices on (degenerate sections)
    for z in np.arange(lo, hi + 1e-9, step) + 1.37e-3:
        sec = mesh.section(plane_origin=[0, 0, z], plane_normal=[0, 0, 1])
        if sec is None:
            continue
        planar, _ = sec.to_2D(to_2D=np.eye(4))
        inside = np.zeros(len(ang), dtype=bool)
        for poly in planar.polygons_full:
            inside |= contains_xy(poly, xs, ys)
        coeffs.append(basis @ inside.astype(float) / len(ang))
        heights.append(z)
    if len(coeffs) < 4:
        return {"starts": 0, "hand": "none", "reason": "too few sections"}
    c = np.asarray(coeffs)
    amp = np.median(np.abs(c), axis=0)
    if amp.max() < HELIX_MIN_AMPLITUDE:
        return {"starts": 0, "hand": "none", "amplitude": round(float(amp.max()), 3)}
    # an n-start thread has no harmonic below n; a lopsided one-start thread
    # has a second harmonic nearly as large as its first
    n = int(harmonics[np.flatnonzero(amp >= 0.5 * amp.max())[0]])
    turn = np.angle(np.exp(1j * np.diff(np.angle(c[:, n - 1])))) / np.diff(heights)
    rate = float(np.median(turn))
    if abs(rate) < 1e-3:
        return {"starts": n, "hand": "none", "amplitude": round(float(amp[n - 1]), 3)}
    # the pattern turns by -phase/n; a right-hand thread turns counter-
    # clockwise (seen from +Z) as it rises, so its phase falls
    return {"starts": n, "hand": "right" if rate < 0 else "left",
            "pitch": round(float(2 * np.pi / abs(rate)), 3), "amplitude": round(float(amp[n - 1]), 3)}


def _check_helix(shape: Any, a: dict[str, Any]) -> dict[str, Any]:
    got = _helix(shape, a)
    starts, hand = int(a.get("starts", 1)), a.get("hand", "right")
    pitch = a.get("pitch")
    hint = (f"model the thread as a real {hand}-hand helix of {starts} start(s)"
            + (f" at pitch {float(pitch):g}" if pitch else "")
            + f" crossing radius {float(a['radius']):g} about the part's Z axis: cut a groove swept along a "
              "Helix (lefthand=True for a left hand) into the cylinder, the cheat sheet's THREADS recipe; "
              "stacked rings or a plain cylinder are not a thread")
    if got["starts"] != starts or got["hand"] != hand:
        raise GateError("G4b", f'assertion "helix": expected a {hand}-hand {starts}-start thread at radius '
                               f'{float(a["radius"]):g}, measured {got["starts"]} start(s), hand {got["hand"]}',
                        hint, expected=starts, measured=got["starts"])
    if pitch and abs(got["pitch"] - float(pitch)) > float(a.get("tol", HELIX_PITCH_TOL)) * float(pitch):
        raise _assertion_failure("helix pitch", float(pitch), got["pitch"], f"pitch {float(pitch):g}", hint)
    return {"kind": "helix", "measured": got}


def g4b_assertions(shape: Any, assertions: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Every assertion is checked, failing or not: (report of passes, failures)."""
    report: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for a in assertions:
        try:
            report.append(_check_assertion(shape, a))
        except GateError as err:
            failures.append(err.as_failure())
        except Exception as err:  # noqa: BLE001 — see _unreadable
            failures.append(_unreadable("G4b", f'assertion "{a.get("kind", "?")}"', err))
    return report, failures


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
    from build123d import (
        Axis,
        Box,
        BuildPart,
        Cone,
        Cylinder,
        GeomType,
        Helix,
        Locations,
        Mode,
        Plane,
        Polygon,
        Pos,
        RegularPolygon,
        Rot,
        chamfer,
        extrude,
        fillet,
        sweep,
    )

    fails: list[str] = []

    def expect(label: str, fn, want_error: str | None = None, want_hint: str | None = None) -> None:
        try:
            fn()
            ok, detail = want_error is None, "passed"
        except GateError as err:
            ok = want_error is not None and want_error in err.error
            if ok and want_hint is not None and want_hint not in (err.hint or ""):
                ok, detail = False, f"hint missing {want_hint!r}: {err.hint}"
                print(f"  FAIL  {label}  <- {detail}")
                fails.append(label)
                return
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
    expect("a groove posed on its floor says so",
           lambda: _probe_channel(grooved, {"key": "g", "type": "GROOVE", "pose": pose((0, 0, 1)), "params": {"width": 3.0}}),
           "sits on its floor")
    # t3-004: a keyway 4 wide whose floor is 7.5 from a Ø12 bore's axis. The
    # mouth is the bore wall, +z out into the bore, depth 1.5 into the hub.
    keyed = (Pos(0, 0, 10) * Cylinder(20, 20) - Pos(0, 0, 10) * Cylinder(6, 22)) - Pos(0, 6, 10) * Box(4, 3, 22)

    def keyway(part, y, depth=1.5):
        return lambda: _probe_channel(part, {"key": "k", "type": "SLOT", "pose": pose((0, y, 10), (0, -1, 0), (0, 0, 1)),
                                             "params": {"width": 4.0, "depth": depth}})
    expect("a keyway posed at its mouth on the bore wall measures its depth to the floor", keyway(keyed, 6))
    expect("posed on its floor it fails, naming the floor", keyway(keyed, 7.5), "sits on its floor")
    expect("a missing keyway is not called a floor",
           keyway(Pos(0, 0, 10) * Cylinder(20, 20) - Pos(0, 0, 10) * Cylinder(6, 22), 6), "no channel at the declared origin")
    # A cable clip burned its whole repair budget here. The generator faked a
    # mouth chamfer with Rot(45,0,0) * Box(w, leg*2, leg*2), whose footprint is
    # leg*sqrt(2) per rotated axis — sized against the wall it removed the wall
    # outright. The walls still exist deeper in, so the SHALLOW slice is what
    # fails, and the hint has to say "over-cut lead-in", not "check your axes".
    def _clip(flare_mult: float):
        clip_w, jaw, slot_w, wall, back = 18.0, 14.0, 20.6, 2.4, 3.0
        mouth, floor = -jaw / 2, jaw / 2

        def span(x_len, y0, y1, z_len):
            return Pos(0, (y0 + y1) / 2, 0) * Box(x_len, y1 - y0, z_len)

        part = span(clip_w, mouth, floor + back, slot_w + 2 * wall) - span(clip_w + 2, mouth - 1, floor, slot_w)
        if flare_mult:
            leg = wall * flare_mult
            for sz in (1, -1):
                part = part - Pos(0, mouth, sz * slot_w / 2) * (Rot(45, 0, 0) * Box(clip_w + 2, leg * 2, leg * 2))
        return part, {"key": "desk_slot", "type": "SLOT",
                      "pose": pose((0, mouth, 0), z=(0, -1, 0)), "params": {"width": slot_w, "depth": jaw}}

    expect("a jaw slot with no lead-in measures clean",
           lambda: _probe_channel(*_clip(0.0)))
    expect("an over-cut 45deg-Box lead-in is caught at the mouth",
           lambda: _probe_channel(*_clip(0.9)),
           "the channel is open",
           want_hint="over-cut lead-in")

    # CADClamp t5-002: a nut drop slot down from the top face into a hex pocket
    # that a Ø5.5 bolt hole crosses. The slice inside the hole has no walls,
    # and that is the hole, not an open slot.
    def _nut_block(slot_y: float, slot_w: float = 4.4):
        block = Pos(0, 0, 15) * Box(40, 20, 30)
        block -= Pos(0, 0, 22.5) * Box(8.4, slot_y, 15)
        block -= Pos(0, 0, 20) * (Rot(90, 0, 0) * Cylinder(2.75, 30))
        return block, {"key": "nut_drop_slot", "type": "SLOT", "pose": pose((0, 0, 30)), "params": {"width": slot_w}}

    expect("a slot crossed by a bolt hole is graded above the breakout",
           lambda: _probe_channel(*_nut_block(4.4)))
    expect("a slot crossed by a bolt hole still fails a wrong width",
           lambda: _probe_channel(*_nut_block(4.4, 3.4)), "expected width 3.4")
    expect("a slot cut across the whole block is open",
           lambda: _probe_channel(*_nut_block(24.0)), "the channel is open")

    expect("groove with no width",
           lambda: _probe_channel(grooved, {"key": "g", "type": "GROOVE", "pose": pose((0, 0, 5)), "params": {}}),
           "no numeric width")

    print("the depth march — the floor, measured not echoed")
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

    print("G1 names the failing line of the node's own code")
    bad = "from build123d import *\n\ndef build(p):\n    xs = []\n    return xs[3]\n"
    expect("an IndexError reports line 5 with context",
           lambda: g1_execute(g0_scan(bad), {}, None, bad), "line 5: return xs[3]")

    print("G2 — one part is one solid unless the contract says otherwise")
    two = Box(10, 10, 10) + Pos(20, 0, 0) * Box(10, 10, 10)
    expect("two disjoint solids fail against the default count",
           lambda: g2_solid_count(two, 1), "2 separate solids", want_hint="fuse")
    expect("two disjoint solids pass when the contract declares 2", lambda: g2_solid_count(two, 2))
    expect("a boss that overlaps its body is one solid",
           lambda: g2_solid_count(Box(10, 10, 10) + Pos(0, 0, 6) * Cylinder(2, 4), 1))
    sealed = g2_validity(Box(20, 20, 20) - Box(10, 10, 10))
    expect("an enclosed void is a warning, not a failure",
           lambda: None if sealed["shells"] == [2] and sealed.get("warnings") else _raise_selfcheck(str(sealed)))

    print("hole probe — fitted centre, axis tilt, narrowest slice")
    def plate_with(cutter):
        return Box(40, 40, 10) - cutter

    def bore(shape, d, kind="CLEARANCE_HOLE", origin=(0, 0, 5)):
        return lambda: _probe_hole(shape, {"key": "h", "type": kind, "pose": pose(origin), "params": {"diameter": d}})

    expect("a centred Ø8 through hole passes", bore(plate_with(Cylinder(4, 12)), 8.0))
    expect("a hole 0.1mm off centre passes", bore(plate_with(Pos(0.1, 0, 0) * Cylinder(4, 12)), 8.0))
    expect("a hole 0.5mm off centre fails with the offset",
           bore(plate_with(Pos(0.5, 0, 0) * Cylinder(4, 12)), 8.0), "0.50mm off the declared origin")
    def tilted(deg):  # pivoted on the port origin, so the mouth stays centred
        return plate_with(Pos(0, 0, 5) * Rot(0, deg, 0) * Pos(0, 0, -5) * Cylinder(4, 30))
    expect("a hole tilted 5 degrees fails", bore(tilted(5), 8.0), "axis tilted 5.0°")
    expect("a hole tilted 1 degree passes", bore(tilted(1), 8.0))
    necked = plate_with(Pos(0, 0, 2.5) * Cylinder(4, 5.01) + Pos(0, 0, -2.5) * Cylinder(3, 5.01))
    expect("a clearance hole that narrows below the mouth is caught",
           bore(necked, 8.0), "measured Ø6.00 (narrowest", want_hint="SCREW_SEAT")
    with BuildPart() as cbh:
        Box(40, 40, 10)
        with Locations((0, 0, 3.5)):
            Cylinder(5, 3, mode=Mode.SUBTRACT)
        Cylinder(2.5, 12, mode=Mode.SUBTRACT)
    expect("a counterbore seat is graded on its own step, not the pilot below",
           bore(cbh.part, 10.0, "SCREW_SEAT"))
    with BuildPart() as chh:
        Box(40, 40, 10)
        Cylinder(3, 12, mode=Mode.SUBTRACT)
        chamfer(chh.edges().filter_by(GeomType.CIRCLE).group_by(Axis.Z)[-1], length=1.0)
    expect("a Ø6 seat hidden under a chamfer is not read as Ø8",
           bore(chh.part, 8.0, "BORE"), "expected Ø8")
    cavity = Box(40, 40, 10) - Box(30, 30, 6)
    expect("an origin in an open cavity names the missing wall",
           bore(cavity, 4.0, "BORE", origin=(0, 0, 3)), "no hole wall found around the port origin")

    print("G4 — primitives are tested in their own rotated frame")
    rod = Rot(0, 90, 0) * Cylinder(3, 40)
    lying = [{"kind": "cylinder", "center": [0, 0, 0], "radius": 3, "height": 40,
              "zAxis": [1, 0, 0], "xAxis": [0, 1, 0]}]
    expect("a horizontal rod fits a horizontal cylinder", lambda: g4_envelope(rod, lying))
    expect("a vertical rod does not", lambda: g4_envelope(Cylinder(3, 40), lying), "escape the declared envelope")
    expect("a lazy xAxis parallel to zAxis still works on a cylinder",
           lambda: g4_envelope(rod, [{**lying[0], "xAxis": [1, 0, 0]}]))
    diamond = [{"kind": "box", "center": [0, 0, 0], "size": [10, 10, 4],
                "zAxis": [0, 0, 1], "xAxis": [1, 1, 0]}]
    expect("a box rotated 45° about z holds a matching diamond",
           lambda: g4_envelope(Rot(0, 0, 45) * Box(10, 10, 4), diamond))
    expect("and rejects the unrotated square",
           lambda: g4_envelope(Box(10, 10, 4), diamond), "escape the declared envelope")
    l_bracket = Box(30, 4, 30) + Pos(0, 13, -13) * Box(30, 30, 4)
    expect("an L-shaped face's mid-parameter point, in the notch, is not sampled",
           lambda: g4_envelope(l_bracket, [{"kind": "box", "center": [0, 0, 0], "size": [30, 4, 30]},
                                           {"kind": "box", "center": [0, 13, -13], "size": [30, 30, 4]}]))
    expect("an unknown primitive kind is an error, not a silent miss",
           lambda: g4_envelope(Box(1, 1, 1), [{"kind": "sphere", "center": [0, 0, 0]}]), "unknown envelope primitive")

    print("contract gates report every failure at once")
    holed = Box(40, 40, 6) - Cylinder(4, 6)

    def _all_three():
        try:
            contract_gates(holed, [
                {"key": "a", "type": "BORE", "pose": pose((0, 0, 3)), "params": {"diameter": 12.0}},
                {"key": "b", "type": "BORE", "pose": pose((15, 15, 3)), "params": {"diameter": 4.0}},
            ], [{"kind": "box", "center": [0, 0, 0], "size": [20, 20, 6]}])
        except GateError as err:
            got = [(f["stage"], f.get("port")) for f in err.failures]
            if err.stage != "G3" or got != [("G3", "a"), ("G3", "b"), ("G4", None)]:
                _raise_selfcheck(f"stage {err.stage}, failures {got}")
            if err.failures[0].get("measured") is None:
                _raise_selfcheck("port a carried no measured diameter")
            return
        _raise_selfcheck("no error raised")
    expect("two bad ports and an envelope escape in one error", _all_three)

    print("HOLE_PATTERN / BOSS_PATTERN — each member probed, each failure named")
    four = Box(60, 60, 6)
    for sx, sy in ((-20, -20), (20, -20), (-20, 20), (20, 20)):
        four = four - Pos(sx, sy, 0) * Cylinder(2.25, 8)
    three = Box(60, 60, 6)
    for sx, sy in ((-20, -20), (20, -20), (-20, 20)):
        three = three - Pos(sx, sy, 0) * Cylinder(2.25, 8)
    grid = {"diameter": 4.5, "nx": 2, "ny": 2, "pitch_x": 40, "pitch_y": 40}
    expect("a 2x2 grid of Ø4.5 measures clean",
           lambda: _probe_port(four, {"key": "h", "type": "HOLE_PATTERN", "pose": pose((0, 0, 3)), "params": grid}))
    expect("a polar pattern of the same four holes measures clean",
           lambda: _probe_port(four, {"key": "h", "type": "HOLE_PATTERN", "pose": pose((0, 0, 3)),
                                      "params": {"diameter": 4.5, "count": 4, "pcd": 40 * math.sqrt(2), "start_angle": 45}}))

    def _missing_one():
        _, failures = g3_ports(three, [{"key": "h", "type": "HOLE_PATTERN", "pose": pose((0, 0, 3)), "params": grid}])
        got = [(f.get("port"), f.get("member")) for f in failures]
        if got != [("h", 4)] or "member 4 of 4" not in failures[0]["error"]:
            _raise_selfcheck(f"failures {got}: {[f['error'] for f in failures]}")
    expect("one missing hole of four is reported as member 4", _missing_one)
    expect("a pattern with no layout fails repairably",
           lambda: _probe_port(four, {"key": "h", "type": "HOLE_PATTERN", "pose": pose((0, 0, 3)), "params": {"diameter": 4.5}}),
           "declares no numeric nx")
    bosses = Box(60, 60, 6)
    for sx in (-15, 15):
        bosses = bosses + Pos(sx, 0, 9) * Cylinder(4, 12) - Pos(sx, 0, 9) * Cylinder(1.25, 14)
    bp = {"outer_diameter": 8.0, "pilot_diameter": 2.5, "nx": 2, "ny": 1, "pitch_x": 30, "pitch_y": 0}
    expect("two bosses in a row measure clean",
           lambda: _probe_port(bosses, {"key": "b", "type": "BOSS_PATTERN", "pose": pose((0, 0, 15)), "params": bp}))
    expect("bosses declared on the wrong pitch are caught",
           lambda: _probe_port(bosses, {"key": "b", "type": "BOSS_PATTERN", "pose": pose((0, 0, 15)), "params": bp | {"pitch_x": 20}}),
           "(BOSS_PATTERN): boss wall missing")
    expect("an unprobed type FAILS instead of passing as skipped",
           lambda: _probe_port(four, {"key": "s", "type": "SNAP_HOOK", "pose": pose((0, 0, 3)), "params": {}}),
           "no probe for SNAP_HOOK")

    print("hardware host features — fit bands, shoulders, a clocked hex")
    def host(kind, d, cutter, **params):
        return lambda: _probe_port(Box(60, 60, 20) - cutter, {"key": "k", "type": kind, "pose": pose((0, 0, 10)),
                                                               "params": {"diameter": d, **params}})

    def blind(d, depth):
        return Pos(0, 0, 10 - depth / 2) * Cylinder(d / 2, depth)
    for fit, d, want in (("press", 3.95, None), ("slip", 3.95, "expected Ø4.05..4.25"),
                         ("slip", 4.15, None), ("press", 4.15, "expected Ø3.90..4.00")):
        expect(f"a Ø{d} dowel hole declared {fit}", host("DOWEL_HOLE", 4.0, blind(d, 10), depth=8, fit=fit), want)
    expect("a CNC slip dowel hole cut at nominal passes",
           lambda: _probe_port(Box(60, 60, 20) - blind(4.0, 10), {"key": "k", "type": "DOWEL_HOLE", "process": "cnc",
                                                                  "pose": pose((0, 0, 10)), "params": {"diameter": 4.0, "depth": 8, "fit": "slip"}}))
    expect("the same hole fails the FDM slip band", host("DOWEL_HOLE", 4.0, blind(4.0, 10), depth=8, fit="slip"),
           "expected Ø4.05..4.25")
    expect("a 608 seat with a lip passes",
           host("BEARING_SEAT", 0, blind(21.95, 7) + Cylinder(9.5, 30), od=22, width=7, fit="press"))
    expect("a 608 seat cut straight through has no shoulder",
           host("BEARING_SEAT", 0, Cylinder(10.975, 30), od=22, width=7, fit="press"), "no shoulder")
    expect("an LM6UU seat 19 deep over a lip passes",
           host("LINEAR_BEARING_SEAT", 0, blind(11.95, 19.5) + Cylinder(4, 30), od=12, length=19, fit="press"))
    expect("an LM6UU seat shorter than the bushing fails",
           host("LINEAR_BEARING_SEAT", 0, blind(11.95, 15) + Cylinder(4, 30), od=12, length=19, fit="press"), "the seat is 15.00mm deep")
    expect("a clip-retained LM8UU seat may run through",
           host("LINEAR_BEARING_SEAT", 0, Cylinder(7.475, 30), od=15, length=19, fit="press", retention="clip"))

    def grooved(d, w, at):
        return Cylinder(2.5, 40) - Pos(0, 0, at) * (Cylinder(3, w) - Cylinder(d / 2, w))

    def groove(shaft_, d, w):
        return lambda: _probe_port(shaft_, {"key": "g", "type": "CLIP_GROOVE", "pose": pose((0, 0, 0)),
                                            "params": {"diameter": d, "width": w, "shaft_diameter": 5}})
    expect("a Ø4 x 0.74 e-clip groove where the port is passes", groove(grooved(4, 0.74, 0), 4, 0.74))
    expect("a groove cut 0.3mm along the shaft fails", groove(grooved(4, 0.74, 0.3), 4, 0.74), "groove's middle is +0.30mm")
    expect("a groove too shallow for its ring fails", groove(grooved(4.4, 0.74, 0), 4, 0.74), "measured Ø4.40")
    land = Box(120, 30, 10)
    for k in range(5):
        land = land - Pos((k - 2) * 20, 0, 1) * Cylinder(2, 8)

    def rail(width, pitch):
        return lambda: _probe_port(land, {"key": "r", "type": "RAIL_MOUNT", "pose": pose((0, 0, 5)),
                                          "params": {"width": width, "length": 100, "pitch": pitch, "count": 5, "hole_diameter": 4, "depth": 6}})
    expect("an MGN9 land with its five holes at 20 passes", rail(9, 20))
    expect("the same land declared at a 25 pitch fails a hole", rail(9, 25), "member")
    expect("a land narrower than the rail fails", rail(40, 20), "no flat land")

    def trap(rot):
        return Pos(0, 0, 7.4) * Rot(0, 0, rot) * extrude(RegularPolygon(5.7 / math.sqrt(3), 6), 2.6) + Cylinder(1.7, 30)
    expect("a nut trap with a corner on xAxis passes", host("NUT_TRAP", 0, trap(0), af=5.5, depth=2.4))
    expect("a nut trap rotated 30° fails", host("NUT_TRAP", 0, trap(30), af=5.5, depth=2.4), "across the flats")
    expect("a round pocket is not a nut trap", host("NUT_TRAP", 0, blind(5.7, 2.6) + Cylinder(1.7, 30), af=5.5, depth=2.4),
           "across the corners")
    # t5-002: a side-entry trap whose drop slot leaves along +x, squared off on
    # -x down to the corner, with its bolt hole on the axis. The 150°/210° flat
    # rays leave through the square end: breakouts, graded on the 90° flat.
    def dropped(rot):
        return (trap(rot) + Pos(15, 0, 8.7) * Box(30, 5.5, 2.6)
                + Pos(-(5.7 / math.sqrt(3) + 0.2) / 2, 0, 8.7) * Box(5.7 / math.sqrt(3) + 0.2, 5.5, 2.6))
    expect("a nut trap with a drop slot and a squared end passes",
           host("NUT_TRAP", 0, dropped(0), af=5.5, depth=2.4, entry="side"))
    expect("the same trap rotated 30° still fails", host("NUT_TRAP", 0, dropped(30), af=5.5, depth=2.4, entry="side"),
           "across the flats")
    expect("a nut trap crossed by a bolt hole along y passes",
           host("NUT_TRAP", 0, trap(0) + Pos(0, 0, 8.7) * Rot(90, 0, 0) * Cylinder(1.7, 60), af=5.5, depth=2.4))
    expect("a thread with no tap drill is repairable", host("THREADED_HOLE", 0, blind(2.5, 10), thread="M7", depth=8),
           "declares no known thread")

    print("G4b — spec-derived assertions, pass and fail per kind")
    cbore = four - Pos(0, 0, 2) * Cylinder(5, 2) - Cylinder(2, 8)
    dbore = Box(30, 30, 10) - (Cylinder(2.575, 12) & Pos(2 - 10, 0, 0) * Box(20, 20, 12))
    keyed = Box(30, 30, 10) - Cylinder(4, 12) - Pos(4, 0, 0) * Box(3, 2, 12)
    slot = Box(40, 30, 10) - Pos(-5, 0, 0) * Cylinder(3, 12) - Pos(5, 0, 0) * Cylinder(3, 12) - Box(10, 6, 12)
    breakout = Box(30, 30, 10) - Pos(12.5, 0, 0) * Cylinder(3, 12)
    step = Box(40, 40, 20) - Pos(10, 0, 5) * Box(20, 50, 10)
    fillet_ = fillet(step.edges().filter_by(Axis.Y).sort_by_distance((0, 0, 0))[0], 3)
    asym = four + Pos(18, 0, 8) * Box(20, 20, 10)
    two_solids = Box(10, 10, 10) + Pos(30, 0, 0) * Box(10, 10, 10)
    thin_cup = Cylinder(20, 30) - Pos(0, 0, 1) * Cylinder(19.6, 30)
    for label, shape_, a, want in (
        ("solids 1 on one solid", four, {"kind": "solids", "count": 1}, None),
        ("solids 1 on two solids", two_solids, {"kind": "solids", "count": 1}, "result is 2 separate solids, the contract expects 1"),
        ("volume in range", Box(10, 10, 10), {"kind": "volume_range", "min": 900, "max": 1100}, None),
        ("volume too small", Box(10, 10, 10), {"kind": "volume_range", "min": 2000, "max": 3000}, 'assertion "volume_range"'),
        ("bbox x = 60", four, {"kind": "bbox_axis", "axis": "x", "min": 60, "max": 60}, None),
        ("bbox z max 4 on a 6mm plate", four, {"kind": "bbox_axis", "axis": "z", "max": 4}, "at most 4 mm along z"),
        ("4 holes counted", four, {"kind": "hole_count", "min": 4, "max": 4}, None),
        ("a counterbored hole counts once", cbore, {"kind": "hole_count", "min": 5, "max": 5}, None),
        ("3 holes where 4 are asked", three, {"kind": "hole_count", "min": 4}, "measured 3"),
        ("a D-bore counts once", dbore, {"kind": "hole_count", "min": 1, "max": 1}, None),
        ("a keyed bore counts once", keyed, {"kind": "hole_count", "min": 1, "max": 1}, None),
        ("a slot is not a hole", slot, {"kind": "hole_count", "min": 0, "max": 0}, None),
        ("a hole breaking out of the side is not a hole", breakout, {"kind": "hole_count", "min": 0, "max": 0}, None),
        ("a concave fillet is not a hole", fillet_, {"kind": "hole_count", "min": 0, "max": 0}, None),
        ("symmetric plate about yz", four, {"kind": "symmetry", "plane": "yz"}, None),
        ("a lug breaks yz symmetry", asym, {"kind": "symmetry", "plane": "yz"}, 'assertion "symmetry yz"'),
        ("a 6mm plate has 2mm walls", four, {"kind": "min_wall", "mm": 2.0}, None),
        ("a 0.4mm cup wall is not 1.2", thin_cup, {"kind": "min_wall", "mm": 1.2}, 'assertion "min_wall"'),
    ):
        expect(f"assertion: {label}", lambda s=shape_, aa=a: contract_gates(s, [], [], [aa]), want)

    print("through holes — pattern members, motor screws, the bore under a head")
    dimples = Box(60, 60, 6)
    for sx, sy in ((-20, -20), (20, -20), (-20, 20), (20, 20)):
        dimples = dimples - Pos(sx, sy, 3 - 0.375) * Cylinder(2.25, 0.75)
    for label, params, want in (("four Ø4.5 dimples 0.75mm deep are not a bolt pattern", grid, "bottoms out"),
                                ("the same dimples declaring their 0.7mm depth pass", grid | {"depth": 0.7}, None),
                                ("declared 3mm deep they are too shallow", grid | {"depth": 3}, "needs 3mm of depth")):
        expect(label, lambda pp=params: _probe_port(dimples, {"key": "h", "type": "HOLE_PATTERN", "pose": pose((0, 0, 3)), "params": pp}),
               want)
    nema = {"pilot_diameter": 22, "hole_diameter": 3.4, "pitch_x": 31, "pitch_y": 31}

    def mount(screw_depth):
        part = Box(60, 60, 10) - Cylinder(11.075, 12)
        for sx, sy in ((-15.5, -15.5), (15.5, -15.5), (-15.5, 15.5), (15.5, 15.5)):
            part = part - Pos(sx, sy, 5 - screw_depth / 2) * Cylinder(1.7, screw_depth)
        return lambda: _probe_port(part, {"key": "m", "type": "MOTOR_MOUNT", "pose": pose((0, 0, 5)), "params": nema})
    expect("a motor mount with through screw holes passes", mount(12))
    expect("a motor mount with 1mm screw dimples fails", mount(1), "bottoms out")
    head = Pos(0, 0, 10 - 1.7) * Cylinder(3.25, 3.4)
    expect("a counterbore over a through bore passes",
           host("COUNTERBORE", 6.5, head + Cylinder(1.7, 30), depth=3.4, through_diameter=3.4))
    expect("a counterbore over a 4mm blind bore fails", host("COUNTERBORE", 6.5, head + Pos(0, 0, 4.6) * Cylinder(1.7, 4),
                                                             depth=3.4, through_diameter=3.4), "bottoms out")
    expect("... unless it declares bore_depth", host("COUNTERBORE", 6.5, head + Pos(0, 0, 4.6) * Cylinder(1.7, 4),
                                                     depth=3.4, through_diameter=3.4, bore_depth=4))
    cone = Pos(0, 0, 10 - 1.15) * Cone(1.7, 4, 2.3)
    expect("a countersink over a through bore passes",
           host("COUNTERSINK", 8, cone + Cylinder(1.7, 30), angle=90, through_diameter=3.4))
    expect("a countersink over a blind bore fails",
           host("COUNTERSINK", 8, cone + Pos(0, 0, 5.7) * Cylinder(1.7, 4), angle=90, through_diameter=3.4), "bottoms out")

    print("hole_count clusters axes, contract errors are the contract's")
    tilted = Pos(7.83, 0, 0) * Rot(0, 45, 0)
    split = (Box(40, 40, 20) - tilted * Pos(0, 0, -15) * Cylinder(3, 30) - tilted * Pos(0, 0, 15) * Cylinder(3, 30)
             - tilted * Cylinder(4, 2))
    expect("a 45° bore at x.xx5 cut from both sides counts once",
           lambda: contract_gates(split, [], [], [{"kind": "hole_count", "min": 1, "max": 1}]))
    for label, envelope, assertion in (("a hole_count with only max", [], {"kind": "hole_count", "max": 4}),
                                       ("a symmetry plane that is not one", [], {"kind": "symmetry", "plane": "ab"}),
                                       ("an envelope box with no size", [{"kind": "box", "center": [0, 0, 0]}], None)):
        expect(f"{label} fails as CONTRACT",
               lambda e=envelope, a=assertion: contract_gates(four, [], e, [a] if a else []), "is malformed")

    def _contract_first():
        try:
            contract_gates(four, [{"key": "x", "type": "BORE", "pose": pose((0, 0, 3)), "params": {"diameter": 4}}], [],
                           [{"kind": "hole_count", "max": 4}])
        except GateError as err:
            if err.stage != "CONTRACT" or len(err.failures) != 2:
                _raise_selfcheck(f"stage {err.stage}, {len(err.failures)} failures")
            return
        _raise_selfcheck("passed")
    expect("a CONTRACT failure leads a combined report", _contract_first)
    fin = Box(100, 100, 50) + Pos(0, 0, 27.5) * Box(0.5, 10, 5)
    expect("a 0.5mm fin on a big block fails min_wall 1.2 (2% of the area never saw it)",
           lambda: contract_gates(fin, [], [], [{"kind": "min_wall", "mm": 1.2}]), 'assertion "min_wall"')

    print("hole breakout — through the top arm into the jaw is through; a blind bottom is not")
    # A C-clamp in section: spine at x<20, arms 15 thick, a 50mm jaw between them.
    clamp = Pos(30, 0, 40) * Box(60, 20, 80) - Pos(40, 0, 40) * Box(40, 30, 50)
    top = pose((50, 0, 80))
    expect("a Ø10.5 hole through the top arm into the jaw passes as a CLEARANCE_HOLE",
           lambda: _probe_hole(clamp - Pos(50, 0, 72.5) * Cylinder(5.25, 16),
                               {"key": "s", "type": "CLEARANCE_HOLE", "pose": top, "params": {"diameter": 10.5}}))
    expect("a hole pattern member breaking into the jaw passes too",
           lambda: _probe_pattern(clamp - Pos(45, 0, 72.5) * Cylinder(2, 16) - Pos(55, 0, 72.5) * Cylinder(2, 16),
                                  {"key": "p", "type": "HOLE_PATTERN", "pose": top,
                                   "params": {"diameter": 4, "nx": 2, "ny": 1, "pitch_x": 10, "pitch_y": 0}},
                                  _probe_screw_hole))
    expect("a blind Ø10.5 hole 8mm into the arm still bottoms out",
           lambda: _probe_hole(clamp - Pos(50, 0, 76) * Cylinder(5.25, 8),
                               {"key": "s", "type": "CLEARANCE_HOLE", "pose": top, "params": {"diameter": 10.5}}),
           "bottoms out")

    print("robust hole centre — a key or a flat moves neither the centre nor the Ø")
    hub = Pos(0, 0, 10) * Cylinder(20, 20) - Pos(0, 0, 10) * Cylinder(6, 22)
    for label, part in (("plain Ø12 bore", hub), ("keyed Ø12 bore", hub - Pos(0, 6, 10) * Box(4, 3, 22)),
                        ("D-bore Ø12 with a flat at 5", hub + Pos(0, 5.75, 10) * Box(12, 1.5, 20))):
        def _centred(part=part):
            r = _probe_hole(part, {"key": "b", "type": "BORE", "pose": pose((0, 0, 20)), "params": {"diameter": 12}})
            if r["center_offset"] > 0.05 or abs(r["measured_diameter"] - 12) > 0.05:
                _raise_selfcheck(f"offset {r['center_offset']}, Ø{r['measured_diameter']}")
        expect(f"{label}: centre within 0.05, Ø12 within 0.05", _centred)

    print("round where it must be — a teardrop roof passes, a 45 deg Box teardrop does not")
    block, run = Box(40, 30, 30), Rot(0, 90, 0) * Cylinder(5, 50)
    roof = Pos(0, 0, 5 / math.sqrt(2)) * Rot(45, 0, 0) * Box(50, 5, 5)  # the cheat sheet's
    box_roof = Rot(45, 0, 0) * Box(50, 10, 10) & Pos(0, 0, 10) * Box(52, 20, 20)  # t3-002's

    def channel(part):
        return lambda: _probe_hole(part, {"key": "c", "type": "CLEARANCE_HOLE", "params": {"diameter": 10},
                                          "pose": pose((20, 0, 0), (1, 0, 0), (0, 1, 0))})
    expect("a round Ø10 channel passes", channel(block - run))
    expect("a teardrop, circle plus a 45° roof from its tangents, passes", channel(block - run - roof))
    expect("a square-shouldered roof keeps its lower half round and passes",
           channel(block - run - Pos(0, 0, 2.5) * Box(50, 10, 5)))
    expect("a teardrop crossed by a branch open at the top passes",
           channel(block - run - roof - Pos(0, 0, 10) * Cylinder(5, 20)))
    expect("a 45° Box teardrop, Ø14 at its equator, fails", channel(block - run - box_roof), "not round")
    expect("so does a BORE cut that way",
           lambda: _probe_hole(block - run - box_roof, {"key": "c", "type": "BORE", "params": {"diameter": 10},
                                                         "pose": pose((20, 0, 0), (1, 0, 0), (0, 1, 0))}), "not round")
    # A screw only passes a clearance hole, so its bulge is a finding until it
    # reaches the head: t3-010's M5 hole, Ø6.93 at the equator under an Ø8.5 head.
    m5 = Rot(0, 90, 0) * Cylinder(2.75, 50)
    m5_roof = Rot(45, 0, 0) * Box(50, 5.5, 5.5) & Pos(0, 0, 5.5) * Box(52, 11, 11)

    def m5_hole(part):
        return _probe_hole(part, {"key": "m5", "type": "CLEARANCE_HOLE", "params": {"diameter": 5.5},
                                  "pose": pose((20, 0, 0), (1, 0, 0), (0, 1, 0))})
    expect("an M5 clearance hole with a Box teardrop passes with a finding",
           lambda: None if "short of the M5 head" in m5_hole(block - m5 - m5_roof).get("finding", "")
           else _raise_selfcheck("no finding"))
    expect("a bulge past the M5 head's Ø8.5 bearing fails",
           lambda: m5_hole(block - m5 - Pos(0, 0, 0.5) * Box(50, 9, 1)), "past the M5 head's Ø8.5")

    print("threads — straight and round to the probes, from the cheat sheet's groove")
    def groove(pitch, length, r_from, r_to, h=0.25, c=0.1):
        s = 1 if r_to > r_from else -1
        a, b = r_from - 0.3 * s, r_from + 0.05 * s
        pts = [(a, -h * pitch), (b, -h * pitch), (r_to, -c * pitch), (r_to, c * pitch), (b, h * pitch), (a, h * pitch)]
        return sweep(Plane.XZ * Polygon(*pts[::-s], align=None), Helix(pitch, length, a), is_frenet=True)

    pitch, rmin = 2.5, 10 - 1.0825 * 2.5 + 0.1
    nut = Pos(0, 0, 7.5) * Box(30, 30, 15) - Pos(0, 0, -pitch) * groove(pitch, 15 + 2 * pitch, rmin, 10.1)
    nut = nut - Cylinder(rmin, 45)
    expect("an M20 internal thread is a straight, centred BORE at its minor Ø",
           lambda: _probe_hole(nut, {"key": "t", "type": "BORE", "pose": pose((0, 0, 15)),
                                     "params": {"diameter": round(2 * rmin, 2)}}))

    def spigot(d, pitch, length, bore=0.0):
        r_maj, r_min = d / 2 - 0.1, d / 2 - 0.6134 * pitch - 0.1
        shank = Pos(0, 0, -length / 2) * Cylinder(r_maj, length)
        shank = shank - Pos(0, 0, -length - pitch) * groove(pitch, length + pitch - 0.5, r_maj, r_min)
        shank = shank - Pos(0, 0, -length - pitch / 2) * groove(pitch, pitch, r_maj, r_min - 0.05, 0.48, 0.48)
        part = Box(40, 40, 6) + Pos(0, 0, 3) * Rot(180, 0, 0) * shank
        return part - Cylinder(bore / 2, 100) if bore else part

    def threaded(part, d, length):
        return lambda: _probe_shaft(part, {"key": "s", "type": "SHAFT", "pose": pose((0, 0, 3)),
                                           "params": {"diameter": d, "length": length}})
    expect("an M8 threaded spigot is a round Ø8 peg", threaded(spigot(8, 1.25, 12), 8, 12))
    tube = spigot(24, 3, 20, bore=18)
    expect("a hollow M24 x 3 spigot with a Ø18 passage is a peg (t4-007)", threaded(tube, 24, 20))
    expect("and declared Ø30 it is still caught", threaded(tube, 30, 20), "expected Ø30")

    print("G0 — a stated feature may not be optional")
    sweep_guarded = ("from build123d import *\ndef build(p):\n    part = Box(10, 10, 10)\n    try:\n"
                     "        part = part + sweep(p.prof, p.path)\n    except Exception:\n        pass\n    return part\n")
    expect("a sweep inside try/except: pass is rejected", lambda: g0_scan(sweep_guarded), "silently skips")
    expect("a fillet inside try/except: pass is allowed",
           lambda: g0_scan("from build123d import *\ndef build(p):\n    part = Box(10, 10, 10)\n    try:\n"
                           "        part = fillet(part.edges().filter_by(Axis.Z) + part.edges(), 1)\n"
                           "    except Exception:\n        pass\n    return part\n"))
    expect("a feature added only if its volume is big enough is rejected",
           lambda: g0_scan("from build123d import *\ndef build(p):\n    part = Box(10, 10, 10)\n"
                           "    ridge = p.ridge & Box(5, 5, 5)\n    if ridge.volume > 1.0:\n        part = part + ridge\n"
                           "    return part\n"), "volume test")

    print()
    if fails:
        print(f"{len(fails)} FAILURE(S): {fails}")
        raise SystemExit(1)
    print("gates self-check passed")
