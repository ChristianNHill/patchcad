"""Assembly instructions, IKEA-style: can each part reach its pose, and the
pages a person builds from.

The ORDER is decided in backend-cad (instructions.ts) from the graph. The
kernel answers only what needs geometry:

- `insertion_report`: each step's new parts swept out of their pose along
  their approach until they are free, against the parts already placed. It is
  G5's prismatic sweep (`g5_swept`); whatever two parts already share AT REST
  is G5's finding, not the sequence's, so it is allowed here and only a path
  that is worse than the rest pose blocks. Free means backed out by its own
  length plus a margin, and off the end of any placed shaft it rides
  (`clear_mm`): past that, a hand can bring a part in sideways. Sweeping on
  to infinity instead "pushed" a bearing seated on the inside of a U-frame
  out through the frame's far wall.
- `build_document`: step pictures (placed parts grey, new parts in the accent,
  pulled back along their approach with an arrow, hardware counted in a
  circle), a hardware page with 1:1 screw gauges, and the pages as SVG,
  rendered to PDF by fpdf2 as the vendor drawing is, plus one HTML file.
"""

from __future__ import annotations

import base64
import math
import os
from typing import Any
from xml.sax.saxutils import escape

import numpy as np

from .drawing import _latin1, _wrap
from .render import (
    SUPERSAMPLE,
    _basis,
    _decimate,
    _downsample,
    _edges,
    _mesh_arrays,
    _rasterize,
    combine,
    transform,
)

PAGE_W, PAGE_H = 210.0, 297.0  # A4 portrait, mm
STEP_PX = 760
ITEM_PX = 260

# Printed paper, not the studio: white ground, ink lines, the studio's one
# action blue (#0070d7) as a pale fill for what is new in a step.
PAPER = (255, 255, 255)
INK = (55, 53, 47)
PLACED = (232, 232, 230)
NEW = (196, 222, 247)
ITEM = (246, 246, 244)
ACCENT = (0, 112, 215)
ROLE_FILL = {"placed": PLACED, "new": NEW, "item": ITEM}


def _unit(v: Any) -> np.ndarray:
    d = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(d)
    return d / n if n > 1e-12 else np.array([0.0, 0.0, -1.0])


# ---------------------------------------------------------------------------
# Insertion sweeps


def insertion_report(meshes: list[tuple[str, Any]], checks: list[dict[str, Any]],
                     allow: list[dict[str, Any]]) -> dict[str, Any]:
    """Per check {id, moving, still, direction, clear_mm?}: sweep `moving` from
    its pose out against `direction` (the way it travels IN) until it is free,
    and report each still part it passes through."""
    from .gates import _manifold, _node_of, _shared, g5_swept

    by_key = dict(meshes)
    allowance = {frozenset((a["a"], a["b"])): float(a["volume_mm3"]) for a in allow}
    results: list[dict[str, Any]] = []
    errors: list[str] = []
    for check in checks:
        moving = [k for k in check["moving"] if k in by_key]
        still = [k for k in check["still"] if k in by_key and k not in moving]
        if not moving or not still:
            results.append({"id": check["id"], "blocked": []})
            continue
        out = -_unit(check["direction"])
        own = (max(float((by_key[k].vertices @ out).max()) for k in moving)
               - min(float((by_key[k].vertices @ out).min()) for k in moving))
        travel = float(check.get("clear_mm") or 0.0) + own + max(5.0, 0.5 * own)
        local = dict(allowance)
        for km in moving:
            for ks in still:
                (a_min, a_max), (b_min, b_max) = by_key[km].bounds, by_key[ks].bounds
                if np.any(a_min > b_max) or np.any(b_min > a_max):
                    continue
                try:
                    volume, _, _ = _shared(_manifold(by_key[km]), _manifold(by_key[ks]))
                except Exception as err:  # noqa: BLE001 — reported, never read as clear
                    errors.append(f"{check['id']}: {km} vs {ks} at rest could not be compared ({type(err).__name__})")
                    continue
                if volume > 0:
                    pair = frozenset((_node_of(km), _node_of(ks)))
                    local[pair] = max(local.get(pair, 0.0), volume * 1.05 + 0.5)
        sweep = {"joint": check["id"], "type": "prismatic", "origin": [0.0, 0.0, 0.0], "direction": out.tolist(),
                 "limits": [0.0, travel], "moving": moving}
        clashes, _, errs = g5_swept([(k, by_key[k]) for k in moving + still], [sweep], local)
        errors.extend(errs)
        results.append({"id": check["id"], "blocked": [
            {"part": c["a"], "by": c["b"], "depth_mm": c["depth_mm"], "volume_mm3": c["volume_mm3"],
             "travel_mm": c["travel"], "at": c["at"]} for c in clashes]})
    return {"checks": results, "errors": errors}


