from build123d import *

def build(p):
    h = p.hub_height
    disc = Pos(0, 0, h / 2) * Cylinder(p.disc_diameter / 2, h)
    # D-bore on the shaft: slip fit, flat facing +x where the shaft's flat is.
    d = p.j1_shaft_d + 0.15
    bore = Pos(0, 0, h / 2) * Cylinder(d / 2, h + 2)
    bore = bore - Pos(p.j1_flat + d, 0, h / 2) * Box(2 * d, 2 * d, h + 4)
    return disc - bore
