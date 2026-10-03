"""Multi-view contact sheet: what a part actually looks like, rendered server-side.

Deliberately a software rasterizer over numpy rather than pyrender/moderngl/VTK.
The kernel is a headless worker pool with a 20 s SIGKILL and no GPU assumptions,
and a GL context is the single most fragile thing that could be added to it —
it would turn "this machine has no display" into a class of cook failure. A few
thousand triangles, z-buffered in numpy, costs milliseconds and cannot fail that
way. Pillow is here only to encode the PNG.

The gates can prove a part has the declared bore and fits its envelope. They
cannot see that it looks wrong. The sheet is what the engine's inspect judge
answers its yes/no visual checks from, so every tile carries what a question
about place and size needs: an axis triad, a millimetre scale bar, and dark
silhouette and crease lines over flat shading.
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

# Light and neutral, in the studio's warm-paper key. The sheet is model-facing,
# so what matters is contrast: a mid-grey part, dark edge lines, pale ground.
BACKGROUND = (240, 238, 233)
PART = (200, 204, 210)
EDGE = (34, 36, 40)
LABEL = (90, 92, 96)
DIVIDER = (214, 210, 202)
AXIS_COLOURS = ((200, 56, 44), (48, 150, 70), (44, 92, 200))  # x red, y green, z blue

# Adjacent pixels whose faces differ by more than this get a crease line. OCP
# tessellates curves at 0.1 rad, so facets of one smooth surface stay far below.
CREASE_COS = math.cos(math.radians(30))
# Rasterize in chunks of this many (triangle, pixel) candidates, to bound memory
# when a few big triangles cover most of the frame.
CHUNK = 1_000_000

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


def _weld(v: np.ndarray, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Merge coincident corners, dropping the triangles that collapses.

    OCP tessellation comes back UNWELDED: one vertex per triangle corner, so
    adjacent triangles share no index (measured on a plate: 2568 vertices for
    1272 distinct positions). A mesh like that has no interior edges at all.
    """
    uniq, inv = np.unique(np.round(v, 6), axis=0, return_inverse=True)
    wt = inv.reshape(-1)[t]
    keep = (wt[:, 0] != wt[:, 1]) & (wt[:, 1] != wt[:, 2]) & (wt[:, 0] != wt[:, 2])
    return uniq, wt[keep]


def _surface_area(v: np.ndarray, t: np.ndarray) -> float:
    a = v[t[:, 1]] - v[t[:, 0]]
    b = v[t[:, 2]] - v[t[:, 0]]
    return float(np.linalg.norm(np.cross(a, b), axis=1).sum() / 2)


