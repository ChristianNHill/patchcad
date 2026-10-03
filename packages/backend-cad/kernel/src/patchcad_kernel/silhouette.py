"""G6 silhouette: the posed assembly against a reference image's mask (Phase 6.5).

Each labelled view is an orthographic projection along the render sheet's own
view direction (render.VIEWS: front looks from -y with +x right, side is the
sheet's "right" view from +x, back from +y, top from +z with +y up). The
projection is then normalized exactly like the reference mask (image_prep:
crop to the subject's bbox, centre in a square with a margin), so IoU measures
SHAPE, not where the camera stood or how big the photo was.

Advisory: there is no calibration data yet for what IoU a correct part
reaches from a hand-held photo, so the caller reports, it does not block.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .image_prep import MARGIN, MASK_SIZE, decode_mask, iou, png_b64
from .render import VIEWS, _basis, _mesh_arrays, _rasterize, transform

#: Reference view label → render.VIEWS name.
VIEW_ALIASES = {"front": "front", "side": "right", "right": "right", "back": "back", "top": "top"}


def _view(label: str) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    # Unknown labels are refused: falling back to "front" scored a "left"
    # reference against the front projection and blamed parts for the mismatch.
    if label not in VIEW_ALIASES:
        raise ValueError(f"unknown reference view {label!r}; one of {', '.join(VIEW_ALIASES)}")
    name = VIEW_ALIASES[label]
    for n, eye, up in VIEWS:
        if n == name:
            return eye, up
    raise KeyError(label)


def project_masks(parts: list[tuple[str, np.ndarray, np.ndarray]], label: str,
                  size: int = MASK_SIZE) -> list[tuple[str, np.ndarray]]:
    """Per-part silhouettes in ONE shared normalized frame: the union's bbox is
    what gets centred and scaled, so parts keep their relative placement."""
    eye, up = _view(label)
    cam = _basis(eye, up)
    projected = [(key, (v @ cam.T)[:, :2], t) for key, v, t in parts if len(v)]
    if not projected:
        return []
    allp = np.vstack([p for _, p, _ in projected])
    lo, hi = allp.min(axis=0), allp.max(axis=0)
    side = max(float((hi - lo).max()), 1e-9) / (1 - 2 * MARGIN)
    scale = size / side
    centre = (lo + hi) / 2
    out = []
    for key, p, t in projected:
        sx = (p[:, 0] - centre[0]) * scale + size / 2
        sy = size / 2 - (p[:, 1] - centre[1]) * scale
        # Every triangle, both windings: a silhouette is coverage, not shading.
        _, ids = _rasterize(sx, sy, np.zeros(len(p)), t, np.arange(len(t)), size)
        out.append((key, ids >= 0))
    return out


def attribute(masks: list[tuple[str, np.ndarray]], ref: np.ndarray) -> list[dict[str, Any]]:
    """Which parts make the shapes disagree. A part owns the pixels it covers
    that the reference does not (excess), plus the reference pixels nobody
    covers that lie nearer its centroid than any other part's (missing). A
    heuristic: good enough to point at the tail, not a proof it is the tail."""
    union = np.zeros_like(ref)
    for _, m in masks:
        union |= m
    missing = ref & ~union
    my, mx = np.nonzero(missing)
    cents = [np.array(np.nonzero(m)).mean(axis=1) if m.any() else np.array([np.inf, np.inf]) for _, m in masks]
    owner = (np.argmin(np.stack([(my - c[0]) ** 2 + (mx - c[1]) ** 2 for c in cents]), axis=0)
             if len(my) and cents else np.zeros(0, dtype=int))
    rows = []
    for i, (key, m) in enumerate(masks):
        rows.append({
            "key": key,
            "area_px": int(m.sum()),
            "excess_px": int((m & ~ref).sum()),
            "missing_px": int((owner == i).sum()),
        })
    rows.sort(key=lambda r: r["excess_px"] + r["missing_px"], reverse=True)
    return rows


def silhouette_report(posed: list[tuple[str, Any, list[float]]], views: list[dict[str, Any]]) -> dict[str, Any]:
    """posed: (key, shape, column-major matrix). views: {view, mask_b64}."""
    parts = []
    for key, shape, matrix in posed:
        v, t = _mesh_arrays(shape)
        parts.append((key, transform(v, matrix), t))
    out = []
    for spec in views:
        ref = decode_mask(spec["mask_b64"])
        masks = project_masks(parts, spec.get("view") or "front", ref.shape[0])
        union = np.zeros_like(ref)
        for _, m in masks:
            union |= m
        out.append({
            "view": spec.get("view") or "front",
            "ref": spec.get("ref", ""),
            "iou": round(iou(union, ref), 4),
            "parts": attribute(masks, ref),
            "mask_b64": png_b64(union),
        })
    return {"views": out}
