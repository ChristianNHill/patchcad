"""Imported-mesh support: STL/3MF/STEP files become graph nodes.

MeshPart wraps a watertight trimesh so it satisfies the same gate interface
as build123d shapes (volume, area, solids, is_valid, bounding_box, tessellate,
is_inside) — imported pieces run through G2/G3/G4 and export like any cooked
part. Segmentation turns one solid into printable pieces: plane cuts along
the longest axis (manifold booleans), with optional alignment/screw holes at
each cut interface. The cut planes become the pieces' mating contracts.
"""

from __future__ import annotations

import base64
import io
import json
import math
import os
from dataclasses import dataclass, field
from functools import cache
from itertools import combinations
from pathlib import Path
from typing import Any

import numpy as np
import trimesh

TESSELLATION_LIMIT = 500_000  # faces; imports beyond this get decimated
EXPORT_TOL_MM = 0.05  # STL/3MF/OBJ tessellation

# Alignment pegs (joint mode "pegs"): the PEG IS SMALLER THAN ITS SOCKET —
# 0.3 mm diametral clearance is the standard FDM slip fit; equal diameters
# never assemble off a printer.
PEG_D = 5.0
PEG_CLEARANCE = 0.3
PEG_LEN = 6.0

# Joint mode "auto": the kernel finds WHERE a joint fits and how much material
# it has there; the server's joint rules pick the hardware (joints.ts) and the
# host features are cut at execute time by `cut_joints`. Every feature keeps
# this much wall around it, the FDM minimum (joints.ts FDM_MIN_WALL_MM).
JOINT_MIN_WALL_MM = 1.2


class _Vec:
    def __init__(self, x: float, y: float, z: float):
        self.X, self.Y, self.Z = float(x), float(y), float(z)


class _BBox:
    def __init__(self, bounds: np.ndarray):
        self.min = _Vec(*bounds[0])
        self.max = _Vec(*bounds[1])
        self.size = _Vec(*(bounds[1] - bounds[0]))


class MeshPart:
    """Duck-typed stand-in for a build123d Part, backed by a trimesh."""

    def __init__(self, mesh: trimesh.Trimesh):
        self.mesh = mesh

    # --- gate interface -----------------------------------------------------
    @property
    def volume(self) -> float:
        return float(self.mesh.volume)

    @property
    def area(self) -> float:
        return float(self.mesh.area)

    def solids(self) -> list[Any]:
        return [self] if len(self.mesh.faces) > 0 else []

    @property
    def is_valid(self) -> bool:
        return bool(self.mesh.is_watertight)

    def bounding_box(self) -> _BBox:
        return _BBox(self.mesh.bounds)

    def tessellate(self, _tolerance: float) -> tuple[list[_Vec], list[tuple[int, ...]]]:
        verts = [_Vec(*v) for v in self.mesh.vertices]
        return verts, [tuple(f) for f in self.mesh.faces]

    def is_inside(self, point: tuple[float, float, float]) -> bool:
        return bool(self.mesh.contains(np.array([point]))[0])

    # --- boolean interop: imported meshes edit like any part -----------------
    # `load_import("x.ply") - Pos(...) * Cylinder(...)` works: build123d shapes
    # tessellate to meshes and manifold does the boolean, so LLM reprompts use
    # the exact same vocabulary on imported geometry as on generated parts.
    def _coerce(self, other: Any) -> trimesh.Trimesh:
        if isinstance(other, MeshPart):
            return other.mesh  # already a volume, and NOT ours to repair in place
        # OCP tessellation duplicates vertices per face — to_trimesh welds
        # (process=True) so the result is a closed volume manifold can boolean.
        mesh = to_trimesh(other, 0.05)
        if not mesh.is_watertight:
            mesh = mesh.copy()  # to_trimesh's mesh is shared for the job
            mesh.merge_vertices(merge_tex=True, merge_norm=True)
            trimesh.repair.fill_holes(mesh)
        return mesh

    def __sub__(self, other: Any) -> MeshPart:
        return MeshPart(_boolean(self.mesh, "difference", self._coerce(other)))

    def __add__(self, other: Any) -> MeshPart:
        return MeshPart(_boolean(self.mesh, "union", self._coerce(other)))

    def __and__(self, other: Any) -> MeshPart:
        return MeshPart(_boolean(self.mesh, "intersection", self._coerce(other)))

    def export_glb(self, path: str) -> None:
        # match build123d's export convention: meters, Y-up glTF
        m = self.mesh.copy()
        m.apply_scale(0.001)
        m.apply_transform(
            np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float)
        )
        m.export(path)


def to_trimesh(shape: Any, tol: float, process: bool = True) -> trimesh.Trimesh:
    """Any part → a trimesh. The one place that answers "is this a MeshPart or a
    build123d shape". Four copies of this branch existed and three of them
    sniffed for MeshPart differently (`.trimesh`, `not callable(.mesh)`,
    `isinstance(.mesh, Trimesh)`) — isinstance, never hasattr, because a
    build123d shape carries a .mesh METHOD.

    Never a private copy: a MeshPart hands over its OWN mesh, and a build123d
    shape's mesh is memoized per (shape, tol) for the job, because one verify
    tessellated the same part at 0.2 three times (printability, min_wall, G4c).
    Callers that transform or repair must copy first. build123d shapes are
    welded (process=True) unless the caller only wants the raw arrays — OCP
    emits vertices duplicated per face, and a boolean or a watertight flag read
    off an unwelded shell is nonsense."""
    if isinstance(shape, MeshPart):
        return shape.mesh
    hit = _MESH_MEMO.get((id(shape), tol, process))
    if hit is None or hit[0] is not shape:
        verts, faces = shape.tessellate(tol)
        mesh = trimesh.Trimesh(
            vertices=[(v.X, v.Y, v.Z) for v in verts],
            faces=[tuple(f) for f in faces],
            process=process,
        )
        hit = _MESH_MEMO[(id(shape), tol, process)] = (shape, mesh)
    return hit[1]