# ---------------------------------------------------------------------------
# Pictures


def _project(points: np.ndarray, cam: np.ndarray, centre: np.ndarray, scale: float, px: int) -> np.ndarray:
    p = (points - centre) @ cam.T
    return np.stack([p[:, 0] * scale + px / 2, px / 2 - p[:, 1] * scale], axis=1) / SUPERSAMPLE


def _picture(v: np.ndarray, t: np.ndarray, fill: np.ndarray, eye: Any, px: int,
             extra: np.ndarray | None = None) -> tuple[np.ndarray, Any]:
    """Flat-filled, ink-edged orthographic picture; returns the image and a
    projector for drawing on top of it. `fill` is a colour per triangle."""
    cam = _basis(tuple(eye), (0.0, 0.0, 1.0))
    pts = v if extra is None else np.vstack([v, extra])
    centre = (pts.min(axis=0) + pts.max(axis=0)) / 2
    flat = (pts - centre) @ cam.T
    half = float(np.abs(flat[:, :2]).max()) or 1.0
    big = px * SUPERSAMPLE
    scale = big * 0.84 / (2 * half)
    p = (v - centre) @ cam.T
    sx, sy, depth = p[:, 0] * scale + big / 2, big / 2 - p[:, 1] * scale, p[:, 2]
    nrm = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
    ln = np.linalg.norm(nrm, axis=1)
    unit = np.zeros_like(nrm)
    ok = ln > 1e-12
    unit[ok] = nrm[ok] / ln[ok, None]
    visible = np.where(unit[:, 2] > 0)[0]
    zbuf, ids = _rasterize(sx, sy, depth, t, visible, big)
    covered = ids >= 0
    img = np.empty((big, big, 3), dtype=np.float64)
    img[:] = PAPER
    shade = 0.84 + 0.16 * unit[ids[covered], 2]
    img[covered] = fill[ids[covered]] * shade[:, None]
    img[_edges(zbuf, ids, unit, scale)] = INK
    return _downsample(img.astype(np.uint8), SUPERSAMPLE), lambda q: _project(np.atleast_2d(q), cam, centre, scale, big)


def _arrow(draw: Any, a: np.ndarray, b: np.ndarray, colour: tuple[int, int, int], width: int = 3) -> None:
    d = b - a
    n = float(np.hypot(*d))
    if n < 12:
        return
    u = d / n
    head = min(18.0, n * 0.4)
    base = b - u * head
    perp = np.array([-u[1], u[0]]) * head * 0.45
    # dashed shaft, as in a printed manual: the path, not a second part
    dash = 9.0
    k = 0.0
    while k < n - head:
        s, e = a + u * k, a + u * min(k + dash, n - head)
        draw.line([tuple(s), tuple(e)], fill=colour, width=width)
        k += dash * 1.8
    draw.polygon([tuple(b), tuple(base + perp), tuple(base - perp)], fill=colour)


