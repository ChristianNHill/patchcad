from build123d import *
import math

def build(p):
    ring = Pos(0, 0, 3) * (Cylinder(5, 6) - Cylinder(2.5, 12))
    hole = Pos(3.75, 0, 3) * Rot(0, 90, 0) * Cylinder(1.25, 3.5)
    return ring - hole
