from build123d import *
import math

def build(p):
    L = p.get("length", 34)
    body = Pos(0, 0, L / 2) * Box(42.3, 42.3, L) & Pos(0, 0, L / 2) * Cylinder(25.38, L)
    for x in (-15.5, 15.5):
        for y in (-15.5, 15.5):
            body = body - Pos(x, y, 2.25) * Cylinder(1.25, 4.5 + 0.01)
    pilot = Pos(0, 0, -1) * Cylinder(11, 2.01)
    shaft = Pos(0, 0, -12) * Cylinder(2.5, 24)
    shaft = shaft - Pos(4.5, 0, -13) * Box(5, 10, 22)
    return body + pilot + shaft
