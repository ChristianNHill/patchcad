"""A dimensioned 2D drawing of one part for a vendor: three third-angle
orthographic views plus an isometric, overall dimensions, hole callouts from
the contract's ports, fit/tolerance notes and a title block, on one A3 sheet.

Edges come from OCCT hidden-line removal (build123d `project_to_viewport`,
orthographic). The sheet is written as SVG and rendered to PDF by fpdf2, which
draws SVG natively and needs no system libraries. fpdf2's core fonts are
latin-1, so every label goes through `_latin1` (Ø, ±, ×, ° survive; dashes and
arrows are spelled out).
"""

from __future__ import annotations

import math
from typing import Any
from xml.sax.saxutils import escape

import numpy as np

PAGE_W, PAGE_H = 420.0, 297.0  # A3 landscape, mm
ORTHO_BOX = (15.0, 15.0, 280.0, 240.0)  # x0, y0, x1, y1 for the three views
ISO_BOX = (292.0, 15.0, 410.0, 110.0)
GAP = 24.0
SCALES = (10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01)

#: (viewer direction, up) per view. Third-angle: top above front, right beside it.
VIEWS = {
    "FRONT": ((0.0, -1.0, 0.0), (0.0, 0.0, 1.0)),
    "TOP": ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0)),
    "RIGHT": ((1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
    "ISOMETRIC": ((1.0, -1.0, 1.0), (0.0, 0.0, 1.0)),
}

#: Hole-like port types that get a callout, and the param naming their Ø.
HOLE_PORTS = {
    "CLEARANCE_HOLE": "diameter", "BORE": "diameter", "SCREW_SEAT": "diameter", "HOLE_PATTERN": "diameter",
    "THREADED_HOLE": "thread", "COUNTERBORE": "through_diameter", "COUNTERSINK": "through_diameter",
    "DOWEL_HOLE": "diameter", "BEARING_SEAT": "od", "BUSHING_BORE": "od", "MAGNET_POCKET": "diameter",
    "HUB_BORE": "diameter", "INSERT_POCKET": "diameter",
}

#: ISO 286 hole tolerance for each contract fit word.
FIT_CLASS = {"press": "N7 (interference)", "slip": "H7 (sliding clearance)", "transition": "K7 (transition)"}


def _latin1(s: str) -> str:
    s = s.replace("—", "-").replace("–", "-").replace("→", "->").replace("≤", "<=").replace("≥", ">=")
    return s.encode("latin-1", "replace").decode("latin-1")


def _fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def _frame(view: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(toward viewer, screen right, screen up) for a view."""
    d, up = (np.asarray(a, float) for a in VIEWS[view])
    d /= np.linalg.norm(d)
    look = -d
    up = up - np.dot(up, look) * look
    up /= np.linalg.norm(up)
    return d, np.cross(look, up), up


def _polylines(edges: Any) -> list[list[tuple[float, float]]]:
    out = []
    for e in edges:
        if e.geom_type.name == "LINE":
            pts = [e.start_point(), e.end_point()]
        else:
            n = int(min(64, max(8, e.length / 0.5)))
            pts = [e.position_at(i / n) for i in range(n + 1)]
        out.append([(float(p.X), float(p.Y)) for p in pts])
    return out


def project(shape: Any, view: str, center: np.ndarray) -> tuple[list, list]:
    """Visible and hidden edges as 2D polylines, centred on `center`."""
    d, _, up = _frame(view)
    reach = float(np.linalg.norm(_extent(shape))) * 4 + 100
    vis, hid = shape.project_to_viewport(tuple(center + d * reach), tuple(up), tuple(center))
    return _polylines(vis), _polylines(hid)


def _extent(shape: Any) -> np.ndarray:
    bb = shape.bounding_box()
    return np.array([bb.size.X, bb.size.Y, bb.size.Z], float)


class Sheet:
    """SVG builder in page millimetres, y down."""

    def __init__(self) -> None:
        self.items: list[str] = []

    def line(self, pts: list[tuple[float, float]], w: float = 0.35, dash: str | None = None) -> None:
        d = " ".join(f"{'M' if i == 0 else 'L'} {x:.3f} {y:.3f}" for i, (x, y) in enumerate(pts))
        extra = f' stroke-dasharray="{dash}"' if dash else ""
        self.items.append(f'<path d="{d}" fill="none" stroke="black" stroke-width="{w}"{extra}/>')

    def rect(self, x: float, y: float, w: float, h: float, lw: float = 0.5) -> None:
        self.items.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="none" stroke="black" stroke-width="{lw}"/>')

    def text(self, x: float, y: float, s: str, size: float = 3.0, bold: bool = False) -> None:
        weight = ' font-weight="bold"' if bold else ""
        self.items.append(f'<text x="{x:.2f}" y="{y:.2f}" font-family="Helvetica" font-size="{size}"{weight} '
                          f'fill="black">{escape(_latin1(s))}</text>')

    def arrow(self, tip: tuple[float, float], toward: tuple[float, float]) -> None:
        tx, ty = tip
        dx, dy = toward[0] - tx, toward[1] - ty
        n = math.hypot(dx, dy) or 1.0
        ux, uy = dx / n * 2.5, dy / n * 2.5
        px, py = -uy * 0.35, ux * 0.35
        self.items.append(f'<path d="M {tx:.3f} {ty:.3f} L {tx + ux + px:.3f} {ty + uy + py:.3f} '
                          f'L {tx + ux - px:.3f} {ty + uy - py:.3f} Z" fill="black"/>')

    def dim(self, a: tuple[float, float], b: tuple[float, float], off: tuple[float, float], value: float) -> None:
        """Linear dimension between feature points a and b, drawn offset by `off`."""
        a2, b2 = (a[0] + off[0], a[1] + off[1]), (b[0] + off[0], b[1] + off[1])
        n = math.hypot(*off) or 1.0
        over = (off[0] / n * 1.5, off[1] / n * 1.5)
        self.line([a, (a2[0] + over[0], a2[1] + over[1])], 0.18)
        self.line([b, (b2[0] + over[0], b2[1] + over[1])], 0.18)
        self.line([a2, b2], 0.18)
        self.arrow(a2, b2)
        self.arrow(b2, a2)
        label = _fmt(value)
        mx, my = (a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2
        if abs(a2[1] - b2[1]) < 1e-6:  # horizontal
            self.text(mx - len(label) * 0.9, my - 1.0, label)
        else:
            self.text(mx - len(label) * 1.8 - 1.5, my + 1.0, label)

    def svg(self) -> str:
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}mm" height="{PAGE_H}mm" '
                f'viewBox="0 0 {PAGE_W} {PAGE_H}">\n' + "\n".join(self.items) + "\n</svg>\n")


def _pick_scale(ext: np.ndarray) -> float:
    x, y, z = ext
    x0, y0, x1, y1 = ORTHO_BOX
    for s in SCALES:
        if (x + y) * s + 3 * GAP <= x1 - x0 and (y + z) * s + 3 * GAP <= y1 - y0:
            return s
    return SCALES[-1]


def _scale_label(s: float) -> str:
    return f"{_fmt(s)}:1" if s >= 1 else f"1:{_fmt(1 / s)}"


def _diameter(port: dict[str, Any]) -> str:
    params = port.get("params", {})
    key = HOLE_PORTS[port["type"]]
    v = params.get(key, params.get("diameter"))
    if key == "thread":
        return str(v or "M?")
    try:
        return f"Ø{_fmt(float(v))}"
    except (TypeError, ValueError):
        return "Ø?"


def hole_callouts(ports: list[dict[str, Any]], measured: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """One callout per hole-like port: letter, text, members (part frame)."""
    from .gates import _frame as port_frame, _pattern_offsets

    seen = {m.get("key"): m for m in measured or []}
    out = []
    for port in ports:
        ptype = port.get("type", "")
        if ptype not in HOLE_PORTS:
            continue
        params = port.get("params", {})
        o, x, y, z = (np.asarray(a, float) for a in port_frame(port["pose"]))
        offsets = _pattern_offsets(port) if ptype == "HOLE_PATTERN" else [(0.0, 0.0)]
        size = _diameter(port)
        if ptype == "COUNTERBORE":
            size += f" THRU, CBORE Ø{_fmt(float(params.get('diameter', 0)))} DEEP {_fmt(float(params.get('depth', 0)))}"
        elif ptype == "COUNTERSINK":
            size += f" THRU, CSK Ø{_fmt(float(params.get('diameter', 0)))} x {_fmt(float(params.get('angle', 90)))}°"
        elif ptype == "THREADED_HOLE":
            size += f"-6H DEEP {_fmt(float(params.get('depth', 0)))}" if params.get("depth") else "-6H THRU"
        elif ptype == "CLEARANCE_HOLE":
            size += " THRU"
        elif params.get("depth"):
            size += f" DEEP {_fmt(float(params['depth']))}"
        fit = params.get("fit")
        text = f"{len(offsets)}x {size}" + (f", {fit} fit {FIT_CLASS.get(fit, '')}".rstrip() if fit else "")
        m = seen.get(port.get("key"), {})
        got = m.get("measured_diameter") or m.get("diameter")
        out.append({
            "letter": chr(ord("A") + len(out)) if len(out) < 26 else f"H{len(out)}",
            "key": port.get("key", "?"), "type": ptype, "text": text, "fit": fit, "axis": z,
            "measured": got if isinstance(got, (int, float)) else None,
            "members": [o + u * x + v * y for u, v in offsets],
        })
    return out


def tolerance_notes(process: str, holes: list[dict[str, Any]]) -> list[str]:
    notes = ["ALL DIMENSIONS IN MM. DO NOT SCALE DRAWING.",
             "GENERAL TOLERANCES ISO 2768-m UNLESS STATED.",
             "BREAK SHARP EDGES 0.2 MAX, DEBURR ALL HOLES." if process in ("cnc", "sheet_metal", "laser_cut")
             else "REMOVE SUPPORT MATERIAL FROM ALL FUNCTIONAL FACES."]
    for h in holes:
        if h["fit"]:
            notes.append(f"{h['letter']} ({h['key']}): {h['fit']} fit, hole {FIT_CLASS.get(h['fit'], 'per contract')}.")
        elif h["type"] == "CLEARANCE_HOLE":
            notes.append(f"{h['letter']} ({h['key']}): clearance hole, ISO 273 medium, +0.2/-0.")
    return notes


def build_sheet(shape: Any, ports: list[dict[str, Any]], meta: dict[str, Any],
                measured: list[dict[str, Any]] | None = None) -> tuple[str, dict[str, Any]]:
    """The drawing as SVG, plus what it shows (for RFQ.md and tests)."""
    bb = shape.bounding_box()
    center = np.array([(bb.min.X + bb.max.X) / 2, (bb.min.Y + bb.max.Y) / 2, (bb.min.Z + bb.max.Z) / 2])
    ext = _extent(shape)
    s = _pick_scale(ext)
    X, Y, Z = ext * s
    x0, y0, _, _ = ORTHO_BOX
    centers = {
        "TOP": (x0 + GAP + X / 2, y0 + GAP + Y / 2),
        "FRONT": (x0 + GAP + X / 2, y0 + 2 * GAP + Y + Z / 2),
        "RIGHT": (x0 + 2 * GAP + X + Y / 2, y0 + 2 * GAP + Y + Z / 2),
    }
    sheet = Sheet()
    sheet.rect(5, 5, PAGE_W - 10, PAGE_H - 10, 0.7)

    def to_page(view: str, scale: float, h: float, v: float) -> tuple[float, float]:
        cx, cy = centers[view]
        return cx + h * scale, cy - v * scale

    for view in ("FRONT", "TOP", "RIGHT"):
        vis, hid = project(shape, view, center)
        for pl in hid:
            sheet.line([to_page(view, s, *p) for p in pl], 0.18, "1.2,0.8")
        for pl in vis:
            sheet.line([to_page(view, s, *p) for p in pl], 0.35)
        cx, cy = centers[view]
        w, h = {"FRONT": (X, Z), "TOP": (X, Y), "RIGHT": (Y, Z)}[view]
        sheet.text(cx - w / 2, cy + h / 2 + (16 if view == "FRONT" else 6), view, 3.0, True)

    # Overall dimensions: width under the front view, height left of it, depth left of the top view.
    fx, fy = centers["FRONT"]
    tx, ty = centers["TOP"]
    sheet.dim((fx - X / 2, fy + Z / 2), (fx + X / 2, fy + Z / 2), (0, 9), ext[0])
    sheet.dim((fx - X / 2, fy + Z / 2), (fx - X / 2, fy - Z / 2), (-9, 0), ext[2])
    sheet.dim((tx - X / 2, ty + Y / 2), (tx - X / 2, ty - Y / 2), (-9, 0), ext[1])

    # Isometric, fitted to its own box.
    iso_vis, _ = project(shape, "ISOMETRIC", center)
    pts = np.array([p for pl in iso_vis for p in pl]) if iso_vis else np.zeros((1, 2))
    span = np.ptp(pts, axis=0)
    bx0, by0, bx1, by1 = ISO_BOX
    iso_s = min((bx1 - bx0 - 10) / max(span[0], 1e-6), (by1 - by0 - 14) / max(span[1], 1e-6))
    mid = (pts.max(axis=0) + pts.min(axis=0)) / 2
    for pl in iso_vis:
        sheet.line([((bx0 + bx1) / 2 + (px - mid[0]) * iso_s, (by0 + by1) / 2 - 2 - (py - mid[1]) * iso_s)
                    for px, py in pl], 0.3)
    sheet.text(bx0, by1, f"ISOMETRIC (scale {_scale_label(iso_s)})", 3.0, True)

    # Hole callouts: a lettered leader in the view that looks down each hole's axis.
    holes = hole_callouts(ports, measured)
    for hole in holes:
        for view in ("TOP", "FRONT", "RIGHT"):
            d, right, up = _frame(view)
            if abs(float(np.dot(hole["axis"], d))) < 0.99:
                continue
            for k, p in enumerate(hole["members"]):
                rel = p - center
                hx, hy = to_page(view, s, float(np.dot(rel, right)), float(np.dot(rel, up)))
                if k == 0:
                    sheet.line([(hx, hy), (hx + 5, hy - 5), (hx + 8, hy - 5)], 0.18)
                    sheet.text(hx + 8.5, hy - 4, hole["letter"], 3.2, True)
                else:
                    sheet.line([(hx - 1, hy), (hx + 1, hy)], 0.18)
                    sheet.line([(hx, hy - 1), (hx, hy + 1)], 0.18)
            break

    notes = tolerance_notes(meta.get("process", ""), holes)
    nx, ny = 292.0, 122.0
    if holes:
        sheet.text(nx, ny, "HOLES", 3.2, True)
        ny += 5
        for hole in holes:
            got = f" (measured Ø{_fmt(hole['measured'])})" if hole["measured"] else ""
            sheet.text(nx, ny, f"{hole['letter']}  {hole['text']}{got}", 2.6)
            ny += 4
        ny += 3
    sheet.text(nx, ny, "NOTES", 3.2, True)
    ny += 5
    for i, note in enumerate(notes + list(meta.get("notes", []))):
        for j, chunk in enumerate(_wrap(note, 62)):
            sheet.text(nx, ny, f"{i + 1}. {chunk}" if j == 0 else f"    {chunk}", 2.6)
            ny += 4
        if ny > 240:
            break

    # Title block.
    rows = [
        ("PART", meta.get("title", "")), ("NODE", meta.get("name", "")),
        ("MATERIAL", meta.get("material", "")), ("FINISH", meta.get("finish") or "none specified"),
        ("PROCESS", meta.get("process", "")), ("QTY", str(meta.get("qty", 1))),
        ("UNITS", "mm"), ("SCALE", _scale_label(s)),
        ("PROJECTION", "third angle"), ("DATE", meta.get("date", "")),
    ]
    tbx, tby, cw, rh = 230.0, 247.0, 90.0, 8.0
    sheet.rect(tbx, tby, 180, 40, 0.5)
    for i, (k, v) in enumerate(rows):
        cx, cy = tbx + (i % 2) * cw, tby + (i // 2) * rh
        sheet.rect(cx, cy, cw, rh, 0.25)
        sheet.text(cx + 1.5, cy + 3.2, k, 2.0)
        sheet.text(cx + 1.5, cy + 7.0, str(v)[:44], 3.0, True)
    sheet.text(15, 290, "Generated by PatchCAD from gate-verified geometry. The STEP file is the master.", 2.4)
    return sheet.svg(), {"scale": s, "holes": holes, "notes": notes, "extent": [float(v) for v in ext]}


def _wrap(text: str, width: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    return lines + ([cur] if cur else [])


def svg_to_pdf(svg: str, path: str) -> None:
    from fpdf import FPDF
    from fpdf.svg import SVGObject

    pdf = FPDF(orientation="L", unit="mm", format="A3")
    pdf.set_creator("PatchCAD")
    pdf.add_page()
    SVGObject(svg).draw_to_page(pdf)
    pdf.output(path)
