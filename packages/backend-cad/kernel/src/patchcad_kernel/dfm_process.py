"""G4c — process DFM: can a vendor actually make this part by the process its
contract names? Runs for fabricate parts only, after G4b, worker-side.

The rules are the ones a quoting engineer bounces a drawing for, measured on
the B-rep where the B-rep knows the answer (edge concavity, cylinder radii,
face orientation) and on a tessellation where only a ray can (undercuts,
thickness, hole-to-edge). Each rule reports ONE failure naming its worst
instance and how many there are, so a repair round sees every rule at once
without a hundred lines of the same corner.

A rule that throws is recorded under `unchecked`, never passed silently and
never failed: the generator cannot repair a checker bug. The vendor package
lists unchecked rules in its RFQ.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .gates import GateError
from .meshpart import MeshPart, to_trimesh

PROCESS_KINDS = ("cnc", "sheet_metal", "laser_cut", "sls", "mjf", "resin")
DEFAULT_TOOL_RADIUS_MM = 1.5
POCKET_DEPTH_PER_WIDTH = 4.0
MIN_WALL_MM = {"sls": 0.8, "mjf": 0.8, "resin": 0.6}
HOLE_EDGE_PER_THICKNESS = 2.0
MESH_TOL = 0.05
EPS = 0.02
RADIUS_TOL_MM = 0.01
UNDERCUT_MIN_AREA_MM2 = 1.0
UNDERCUT_MAX_SAMPLES = 6000


def _fail(kind: str, rule: str, error: str, hint: str, **detail: Any) -> dict[str, Any]:
    return GateError("G4c", f'process {kind} "{rule}": {error}', hint, rule=rule, **detail).as_failure()


def _pt(v: Any) -> list[float]:
    return [round(float(c), 2) for c in (v.X, v.Y, v.Z)] if hasattr(v, "X") else [round(float(c), 2) for c in v]


def _vec(v: Any) -> np.ndarray:
    return np.array([v.X, v.Y, v.Z], dtype=float) if hasattr(v, "X") else np.asarray(v, dtype=float)


# ---------------------------------------------------------------------------
# B-rep helpers
# ---------------------------------------------------------------------------

def _edge_faces(shape: Any) -> list[tuple[Any, list[Any]]]:
    """Every edge with the faces that share it."""
    from build123d import Edge, Face
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

    m = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape.wrapped, TopAbs_EDGE, TopAbs_FACE, m)
    out = []
    for i in range(1, m.Extent() + 1):
        faces: list[Any] = []
        for f in m.FindFromIndex(i):
            # A seam edge lists its one face twice.
            if not any(f.IsSame(u.wrapped) for u in faces):
                faces.append(Face(f))
        out.append((Edge(m.FindKey(i)), faces))
    return out


def _normal(face: Any, at: Any) -> np.ndarray:
    n = _vec(face.normal_at(at))
    return n / (np.linalg.norm(n) or 1.0)


def _concave(shape: Any, mid: np.ndarray, n1: np.ndarray, n2: np.ndarray) -> bool:
    """Two faces meet concavely when a point stepped off the edge along n1-n2
    lands in material: at a convex corner it lands outside for either order."""
    step = n1 - n2
    norm = np.linalg.norm(step)
    if norm < 1e-6:
        return False
    return bool(shape.is_inside(tuple(mid + EPS * 2 * step / norm)))


def _cylinder(face: Any) -> tuple[float, np.ndarray, np.ndarray, float] | None:
    """(radius, axis point, axis direction, angular span) of a cylindrical face."""
    if face.geom_type.name != "CYLINDER":
        return None
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepTools import BRepTools

    cyl = BRepAdaptor_Surface(face.wrapped).Cylinder()
    ax = cyl.Axis()
    loc, d = ax.Location(), ax.Direction()
    umin, umax, _, _ = BRepTools.UVBounds_s(face.wrapped)
    return cyl.Radius(), np.array([loc.X(), loc.Y(), loc.Z()]), np.array([d.X(), d.Y(), d.Z()]), umax - umin


def _face_samples(face: Any, n: int = 5) -> list[tuple[np.ndarray, np.ndarray]]:
    """Points ON the face with their outward normals: centroids of its largest
    tessellation triangles, which (unlike a face centre) never sit in a hole."""
    verts, tris = face.tessellate(MESH_TOL)
    if not tris:
        return []
    v = np.array([[p.X, p.Y, p.Z] for p in verts])
    t = np.array(tris)
    a = np.linalg.norm(np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]]), axis=1)
    out = []
    for i in np.argsort(-a)[:n]:
        c = v[t[i]].mean(axis=0)
        out.append((c, _normal(face, tuple(c))))
    return out


def _concave_cylinder(face: Any, info: tuple[float, np.ndarray, np.ndarray, float]) -> bool:
    """A cylinder whose outward normal points at its own axis is a hole or an
    internal fillet; one pointing away is a boss or a rounded outside edge."""
    samples = _face_samples(face, 1)
    if not samples:
        return False
    p, n = samples[0]
    _, loc, d, _ = info
    on_axis = loc + d * np.dot(p - loc, d)
    return float(np.dot(n, on_axis - p)) > 0


def _first_hits(mesh: Any, origins: np.ndarray, dirs: np.ndarray) -> np.ndarray:
    """Distance to the first surface along each ray, inf where nothing is hit."""
    out = np.full(len(origins), np.inf)
    if len(origins) == 0:
        return out
    locs, ray_idx, _ = mesh.ray.intersects_location(origins, dirs, multiple_hits=True)
    for loc, r in zip(locs, ray_idx):
        dist = float(np.dot(loc - origins[r], dirs[r]))
        if dist > 1e-4 and dist < out[r]:
            out[r] = dist
    return out


# ---------------------------------------------------------------------------
# CNC (3-axis, tool along part z)
# ---------------------------------------------------------------------------

def _cnc_corners(shape: Any, tool_r: float) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    z = np.array([0.0, 0.0, 1.0])
    bad: list[tuple[float, list[float]]] = []
    for edge, faces in _edge_faces(shape):
        if len(faces) != 2 or edge.geom_type.name != "LINE":
            continue
        a, b = _vec(edge.start_point()), _vec(edge.end_point())
        t = (b - a) / (np.linalg.norm(b - a) or 1.0)
        if abs(float(np.dot(t, z))) < 0.995:
            continue
        mid = (a + b) / 2
        n1, n2 = _normal(faces[0], tuple(mid)), _normal(faces[1], tuple(mid))
        if float(np.dot(n1, n2)) > 0.98:
            continue  # tangent: a fillet meeting its wall
        if _concave(shape, mid, n1, n2):
            bad.append((0.0, _pt(mid)))
    for face in shape.faces():
        info = _cylinder(face)
        if info is None:
            continue
        r, _, d, span = info
        # Fillets only: a hole (full turn, or a seam-split half) is drilled.
        if abs(float(np.dot(d, z))) < 0.995 or span >= math.pi - 0.01 or r >= tool_r - RADIUS_TOL_MM:
            continue
        if _concave_cylinder(face, info):
            bad.append((r, _pt(face.center())))
    report = {"tool_radius": tool_r, "sharp_internal_corners": len(bad)}
    if not bad:
        return report, []
    r, at = min(bad)
    return report, [_fail(
        "cnc", "internal_corner",
        f"{len(bad)} internal vertical corner(s) tighter than the Ø{2 * tool_r:g} end mill can cut; "
        f"tightest radius {r:.2f} mm at {at}",
        f"a rotating tool leaves its own radius in every inside corner: round each vertical inside corner "
        f"to at least {tool_r:g} mm (fillet the edges parallel to Z, e.g. "
        f"fillet(part.edges().filter_by(Axis.Z), {tool_r + 0.1:g}) BEFORE cutting outside features), "
        f"or open the corner with a relief",
        expected=tool_r, measured=round(r, 3), at=at, count=len(bad))]


def _cnc_undercuts(shape: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    mesh = to_trimesh(shape, MESH_TOL)
    area = mesh.area_faces
    idx = np.arange(len(area))
    if len(idx) > UNDERCUT_MAX_SAMPLES:
        idx = np.random.default_rng(0).choice(idx, UNDERCUT_MAX_SAMPLES, replace=False, p=area / area.sum())
    origins = mesh.triangles_center[idx] + EPS * mesh.face_normals[idx]
    up = np.tile([0.0, 0.0, 1.0], (len(idx), 1))
    blocked_up = mesh.ray.intersects_any(origins, up)
    blocked_down = mesh.ray.intersects_any(origins, -up)
    hidden = idx[blocked_up & blocked_down]
    scale = area.sum() / area[idx].sum()
    hidden_area = float(area[hidden].sum() * scale)
    report = {"undercut_area_mm2": round(hidden_area, 2)}
    if hidden_area < UNDERCUT_MIN_AREA_MM2:
        return report, []
    worst = hidden[np.argmax(area[hidden])]
    at = _pt(mesh.triangles_center[worst])
    return report, [_fail(
        "cnc", "undercut",
        f"{hidden_area:.1f} mm² of surface cannot be reached by a tool from +Z or -Z (e.g. at {at})",
        "a 3-axis mill reaches only what it can see from above or below: make every feature open toward "
        "+Z or -Z (no side holes, no overhanging lips, no internal cavities), or, if a second setup is "
        "intended, the architect sets sourcing.allowUndercuts",
        expected=0, measured=round(hidden_area, 2), at=at)]


def _cnc_pockets(shape: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    mesh = to_trimesh(shape, MESH_TOL)
    bb = shape.bounding_box()
    zmax, zmin = float(bb.max.Z), float(bb.min.Z)
    angles = np.radians(np.arange(0, 180, 22.5))
    dirs = np.stack([np.cos(angles), np.sin(angles), np.zeros_like(angles)], axis=1)
    worst: tuple[float, float, float, list[float]] | None = None
    checked = 0
    for face in shape.faces():
        if face.geom_type.name != "PLANE":
            continue
        samples = _face_samples(face, 1)
        if not samples:
            continue
        c, n = samples[0]
        sz = round(float(n[2]))
        if abs(n[2]) < 0.999 or (sz > 0 and c[2] > zmax - 0.01) or (sz < 0 and c[2] < zmin + 0.01):
            continue
        # A drilled hole's floor is a disc: drilling depth is not milling depth.
        edges = face.outer_wire().edges()
        if len(edges) == 1 and edges[0].geom_type.name == "CIRCLE":
            continue
        p = c + sz * 0.05 * np.array([0.0, 0.0, 1.0])
        origins = np.repeat(p[None, :], len(dirs), axis=0)
        fwd, back = _first_hits(mesh, origins, dirs), _first_hits(mesh, origins, -dirs)
        widths = fwd + back
        if not np.isfinite(widths).any():
            continue  # open on every axis: a step, not a pocket
        k = int(np.argmin(widths))
        # Wall height at both sides of the narrowest span: the wall top seen
        # from beyond the part, along the tool axis.
        tops = []
        for side, dist in ((dirs[k], fwd[k]), (-dirs[k], back[k])):
            q = p + side * (dist + 0.05)
            start = np.array([q[0], q[1], zmax + 1 if sz > 0 else zmin - 1])
            hit = _first_hits(mesh, start[None, :], np.array([[0.0, 0.0, -float(sz)]]))[0]
            tops.append(abs(start[2] - sz * hit - c[2]) if np.isfinite(hit) else 0.0)
        depth, width = min(tops), float(widths[k])
        checked += 1
        ratio = depth / width if width > 0 else 0.0
        if worst is None or ratio > worst[0]:
            worst = (ratio, depth, width, _pt(c))
    report: dict[str, Any] = {"pockets": checked}
    if worst is None:
        return report, []
    ratio, depth, width, at = worst
    report["worst_depth_per_width"] = round(float(ratio), 2)
    if ratio <= POCKET_DEPTH_PER_WIDTH + 0.01:
        return report, []
    return report, [_fail(
        "cnc", "pocket_depth",
        f"pocket at {at} is {depth:.1f} mm deep and {width:.1f} mm wide ({ratio:.1f}x; limit {POCKET_DEPTH_PER_WIDTH:g}x)",
        f"a cutter long enough for this pocket chatters and snaps: widen the pocket to at least "
        f"{depth / POCKET_DEPTH_PER_WIDTH:.1f} mm or make it shallower than {width * POCKET_DEPTH_PER_WIDTH:.1f} mm",
        expected=POCKET_DEPTH_PER_WIDTH, measured=round(ratio, 2), at=at)]


# ---------------------------------------------------------------------------
# Sheet metal
# ---------------------------------------------------------------------------

def _sheet_faces(shape: Any, mesh: Any) -> tuple[float, list[dict[str, Any]]]:
    """Per face: inward thickness, strip width (2·area/perimeter) and class.
    The sheet thickness is the largest face's: that face IS the sheet."""
    import trimesh

    faces = []
    for face in shape.faces():
        samples = _face_samples(face)
        if not samples:
            continue
        pts = np.array([s[0] for s in samples])
        nrm = np.array([s[1] for s in samples])
        th = np.asarray(trimesh.proximity.thickness(mesh, pts, normals=nrm, method="ray"))
        th = th[np.isfinite(th)]
        perimeter = sum(e.length for e in face.edges()) or 1.0
        faces.append({"face": face, "area": float(face.area), "d": float(np.median(th)) if len(th) else math.inf,
                      "width": 2 * float(face.area) / perimeter, "at": _pt(pts[0])})
    t0 = max(faces, key=lambda f: f["area"])["d"] if faces else math.inf
    tol = max(0.05, 0.05 * t0)
    for f in faces:
        f["cls"] = "sheet" if abs(f["d"] - t0) <= tol else ("rim" if f["width"] <= 1.25 * t0 + tol else "off")
    return t0, faces


