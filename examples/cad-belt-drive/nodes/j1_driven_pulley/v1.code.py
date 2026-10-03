from build123d import *
import math

def build(p):
    def disc(rad, h, z):
        return Pos(0, 0, z + h / 2) * Cylinder(rad, h)
    rim = disc(12.478395447351629, 7, 8)
    grooves = [
        Pos(12.283395447351628 * math.cos(i * 2 * math.pi / 40), 12.283395447351628 * math.sin(i * 2 * math.pi / 40), 11.5) * Cylinder(0.555, 7)
        for i in range(40)
    ]
    body = disc(14.5, 1, 7) + rim.cut(*grooves) + disc(14.5, 1, 15)
    body = body + disc(9, 7, 0)
    body = body - Pos(0, 0, 8) * Cylinder(2.5, 32)
    return body - Pos(5.75, 0, 3.5) * Rot(0, 90, 0) * Cylinder(1.25, 7.5)
