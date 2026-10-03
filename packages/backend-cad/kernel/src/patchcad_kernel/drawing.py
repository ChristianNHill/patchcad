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
#: Room around the views for stacked dimensions: left, top, right, bottom.
MARGIN = (44.0, 30.0, 30.0, 40.0)
DIM_FIRST, DIM_STEP, DIM_LEVELS = 9.0, 7.0, 4
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

    def text(self, x: float, y: float, s: str, size: float = 3.0, bold: bool = False, upright: bool = False) -> None:
        """`upright` turns the text to read up the page, for a vertical dimension."""
        weight = ' font-weight="bold"' if bold else ""
        turn = f' transform="rotate(-90 {x:.2f} {y:.2f})"' if upright else ""
        self.items.append(f'<text x="{x:.2f}" y="{y:.2f}" font-family="Helvetica" font-size="{size}"{weight}{turn} '
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
        label = _fmt(value)
        span = math.dist(a2, b2)
        if span < 6.0 + len(label) * 1.8:  # too short for arrows and label inside: both go outside
            u = ((b2[0] - a2[0]) / (span or 1.0), (b2[1] - a2[1]) / (span or 1.0))
            self.line([(a2[0] - u[0] * 4, a2[1] - u[1] * 4), (b2[0] + u[0] * 4, b2[1] + u[1] * 4)], 0.18)
            self.arrow(a2, (a2[0] - u[0], a2[1] - u[1]))
            self.arrow(b2, (b2[0] + u[0], b2[1] + u[1]))
            tx, ty = b2[0] + u[0] * 5, b2[1] + u[1] * 5
            if abs(u[1]) < 1e-6:
                self.text(tx, ty - 1.0, label)
            else:
                self.text(tx - 1.0, ty, label, upright=True)
            return
        self.line([a2, b2], 0.18)
        self.arrow(a2, b2)
        self.arrow(b2, a2)
        mx, my = (a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2
        if abs(a2[1] - b2[1]) < 1e-6:  # horizontal
            self.text(mx - len(label) * 0.9, my - 1.0, label)
        else:  # aligned with the line, so stacked dimensions 7 mm apart never collide
            self.text(mx - 1.0, my + len(label) * 0.9, label, upright=True)

    def svg(self) -> str:
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}mm" height="{PAGE_H}mm" '
                f'viewBox="0 0 {PAGE_W} {PAGE_H}">\n' + "\n".join(self.items) + "\n</svg>\n")


def _pick_scale(ext: np.ndarray) -> float:
    x, y, z = ext
    x0, y0, x1, y1 = ORTHO_BOX
    ml, mt, mr, mb = MARGIN
    for s in SCALES:
        if (x + y) * s + ml + GAP + mr <= x1 - x0 and (y + z) * s + mt + GAP + mb <= y1 - y0:
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


def _limits(nominal: float, fit: str, process: str) -> str:
    """The fit as the band G3 held the bore to, e.g. "Ø22 +0.050/+0.000". No
    ISO class: the STEP is cut to the band midpoint, which N7/H7 do not
    contain (N7 on Ø8 is -0.019..-0.004, the press cut is -0.025), and the
    drawing must not name a class the geometry it ships with fails."""
    from .gates import FIT_BANDS, MACHINED, MACHINED_FIT_BANDS

    bands = MACHINED_FIT_BANDS if process in MACHINED else FIT_BANDS
    if fit not in bands:
        return f"Ø{_fmt(nominal)} (NO GATED BAND FOR A {fit.upper()} FIT: CONFIRM LIMITS)"
    lo, hi = bands[fit]
    return f"Ø{_fmt(nominal)} {hi:+.3f}/{lo:+.3f}"


def _through(shape: Any, o: np.ndarray, z: np.ndarray) -> bool:
    """Whether a feature opening at o along -z runs out the far side."""
    from .gates import _reach

    reach = _reach(shape)
    return not any(shape.is_inside(tuple(o - z * w)) for w in np.arange(0.6, reach, 0.25))


def _slot_length(shape: Any, o: np.ndarray, x: np.ndarray, z: np.ndarray) -> float | None:
    """Overall length of a slot running along x, read off the geometry (the
    contract gives only its width): void either side of the origin, just
    below the face."""
    p = o - z * 0.6
    if shape.is_inside(tuple(p)):
        return None
    reach = float(np.linalg.norm(_extent(shape)))

    def run(sign: float) -> float | None:
        lo = 0.0
        while not shape.is_inside(tuple(p + x * sign * (lo + 0.25))):
            lo += 0.25
            if lo > reach:  # open-ended: runs out of the part
                return None
        hi = lo + 0.25
        for _ in range(12):
            mid = (lo + hi) / 2
            lo, hi = (lo, mid) if shape.is_inside(tuple(p + x * sign * mid)) else (mid, hi)
        return lo

    ends = run(1.0), run(-1.0)
    return None if None in ends else round(sum(ends), 2)


