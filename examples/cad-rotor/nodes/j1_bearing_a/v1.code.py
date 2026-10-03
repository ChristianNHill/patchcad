from build123d import *
import math

def build(p):
    def annulus(ro, ri, h, z):
        return Pos(0, 0, z + h / 2) * (Cylinder(ro, h) - Cylinder(ri, h * 2))
    outer = annulus(8, 6.35, 5, 0)
    inner = annulus(4.15, 2.5, 5, 0)
    band = annulus(6.359999999999999, 4.140000000000001, 4.6, 0.2)
    brg = outer + inner + band
    return brg
