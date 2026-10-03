from build123d import *
import math

def build(p):
    L = p.get("length", 4)
    head = Pos(0, 0, 0.825) * Cylinder(2.85, 1.65)
    head = fillet(head.edges().group_by(Axis.Z)[-1], 1.32)
    shank = Pos(0, 0, -L / 2) * Cylinder(1.5, L)
    return head + shank - Pos(0, 0, 0.66) * extrude(RegularPolygon(2 / math.sqrt(3), 6), 0.9999999999999999)
