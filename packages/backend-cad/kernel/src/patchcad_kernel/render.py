"""Multi-view contact sheet: what a part actually looks like, rendered server-side.

Deliberately a software rasterizer over numpy rather than pyrender/moderngl/VTK.
The kernel is a headless worker pool with a 20 s SIGKILL and no GPU assumptions,
and a GL context is the single most fragile thing that could be added to it —
it would turn "this machine has no display" into a class of cook failure. A few
thousand triangles, z-buffered in numpy, costs milliseconds and cannot fail that
way. Pillow is here only to encode the PNG.

The gates can prove a part has the declared bore and fits its envelope. They
cannot see that it looks wrong. This is the first step at closing that: for now
a human looks at it.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .meshpart import to_trimesh

# Each view is rendered at this square size, then tiled into the sheet. Small
# on purpose: the sheet is for judging shape and proportion, not surface finish.
VIEW_PX = 220
SUPERSAMPLE = 2  # render 2x and box-filter down — cheap anti-aliasing
MARGIN = 0.08  # fraction of the frame left empty around the part

# Above this, decimate before rasterizing: the per-triangle loop is the cost,
# and shape reads identically at a few thousand faces.
MAX_TRIANGLES = 4000

BACKGROUND = (24, 26, 29)
INK = (232, 236, 240)

# (name, eye direction, up) — the four a machinist asks for, plus two isos so
# the sheet shows both front corners.
VIEWS: list[tuple[str, tuple[float, float, float], tuple[float, float, float]]] = [
    ("iso", (1.0, -1.0, 0.7), (0.0, 0.0, 1.0)),
    ("front", (0.0, -1.0, 0.0), (0.0, 0.0, 1.0)),
    ("right", (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
    ("top", (0.0, 0.0, 1.0), (0.0, 1.0, 0.0)),
    ("back", (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
    ("iso-rear", (-1.0, 1.0, 0.7), (0.0, 0.0, 1.0)),
]


def _mesh_arrays(shape: Any, tol: float = 0.3) -> tuple[np.ndarray, np.ndarray]:
    """(vertices Nx3, triangles Mx3) from either a build123d shape or a MeshPart.

    process=False: a rasterizer draws triangles and never asks whether they
    close, so welding here would cost time and buy nothing. exporters.py, which
    does care, welds its own combined mesh."""
    mesh = to_trimesh(shape, tol, process=False)
    return (np.asarray(mesh.vertices, dtype=np.float64),
            np.asarray(mesh.faces, dtype=np.int64).reshape(-1, 3))


def _decimate(v: np.ndarray, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if len(t) <= MAX_TRIANGLES:
        return v, t
    try:
        import fast_simplification

        vo, to = fast_simplification.simplify(v, t, target_count=MAX_TRIANGLES)
        return np.asarray(vo, dtype=np.float64), np.asarray(to, dtype=np.int64)
    except Exception:  # noqa: BLE001 — a slow render beats no render
        return v, t


def _basis(eye: tuple[float, float, float], up: tuple[float, float, float]) -> np.ndarray:
    """Rows are the camera's right/up/forward in world space."""
    f = np.array(eye, dtype=np.float64)
    f /= np.linalg.norm(f)
    u = np.array(up, dtype=np.float64)
    r = np.cross(u, f)
    n = np.linalg.norm(r)
    if n < 1e-9:  # up parallel to the view direction (the top view)
        r = np.cross(np.array([0.0, 1.0, 0.0]), f)
        n = np.linalg.norm(r)
    r /= n
    u = np.cross(f, r)
    return np.stack([r, u, f])


