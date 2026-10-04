"""Involute spur gear for the registry (injected as `involute_gear`).

bd_warehouse's SpurGear refuses any gear whose root circle lies outside its
base circle (z >= 42 at 20 degrees), and aligns the bounding box rather than
the axis, so an odd tooth count sat off centre. This one draws the profile as a
single wire: per tooth a root arc, a radial line up to the base circle where the
root lies inside it, an involute flank, a tip arc and the mirrored flank. Axis
on z, a tooth centred on +x, z from -thickness/2 to +thickness/2, standard
addendum m and dedendum 1.25m, zero backlash, no undercut.
"""

from __future__ import annotations

import math

from build123d import Edge, Face, Pos, Rot, Spline, ThreePointArc, Vector, Wire, extrude

FLANK_POINTS = 8


def _inv(a: float) -> float:
    return math.tan(a) - a


def involute_gear(module: float, teeth: int, pressure_angle: float = 20, thickness: float = 5, phase: float = 0):
    if teeth < 6:
        raise ValueError(f"a spur gear needs at least 6 teeth, got {teeth}")
    alpha = math.radians(pressure_angle)
    rp = module * teeth / 2
    rb = rp * math.cos(alpha)
    ra = rp + module
    rf = rp - 1.25 * module
    if rf <= 0:
        raise ValueError(f"module {module} with {teeth} teeth leaves no root circle")
    half_pitch = math.pi / (2 * teeth) + _inv(alpha)

    def half_angle(r: float) -> float:
        return half_pitch - _inv(math.acos(min(1.0, rb / r)))

    r0 = max(rb, rf)
    if half_angle(ra) <= 0:
        raise ValueError(f"{teeth} teeth at {pressure_angle} degrees come to a point below the tip circle")
    radii = [r0 + (ra - r0) * i / (FLANK_POINTS - 1) for i in range(FLANK_POINTS)]

    def polar(r: float, a: float) -> Vector:
        return Vector(r * math.cos(a), r * math.sin(a))

    step = 2 * math.pi / teeth
    edges: list[Edge] = []
    for i in range(teeth):
        c = i * step
        lower = [polar(r, c - half_angle(r)) for r in radii]
        upper = [polar(r, c + half_angle(r)) for r in reversed(radii)]
        if rf < rb:
            edges.append(Edge.make_line(polar(rf, c - half_angle(rb)), lower[0]))
        edges.append(Spline(*lower))
        edges.append(ThreePointArc(lower[-1], polar(ra, c), upper[0]))
        edges.append(Spline(*upper))
        start = c + half_angle(r0)
        end = c + step - half_angle(r0)
        if rf < rb:
            edges.append(Edge.make_line(upper[-1], polar(rf, start)))
        edges.append(ThreePointArc(polar(rf, start), polar(rf, (start + end) / 2), polar(rf, end)))
    profile = Face(Wire(edges))
    return Rot(0, 0, phase) * Pos(0, 0, -thickness / 2) * extrude(profile, thickness)
