from build123d import *
import math

def build(p):
    ring = Cylinder(5, 1) - Cylinder(2.65, 2)
    return Pos(0, 0, 0.5) * ring