def _callout(draw: Any, font: Any, anchor: np.ndarray, label: str, px: int) -> None:
    """A count in a circle ("4x"), leaning away from the centre of the frame."""
    out = anchor - px / 2
    n = float(np.hypot(*out)) or 1.0
    at = anchor + out / n * 46 + np.array([0.0, -10.0])
    at = np.clip(at, 30, px - 30)
    r = 24
    draw.line([tuple(anchor), tuple(at)], fill=INK, width=2)
    draw.ellipse((at[0] - r, at[1] - r, at[0] + r, at[1] + r), fill=PAPER, outline=INK, width=3)
    w = draw.textlength(label, font=font)
    draw.text((at[0] - w / 2, at[1] - 13), label, fill=INK, font=font)


def render_step(posed: dict[str, tuple[np.ndarray, np.ndarray]], step: dict[str, Any], path: str,
                px: int = STEP_PX) -> dict[str, Any]:
    """Context parts in grey; each moving copy in the accent, pulled back
    against its direction of travel by its own length along it plus a margin,
    with a dashed arrow to where it goes; each callout as a count circle.
    A later `stage` (the screws of a part placed in the same step) is pulled
    back past the earlier one, so the part and its screws read as two moves.
    Parts arriving from both above and below get an inset from the other side."""
    from PIL import Image, ImageDraw, ImageFont

    context = [k for k in step.get("context", []) if k in posed]
    moving = [m for m in step.get("moving", []) if m["key"] in posed]
    everything = [posed[k][0] for k in context] + [posed[m["key"]][0] for m in moving]
    size = float(np.ptp(np.vstack(everything), axis=0).max()) if everything else 1.0
    groups: dict[tuple[tuple[float, ...], int], list[str]] = {}
    for m in moving:
        groups.setdefault((tuple(np.round(_unit(m["direction"]), 4)), int(m.get("stage", 0))), []).append(m["key"])
    offset: dict[str, np.ndarray] = {}
    # Where each copy's arrow ends: its pose, moved with the stage before it
    # (a screw points into its hole in the pulled-back part).
    landing: dict[str, np.ndarray] = {}
    pulled: dict[tuple[float, ...], float] = {}
    for (d, _), keys in sorted(groups.items(), key=lambda g: g[0][1]):
        u = np.asarray(d)
        along = np.concatenate([posed[k][0] @ u for k in keys])
        before = pulled.get(d, 0.0)
        pulled[d] = before + float(np.ptp(along)) + max(8.0, 0.18 * size)
        for k in keys:
            offset[k] = -u * pulled[d]
            landing[k] = -u * before

    parts, fills = [], []
    for k in context:
        v, t = posed[k]
        parts.append((v, t))
        fills.append(np.tile(PLACED, (len(t), 1)))
    starts, ends = {}, {}
    for m in moving:
        v, t = posed[m["key"]]
        parts.append((v + offset[m["key"]], t))
        fills.append(np.tile(NEW, (len(t), 1)))
        starts[m["key"]], ends[m["key"]] = v.mean(axis=0) + offset[m["key"]], v.mean(axis=0) + landing[m["key"]]
    v, t = combine(parts)
    if not len(t):
        Image.new("RGB", (px, px), PAPER).save(path, "PNG")
        return {"size": [px, px], "triangles": 0}
    fill = np.vstack(fills).astype(np.float64)
    ghost = np.vstack(list(ends.values())) if ends else None
    up = {m["key"] for m in moving if _unit(m["direction"])[2] > 0.5}
    down = {m["key"] for m in moving if _unit(m["direction"])[2] < -0.5}
    # Look from the side most new parts come in from; up from below is seen from underneath.
    below = len(up) > len(down)

    def view(size_px: int, from_below: bool, keys: set[str], callouts: bool) -> Any:
        img, project = _picture(v, t, fill, (1.0, -1.0, -0.75 if from_below else 0.75), size_px, ghost)
        sheet = Image.fromarray(img)
        draw = ImageDraw.Draw(sheet)
        for k in keys:
            a, b = project(starts[k])[0], project(ends[k])[0]
            _arrow(draw, a + (b - a) * 0.18, a + (b - a) * 0.82, ACCENT)
        if callouts:
            font = ImageFont.load_default(size=22)
            for c in step.get("callouts", []):
                ks = [k for k in c["keys"] if k in keys]
                if ks:
                    _callout(draw, font, project(starts[ks[0]])[0], c["label"], size_px)
        return sheet

    sheet = view(px, below, set(starts) - (down if below else up), True)
    hidden = down if below else up
    if hidden and len(hidden) < len(starts):
        inset_px = int(px * 0.4)
        inset = view(inset_px, not below, hidden, False)
        draw = ImageDraw.Draw(inset)
        draw.rectangle((0, 0, inset_px - 1, inset_px - 1), outline=INK, width=2)
        draw.text((8, 6), "from above" if below else "from below", fill=INK, font=ImageFont.load_default(size=16))
        sheet.paste(inset, (px - inset_px - 4, px - inset_px - 4))
    sheet.save(path, "PNG", optimize=True)
    return {"size": [px, px], "triangles": len(t)}