def hole_callouts(ports: list[dict[str, Any]], measured: list[dict[str, Any]] | None = None,
                  process: str = "", shape: Any = None) -> list[dict[str, Any]]:
    """One lettered callout per feature: hole-like ports, motor mounts (pilot +
    screw pattern) and slots. Identical callouts on the same axis merge into
    one "Nx". Each carries `members` (part frame, one per feature) and
    `locate`: the points the drawing dimensions from the part edges. A pattern
    locates its centre; its members are placed by the pitch in its text."""
    from .gates import PILOT_D_KEYS, WIDTH_KEYS, _pattern_offsets, _port_dim_opt
    from .gates import _frame as port_frame

    seen = {m.get("key"): m for m in measured or []}
    raw: list[dict[str, Any]] = []

    def add(port: dict[str, Any], size: str, members: list[np.ndarray], locate: list[np.ndarray], axis: np.ndarray,
            fit: str | None = None, got: Any = None, note: str = "") -> None:
        raw.append({"key": port.get("key", "?"), "type": port.get("type", ""), "size": size, "fit": fit,
                    "axis": axis, "members": members, "locate": locate, "note": note,
                    "measured": got if isinstance(got, (int, float)) else None})

    for port in ports:
        ptype = port.get("type", "")
        params = port.get("params", {})
        o, x, y, z = (np.asarray(a, float) for a in port_frame(port["pose"]))
        m = seen.get(port.get("key")) or {}
        if ptype == "MOTOR_MOUNT":
            pilot = _port_dim_opt(port, PILOT_D_KEYS)
            hole = _port_dim_opt(port, ("hole_diameter", "holeDiameter"))
            thru = " THRU" if m.get("through") or (shape is not None and _through(shape, o, z)) else ""
            if pilot:
                add(port, f"{_limits(pilot, 'slip', process)}{thru}", [o], [o], z, "slip",
                    m.get("measured_diameter"), "motor pilot")
            if hole:
                layout = {k: params[k] for k in ("count", "pcd", "start_angle", "nx", "ny", "pitch_x", "pitch_y")
                          if k in params}
                if "pcd" not in layout:
                    layout = {"nx": 2, "ny": 2} | layout
                offsets = _pattern_offsets({**port, "params": layout})
                pattern = (f"ON Ø{_fmt(float(layout['pcd']))} PCD" if "pcd" in layout
                           else f"ON {_fmt(float(layout['pitch_x']))} x {_fmt(float(layout['pitch_y']))}"
                           + (" SQUARE" if layout["pitch_x"] == layout["pitch_y"] else ""))
                where = "ABOUT THE PILOT" if pilot else "ABOUT ITS CENTRE"
                holes = m.get("holes") or []
                got = holes[0].get("measured_diameter") if holes else None
                add(port, f"Ø{_fmt(hole)} THRU {pattern} {where}", [o + u * x + v * y for u, v in offsets],
                    [] if pilot else [o], z, None, got)
            continue
        if ptype == "SLOT":
            width = _port_dim_opt(port, WIDTH_KEYS)
            length = _slot_length(shape, o, x, z) if shape is not None else None
            thru = shape is not None and _through(shape, o, z)
            size = (f"SLOT {_fmt(width) if width else '?'} WIDE"
                    + (f" x {_fmt(length)} LONG" if length else "")
                    + (" THRU" if thru else (f" DEEP {_fmt(float(params['depth']))}" if params.get("depth") else "")))
            add(port, size, [o], [o], z, None, m.get("measured_width"))
            continue
        if ptype not in HOLE_PORTS:
            continue
        offsets = _pattern_offsets(port) if ptype == "HOLE_PATTERN" else [(0.0, 0.0)]
        fit = params.get("fit")
        size = _diameter(port)
        if fit and size.startswith("Ø"):
            size = _limits(float(size[1:]), fit, process)
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
        if ptype == "HOLE_PATTERN":
            size += (f" ON Ø{_fmt(float(params['pcd']))} PCD" if "pcd" in params
                     else f" ON {_fmt(float(params.get('pitch_x', 0)))} x {_fmt(float(params.get('pitch_y', 0)))}")
        members = [o + u * x + v * y for u, v in offsets]
        add(port, size, members, [o] if ptype == "HOLE_PATTERN" else members, z, fit,
            m.get("measured_diameter") or m.get("diameter"))

    out: list[dict[str, Any]] = []
    for r in raw:
        twin = next((c for c in out if c["size"] == r["size"] and c["type"] == r["type"] and c["note"] == r["note"]
                     and abs(abs(float(np.dot(c["axis"], r["axis"]))) - 1) < 1e-6), None)
        if twin:
            twin["keys"].append(r["key"])
            twin["members"] += r["members"]
            twin["locate"] += r["locate"]
        else:
            out.append(r | {"keys": [r["key"]]})
    for i, c in enumerate(out):
        n = len(c["members"])
        c["letter"] = chr(ord("A") + i) if i < 26 else f"H{i}"
        c["key"] = ", ".join(c["keys"])
        c["text"] = (f"{n}x " if n > 1 else "") + c["size"] + (f", {c['fit']} fit" if c["fit"] else "") \
            + (f" ({c['note'].upper()})" if c["note"] else "")
    return out


