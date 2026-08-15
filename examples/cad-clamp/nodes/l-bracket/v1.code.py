from build123d import *

def build(p):
    t = p.thickness
    base = Pos(0, 0, t / 2) * Box(p.width, p.depth, t)
    wall = Pos(0, p.depth / 2 - t / 2, p.height / 2) * Box(p.width, t, p.height)
    bracket = base + wall
    base_hole = Pos(0, -p.depth / 2 + p.hole_inset, t / 2) * Cylinder(p.hole_diameter / 2, t)
    wall_hole = Pos(0, p.depth / 2 - t / 2, p.height - p.hole_inset) * \
        Rot(90, 0, 0) * Cylinder(p.hole_diameter / 2, t)
    return bracket - base_hole - wall_hole
