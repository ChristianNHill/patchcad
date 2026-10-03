from build123d import *
import math

def build(p):
    H = p.housing_height
    plate = Pos(0, 0, p.plate_thickness / 2) * Cylinder(p.plate_diameter / 2, p.plate_thickness)
    tower = Pos(0, 0, H / 2) * Cylinder(p.tower_diameter / 2, H)
    body = plate + tower
    # Three legs lift the plate, so the collar under the lower bearing clears the bench.
    r = p.plate_diameter / 2 - 6
    for k in range(3):
        a = math.radians(90 + 120 * k)
        body = body + Pos(r * math.cos(a), r * math.sin(a), -p.leg_height / 2) * Cylinder(4, p.leg_height)
    # A bearing seat in each face of the tower, pressed: 0.05 under the OD.
    seat = p.j1_seat_od - 0.05
    w = p.j1_seat_w
    body = body - Pos(0, 0, H - w / 2 + 0.5) * Cylinder(seat / 2, w + 1)
    body = body - Pos(0, 0, w / 2 - 0.5) * Cylinder(seat / 2, w + 1)
    # Between the seats the bore steps down to half the seat, which leaves each
    # bearing a shoulder and still clears the shaft of any bearing that size.
    return body - Pos(0, 0, H / 2) * Cylinder(p.j1_seat_od / 4 - 0.5, H + 2)
