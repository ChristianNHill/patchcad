"""Reference images in, normalized subject + silhouette out (Phase 6.2).

The architect reads the prepped picture, and G6 compares the posed assembly's
silhouette against the mask. Both sides go through `normalize_mask` so the
comparison is scale- and offset-free: the subject's bounding box is centred in
a square and scaled to fill it, which is exactly what an orthographic render of
the assembly is put through before the two masks meet.

Deterministic for a given image and method. `auto` picks by backdrop: on a
plain one (the border is one flat colour) a threshold on distance from that
colour is exact, and rembg is not — u2net's soft edge cost a 5mm-thick
L-bracket render 0.16 IoU against ground truth (0.84 vs 0.95). Anything else
goes to rembg (u2net on CPU), falling back to the threshold if rembg cannot
load. `method` in the result says which one ran.
"""

from __future__ import annotations

import base64
import io
from typing import Any

import numpy as np
from PIL import Image

#: Side of the square silhouette both masks are compared at.
MASK_SIZE = 256
#: Long side of the prepped picture the architect sees.
PREP_SIZE = 768
#: Empty border around the subject, as a fraction of the square's side.
MARGIN = 0.04

_session = None


def _rembg_mask(img: Image.Image) -> np.ndarray:
    global _session
    from rembg import new_session, remove

    if _session is None:
        _session = new_session("u2net")
    return np.asarray(remove(img, session=_session, only_mask=True)) > 127


#: Per-channel std of the border pixels below which the backdrop counts as plain.
PLAIN_BORDER_STD = 6.0


def _border(a: np.ndarray) -> np.ndarray:
    return np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])


def plain_backdrop(img: Image.Image) -> bool:
    return bool(_border(np.asarray(img.convert("RGB"), dtype=np.float64)).std(axis=0).max() < PLAIN_BORDER_STD)


def threshold_mask(img: Image.Image) -> np.ndarray:
    """Fallback: pixels far from the border colour, largest connected blob kept.
    Works for a product shot on a plain backdrop and nothing much else."""
    from scipy import ndimage

    a = np.asarray(img.convert("RGB"), dtype=np.float64)
    bg = np.median(_border(a), axis=0)
    fg = np.linalg.norm(a - bg, axis=2) > 40.0
    labels, n = ndimage.label(fg)
    if n == 0:
        return fg
    sizes = ndimage.sum(fg, labels, range(1, n + 1))
    return ndimage.binary_fill_holes(labels == (int(np.argmax(sizes)) + 1))


def subject_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    """(x0, y0, x1, y1), exclusive ends, or None for an empty mask."""
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _square_box(bbox: tuple[int, int, int, int]) -> tuple[float, float, float]:
    """Centre and side of the square the subject is padded into."""
    x0, y0, x1, y1 = bbox
    side = max(x1 - x0, y1 - y0) / (1 - 2 * MARGIN)
    return (x0 + x1) / 2, (y0 + y1) / 2, side


def normalize_mask(mask: np.ndarray, size: int = MASK_SIZE) -> np.ndarray:
    """Crop to the subject, pad to a centred square with MARGIN, resample to
    size x size. An empty mask stays empty."""
    bbox = subject_bbox(mask)
    if bbox is None:
        return np.zeros((size, size), dtype=bool)
    cx, cy, side = _square_box(bbox)
    im = Image.fromarray(mask.astype(np.uint8) * 255)
    box = (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)
    return np.asarray(im.transform((size, size), Image.Transform.EXTENT, box, Image.Resampling.BILINEAR)) > 127


def iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / union) if union else 1.0


def png_b64(arr_or_img: Any) -> str:
    im = arr_or_img if isinstance(arr_or_img, Image.Image) else Image.fromarray(
        arr_or_img.astype(np.uint8) * 255 if arr_or_img.dtype == bool else arr_or_img)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def decode_mask(b64: str) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(base64.b64decode(b64))).convert("L")) > 127


def prep_image(data_b64: str, method: str = "auto") -> dict[str, Any]:
    """Background removed, cropped to the subject, padded square, on white.
    `aspect` is the subject bbox width / height in the source image."""
    img = Image.open(io.BytesIO(base64.b64decode(data_b64)))
    img.load()
    rgb = img.convert("RGB")
    used = method
    if method == "auto" and plain_backdrop(rgb):
        mask = threshold_mask(rgb)
        used = "threshold"
    elif method in ("auto", "rembg"):
        try:
            mask = _rembg_mask(rgb)
            used = "rembg"
        except Exception:  # noqa: BLE001 — model missing or onnx failing: say so via `method`
            if method == "rembg":
                raise
            mask = threshold_mask(rgb)
            used = "threshold"
    else:
        mask = threshold_mask(rgb)
        used = "threshold"
    bbox = subject_bbox(mask)
    if bbox is None:
        raise ValueError("no subject found in the image")
    x0, y0, x1, y1 = bbox
    cx, cy, side = _square_box(bbox)
    white = Image.new("RGB", rgb.size, (255, 255, 255))
    subject = Image.composite(rgb, white, Image.fromarray(mask.astype(np.uint8) * 255))
    # Pasted onto a white square rather than cropped: the padded square runs
    # past the source frame whenever the subject is near an edge.
    s = int(np.ceil(side))
    canvas = Image.new("RGB", (s, s), (255, 255, 255))
    canvas.paste(subject, (int(round(s / 2 - cx)), int(round(s / 2 - cy))))
    out = min(PREP_SIZE, s)
    prepped = canvas.resize((out, out), Image.Resampling.LANCZOS)
    norm = normalize_mask(mask)
    return {
        "method": used,
        "png_b64": png_b64(prepped),
        "mask_b64": png_b64(norm),
        "aspect": round((x1 - x0) / (y1 - y0), 4),
        "bbox": [x0, y0, x1, y1],
        "source_size": list(rgb.size),
        "mask_size": MASK_SIZE,
    }
