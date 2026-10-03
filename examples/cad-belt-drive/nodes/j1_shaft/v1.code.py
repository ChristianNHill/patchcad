from build123d import *
import math

def build(p):
    L = p.get("length", 20)
    return Pos(0, 0, L / 2) * Cylinder(2.5, L) - Pos(4.5, 0, L / 2) * Box(5, 10, L * 2)