def tolerance_notes(process: str, holes: list[dict[str, Any]]) -> list[str]:
    notes = ["ALL DIMENSIONS IN MM. DO NOT SCALE DRAWING.",
             "GENERAL TOLERANCES ISO 2768-m UNLESS STATED.",
             "BREAK SHARP EDGES 0.2 MAX, DEBURR ALL HOLES." if process in ("cnc", "sheet_metal", "laser_cut")
             else "REMOVE SUPPORT MATERIAL FROM ALL FUNCTIONAL FACES.",
             "UNDIMENSIONED FEATURES AND RADII PER THE STEP MODEL.",
             "MODEL AXES: THE FRONT VIEW LOOKS ALONG +Y, WITH +X RIGHT AND +Z UP."]
    for h in holes:
        if h["fit"]:
            notes.append(f"{h['letter']} ({h['key']}): {h['fit']} fit, hold the stated limits; checked on the model.")
        elif h["type"] == "CLEARANCE_HOLE":
            notes.append(f"{h['letter']} ({h['key']}): clearance hole, ISO 273 medium, +0.2/-0.")
    if any(h["type"] in ("MOTOR_MOUNT", "HOLE_PATTERN") and not h["fit"] for h in holes):
        notes.append("PATTERN PITCHES ARE BASIC, POSITION Ø0.2 TO THE PATTERN CENTRE.")
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
    ml, mt, _, _ = MARGIN
    centers = {
        "TOP": (x0 + ml + X / 2, y0 + mt + Y / 2),
        "FRONT": (x0 + ml + X / 2, y0 + mt + GAP + Y + Z / 2),
        "RIGHT": (x0 + ml + GAP + X + Y / 2, y0 + mt + GAP + Y + Z / 2),
    }
    size = {"FRONT": (ext[0], ext[2]), "TOP": (ext[0], ext[1]), "RIGHT": (ext[1], ext[2])}
    holes = hole_callouts(ports, measured, meta.get("process", ""), shape)

    def view_of(axis: np.ndarray) -> str | None:
        return next((v for v in ("TOP", "FRONT", "RIGHT") if abs(float(np.dot(axis, _frame(v)[0]))) >= 0.99), None)

    def in_view(view: str, p: np.ndarray) -> tuple[float, float]:
        _, right, up = _frame(view)
        return float(np.dot(p - center, right)), float(np.dot(p - center, up))

    sheet = Sheet()
    sheet.rect(5, 5, PAGE_W - 10, PAGE_H - 10, 0.7)

    def to_page(view: str, scale: float, h: float, v: float) -> tuple[float, float]:
        cx, cy = centers[view]
        return cx + h * scale, cy - v * scale

    edges = {view: project(shape, view, center) for view in ("FRONT", "TOP", "RIGHT")}

    # Positions to dimension from each view's left and bottom edges: every
    # feature centre, plus the steps of the RIGHT view's own profile (wall
    # thicknesses, ledges), which no feature callout reaches.
    locate: dict[str, tuple[set[float], set[float]]] = {v: (set(), set()) for v in centers}

    def mark(view: str, u: float, v: float, horizontal: bool = True, vertical: bool = True) -> None:
        w, h = size[view]
        if horizontal and 0.05 < u + w / 2 < w - 0.05:
            locate[view][0].add(round(u + w / 2, 2))
        if vertical and 0.05 < v + h / 2 < h - 0.05:
            locate[view][1].add(round(v + h / 2, 2))

    for hole in holes:
        view = view_of(hole["axis"])
        for p in hole["locate"] if view else []:
            mark(view, *in_view(view, p))
    for pl in edges["RIGHT"][0]:
        (ua, va), (ub, vb) = pl[0], pl[-1]
        if len(pl) == 2 and abs(ua - ub) < 1e-6:
            mark("RIGHT", ua, 0.0, vertical=False)
        elif len(pl) == 2 and abs(va - vb) < 1e-6:
            mark("RIGHT", 0.0, va, horizontal=False)
    hs_, vs_ = ({v: sorted(locate[v][i])[:DIM_LEVELS] for v in locate} for i in (0, 1))

    for view, (vis, hid) in edges.items():
        for pl in hid:
            sheet.line([to_page(view, s, *p) for p in pl], 0.18, "1.2,0.8")
        for pl in vis:
            sheet.line([to_page(view, s, *p) for p in pl], 0.35)
        cx, cy = centers[view]
        w, h = size[view][0] * s, size[view][1] * s
        below = {"FRONT": len(hs_["FRONT"]) + 1, "TOP": 0, "RIGHT": len(hs_["RIGHT"]) + bool(hs_["RIGHT"])}[view]
        sheet.text(cx - w / 2, cy + h / 2 + (DIM_FIRST + DIM_STEP * (below - 1) + 7 if below else 6), view, 3.0, True)

    # Locations nearest the view, shortest first, so no extension line crosses
    # a label; the overall size outermost. TOP's locations go above it (FRONT
    # is below), RIGHT's heights go right of it (FRONT is left).
    for view, side_h, side_v in (("FRONT", 1, -1), ("TOP", -1, -1), ("RIGHT", 1, 1)):
        cx, cy = centers[view]
        w, h = size[view][0] * s, size[view][1] * s
        left, bottom = cx - w / 2, cy + h / 2
        edge_y = bottom if side_h > 0 else bottom - h
        edge_x = left if side_v < 0 else left + w
        for k, val in enumerate(hs_[view]):
            sheet.dim((left, edge_y), (left + val * s, edge_y), (0, side_h * (DIM_FIRST + DIM_STEP * k)), val)
        for k, val in enumerate(vs_[view]):
            sheet.dim((edge_x, bottom), (edge_x, bottom - val * s), (side_v * (DIM_FIRST + DIM_STEP * k), 0), val)
    fx, fy = centers["FRONT"]
    tx, ty = centers["TOP"]
    sheet.dim((fx - X / 2, fy + Z / 2), (fx + X / 2, fy + Z / 2), (0, DIM_FIRST + DIM_STEP * len(hs_["FRONT"])), ext[0])
    sheet.dim((fx - X / 2, fy + Z / 2), (fx - X / 2, fy - Z / 2), (-DIM_FIRST - DIM_STEP * len(vs_["FRONT"]), 0), ext[2])
    sheet.dim((tx - X / 2, ty + Y / 2), (tx - X / 2, ty - Y / 2), (-DIM_FIRST - DIM_STEP * len(vs_["TOP"]), 0), ext[1])
    if hs_["RIGHT"]:  # its steps read from the same overall depth the TOP view states
        rx, ry = centers["RIGHT"]
        sheet.dim((rx - Y / 2, ry + Z / 2), (rx + Y / 2, ry + Z / 2), (0, DIM_FIRST + DIM_STEP * len(hs_["RIGHT"])), ext[1])

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
    sheet.text(bx0, by1, "ISOMETRIC (NOT TO SCALE)", 3.0, True)

    # Callouts: a centre mark on every member, a lettered leader on the first,
    # in the view that looks down the feature's axis.
    for hole in holes:
        view = view_of(hole["axis"])
        if view is None:
            continue
        for k, p in enumerate(hole["members"]):
            hx, hy = to_page(view, s, *in_view(view, p))
            sheet.line([(hx - 1.5, hy), (hx + 1.5, hy)], 0.13)
            sheet.line([(hx, hy - 1.5), (hx, hy + 1.5)], 0.13)
            if k == 0:
                sheet.line([(hx, hy), (hx + 5, hy - 5), (hx + 8, hy - 5)], 0.18)
                sheet.text(hx + 8.5, hy - 4, hole["letter"], 3.2, True)

    notes = tolerance_notes(meta.get("process", ""), holes)
    nx, ny = 292.0, 122.0
    if holes:
        sheet.text(nx, ny, "HOLES", 3.2, True)
        ny += 5
        for hole in holes:
            got = (f" (measured {'' if hole['type'] == 'SLOT' else 'Ø'}{hole['measured']:.3f})"
                   if hole["measured"] else "")
            for j, chunk in enumerate(_wrap(f"{hole['text']}{got}", 58)):
                sheet.text(nx, ny, f"{hole['letter']}  {chunk}" if j == 0 else f"     {chunk}", 2.6)
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