_MESH_MEMO: dict[tuple[int, float, bool], tuple[Any, trimesh.Trimesh]] = {}


def weld(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Weld an OCP tessellation in place the way an export must: merge the
    per-face duplicate vertices, then drop the triangles the merge collapsed.
    OCCT fans a sphere's pole with a sliver whose two pole vertices coincide;
    welded, it is a triangle with a repeated corner, and it left one open and
    one non-manifold edge at every pole, so any part with a sphere in it
    exported non-watertight. Never process(validate=True): see the module."""
    mesh.merge_vertices()
    f = mesh.faces
    mesh.update_faces((f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2]))
    return mesh


def reset_mesh_memo() -> None:
    _MESH_MEMO.clear()


# --- loading ----------------------------------------------------------------

def load_mesh_file(filename: str, data: bytes) -> list[trimesh.Trimesh]:
    """Load STL/3MF/STEP bytes → list of watertight-ish component meshes (mm)."""
    ext = os.path.splitext(filename.lower())[1]
    if ext in (".stl", ".3mf", ".obj", ".ply"):
        # PLY loads verbatim (our own manifold-clean piece files — vertex
        # merging would break watertightness); soups get welded.
        loaded = trimesh.load(
            io.BytesIO(data), file_type=ext[1:], force="scene", process=ext != ".ply"
        )
        meshes = [g for g in loaded.geometry.values()] if isinstance(loaded, trimesh.Scene) else [loaded]
        merged = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
        parts = merged.split(only_watertight=False)
        return [p for p in parts if len(p.faces) > 0] or [merged]
    if ext in (".step", ".stp"):
        # B-rep in → tessellate each solid so segmentation is uniform mesh math.
        import tempfile

        from build123d import import_step

        with tempfile.NamedTemporaryFile(suffix=".step", delete=False) as f:
            f.write(data)
            tmp = f.name
        try:
            shape = import_step(tmp)
            solids = shape.solids() if hasattr(shape, "solids") else [shape]
            out = []
            for s in solids:
                verts, faces = s.tessellate(0.2)
                out.append(
                    trimesh.Trimesh(
                        vertices=[(v.X, v.Y, v.Z) for v in verts],
                        faces=[tuple(f_) for f_ in faces],
                        process=True,
                    )
                )
            return out
        finally:
            os.unlink(tmp)
    raise ValueError(f"unsupported import format {ext!r} — STL, 3MF, OBJ, PLY, or STEP")


# --- segmentation -----------------------------------------------------------

@dataclass
class Interface:
    piece_a: int
    piece_b: int
    """cut plane: point + normal (from piece_a toward piece_b), part-global mm"""
    origin: list[float]
    normal: list[float]
    holes: list[dict[str, Any]]  # {center: [x,y,z], diameter: float}
    pegs: list[dict[str, Any]]  # {center, peg_diameter, socket_diameter, length}
    face_size: float = 3.0  # probe extent that actually fits in material at the anchor
    # joint mode "auto": {center, normal, span, wallA, wallB, face_size} per site
    candidates: list[dict[str, Any]] = field(default_factory=list)


def _boolean(a: trimesh.Trimesh, op: str, b: trimesh.Trimesh) -> trimesh.Trimesh:
    fn = {"difference": trimesh.boolean.difference,
          "intersection": trimesh.boolean.intersection,
          "union": trimesh.boolean.union}[op]
    # manifold output is already watertight with consistent winding; a
    # validate pass would "fix" interior hole tunnels into positive shells.
    return fn([a, b], engine="manifold")


def _slab(bounds: np.ndarray, axis: int, lo: float, hi: float) -> trimesh.Trimesh:
    pad = 1.0
    mins = bounds[0] - pad
    maxs = bounds[1] + pad
    mins[axis] = lo
    maxs[axis] = hi
    return trimesh.creation.box(bounds=np.array([mins, maxs]))


def _area_profile(solid: trimesh.Trimesh, axis: int, stations: int = 64) -> tuple[np.ndarray, np.ndarray]:
    """Cross-section area swept along an axis (on a decimated copy — analysis
    only; cutting always happens on the full mesh)."""
    analysis = solid
    if len(analysis.faces) > 40_000:
        try:
            analysis = analysis.simplify_quadric_decimation(face_count=40_000)
        except Exception:  # noqa: BLE001, S110 — analysis only: the full mesh is a slower, correct fallback
            pass
    lo, hi = float(solid.bounds[0][axis]), float(solid.bounds[1][axis])
    span = hi - lo
    xs = np.linspace(lo + span * 0.05, hi - span * 0.05, stations)
    areas = np.zeros(stations)
    for i, s in enumerate(xs):
        try:
            sec = analysis.section(plane_origin=np.eye(3)[axis] * s, plane_normal=np.eye(3)[axis])
            if sec is None or len(sec.vertices) == 0:
                areas[i] = 0.0
                continue
            planar, _ = sec.to_planar()
            areas[i] = float(sum(p.area for p in planar.polygons_full)) or 0.0
        except Exception:  # noqa: BLE001
            areas[i] = areas[i - 1] if i else 0.0
    # light smoothing so tessellation noise does not fake necks
    kernel = np.ones(3) / 3.0
    areas = np.convolve(areas, kernel, mode="same")
    return xs, areas


def find_natural_cuts(solid: trimesh.Trimesh, max_cuts: int = 6) -> tuple[int, list[float]]:
    """The minima rule: parts separate where the cross-section pinches. Sweep
    all three axes; on the best one, keep prominent local minima (a neck must
    dip below 55% of the smaller neighboring bulge) spaced at least 8% of the
    span apart. Returns (axis, cut positions) — empty when the shape has no
    convincing necks (then it is honestly one piece)."""
    extents = solid.bounds[1] - solid.bounds[0]
    best: tuple[float, int, list[float]] = (0.0, int(np.argmax(extents)), [])
    for axis in range(3):
        span = float(extents[axis])
        if span < 20.0:
            continue
        xs, areas = _area_profile(solid, axis)
        peak = float(areas.max())
        if peak <= 0:
            continue
        candidates: list[tuple[float, float]] = []  # (depth score, position)
        minima: list[tuple[float, float, float]] = []  # (depth, position, area)
        # 1. deep local minima BETWEEN bulges (two orbs touching)
        for i in range(2, len(xs) - 2):
            if not (areas[i] <= areas[i - 1] and areas[i] <= areas[i + 1]):
                continue
            left_bulge = float(areas[:i].max())
            right_bulge = float(areas[i + 1 :].max())
            bulge = min(left_bulge, right_bulge)
            if bulge <= 0:
                continue
            ratio = float(areas[i]) / bulge
            if ratio < 0.55:
                minima.append((1.0 - ratio, float(xs[i]), float(areas[i])))
        # 2. bulge boundaries against the baseline (an orb on a plain shaft):
        #    cut where the profile crosses well above its typical level.
        baseline = float(np.median(areas[areas > 0])) if (areas > 0).any() else 0.0
        threshold = max(baseline * 1.6, baseline + 0.25 * (peak - baseline))
        boundary_cuts = 0
        if baseline > 0 and peak > threshold:
            above = areas > threshold
            for i in range(1, len(xs)):
                if above[i] != above[i - 1]:
                    depth = 1.0 - baseline / max(peak, 1e-9)
                    candidates.append((depth * 0.9, float((xs[i] + xs[i - 1]) / 2)))
                    boundary_cuts += 1
        # A flat shaft plateau is not a neck: when bulge boundaries already
        # partition the shape, keep only minima that dip meaningfully below
        # the baseline region OR sit well above it (true necks between bulges).
        for depth, pos, area in minima:
            if boundary_cuts > 0 and baseline > 0 and area <= baseline * 1.15:
                continue
            candidates.append((depth, pos))
        # merge near-duplicate necks: keep the deepest within 8% of the span
        candidates.sort(key=lambda c: c[1])
        merged: list[tuple[float, float]] = []
        for depth, pos in candidates:
            if merged and abs(pos - merged[-1][1]) < span * 0.08:
                if depth > merged[-1][0]:
                    merged[-1] = (depth, pos)
            else:
                merged.append((depth, pos))
        merged.sort(key=lambda c: c[0], reverse=True)
        kept = sorted(pos for _, pos in merged[:max_cuts])
        score = sum(d for d, _ in merged[:max_cuts])
        if score > best[0]:
            best = (score, axis, kept)
    return best[1], best[2]


def _solid_on_both_sides(solid: trimesh.Trimesh, pt: np.ndarray, axis: int, eps: float = 0.5) -> bool:
    """A joint/anchor point is only real if the solid crosses the cut plane
    there — 2D section polygons lie on messy meshes (unrecorded voids)."""
    lo = pt.copy(); lo[axis] -= eps
    hi = pt.copy(); hi[axis] += eps
    try:
        return bool(solid.contains(np.array([lo, hi])).all())
    except Exception:  # noqa: BLE001
        return False


def _crossing_spans(
    solid: trimesh.Trimesh, axis: int, plane: float, lines: int = 25, eps: float = 0.5
) -> list[tuple[float, float, float]]:
    """Material spans that CROSS the cut plane, as (width, u_mid, v) sorted
    widest-first. Ray-casts the two offset planes (plane ± eps) along u for a
    fan of v lines and intersects the solid intervals — immune to the phantom
    polygons that 2D sections produce on messy meshes. A connected solid
    always has at least one crossing span at any interior cut."""
    u, v = [a for a in range(3) if a != axis]
    lo, hi = solid.bounds
    spans: list[tuple[float, float, float]] = []
    for vv in np.linspace(lo[v], hi[v], lines + 2)[1:-1]:
        sides: list[list[tuple[float, float]]] = []
        for side in (-eps, eps):
            origin = np.zeros(3)
            origin[axis] = plane + side
            origin[u] = lo[u] - 1.0
            origin[v] = vv
            direction = np.zeros(3)
            direction[u] = 1.0
            try:
                locs = solid.ray.intersects_location(
                    ray_origins=[origin], ray_directions=[direction]
                )[0]
            except Exception:  # noqa: BLE001
                locs = np.zeros((0, 3))
            ts = np.unique(np.round(locs[:, u], 6)) if len(locs) else np.zeros(0)
            if len(ts) % 2:  # grazing hit broke entry/exit parity — skip line
                sides.append([])
                continue
            sides.append([(float(ts[j]), float(ts[j + 1])) for j in range(0, len(ts), 2)])
        for a0, a1 in sides[0]:
            for b0, b1 in sides[1]:
                s0, s1 = max(a0, b0), min(a1, b1)
                if s1 - s0 > 1.0:
                    spans.append((s1 - s0, (s0 + s1) / 2, float(vv)))
    spans.sort(key=lambda s: s[0], reverse=True)
    return spans


def _probed_face_size(solid: trimesh.Trimesh, anchor: np.ndarray, axis: int, cap: float = 3.0) -> float:
    """Largest probe grid (G3 samples corners at ±size/2) proven to sit in
    material on both sides of the plane; 0.6 = center-only probe."""
    uv = [a for a in range(3) if a != axis]
    off = np.zeros(3)
    off[axis] = 0.5
    for s in (min(cap, 3.0) / 2, 0.75, 0.375):
        if s < 0.35:
            continue
        corners = []
        for du in (-s, s):
            for dv in (-s, s):
                c = anchor.copy()
                c[uv[0]] += du
                c[uv[1]] += dv
                corners.append(c)
        arr = np.array(corners)
        try:
            if solid.contains(arr - off).all() and solid.contains(arr + off).all():
                return round(s * 2, 2)
        except Exception:  # noqa: BLE001, S110 — an unclassifiable grid tries the next, smaller size
            pass
    return 0.6


def _joint_need(thread: str, min_wall: float = JOINT_MIN_WALL_MM) -> float:
    """Ø of material a fastened joint needs around its axis: the widest feature
    any fastening rule cuts for this thread (an insert's boss, a counterbore, a
    nut's corners) plus a wall each side. The rules run on the server; this is
    their envelope, so no site the kernel offers is too narrow for one of them.
    The old floor was hole Ø + 2, which left 0.75mm walls around a peg socket."""
    threads = {k.upper(): k for k in _catalog_threads()}
    key = threads.get(thread.upper(), "M4")
    families = _catalog()["families"]

    def dims(family: str) -> dict[str, Any]:
        return families[family]["dims"].get(key, {})

    widest = max(
        dims("heatset_std").get("minBossOd", 0.0),
        dims("shcs").get("headD", 0.0) + 1.0,  # the counterbore, bindings.ts cboreD
        dims("hex_nut").get("af", 0.0) * 2 / math.sqrt(3),
        _catalog_clearance(key) + 1.0,
    )
    return round(widest + 2 * min_wall, 2)


def _rim(pt: np.ndarray, axis: int, radius: float, n: int = 8) -> np.ndarray:
    """pt and n points on a circle of `radius` around it, in the cut plane."""
    u, v = [a for a in range(3) if a != axis]
    pts = [pt.copy()]
    for k in range(n):
        q = pt.copy()
        q[u] += radius * math.cos(2 * math.pi * k / n)
        q[v] += radius * math.sin(2 * math.pi * k / n)
        pts.append(q)
    return np.array(pts)


def _disk_in_solid(solid: trimesh.Trimesh, pt: np.ndarray, axis: int, radius: float,
                   n: int = 8, eps: float = 0.5) -> bool:
    """A disk of material on both sides of the plane, not just a point."""
    pts = _rim(pt, axis, radius, n)
    off = np.zeros(3)
    off[axis] = eps
    try:
        return bool(solid.contains(pts - off).all() and solid.contains(pts + off).all())
    except Exception:  # noqa: BLE001
        return False


def _column_depth(solid: trimesh.Trimesh, pt: np.ndarray, axis: int, sign: float,
                  radius: float, limit: float) -> float:
    """How far material runs from the cut plane along sign·axis over a column
    of `radius` around pt: the shortest of the axis ray and its rim rays,
    capped at `limit` (the slab boundary — past it is another piece). This is
    a joint's wall: the head, nut or pocket floor sits inside it everywhere."""
    pts = _rim(pt, axis, radius)
    direction = np.zeros(3)
    direction[axis] = sign
    origins = pts + direction * 0.01
    try:
        locs, idx, _ = solid.ray.intersects_location(
            ray_origins=origins, ray_directions=np.repeat([direction], len(origins), axis=0)
        )
    except Exception:  # noqa: BLE001
        return 0.0
    depth = limit
    for k in range(len(origins)):
        ts = (locs[idx == k] - origins[k]) @ direction
        ts = ts[ts > 1e-6]
        if len(ts) == 0:
            return 0.0
        depth = min(depth, float(ts.min()) + 0.01)
    return max(0.0, depth)


def _joint_candidates(
    solid: trimesh.Trimesh,
    axis: int,
    spans: list[tuple[float, float, float]],
    to3: Any,
    need: float,
    walls: tuple[float, float],
    avoid: list[list[float]] = (),
) -> list[dict[str, Any]]:
    """Up to two joint sites on one cut, each a validated disk of Ø `need` with
    its column depth into each piece. Two only when the disk around their
    midpoint, out past both, is material too: the server makes the pair ONE
    joint with count 2 (one screw node, two placements), and that joint's face
    probe rings their midpoint. Sites too shallow for any rule (a wall under
    2·minWall either side) are dropped rather than offered, and so are sites
    whose column (a joint's bores and access run the full axis) passes within
    `need` of a feature already in the piece: `avoid`, from earlier joints."""
    keep_off = np.asarray(avoid, dtype=float).reshape(-1, 3)

    def clear_of_features(pt: np.ndarray) -> bool:
        off = keep_off - pt
        off[:, axis] = 0.0
        return bool((np.linalg.norm(off, axis=1) >= need).all())

    sites: list[tuple[np.ndarray, float]] = []
    for width, u_mid, v_val in spans:
        if width < need:
            continue
        slack = (width - need) / 2 - 0.5  # a disk exactly at the edge is not inside it
        for du in [0.0] if slack < need / 2 else [-slack, slack, 0.0]:
            cand = to3(u_mid + du, v_val)
            if any(np.linalg.norm(cand - s) < need for s, _ in sites) or not clear_of_features(cand):
                continue
            if _disk_in_solid(solid, cand, axis, need / 2):
                sites.append((cand, width))
        if len(sites) >= 8:
            break

    found: list[dict[str, Any]] = []
    for pt, width in sites:
        wall_a = _column_depth(solid, pt, axis, -1.0, need / 2, walls[0])
        wall_b = _column_depth(solid, pt, axis, 1.0, need / 2, walls[1])
        if min(wall_a, wall_b) < 2 * JOINT_MIN_WALL_MM:
            continue
        found.append({
            "center": [round(float(c), 3) for c in pt],
            "normal": [float(c) for c in np.eye(3)[axis]],
            "span": round(float(width), 2),
            # floored, never rounded up: a wall is a promise of material
            "wallA": math.floor(wall_a * 10) / 10,
            "wallB": math.floor(wall_b * 10) / 10,
            "face_size": need,
        })
    if not found:
        return []
    best, best_d = found[:1], 0.0
    for a, b in combinations(found, 2):
        pa, pb = np.asarray(a["center"]), np.asarray(b["center"])
        d = float(np.linalg.norm(pa - pb))
        if d > best_d and _disk_in_solid(solid, (pa + pb) / 2, axis, d / 2 + need / 2, n=16):
            best, best_d = [a, b], d
    return best


def segment(
    components: list[trimesh.Trimesh],
    pieces: int,
    joints: str,
    thread: str,
    avoid: list[list[float]] = (),
) -> tuple[list[trimesh.Trimesh], list[Interface]]:
    """Multi-body files: one piece per body (no cutting). Single solids with
    pieces > 1: equal slabs along the longest axis. Joints at each cut:
    "auto" (the default) = joint SITES only, `Interface.candidates`, nothing
    cut — the server's joint rules pick real hardware and the host features
    are cut at execute time (`cut_joints`); "holes" = thread-clearance
    through-holes for screws; "pegs" = an alignment peg grown on the low side
    + a CLEARANCE-FIT socket cut into the high side."""
    join_holes = joints in ("holes", "pegs")  # both modes need placement points
    if len(components) > 1 or pieces == 1:
        return components, []

    solid = components[0]
    bounds = solid.bounds
    extents = bounds[1] - bounds[0]

    if pieces == 0:  # auto: cut at the shape's natural necks
        axis, planes = find_natural_cuts(solid)
        if not planes:
            return components, []  # no convincing necks — honestly one piece
    else:
        axis = int(np.argmax(extents))
        lo0, hi0 = float(bounds[0][axis]), float(bounds[1][axis])
        step = (hi0 - lo0) / pieces
        planes = [lo0 + step * i for i in range(1, pieces)]

    lo, hi = float(bounds[0][axis]), float(bounds[1][axis])
    # The slab boundaries are what a joining hole has to reach, so they are
    # computed here rather than at the cut, and the cut reads them.
    boundaries = [lo - 1.0, *planes, hi + 1.0]

    # ISO 273 clearance from the same catalog the TS registry reads.
    hole_d = _catalog_clearance(thread)
    # What a feature needs around it: for holes/pegs the feature's own Ø plus a
    # minimum wall each side; for auto whatever the widest joint rule cuts.
    feature_d = PEG_D + PEG_CLEARANCE if joints == "pegs" else hole_d
    need = _joint_need(thread) if joints == "auto" else feature_d + 2 * JOINT_MIN_WALL_MM
    interfaces: list[Interface] = []
    hole_cutters: list[trimesh.Trimesh] = []

    for i, plane in enumerate(planes, start=1):
        # Placement never trusts 2D section polygons (they mis-nest on messy
        # meshes and claim material over voids). Everything — joints and the
        # mating-face anchor — comes from ray-cast crossing spans, each point
        # 3D-validated on the actual solid before it is declared.
        spans = _crossing_spans(solid, axis, plane)
        u, v = [a for a in range(3) if a != axis]

        def to3(u_val: float, v_val: float, _u: int = u, _v: int = v, _plane: float = plane) -> np.ndarray:
            pt = np.zeros(3)
            pt[axis] = _plane
            pt[_u] = u_val
            pt[_v] = v_val
            return pt

        hole_pts: list[np.ndarray] = []
        if join_holes:
            for width, u_mid, v_val in spans:
                if width < need:
                    continue
                # wide spans offer spread-out candidates (anti-rotation pairs)
                offsets = [0.0] if width < hole_d * 4 else [-width / 4, width / 4, 0.0]
                for du in offsets:
                    cand = to3(u_mid + du, v_val)
                    if any(np.linalg.norm(cand - hp) < hole_d * 2 for hp in hole_pts):
                        continue
                    if _solid_on_both_sides(solid, cand, axis, eps=1.5):
                        hole_pts.append(cand)
                    if len(hole_pts) == 2:
                        break
                if len(hole_pts) == 2:
                    break

        candidates: list[dict[str, Any]] = []
        if joints == "auto":
            candidates = _joint_candidates(
                solid, axis, spans, to3, need, (plane - boundaries[i - 1], boundaries[i + 1] - plane), avoid
            )
        # The anchor's face probe (≤ 3mm) stays clear of every feature's disk.
        keep_out = [(hp, hole_d / 2 + 3.0) for hp in hole_pts] + [
            (np.asarray(c["center"]), need / 2 + 1.6) for c in candidates
        ]

        anchor3: np.ndarray | None = None
        face_size = 0.6
        for width, u_mid, v_val in spans:
            cand = to3(u_mid, v_val)
            if any(np.linalg.norm(cand - pt) < r for pt, r in keep_out):
                continue
            if _solid_on_both_sides(solid, cand, axis):
                anchor3 = cand
                face_size = _probed_face_size(solid, cand, axis, cap=width - 0.4)
                break
        if anchor3 is None:
            # no verifiable crossing found — bbox centre; G3 reports honestly
            anchor3 = (bounds[0] + bounds[1]) / 2
            anchor3[axis] = plane

        holes: list[dict[str, Any]] = []
        pegs: list[dict[str, Any]] = []
        for hp in hole_pts:
            hp[axis] = plane
            if joints == "holes":
                holes.append({"center": [round(float(c), 3) for c in hp], "diameter": hole_d})
                # SPANS THE TWO SLABS THIS PLANE DIVIDES, and nothing else.
                # A screw needs to cross both pieces it joins, so the reach is
                # each neighbour's own length, not a constant and not the whole
                # model. A fixed 40mm cutter left a BLIND hole in any piece
                # thicker than 20mm; a whole-model cutter is centred on the
                # plane, so it reaches L/2 each way and goes blind again for any
                # cut more than a hair off centre, which is exactly what the
                # natural-neck path produces. It also over-drilled: on a 3-way
                # split its far end bored 21mm into a piece that does not touch
                # this interface at all.
                back = plane - boundaries[i - 1]
                fwd = boundaries[i + 1] - plane
                cyl = trimesh.creation.cylinder(radius=hole_d / 2, height=back + fwd)
                align = trimesh.geometry.align_vectors([0, 0, 1], np.eye(3)[axis])
                cyl.apply_transform(align)
                centre = hp.copy()
                centre[axis] = plane + (fwd - back) / 2
                cyl.apply_translation(centre)
                hole_cutters.append(cyl)
            elif joints == "pegs":
                pegs.append({
                    "center": [round(float(c), 3) for c in hp],
                    "peg_diameter": PEG_D,
                    "socket_diameter": round(PEG_D + PEG_CLEARANCE, 3),
                    "length": PEG_LEN,
                })

        interfaces.append(
            Interface(
                piece_a=i - 1,
                piece_b=i,
                origin=[round(float(c), 3) for c in anchor3],
                normal=[float(v) for v in np.eye(3)[axis]],
                holes=holes,
                pegs=pegs,
                face_size=round(float(face_size), 2),
                candidates=candidates,
            )
        )

    drilled = solid
    for cutter in hole_cutters:
        drilled = _boolean(drilled, "difference", cutter)

    result: list[trimesh.Trimesh] = []
    for i in range(len(boundaries) - 1):
        slab = _slab(bounds, axis, boundaries[i], boundaries[i + 1])
        piece = _boolean(drilled, "intersection", slab)
        if len(piece.faces) == 0:
            raise ValueError(f"cut produced an empty piece at slab {i} — try fewer pieces")
        result.append(piece)

    if joints == "pegs":
        align = trimesh.geometry.align_vectors([0, 0, 1], np.eye(3)[axis])
        for itf in interfaces:
            for peg in itf.pegs:
                center = np.asarray(peg["center"], dtype=float)
                # peg: Ø PEG_D spanning ±PEG_LEN across the plane — the minus
                # half anchors inside piece_a, the plus half protrudes into B's space
                peg_cyl = trimesh.creation.cylinder(radius=peg["peg_diameter"] / 2, height=2 * PEG_LEN)
                peg_cyl.apply_transform(align)
                peg_cyl.apply_translation(center)
                result[itf.piece_a] = _boolean(result[itf.piece_a], "union", peg_cyl)
                # socket: clearance-fit Ø, slightly deeper than the peg protrudes
                sock = trimesh.creation.cylinder(radius=peg["socket_diameter"] / 2, height=2 * (PEG_LEN + 0.8))
                sock.apply_transform(align)
                sock.apply_translation(center)
                result[itf.piece_b] = _boolean(result[itf.piece_b], "difference", sock)

    return result, interfaces


def run_import(job: dict[str, Any]) -> dict[str, Any]:
    """Worker entrypoint: decode, segment, write piece STLs + GLBs, report."""
    data = base64.b64decode(job["data_b64"])
    components = load_mesh_file(job["filename"], data)
    joints = str(job.get("joints") or "auto")
    pieces, interfaces = segment(
        components,
        pieces=int(job.get("pieces", 1)),
        joints=joints,
        thread=str(job.get("thread", "M4")),
        avoid=job.get("avoid") or [],
    )

    out_dir = job["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    report = []
    for i, mesh in enumerate(pieces):
        if len(mesh.faces) > TESSELLATION_LIMIT:
            mesh = mesh.simplify_quadric_decimation(face_count=TESSELLATION_LIMIT)
        # PLY, not STL: STL is a triangle soup — the reload re-merges vertices
        # and complex organic meshes come back non-watertight, failing G2.
        # Binary PLY round-trips the exact vertex/face arrays.
        mesh.export(os.path.join(out_dir, f"piece-{i}.ply"))
        part = MeshPart(mesh)
        part.export_glb(os.path.join(out_dir, f"piece-{i}.glb"))
        b = mesh.bounds
        report.append(
            {
                "index": i,
                "file": f"piece-{i}.ply",
                "volume_mm3": round(float(mesh.volume), 1),
                "watertight": bool(mesh.is_watertight),
                "bbox": {
                    "min": [round(float(v), 2) for v in b[0]],
                    "max": [round(float(v), 2) for v in b[1]],
                },
                "faces": len(mesh.faces),
            }
        )
    return {
        "ok": True,
        "pieces": report,
        "interfaces": [
            {
                "piece_a": itf.piece_a,
                "piece_b": itf.piece_b,
                "origin": itf.origin,
                "normal": itf.normal,
                "holes": itf.holes,
                "pegs": itf.pegs,
                "face_size": itf.face_size,
                "candidates": itf.candidates,
            }
            for itf in interfaces
        ],
    }


# --- generated meshes (Phase 6.4) -------------------------------------------

# How deep a mating face may be cut into a generated mesh to leave a flat of
# the declared size: an organic extreme is a dome, and its first millimetre
# is a pinhead.
FLAT_CUT_STEPS_MM = (1.0, 2.0, 4.0, 8.0)

# Y-up (glTF) → Z-up: +90° about X. glTF's front (+Z) lands on -Y, which is
# where our "front" view camera stands.
_Y_UP_TO_Z_UP = trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0])


def _flat_width(mesh: trimesh.Trimesh, origin: np.ndarray, normal: np.ndarray) -> float:
    """Narrowest in-plane extent of the section through `origin`, 0 for none."""
    section = mesh.section(plane_origin=origin, plane_normal=normal)
    if section is None:
        return 0.0
    planar, _ = section.to_2D()
    lo, hi = planar.bounds
    return float(min(hi - lo))


def run_mesh_fit(job: dict[str, Any]) -> dict[str, Any]:
    """A generator's GLB → one printable piece in the node's own frame.

    Rotates glTF Y-up to Z-up, keeps the substantial shells, repairs what
    trimesh can (weld, fill holes, fix winding), scales uniformly to fit the
    contract's envelope box and centres it there. Each axis-aligned FLAT_FACE
    port then gets a real flat: the mesh is pushed past the port plane by the
    shallowest step that leaves a section of the declared size, and everything
    in front of the plane is cut away. Writes `mesh.ply` + `mesh.glb`."""
    data = base64.b64decode(job["data_b64"])
    loaded = trimesh.load(io.BytesIO(data), file_type="glb", force="scene")
    mesh = loaded.dump(concatenate=True) if isinstance(loaded, trimesh.Scene) else loaded
    if job.get("up", "y") == "y":
        mesh.apply_transform(_Y_UP_TO_Z_UP)

    # Generators leave floating crumbs and inner shells; a crumb is a separate
    # body the slicer prints as debris.
    mesh.merge_vertices()
    shells = mesh.split(only_watertight=False)
    if len(shells) > 1:
        biggest = max(len(s.faces) for s in shells)
        mesh = trimesh.util.concatenate([s for s in shells if len(s.faces) >= 0.05 * biggest])
    trimesh.repair.fill_holes(mesh)
    trimesh.repair.fix_normals(mesh)

    center = np.asarray(job["box"]["center"], dtype=float)
    dims = np.asarray(job["box"]["dims"], dtype=float)
    extent = mesh.extents
    scale = float(np.min(dims / np.maximum(extent, 1e-9)))
    mesh.apply_scale(scale)
    mesh.apply_translation(center - mesh.bounds.mean(axis=0))

    notes: list[str] = []
    # Every flat's push is measured on the fitted mesh first, the mesh moves
    # ONCE, and only then is anything cut. Pushing and cutting flat by flat let
    # the second flat of an opposite pair drag the first cut off its plane: a
    # sphere with flats at z=±10 came out with its top at z=8. Two flats facing
    # apart on one axis cannot both be reached by a shift, so that axis is
    # stretched instead, each extreme landing its own depth past its plane.
    cuts: list[tuple[dict[str, Any], np.ndarray, int, float]] = []
    targets: dict[int, dict[float, float]] = {}
    for flat in job.get("flats") or []:
        origin = np.asarray(flat["origin"], dtype=float)
        normal = np.asarray(flat["normal"], dtype=float)
        normal /= np.linalg.norm(normal)
        axis = int(np.argmax(np.abs(normal)))
        if abs(normal[axis]) < 0.99:
            notes.append(f"flat {flat.get('name', '?')} is not axis-aligned; left uncut")
            continue
        sign = float(np.sign(normal[axis]))
        size = float(flat.get("size", 0.0))
        # How far the mesh's extreme on that side must pass the plane, shallowest first.
        extreme = mesh.bounds[1 if sign > 0 else 0][axis]
        depth = FLAT_CUT_STEPS_MM[-1]
        for step in FLAT_CUT_STEPS_MM:
            probe = origin.copy()
            probe[axis] = extreme - sign * step
            if _flat_width(mesh, probe, normal) >= size:
                depth = step
                break
        targets.setdefault(axis, {})[sign] = origin[axis] + sign * depth
        cuts.append((flat, origin, axis, sign))
    move = np.eye(4)
    for axis, ends in targets.items():
        lo, hi = mesh.bounds[0][axis], mesh.bounds[1][axis]
        if len(ends) == 2:
            k = (ends[1.0] - ends[-1.0]) / max(hi - lo, 1e-9)
            move[axis, axis], move[axis, 3] = k, ends[-1.0] - k * lo
        else:
            (sign, end), = ends.items()
            move[axis, 3] = end - (hi if sign > 0 else lo)
    mesh.apply_transform(move)
    for flat, origin, axis, sign in cuts:
        bounds = mesh.bounds.copy()
        bounds[0] -= 1.0
        bounds[1] += 1.0
        # Keep everything behind the face: the half-space on -normal.
        if sign > 0:
            bounds[1][axis] = origin[axis]
        else:
            bounds[0][axis] = origin[axis]
        try:
            mesh = _boolean(mesh, "intersection", trimesh.creation.box(bounds=bounds))
        except Exception as e:  # noqa: BLE001 — a non-volume mesh cannot be cut
            notes.append(f"flat {flat.get('name', '?')} not cut: {e}")

    if len(mesh.faces) > TESSELLATION_LIMIT:
        mesh = mesh.simplify_quadric_decimation(face_count=TESSELLATION_LIMIT)
    out_dir = job["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    mesh.export(os.path.join(out_dir, "mesh.ply"))
    MeshPart(mesh).export_glb(os.path.join(out_dir, "mesh.glb"))
    b = mesh.bounds
    return {
        "ok": True,
        "file": "mesh.ply",
        "scale": scale,
        "watertight": bool(mesh.is_watertight),
        "volume_mm3": round(float(mesh.volume), 1) if mesh.is_watertight else None,
        "bbox": {"min": [round(float(v), 2) for v in b[0]], "max": [round(float(v), 2) for v in b[1]]},
        "faces": len(mesh.faces),
        "notes": notes,
    }


@cache
def _catalog() -> dict[str, Any]:
    """packages/backend-cad/catalog/hardware.json — plain JSON so this side
    reads the numbers the TS registry builds from instead of mirroring them."""
    path = Path(__file__).resolve().parents[3] / "catalog" / "hardware.json"
    return json.loads(path.read_text("utf8"))


def _catalog_threads() -> dict[str, Any]:
    return _catalog()["threads"]


def _catalog_clearance(thread: str) -> float:
    """ISO 273 medium clearance Ø for a thread; M4's when the thread is unknown."""
    threads = {k.upper(): v for k, v in _catalog_threads().items()}
    return float(threads.get(thread.upper(), threads["M4"])["clearance"])


def load_import_part(import_dir: str, name: str, scale: float = 1.0) -> MeshPart:
    """`load_import("piece-0.ply", scale=p.scale)` inside node code — the
    build(p) body for imported pieces. Scale is the T0 dimension surface."""
    safe = os.path.basename(name)
    path = os.path.join(import_dir, safe)
    # trimesh says ValueError("string is not a file"); registry code falls back
    # from a missing vendor STEP to the parametric model on FileNotFoundError only.
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    # process=False: the stored PLY is manifold-clean; trimesh's default vertex
    # merging fuses near-duplicates on dense organic meshes and breaks
    # watertightness (real 300k-face STL regression).
    mesh = trimesh.load(path, force="mesh", process=False)
    if scale and float(scale) != 1.0:
        mesh = mesh.copy()
        mesh.apply_scale(float(scale))
    return MeshPart(mesh)


def _port_matrix(o: list[float], z: list[float], x: list[float]) -> np.ndarray:
    """A port frame as a 4x4: x, y = z × x, z columns, origin o."""
    zu = np.asarray(z, dtype=float)
    zu /= np.linalg.norm(zu)
    xu = np.asarray(x, dtype=float)
    xu = xu - xu.dot(zu) * zu
    xu /= np.linalg.norm(xu)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = xu, np.cross(zu, xu), zu, o
    return m


def _prism(d: float, z0: float, z1: float, frame: np.ndarray, hexagon: bool = False) -> trimesh.Trimesh:
    """A Ø d cylinder (hexagon: d across the flats, a corner on +x) from z0 to
    z1 along the frame's z."""
    radius = d / math.sqrt(3) if hexagon else d / 2
    body = trimesh.creation.cylinder(radius=radius, height=z1 - z0, sections=6 if hexagon else 48)
    body.apply_translation([0.0, 0.0, (z0 + z1) / 2])
    body.apply_transform(frame)
    return body


def cut_joints(part: MeshPart, cuts: list[dict[str, Any]]) -> MeshPart:
    """Host features for joint hardware, cut into an imported piece at execute
    time from its own port params (registry.ts importedNodeCode writes the
    list, zero LLM). Each cut sits in a port frame {o, z, x}, +z out of the
    part:
      kind "round" | "hex": a Ø d bore (hex: d across the flats, a corner on
        x) `depth` into the part, or through it when depth is None;
      through: a Ø bore on from the origin through the part (the clearance
        under a counterbore);
      access: a Ø column from the origin OUT of the part. A head or a nut has
        to get in, and the port plane sits at the joint's shallowest wall, so
        an organic surface is usually above it somewhere;
      kind "peg": a Ø d peg grown `depth` out of the face, fused 1mm in.
    Manifold booleans, like every MeshPart edit."""
    mesh = part.mesh
    reach = float(np.linalg.norm(mesh.extents)) + 10.0
    cutters: list[trimesh.Trimesh] = []
    grown: list[trimesh.Trimesh] = []
    for c in cuts:
        frame = _port_matrix(c["o"], c["z"], c["x"])
        d = float(c["d"])
        if c["kind"] == "peg":
            grown.append(_prism(d, -1.0, float(c["depth"]), frame))
            continue
        depth = reach if c.get("depth") is None else float(c["depth"])
        cutters.append(_prism(d, -depth, 0.5, frame, hexagon=c["kind"] == "hex"))
        if c.get("through"):
            cutters.append(_prism(float(c["through"]), -reach, 0.0, frame))
        if c.get("access"):
            cutters.append(_prism(float(c["access"]), 0.0, reach, frame))
    for peg in grown:
        mesh = _boolean(mesh, "union", peg)
    if cutters:
        mesh = _boolean(mesh, "difference", trimesh.boolean.union(cutters, engine="manifold") if len(cutters) > 1 else cutters[0])
    return MeshPart(mesh)