def _decimate(v: np.ndarray, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if len(t) <= MAX_TRIANGLES:
        return v, t
    try:
        import fast_simplification

        # WELD FIRST. fast_simplification coarsens by collapsing EDGES, and an
        # unwelded tessellation has none to collapse — so instead of coarsening
        # it shreds the mesh into disconnected slivers. Measured on a 90x90x3
        # plate: simplifying unwelded took surface area 17243mm2 -> 910mm2, 95%
        # of the part destroyed; welded kept 17199mm2.
        #
        # This was NOT cosmetic. Only meshes over MAX_TRIANGLES were affected,
        # so a 4959-triangle plate rendered as scattered line fragments while a
        # 4000-triangle one beside it shaded correctly — and the contact sheet
        # is exactly what inspectNode shows the vision model, so a sound part
        # was being presented for judgement as a broken one.
        wv, wt = _weld(v, t)
        if len(wt) <= MAX_TRIANGLES:
            return wv, wt  # welding alone got us under; also avoids the
            # ValueError simplify raises when target_count >= n_faces
        vo, to = fast_simplification.simplify(wv, wt, target_count=MAX_TRIANGLES)
        vo = np.asarray(vo, dtype=np.float64)
        to = np.asarray(to, dtype=np.int64).reshape(-1, 3)
        # A simplifier that ate the part is worse than no simplifier: drawing
        # every triangle is merely slow, whereas rendering something that is not
        # the part is a wrong answer nothing downstream can detect.
        if len(to) == 0 or _surface_area(vo, to) < 0.5 * _surface_area(wv, wt):
            return v, t
        return vo, to
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

    a, b, c = t[:, 0], t[:, 1], t[:, 2]
    # Face normals in camera space: z component alone gives the headlight term.
    e1 = p[b] - p[a]
    e2 = p[c] - p[a]
    nrm = np.cross(e1, e2)
    ln = np.linalg.norm(nrm, axis=1)
    ok = ln > 1e-12
    unit = np.zeros_like(nrm)
    unit[ok] = nrm[ok] / ln[ok, None]
    facing = unit[:, 2]
    # Backfaces point away; drawing only front faces is both faster and correct
    # for the closed solids the gates have already validated.
    visible = np.where(facing > 0)[0]

    zbuf, ids = _rasterize(sx, sy, depth, t, visible, px)
    covered = ids >= 0

    img = np.empty((px, px, 3), dtype=np.float64)
    img[:] = BACKGROUND
    # Headlight plus ambient: enough to read form, no scene setup to get wrong.
    shade = 0.35 + 0.65 * facing[ids[covered]]
    img[covered] = np.asarray(PART, dtype=np.float64) * shade[:, None]
    img[_edges(zbuf, ids, unit, scale)] = EDGE
    return img.astype(np.uint8)


def _rasterize(
    sx: np.ndarray, sy: np.ndarray, depth: np.ndarray, t: np.ndarray, visible: np.ndarray, px: int
) -> tuple[np.ndarray, np.ndarray]:
    """Z-buffer every visible triangle at once. Returns (depth, triangle id),
    each px*px, id -1 where nothing was drawn.

    Vectorised over (triangle, pixel-in-its-bbox) pairs instead of a Python loop
    per triangle, which cost 414ms for 520 triangles. The nearest candidate per
    pixel wins after one sort, which is the same answer the loop reached by
    overwriting."""
    zbuf = np.full(px * px, -np.inf)
    ids = np.full(px * px, -1, dtype=np.int64)
    if len(visible) == 0:
        return zbuf.reshape(px, px), ids.reshape(px, px)

    tv = t[visible]
    X, Y, Z = sx[tv], sy[tv], depth[tv]  # (m, 3) each
    x0 = np.clip(np.floor(X.min(axis=1)), 0, px - 1).astype(np.int64)
    x1 = np.clip(np.ceil(X.max(axis=1)), 0, px - 1).astype(np.int64)
    y0 = np.clip(np.floor(Y.min(axis=1)), 0, px - 1).astype(np.int64)
    y1 = np.clip(np.ceil(Y.max(axis=1)), 0, px - 1).astype(np.int64)
    det = (Y[:, 1] - Y[:, 2]) * (X[:, 0] - X[:, 2]) + (X[:, 2] - X[:, 1]) * (Y[:, 0] - Y[:, 2])
    flat = np.abs(det) < 1e-12
    det[flat] = 1.0
    # Barycentrics as per-triangle linear functions of the pixel centre, so the
    # per-pair work is two multiply-adds instead of six gathers.
    a0, b0 = (Y[:, 1] - Y[:, 2]) / det, (X[:, 2] - X[:, 1]) / det
    a1, b1 = (Y[:, 2] - Y[:, 0]) / det, (X[:, 0] - X[:, 2]) / det
    w = x1 - x0 + 1
    n = np.where(flat, 0, w * (y1 - y0 + 1))
    ends = np.cumsum(n)

    pix_all: list[np.ndarray] = []
    z_all: list[np.ndarray] = []
    tri_all: list[np.ndarray] = []
    i = 0
    while i < len(tv):
        j = max(i + 1, int(np.searchsorted(ends, ends[i] - n[i] + CHUNK, side="right")))
        k = np.repeat(np.arange(i, j), n[i:j])
        if len(k):
            off = np.arange(ends[i] - n[i], ends[j - 1]) - np.repeat(ends[i:j] - n[i:j], n[i:j])
            gx = x0[k] + off % w[k]
            gy = y0[k] + off // w[k]
            dx = gx + 0.5 - X[k, 2]
            dy = gy + 0.5 - Y[k, 2]
            w0 = a0[k] * dx + b0[k] * dy
            w1 = a1[k] * dx + b1[k] * dy
            inside = (w0 >= 0) & (w1 >= 0) & (w0 + w1 <= 1)
            ki = k[inside]
            w0, w1 = w0[inside], w1[inside]
            pix_all.append(gy[inside] * px + gx[inside])
            z_all.append(Z[ki, 2] + w0 * (Z[ki, 0] - Z[ki, 2]) + w1 * (Z[ki, 1] - Z[ki, 2]))
            tri_all.append(visible[ki])
        i = j

    pix, z, tri = np.concatenate(pix_all), np.concatenate(z_all), np.concatenate(tri_all)
    if len(pix):
        order = np.lexsort((z, pix))  # by pixel, nearest (largest z) last
        pix, z, tri = pix[order], z[order], tri[order]
        last = np.append(pix[1:] != pix[:-1], True)
        zbuf[pix[last]] = z[last]
        ids[pix[last]] = tri[last]
    return zbuf.reshape(px, px), ids.reshape(px, px)


def _edges(zbuf: np.ndarray, ids: np.ndarray, unit: np.ndarray, scale: float) -> np.ndarray:
    """Silhouettes, creases and depth steps, found in image space: a pixel is on
    an edge when its neighbour is background and it is not, faces a different
    way by more than the crease angle, or sits at a different depth than the
    slope of its own face explains. Both pixels of a pair are marked, so lines
    are two supersampled pixels wide and survive the box filter."""
    covered = ids >= 0
    nrm = np.zeros(ids.shape + (3,))
    nrm[covered] = unit[ids[covered]]
    # Depth change per pixel a face explains on its own, from its slope.
    nz = np.maximum(nrm[..., 2], 0.05)
    mark = np.zeros(ids.shape, dtype=bool)
    for axis, comp in ((1, 0), (0, 1)):
        sl_a = (slice(None), slice(None, -1)) if axis == 1 else (slice(None, -1), slice(None))
        sl_b = (slice(None), slice(1, None)) if axis == 1 else (slice(1, None), slice(None))
        ca, cb = covered[sl_a], covered[sl_b]
        both = ca & cb
        crease = (nrm[sl_a] * nrm[sl_b]).sum(axis=-1) < CREASE_COS
        slope = np.maximum(np.abs(nrm[sl_a][..., comp]) / nz[sl_a], np.abs(nrm[sl_b][..., comp]) / nz[sl_b])
        gap = np.abs(np.where(both, zbuf[sl_a], 0.0) - np.where(both, zbuf[sl_b], 0.0))
        step = gap > (1.5 + 2.0 * slope) / scale
        hit = (ca != cb) | (both & (crease | step))
        mark[sl_a] |= hit
        mark[sl_b] |= hit
    return mark


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


def _draw_triad(draw: Any, font: Any, cam: np.ndarray, ox: int, oy: int, length: float = 15.0) -> None:
    """World x/y/z as this view sees them, so "top face" and "toward the tail"
    can be read off any tile. An axis along the line of sight draws as a dot
    when it points at the viewer and a ring when it points away."""
    for k, (label, colour) in enumerate(zip("xyz", AXIS_COLOURS)):
        dx, dy = cam[0][k] * length, -cam[1][k] * length
        if math.hypot(dx, dy) < 0.25 * length:
            toward = cam[2][k] > 0
            draw.ellipse((ox - 3, oy - 3, ox + 3, oy + 3), outline=colour, width=2, fill=colour if toward else None)
            draw.text((ox + 5, oy - 13), label, fill=colour, font=font)
            continue
        draw.line((ox, oy, ox + dx, oy + dy), fill=colour, width=2)
        draw.text((ox + dx * 1.3 - 3, oy + dy * 1.3 - 6), label, fill=colour, font=font)


def _draw_scale_bar(draw: Any, font: Any, mm_per_px: float, right: int, base: int) -> None:
    """A round-number bar (1/2/5 x 10^n mm) about a quarter of the tile wide.
    Every tile shares one magnification, so each bar reads the same."""
    target = 0.28 * VIEW_PX * mm_per_px
    mag = 10 ** math.floor(math.log10(target))
    mm = max(m * mag for m in (1, 2, 5) if m * mag <= target)
    bar = mm / mm_per_px
    left = right - bar
    draw.line((left, base, right, base), fill=EDGE, width=2)
    draw.line((left, base - 4, left, base + 2), fill=EDGE, width=1)
    draw.line((right, base - 4, right, base + 2), fill=EDGE, width=1)
    text = f"{mm:g} mm"
    draw.text((right - draw.textlength(text, font=font), base - 16), text, fill=LABEL, font=font)


def _sheet_from_mesh(v: np.ndarray, t: np.ndarray, path: str, views: int) -> dict[str, Any]:
    from PIL import Image, ImageDraw, ImageFont

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
    font = ImageFont.load_default(size=11)
    mm_per_px = SUPERSAMPLE / scale
    for i, ((name, tile), (_, eye, up)) in enumerate(zip(tiles, chosen)):
        x, y = (i % cols) * VIEW_PX, (i // cols) * VIEW_PX
        sheet.paste(Image.fromarray(tile), (x, y))
        draw.rectangle((x, y, x + VIEW_PX - 1, y + VIEW_PX - 1), outline=DIVIDER)
        draw.text((x + 6, y + 4), name, fill=LABEL, font=font)
        _draw_triad(draw, font, _basis(eye, up), x + 22, y + VIEW_PX - 22)
        _draw_scale_bar(draw, font, mm_per_px, x + VIEW_PX - 10, y + VIEW_PX - 12)

    sheet.save(path, "PNG", optimize=True)
    return {"views": [n for n, _ in tiles], "triangles": len(t), "size": list(sheet.size)}


def render_sheet(shape: Any, path: str, views: int = 6) -> dict[str, Any]:
    """Render one part from several angles into a PNG contact sheet."""
    v, t = _decimate(*_mesh_arrays(shape))
    return _sheet_from_mesh(v, t, path, views)
