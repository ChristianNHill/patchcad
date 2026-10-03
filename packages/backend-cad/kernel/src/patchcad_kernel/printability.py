"""Report-only DfAM measurements attached to every cooked part.

Adapted from CADClamp (github.com/ChristianNHill/cadclamp, Apache-2.0) —
the author's own DfM benchmark engine: min-wall via ray chords along
inverted normals (a guarded minimum, see thin_wall_mm), area-weighted overhang bands (angle from
vertical, build +Z, first-layer band excluded), and the two-tier Fudos
logistic index. Here they are advisory (shown in the inspector), not gates —
PatchCAD is an editor, not a benchmark; the numbers tell the user what will
and won't print before the slicer does.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import trimesh

from .meshpart import to_trimesh

LINE_WIDTH_MM = 0.4
WALL_SAMPLES = 400
WALL_TRIANGLE_SAMPLES = 200
WALL_OUTLIERS = 2
OVERHANG_WARN_DEG = 45.0
OVERHANG_FAIL_DEG = 60.0
LAYER_MM = 0.2
WARN_WEIGHT = 0.35


def two_tier_index(measured: float, feasible: float, recommended: float) -> float:
    center = (feasible + recommended) / 2.0
    scale = (recommended - feasible) / 4.0
    z = max(-60.0, min(60.0, (measured - center) / scale))
    return 1.0 / (1.0 + math.exp(-z))


def thin_wall_mm(mesh: trimesh.Trimesh) -> float | None:
    """The guarded min of wall_chords: the measure G4b, G4c and the advisory share."""
    return wall_chords(mesh)[0]


def wall_chords(mesh: trimesh.Trimesh) -> tuple[float | None, float | None]:
    """(min wall, thinnest edge sliver): ray chords along inverted surface
    normals. Shared with the G4b `min_wall` assertion and the G4c additive
    rule, so advisory and gate agree.

    The MINIMUM, past the WALL_OUTLIERS thinnest chords. It was the 2nd
    percentile, which let any thin wall covering under 2% of the surface pass a
    gate stated as a minimum. Dropping two chords is the outlier guard: a stray
    ray at an edge cannot set the verdict, a real wall gives several. Area
    samples alone never land on a small fin (a 0.5mm fin on a 100mm block got
    none of 400), so one point per triangle is added, up to
    WALL_TRIANGLE_SAMPLES of them: a feature has its own triangles at any size.

    A chord within a nozzle width of an ACUTE edge is a sliver, not a wall: a
    76 deg dovetail edge and a feathered thread runout read 0.01-0.28mm however
    thick the part is, and a slicer simply drops what is under one line there.
    Those samples are left out of the minimum and their thinnest chord comes
    back second, for a finding. Only a LOCAL sliver is excused: the surface
    SLIVER_SPAN_MM further from that edge is measured too, and if it is still
    under SLIVER_WALL_MM the thin region runs along the part, a rib, and the
    sample counts. A pen cup with 0.25mm ribs read 0.450 and passed without
    this, every rib sample sitting near some edge of its cell."""
    points, face_index = trimesh.sample.sample_surface(mesh, WALL_SAMPLES, seed=0)
    tris = np.arange(len(mesh.faces))
    if len(tris) > WALL_TRIANGLE_SAMPLES:
        tris = np.random.default_rng(0).choice(tris, WALL_TRIANGLE_SAMPLES, replace=False)
    points = np.vstack([points, mesh.triangles_center[tris]])
    face_index = np.concatenate([face_index, tris])
    thickness = np.asarray(trimesh.proximity.thickness(mesh, points, normals=mesh.face_normals[face_index], method="ray"))
    sliver = _local_slivers(mesh, points, face_index)
    walls = np.sort(thickness[np.isfinite(thickness) & ~sliver])
    slivers = thickness[np.isfinite(thickness) & sliver]
    return (float(walls[min(WALL_OUTLIERS, len(walls) - 1)]) if len(walls) > 0 else None,
            float(slivers.min()) if len(slivers) > 0 else None)


SLIVER_EDGE_DEG = 100.0  # interior angle under which an edge makes slivers
SLIVER_REACH_MM = LINE_WIDTH_MM + 0.1  # a nozzle width, plus half the 0.2mm tessellation's deviation
SLIVER_SPAN_MM = 1.5  # how far from the edge a sliver must have ended
SLIVER_WALL_MM = 0.45  # dfm_process.FDM_MIN_WALL_MM: thinner than one perimeter


def _local_slivers(mesh: trimesh.Trimesh, points: np.ndarray, face_index: np.ndarray) -> np.ndarray:
    """Which points lie within SLIVER_REACH_MM of a convex edge whose interior
    angle is under SLIVER_EDGE_DEG, AND whose surface SLIVER_SPAN_MM further
    from that edge, across the point's own face, is no longer under
    SLIVER_WALL_MM. A 76 deg dovetail edge is 6mm thick 1.5mm in; a 0.3mm fin
    or a 0.25mm rib is still 0.3 and 0.25 there, so neither is excused."""
    out = np.zeros(len(points), dtype=bool)
    if len(mesh.face_adjacency) == 0:
        return out
    interior = np.pi - mesh.face_adjacency_angles
    acute = mesh.face_adjacency_convex & (interior < np.radians(SLIVER_EDGE_DEG))
    if not acute.any():
        return out
    a, b = (mesh.vertices[mesh.face_adjacency_edges[acute][:, i]] for i in (0, 1))
    ab = b - a
    nearest = np.zeros((len(points), 3))
    along = np.zeros((len(points), 3))
    for i in range(0, len(points), 64):  # point x edge distances, in blocks
        p = points[i:i + 64, None, :]
        t = np.clip(((p - a) * ab).sum(-1) / np.maximum((ab * ab).sum(-1), 1e-12), 0.0, 1.0)
        foot = a + t[..., None] * ab
        d = np.linalg.norm(p - foot, axis=-1)
        j = d.argmin(axis=1)
        rows = np.arange(len(j))
        out[i:i + 64] = d[rows, j] <= SLIVER_REACH_MM
        nearest[i:i + 64] = foot[rows, j]
        along[i:i + 64] = ab[j]
    near = np.where(out)[0]
    if len(near) == 0:
        return out
    # Away from the edge across the point's own face: normal x edge, turned
    # toward the point (toward its triangle's centre when it sits on the edge).
    normals = mesh.face_normals[face_index[near]]
    away = np.cross(normals, along[near])
    away /= np.maximum(np.linalg.norm(away, axis=1, keepdims=True), 1e-12)
    side = points[near] - nearest[near]
    side = np.where((np.linalg.norm(side, axis=1) > 1e-6)[:, None], side,
                    mesh.triangles_center[face_index[near]] - nearest[near])
    away *= np.where((away * side).sum(1) < 0, -1.0, 1.0)[:, None]
    # The surface nearest that far point, wherever it is: a face narrower than
    # the span (a 0.3mm pin left between overlapping cutouts) lands on the
    # feature's other faces, which are just as thin.
    probe, _, tri = trimesh.proximity.closest_point(mesh, nearest[near] + away * SLIVER_SPAN_MM)
    span = np.asarray(trimesh.proximity.thickness(mesh, probe, normals=mesh.face_normals[tri], method="ray"))
    runs_on = np.isfinite(span) & (span < SLIVER_WALL_MM)
    out[near[runs_on]] = False
    return out


def measure_printability(shape: Any) -> dict[str, Any]:
    mesh = to_trimesh(shape, 0.2)
    out: dict[str, Any] = {}

    try:
        thin = thin_wall_mm(mesh)
        if thin is not None:
            recommended = 2.0 * LINE_WIDTH_MM
            feasible = 1.125 * LINE_WIDTH_MM
            out["min_wall"] = {
                "thin_wall_p2_mm": round(thin, 3),  # the studio reads this name; the value is the guarded min
                "index": round(two_tier_index(thin, feasible, recommended), 3),
                "recommended_mm": recommended,
            }
    except Exception as err:  # noqa: BLE001 — advisory only, never block a cook, but say it did not run
        out.setdefault("errors", []).append(f"min_wall: {type(err).__name__}: {err}")

    # overhang: area-weighted bands, angle from vertical, build +Z
    try:
        normals = mesh.face_normals
        theta = np.degrees(np.arcsin(np.clip(-normals[:, 2], 0.0, 1.0)))
        areas = mesh.area_faces
        z_min = float(mesh.bounds[0][2])
        relevant = mesh.triangles_center[:, 2] > (z_min + LAYER_MM)
        total = float(areas.sum())
        warn = float(areas[relevant & (theta > OVERHANG_WARN_DEG) & (theta <= OVERHANG_FAIL_DEG)].sum() / total) if total else 0.0
        fail = float(areas[relevant & (theta > OVERHANG_FAIL_DEG)].sum() / total) if total else 0.0
        out["overhang"] = {
            "warn_area_fraction": round(warn, 4),
            "fail_area_fraction": round(fail, 4),
            "index": round(max(0.0, 1.0 - WARN_WEIGHT * warn - fail), 3),
        }
    except Exception as err:  # noqa: BLE001
        out.setdefault("errors", []).append(f"overhang: {type(err).__name__}: {err}")

    indices = [v["index"] for v in out.values() if isinstance(v, dict) and "index" in v]
    if indices:
        out["composite"] = round(float(np.prod(indices) ** (1.0 / len(indices))), 3)
    return out