def _render_view(
    v: np.ndarray,
    t: np.ndarray,
    eye: tuple[float, float, float],
    up: tuple[float, float, float],
    px: int,
    centre: np.ndarray,
    scale: float,
) -> np.ndarray:
    """Orthographic, z-buffered, flat-shaded. Returns px*px*3 uint8.

    `centre` and `scale` come from the whole part, not this view, so every tile
    on the sheet is at the SAME magnification. Fitting each view independently
    made a thin plate's edge-on view fill the frame while its iso view sat
    small, which is precisely the misreading a contact sheet exists to prevent.
    """
    cam = _basis(eye, up)
    p = (v - centre) @ cam.T  # x right, y up, z toward the camera

    # To pixel space, y flipped so +up is up in the image.
    sx = p[:, 0] * scale + px / 2
    sy = px / 2 - p[:, 1] * scale
    depth = p[:, 2]

    img = np.zeros((px, px, 3), dtype=np.float64)
    img[:] = BACKGROUND
    zbuf = np.full((px, px), -np.inf)

    a, b, c = t[:, 0], t[:, 1], t[:, 2]
    # Face normals in camera space: z component alone gives the headlight term.
    e1 = p[b] - p[a]
    e2 = p[c] - p[a]
    nrm = np.cross(e1, e2)
    ln = np.linalg.norm(nrm, axis=1)
    ok = ln > 1e-12
    facing = np.zeros(len(t))
    facing[ok] = nrm[ok, 2] / ln[ok]
    # Backfaces point away; drawing only front faces is both faster and correct
    # for the closed solids the gates have already validated.
    visible = np.where(facing > 0)[0]

    for i in visible:
        ia, ib, ic = t[i]
        x0, x1 = sx[[ia, ib, ic]].min(), sx[[ia, ib, ic]].max()
        y0, y1 = sy[[ia, ib, ic]].min(), sy[[ia, ib, ic]].max()
        px0, px1 = max(0, int(math.floor(x0))), min(px - 1, int(math.ceil(x1)))
        py0, py1 = max(0, int(math.floor(y0))), min(px - 1, int(math.ceil(y1)))
        if px1 < px0 or py1 < py0:
            continue

        xs = np.arange(px0, px1 + 1) + 0.5
        ys = np.arange(py0, py1 + 1) + 0.5
        gx, gy = np.meshgrid(xs, ys)

        ax, ay = sx[ia], sy[ia]
        bx, by = sx[ib], sy[ib]
        cx, cy = sx[ic], sy[ic]
        det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(det) < 1e-12:
            continue
        w0 = ((by - cy) * (gx - cx) + (cx - bx) * (gy - cy)) / det
        w1 = ((cy - ay) * (gx - cx) + (ax - cx) * (gy - cy)) / det
        w2 = 1.0 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue

        z = w0 * depth[ia] + w1 * depth[ib] + w2 * depth[ic]
        sub = zbuf[py0 : py1 + 1, px0 : px1 + 1]
        win = inside & (z > sub)
        if not win.any():
            continue
        sub[win] = z[win]

        # Headlight plus ambient: enough to read form, no scene setup to get wrong.
        shade = 0.25 + 0.75 * float(facing[i])
        colour = np.array(INK, dtype=np.float64) * shade
        tile = img[py0 : py1 + 1, px0 : px1 + 1]
        tile[win] = colour

    return img.astype(np.uint8)


def _downsample(img: np.ndarray, factor: int) -> np.ndarray:
    if factor <= 1:
        return img
    h, w, _ = img.shape
    return img.reshape(h // factor, factor, w // factor, factor, 3).mean(axis=(1, 3)).astype(np.uint8)


def transform(v: np.ndarray, matrix: list[float]) -> np.ndarray:
    """Apply a column-major 4x4 (translation at 12,13,14) — the layout the
    assembly solver and three.js both use."""
    m = np.asarray(matrix, dtype=np.float64)
    if m.size != 16:
        return v
    rot = np.array([[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]])
    return v @ rot.T + np.array([m[12], m[13], m[14]])


def combine(parts: list[tuple[np.ndarray, np.ndarray]]) -> tuple[np.ndarray, np.ndarray]:
    """One mesh from many, triangle indices rebased as they are appended."""
    verts: list[np.ndarray] = []
    tris: list[np.ndarray] = []
    offset = 0
    for v, t in parts:
        verts.append(v)
        tris.append(t + offset)
        offset += len(v)
    if not verts:
        return np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64)
    return np.vstack(verts), np.vstack(tris)


def _sheet_from_mesh(v: np.ndarray, t: np.ndarray, path: str, views: int) -> dict[str, Any]:
    from PIL import Image, ImageDraw

    chosen = VIEWS[: max(1, min(views, len(VIEWS)))]

    # One magnification for the whole sheet. The bounding sphere is used rather
    # than a per-view box because it is the same from every angle, so nothing
    # is cropped whichever way the part is turned.
    centre = (v.min(axis=0) + v.max(axis=0)) / 2
    radius = float(np.linalg.norm(v - centre, axis=1).max()) or 1.0

    big = VIEW_PX * SUPERSAMPLE
    scale = (big * (1 - 2 * MARGIN)) / (2 * radius)
    tiles = [
        (name, _downsample(_render_view(v, t, eye, up, big, centre, scale), SUPERSAMPLE))
        for name, eye, up in chosen
    ]

    cols = 3 if len(tiles) > 2 else len(tiles)
    rows = math.ceil(len(tiles) / cols)
    sheet = Image.new("RGB", (cols * VIEW_PX, rows * VIEW_PX), BACKGROUND)
    draw = ImageDraw.Draw(sheet)
    for i, (name, tile) in enumerate(tiles):
        x, y = (i % cols) * VIEW_PX, (i // cols) * VIEW_PX
        sheet.paste(Image.fromarray(tile), (x, y))
        draw.text((x + 6, y + 5), name, fill=(120, 128, 136))

    sheet.save(path, "PNG", optimize=True)
    return {"views": [n for n, _ in tiles], "triangles": int(len(t)), "size": list(sheet.size)}


def render_sheet(shape: Any, path: str, views: int = 6) -> dict[str, Any]:
    """Render one part from several angles into a PNG contact sheet."""
    v, t = _decimate(*_mesh_arrays(shape))
    return _sheet_from_mesh(v, t, path, views)
