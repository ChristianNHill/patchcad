from build123d import *
import math

def build(p):
    def disc(rad, h, z):
        return Pos(0, 0, z + h / 2) * Cylinder(rad, h)
    rim = disc(6.1121977236758145, 7, 8)
    grooves = [
        Pos(5.917197723675814 * math.cos(i * 2 * math.pi / 20), 5.917197723675814 * math.sin(i * 2 * math.pi / 20), 11.5) * Cylinder(0.555, 7)
        for i in range(20)
    ]
    body = disc(8, 1, 7) + rim.cut(*grooves) + disc(8, 1, 15)
    body = body + disc(8, 7, 0)
    body = body - Pos(0, 0, 8) * Cylinder(2.5, 32)
    return body - Pos(5.25, 0, 3.5) * Rot(0, 90, 0) * Cylinder(1.25, 6.5)