def render_item(v: np.ndarray, t: np.ndarray, path: str, px: int = ITEM_PX) -> None:
    """One bought part on its own, in line art: what the hardware page shows."""
    from PIL import Image

    img, _ = _picture(v, t, np.tile(ITEM, (len(t), 1)).astype(np.float64), (1.0, -1.0, 0.75), px)
    Image.fromarray(img).save(path, "PNG", optimize=True)


# ---------------------------------------------------------------------------
# Pages


class Page:
    """SVG in page millimetres, y down (drawing.Sheet's conventions)."""

    def __init__(self) -> None:
        self.items: list[str] = []

    def text(self, x: float, y: float, s: str, size: float = 3.6, bold: bool = False, colour: str = "#37352f",
             anchor: str = "start") -> None:
        weight = ' font-weight="bold"' if bold else ""
        self.items.append(f'<text x="{x:.2f}" y="{y:.2f}" font-family="Helvetica" font-size="{size}"{weight} '
                          f'text-anchor="{anchor}" fill="{colour}">{escape(_latin1(s))}</text>')

    def para(self, x: float, y: float, s: str, width: float, size: float = 3.6, bold: bool = False) -> float:
        """Wrapped text; returns the y below it."""
        for line in _wrap(s, max(12, int(width / (size * 0.5)))):
            self.text(x, y, line, size, bold)
            y += size * 1.35
        return y

    def line(self, x0: float, y0: float, x1: float, y1: float, w: float = 0.3, colour: str = "#37352f") -> None:
        self.items.append(f'<path d="M {x0:.2f} {y0:.2f} L {x1:.2f} {y1:.2f}" stroke="{colour}" stroke-width="{w}" fill="none"/>')

    def rect(self, x: float, y: float, w: float, h: float, lw: float = 0.3, colour: str = "#cfcfcc") -> None:
        self.items.append(f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" fill="none" '
                          f'stroke="{colour}" stroke-width="{lw}"/>')

    def circle(self, cx: float, cy: float, r: float, lw: float = 0.5) -> None:
        self.items.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" fill="none" stroke="#37352f" stroke-width="{lw}"/>')

    def image(self, x: float, y: float, w: float, h: float, png: bytes) -> None:
        uri = "data:image/png;base64," + base64.b64encode(png).decode()
        self.items.append(f'<image x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" href="{uri}"/>')

    def svg(self) -> str:
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}mm" height="{PAGE_H}mm" '
                f'viewBox="0 0 {PAGE_W} {PAGE_H}">\n<rect width="{PAGE_W}" height="{PAGE_H}" fill="#ffffff"/>\n'
                + "\n".join(self.items) + "\n</svg>\n")


def _footer(page: Page, title: str, n: int) -> None:
    page.line(15, 284, 195, 284, 0.2, "#cfcfcc")
    page.text(15, 289, title, 2.8, colour="#615f5a")
    page.text(195, 289, str(n), 2.8, colour="#615f5a", anchor="end")


