from build123d import *
import math

def build(p):
    body = Pos(0, 0, 5.8 / 2) * Cylinder(4 / 2, 5.8)
    bore = Pos(0, 0, 5.8 / 2) * Cylinder(2.5 / 2, 5.8 * 2)
    return body - bore
