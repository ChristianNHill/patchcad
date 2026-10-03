from build123d import *
import math

def build(p):
    L = p.get("length", 110)
    c = p.get("center", 0)
    if c > 0:
        def hull(r1, r2):
            return Face(Wire.make_convex_hull([Edge.make_circle(r1), Pos(c, 0, 0) * Edge.make_circle(r2)]))
        r1, r2 = p.get("d1", 10) / 2, p.get("d2", 10) / 2
        return extrude(hull(r1 + 1.38, r2 + 1.38) - hull(r1, r2), 6, dir=(0, 0, 1))
    return Pos(L / 2, 0, 0.69) * Box(L, 6, 1.38)
