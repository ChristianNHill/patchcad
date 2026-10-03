from build123d import *

def build(p):
    h = p.hub_height
    rotor = Pos(0, 0, h / 2) * Cylinder(p.hub_diameter / 2, h)
    reach = p.rotor_diameter / 2 - p.hub_diameter / 2 + 2
    for k in range(int(p.blade_count)):
        blade = Pos(p.hub_diameter / 2 - 2 + reach / 2, 0, h / 2) * Box(reach, p.blade_width, p.blade_thickness)
        rotor = rotor + Rot(0, 0, 360 * k / p.blade_count) * blade
    # D-bore on the shaft: slip fit, flat facing +x where the shaft's flat is.
    d = p.j1_shaft_d + 0.15
    bore = Pos(0, 0, h / 2) * Cylinder(d / 2, h + 2)
    bore = bore - Pos(p.j1_flat + d, 0, h / 2) * Box(2 * d, 2 * d, h + 4)
    return rotor - bore
