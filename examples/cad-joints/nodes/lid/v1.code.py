from build123d import *

def build(p):
    t = p.thickness
    lid = Pos(0, 0, t / 2) * Box(p.width, p.width, t)
    for sx in (-1, 1):
        for sy in (-1, 1):
            lid = lid - Pos(sx * 22, sy * 22, t / 2) * Cylinder(p.j1_clear / 2, t * 2)
    return lid
