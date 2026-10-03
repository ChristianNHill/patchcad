from build123d import *
import math

def build(p):
    H = p.housing_height
    t = p.plate_thickness
    # The motor's axis, as the joint rules placed it (the j1_motor_mount port).
    cx = 48.58
    x0, x1 = -p.tower_diameter / 2, cx + 30
    plate = Pos((x0 + x1) / 2, 0, H - t / 2) * Box(x1 - x0, p.plate_width, t)
    tower = Pos(0, 0, H / 2) * Cylinder(p.tower_diameter / 2, H)
    body = plate + tower
    # A bearing seat in each face of the tower, pressed: 0.05 under the OD.
    seat = p.j1_seat_od - 0.05
    w = p.j1_seat_w
    body = body - Pos(0, 0, H - w / 2 + 0.5) * Cylinder(seat / 2, w + 1)
    body = body - Pos(0, 0, w / 2 - 0.5) * Cylinder(seat / 2, w + 1)
    body = body - Pos(0, 0, H / 2) * Cylinder(p.j1_seat_od / 4 - 0.5, H + 2)
    # The motor under the plate: its pilot through a slip-fit bore, four M3
    # clearance holes on the 31mm square.
    body = body - Pos(cx, 0, H - t / 2) * Cylinder((p.j1_pilot + 0.15) / 2, t + 2)
    for sx in (-1, 1):
        for sy in (-1, 1):
            body = body - Pos(cx + sx * 15.5, sy * 15.5, H - t / 2) * Cylinder(3.4 / 2, t + 2)
    return body
