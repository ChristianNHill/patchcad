from build123d import *

def build(p):
    head = Pos(0, 0, 4 / 2) * Cylinder(7 / 2, 4)
    shank = Pos(0, 0, -p.length / 2) * Cylinder(4 / 2, p.length)
    return head + shank
