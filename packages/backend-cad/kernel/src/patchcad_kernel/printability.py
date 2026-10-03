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
    """Min wall: ray chords along inverted surface normals. Shared with the G4b
    `min_wall` assertion and the G4c additive rule, so advisory and gate agree.

    The MINIMUM, past the WALL_OUTLIERS thinnest chords. It was the 2nd
    percentile, which let any thin wall covering under 2% of the surface pass a
    gate stated as a minimum. Dropping two chords is the outlier guard: a stray
    ray at an edge cannot set the verdict, a real wall gives several. Area
    samples alone never land on a small fin (a 0.5mm fin on a 100mm block got
    none of 400), so one point per triangle is added, up to
    WALL_TRIANGLE_SAMPLES of them: a feature has its own triangles at any size."""
    points, face_index = trimesh.sample.sample_surface(mesh, WALL_SAMPLES, seed=0)
    tris = np.arange(len(mesh.faces))
    if len(tris) > WALL_TRIANGLE_SAMPLES:
        tris = np.random.default_rng(0).choice(tris, WALL_TRIANGLE_SAMPLES, replace=False)
    points = np.vstack([points, mesh.triangles_center[tris]])
    face_index = np.concatenate([face_index, tris])
    thickness = trimesh.proximity.thickness(mesh, points, normals=mesh.face_normals[face_index], method="ray")
    finite = np.sort(np.asarray(thickness)[np.isfinite(thickness)])
    return float(finite[min(WALL_OUTLIERS, len(finite) - 1)]) if len(finite) > 0 else None


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