def _gauge(page: Page, x: float, y: float, length: float) -> None:
    """A 1:1 length gauge: lay the screw on it."""
    page.line(x, y, x + length, y, 0.35)
    for at in (x, x + length):
        page.line(at, y - 2.2, at, y + 2.2, 0.35)
    page.text(x + length + 2, y + 1.1, f"{length:g} mm (1:1)", 2.6, colour="#615f5a")


def _cover(doc: dict[str, Any], hero: bytes | None, n: int) -> Page:
    page = Page()
    y = page.para(15, 30, doc.get("title") or "Assembly instructions", 180, 9, bold=True)
    y = page.para(15, y + 2, doc.get("subtitle") or "", 180, 4.2)
    if hero:
        page.image(25, y + 4, 160, 160, hero)
    y += 172
    y = min(y, 250)
    page.text(15, y, f"{doc.get('summary', '')}", 3.8, bold=True)
    y += 8
    tools = doc.get("tools") or []
    page.text(15, y, "You will need", 3.8, bold=True)
    y += 6
    for tool in tools or ["no tools"]:
        page.text(19, y, f"-  {tool}", 3.6)
        y += 5
    problems = doc.get("problems") or []
    if problems:
        y += 4
        page.text(15, y, "Check before you build", 3.8, bold=True, colour="#b3261e")
        y += 6
        for p in problems[:8]:
            y = page.para(19, y, f"-  {p}", 172, 3.2) + 1
    _footer(page, doc.get("title", ""), n)
    return page


