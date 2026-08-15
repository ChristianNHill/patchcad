from build123d import *

def build(p):
    plate = Box(p.width, p.depth, p.thickness)
    inset = p.hole_inset
    for sx in (-1, 1):
        for sy in (-1, 1):
            hole = Pos(sx * (p.width / 2 - inset), sy * (p.depth / 2 - inset), 0) * \
                Cylinder(p.hole_diameter / 2, p.thickness)
            plate = plate - hole
    return plate
