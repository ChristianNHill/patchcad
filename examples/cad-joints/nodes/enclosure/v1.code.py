from build123d import *

def build(p):
    H = p.height
    body = Pos(0, 0, H / 2) * Box(p.width, p.width, H)
    body = body - Pos(0, 0, p.floor + H / 2) * Cylinder(p.cavity_diameter / 2, H)
    # A heat-set insert pocket in each solid corner, at the declared Ø, as deep
    # as the screw reaches plus room for the melt.
    for sx in (-1, 1):
        for sy in (-1, 1):
            depth = p.j1_pocket + 0.5
            body = body - Pos(sx * 22, sy * 22, H - depth / 2) * Cylinder(p.j1_insert_d / 2, depth)
    return body