def _hardware_pages(doc: dict[str, Any], tiles: dict[str, bytes], first: int) -> list[Page]:
    items = doc.get("items") or []
    made = doc.get("made") or []
    pages: list[Page] = []
    per_page = 6
    chunks = [items[i:i + per_page] for i in range(0, len(items), per_page)] or [[]]
    for c, chunk in enumerate(chunks):
        page = Page()
        page.text(15, 24, "Hardware" if c == 0 else "Hardware (continued)", 7, bold=True)
        page.text(15, 31, "Everything you buy. Print at 100% to use the 1:1 gauges.", 3.4, colour="#615f5a")
        for i, item in enumerate(chunk):
            x, y = 15 + (i % 2) * 92, 38 + (i // 2) * 54
            page.rect(x, y, 88, 50)
            if item["id"] in tiles:
                page.image(x + 2, y + 2, 34, 34, tiles[item["id"]])
            page.text(x + 40, y + 13, f"{item['qty']}x", 8, bold=True)
            yy = page.para(x + 40, y + 21, item["label"], 46, 3.3, bold=True)
            page.text(x + 40, yy + 0.5, item["id"], 2.7, colour="#615f5a")
            if item.get("gauge_mm"):
                _gauge(page, x + 4, y + 43, float(item["gauge_mm"]))
        if c == len(chunks) - 1:
            y = 38 + math.ceil(max(1, len(chunk)) / 2) * 54 + 6
            if made:
                page.text(15, y, "Printed and made parts", 4.2, bold=True)
                y += 6
                for m in made:
                    y = page.para(19, y, f"{m['qty']}x  {m['label']}", 170, 3.5)
            tools = doc.get("tools") or []
            if tools:
                y += 4
                page.text(15, y, "Tools", 4.2, bold=True)
                y += 6
                for tool in tools:
                    page.text(19, y, f"-  {tool}", 3.5)
                    y += 5
        _footer(page, doc.get("title", ""), first + c)
        pages.append(page)
    return pages


def _step_page(doc: dict[str, Any], step: dict[str, Any], picture: bytes, tiles: dict[str, bytes], n: int) -> Page:
    page = Page()
    page.text(15, 30, str(step["n"]), 16, bold=True)
    top = 50.0
    if step.get("subassembly"):
        page.text(15, 47, step["subassembly"], 3.2, colour="#615f5a")
        top = 54.0
    # Hardware boxes across the top, the IKEA way: what this step uses, counted.
    x = 40.0
    for h in step.get("hardware", [])[:5]:
        page.rect(x, 14, 30, 26)
        if h.get("item") in tiles:
            page.image(x + 1, 15, 16, 16, tiles[h["item"]])
        page.text(x + 28, 22, f"{h['qty']}x", 5, bold=True, anchor="end")
        for k, line in enumerate(_wrap(h["label"], 20)[:2]):
            page.text(x + 1.5, 34 + k * 3, line, 2.4)
        x += 32
    y = page.para(15, top, step["title"], 180, 4.6, bold=True)
    page.image(20, y + 2, 170, 170, picture)
    y += 176
    for note in step.get("notes", []):
        y = page.para(15, y, note, 180, 3.5) + 1
    _footer(page, doc.get("title", ""), n)
    return page


def build_document(posed: dict[str, tuple[np.ndarray, np.ndarray]], items: dict[str, tuple[np.ndarray, np.ndarray]],
                   doc: dict[str, Any], out_dir: str) -> dict[str, Any]:
    """Every picture, every page, the PDF and the HTML, into out_dir."""
    from fpdf import FPDF
    from fpdf.svg import SVGObject

    os.makedirs(out_dir, exist_ok=True)

    def png(path: str) -> bytes:
        with open(path, "rb") as f:
            return f.read()

    tiles: dict[str, bytes] = {}
    for i, (sku, (v, t)) in enumerate(items.items()):
        path = os.path.join(out_dir, f"item-{i + 1}.png")
        render_item(v, t, path)
        tiles[sku] = png(path)
    hero_path = os.path.join(out_dir, "step-0.png")
    render_step(posed, {"context": list(posed), "moving": []}, hero_path)
    pictures = []
    for step in doc.get("steps", []):
        path = os.path.join(out_dir, f"step-{step['n']}.png")
        render_step(posed, step, path)
        pictures.append(png(path))

    pages = [_cover(doc, png(hero_path) if posed else None, 1)]
    pages += _hardware_pages(doc, tiles, len(pages) + 1)
    for step, picture in zip(doc.get("steps", []), pictures):
        pages.append(_step_page(doc, step, picture, tiles, len(pages) + 1))

    svgs = [p.svg() for p in pages]
    for i, s in enumerate(svgs):
        with open(os.path.join(out_dir, f"page-{i + 1}.svg"), "w", encoding="utf8") as f:
            f.write(s)
    pdf = FPDF(unit="mm", format="A4")
    pdf.set_creator("PatchCAD")
    for s in svgs:
        pdf.add_page()
        SVGObject(s).draw_to_page(pdf)
    tmp = os.path.join(out_dir, f"instructions.{os.getpid()}.tmp.pdf")
    pdf.output(tmp)
    os.replace(tmp, os.path.join(out_dir, "instructions.pdf"))
    title = escape(doc.get("title") or "Assembly instructions")
    html = ("<!doctype html><html><head><meta charset=\"utf-8\"><title>" + title + "</title><style>"
            "body{margin:0;background:#e0e0df}svg{display:block;margin:16px auto;background:#fff;"
            "box-shadow:0 1px 3px rgba(0,0,0,.2);max-width:100%;height:auto}"
            "@media print{body{background:#fff}svg{margin:0;box-shadow:none;page-break-after:always}}"
            "</style></head><body>" + "".join(svgs) + "</body></html>")
    with open(os.path.join(out_dir, f"instructions.{os.getpid()}.tmp.html"), "w", encoding="utf8") as f:
        f.write(html)
    os.replace(os.path.join(out_dir, f"instructions.{os.getpid()}.tmp.html"), os.path.join(out_dir, "instructions.html"))
    return {"pages": len(svgs), "steps": len(pictures), "items": len(tiles)}


def posed_arrays(shape: Any, matrix: list[float]) -> tuple[np.ndarray, np.ndarray]:
    """The render mesh of one placed copy."""
    v, t = _decimate(*_mesh_arrays(shape))
    return (transform(v, matrix) if matrix else v), t