def _sheet_metal(shape: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    mesh = to_trimesh(shape, MESH_TOL)
    t0, faces = _sheet_faces(shape, mesh)
    if not math.isfinite(t0):
        raise ValueError("no sheet face thickness could be measured")
    tol = max(0.05, 0.05 * t0)
    failures: list[dict[str, Any]] = []
    report: dict[str, Any] = {"thickness": round(t0, 3)}

    off = [f for f in faces if f["cls"] == "off"]
    if off:
        worst = max(off, key=lambda f: abs(f["d"] - t0))
        failures.append(_fail(
            "sheet_metal", "constant_thickness",
            f"{len(off)} face(s) are not {t0:.2f} mm sheet; worst measures {worst['d']:.2f} mm at {worst['at']}",
            f"sheet metal is one gauge everywhere: build the part as a {t0:g} mm sheet bent into shape "
            "(an extruded profile, or an L/U of plates with bend radii), with no bosses, pockets or ribs",
            expected=round(t0, 3), measured=round(worst["d"], 3), at=worst["at"], count=len(off)))

    # Bends: an inner bend is a concave cylinder of the sheet, or a sharp
    # concave edge between two sheet faces (radius 0).
    tight: list[tuple[float, list[float]]] = []
    for f in faces:
        info = _cylinder(f["face"])
        if f["cls"] == "sheet" and info and info[0] < t0 - tol and _concave_cylinder(f["face"], info):
            tight.append((info[0], f["at"]))
    sheet = [f["face"] for f in faces if f["cls"] == "sheet"]
    for edge, adj in _edge_faces(shape):
        if len(adj) != 2 or not all(any(a.wrapped.IsSame(s.wrapped) for s in sheet) for a in adj):
            continue
        mid = _vec(edge.center())
        n1, n2 = _normal(adj[0], tuple(mid)), _normal(adj[1], tuple(mid))
        if float(np.dot(n1, n2)) < 0.98 and _concave(shape, mid, n1, n2):
            tight.append((0.0, _pt(mid)))
    report["tight_bends"] = len(tight)
    if tight:
        r, at = min(tight)
        failures.append(_fail(
            "sheet_metal", "bend_radius",
            f"{len(tight)} bend(s) with inner radius below the {t0:.2f} mm thickness; tightest {r:.2f} mm at {at}",
            f"a brake cannot fold tighter than the material: give every bend an inner radius of at least "
            f"{t0:g} mm (outer = inner + thickness), e.g. sweep the profile along a path with RadiusArc corners",
            expected=round(t0, 3), measured=round(r, 3), at=at, count=len(tight)))

    holes: dict[tuple, tuple[float, np.ndarray, np.ndarray]] = {}
    for f in faces:
        info = _cylinder(f["face"])
        if f["cls"] == "rim" and info and info[3] >= math.pi - 0.01 and _concave_cylinder(f["face"], info):
            r, loc, d, _ = info
            p = _face_samples(f["face"], 1)[0][0]
            c = loc + d * np.dot(p - loc, d)
            holes.setdefault((round(r, 2), *np.round(loc - d * np.dot(loc, d), 1)), (r, c, d))
    edge_d: list[tuple[float, list[float]]] = []
    for r, c, d in holes.values():
        u = np.cross(d, [1.0, 0, 0] if abs(d[0]) < 0.9 else [0, 1.0, 0])
        u /= np.linalg.norm(u)
        v = np.cross(d, u)
        angles = np.radians(np.arange(0, 360, 22.5))
        dirs = np.array([math.cos(a) * u + math.sin(a) * v for a in angles])
        origins = c + (r + EPS) * dirs
        inside = mesh.contains(origins)
        dist = np.where(inside, _first_hits(mesh, origins, dirs) + EPS, 0.0)
        edge_d.append((float(dist.min()), _pt(c)))
    report["holes"] = len(edge_d)
    need = HOLE_EDGE_PER_THICKNESS * t0
    near = [e for e in edge_d if e[0] < need - tol]
    if near:
        dmin, at = min(near)
        failures.append(_fail(
            "sheet_metal", "hole_edge",
            f"{len(near)} hole(s) closer than {need:.2f} mm (2x thickness) to an edge or bend; closest "
            f"{dmin:.2f} mm, hole at {at}",
            f"a punched hole near an edge tears out and one near a bend distorts: move each hole so its rim is "
            f"at least {need:g} mm from every edge, other hole and bend, or grow the flange",
            expected=round(need, 3), measured=round(dmin, 3), at=at, count=len(near)))
    return report, failures


# ---------------------------------------------------------------------------
# Laser cut: one profile, extruded
# ---------------------------------------------------------------------------

def profile_axis(shape: Any) -> np.ndarray:
    """The extrusion axis of a flat part: the normal of its largest plane."""
    planes = [f for f in shape.faces() if f.geom_type.name == "PLANE"]
    if not planes:
        raise ValueError("no planar face to cut a profile from")
    big = max(planes, key=lambda f: f.area)
    return _normal(big, big.center())


def planar_profile(shape: Any) -> tuple[np.ndarray, list[float], list[tuple[str, list[float]]]]:
    """(axis, cap offsets, faces that break the profile). An extruded profile
    has exactly two cap levels and every other face parallel to the axis."""
    axis = profile_axis(shape)
    levels: list[float] = []
    bad: list[tuple[str, list[float]]] = []
    for face in shape.faces():
        samples = _face_samples(face, 4)
        dots = [abs(float(np.dot(n, axis))) for _, n in samples]
        if dots and min(dots) > 0.999 and face.geom_type.name == "PLANE":
            off = float(np.dot(samples[0][0], axis))
            if not any(abs(off - l) < 0.01 for l in levels):
                levels.append(off)
        elif dots and max(dots) > 0.001:
            bad.append((face.geom_type.name.lower(), _pt(samples[0][0])))
    return axis, sorted(levels), bad


def _laser_cut(shape: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    axis, levels, bad = planar_profile(shape)
    report: dict[str, Any] = {"axis": [round(float(c), 3) for c in axis], "cap_levels": len(levels)}
    failures = []
    if bad:
        kind, at = bad[0]
        failures.append(_fail(
            "laser_cut", "planar_profile",
            f"{len(bad)} face(s) are neither parallel nor perpendicular to the sheet (first: a {kind} at {at})",
            "a laser cuts one 2D outline straight through: no chamfers, fillets on the top/bottom edges, "
            "drafts or countersinks. Build it as extrude(<profile sketch>, thickness) with holes cut through",
            expected=0, measured=len(bad), at=at, count=len(bad)))
    if len(levels) != 2:
        failures.append(_fail(
            "laser_cut", "single_thickness",
            f"the sheet faces sit at {len(levels)} levels, not 2 (top and bottom)",
            "a laser part is one thickness: remove steps, pockets and bosses so every face normal to the sheet "
            "is either the top or the bottom",
            expected=2, measured=len(levels)))
    else:
        report["thickness"] = round(levels[1] - levels[0], 3)
    return report, failures


# ---------------------------------------------------------------------------
# Additive vendor processes
# ---------------------------------------------------------------------------

def _additive(shape: Any, kind: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    from .printability import thin_wall_mm

    need = MIN_WALL_MM[kind]
    wall = thin_wall_mm(to_trimesh(shape, 0.2))
    report: dict[str, Any] = {"min_wall": None if wall is None else round(wall, 3)}
    failures = []
    if wall is not None and wall < need - 0.02:
        failures.append(_fail(
            kind, "min_wall", f"thinnest wall {wall:.2f} mm, the process needs {need:g} mm",
            f"{kind.upper()} cannot form walls under {need:g} mm: thicken them or move cuts apart",
            expected=need, measured=round(wall, 3)))
    if kind == "resin" and not isinstance(shape, MeshPart):
        voids = sum(len(s.shells()) - 1 for s in shape.solids())
        report["enclosed_voids"] = voids
        if voids:
            failures.append(_fail(
                kind, "enclosed_void",
                f"{voids} fully enclosed void(s): uncured resin is trapped inside and the part cracks",
                "make the part solid, or open each cavity with a drain hole of at least 2 mm to the outside",
                expected=0, measured=voids))
    return report, failures


def g4c_process(shape: Any, process: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """(report, failures) for the process the contract names."""
    kind = process.get("kind", "")
    if kind not in PROCESS_KINDS:
        return {"kind": kind, "skipped": "no DFM rules for this process"}, []
    if kind in MIN_WALL_MM:
        rules = [("wall", lambda s: _additive(s, kind))]
    elif isinstance(shape, MeshPart):
        return {"kind": kind}, [_fail(kind, "brep", "an imported mesh has no faces or edges to check",
                                      "fabricate it from parametric build123d geometry, or class it print")]
    elif kind == "cnc":
        tool_r = float(process.get("tool_radius") or DEFAULT_TOOL_RADIUS_MM)
        rules = [("corners", lambda s: _cnc_corners(s, tool_r)), ("pockets", _cnc_pockets)]
        if not process.get("allow_undercuts"):
            rules.append(("undercuts", _cnc_undercuts))
    elif kind == "sheet_metal":
        rules = [("sheet", _sheet_metal)]
    else:
        rules = [("profile", _laser_cut)]
    report: dict[str, Any] = {"kind": kind}
    failures: list[dict[str, Any]] = []
    for name, rule in rules:
        try:
            part, fails = rule(shape)
        except Exception as err:  # noqa: BLE001 — a checker bug is not the part's fault
            report.setdefault("unchecked", {})[name] = f"{type(err).__name__}: {err}"
            continue
        report |= part
        failures += fails
    return report, failures
