"""Report-only DfAM measurements attached to every cooked part.

Adapted from CADClamp (github.com/ChristianNHill/cadclamp, Apache-2.0) —
the author's own DfM benchmark engine: min-wall via ray chords along
inverted normals (p2 statistic), area-weighted overhang bands (angle from
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
THIN_PERCENTILE = 2.0
OVERHANG_WARN_DEG = 45.0
OVERHANG_FAIL_DEG = 60.0
LAYER_MM = 0.2
WARN_WEIGHT = 0.35


def two_tier_index(measured: float, feasible: float, recommended: float) -> float:
    center = (feasible + recommended) / 2.0
    scale = (recommended - feasible) / 4.0
    z = max(-60.0, min(60.0, (measured - center) / scale))
    return 1.0 / (1.0 + math.exp(-z))


def measure_printability(shape: Any) -> dict[str, Any]:
    mesh = to_trimesh(shape, 0.2)
    out: dict[str, Any] = {}

    # min wall: ray chords along inverted surface normals, robust percentile
    try:
        points, face_index = trimesh.sample.sample_surface(mesh, WALL_SAMPLES, seed=0)
        normals = mesh.face_normals[face_index]
        thickness = trimesh.proximity.thickness(mesh, points, normals=normals, method="ray")
        finite = np.asarray(thickness)[np.isfinite(thickness)]
        if len(finite) > 0:
            thin = float(np.percentile(finite, THIN_PERCENTILE))
            recommended = 2.0 * LINE_WIDTH_MM
            feasible = 1.125 * LINE_WIDTH_MM
            out["min_wall"] = {
                "thin_wall_p2_mm": round(thin, 3),
                "index": round(two_tier_index(thin, feasible, recommended), 3),
                "recommended_mm": recommended,
            }
    except Exception:  # noqa: BLE001 — advisory only, never block a cook
        pass

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
    except Exception:  # noqa: BLE001
        pass

    indices = [v["index"] for v in out.values() if isinstance(v, dict) and "index" in v]
    if indices:
        out["composite"] = round(float(np.prod(indices) ** (1.0 / len(indices))), 3)
    return out
