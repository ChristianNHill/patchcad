/** Viewport measuring and sectioning, kept free of three.js so it can be
 *  tested without a renderer. Everything is world millimetres, z-up. */

export type Vec3 = [number, number, number];

/** A clicked surface point and the outward normal of the face it landed on. */
export interface MeasurePoint {
  point: Vec3;
  normal: Vec3 | null;
}

export interface Measurement {
  /** Straight-line distance between the two clicked points. */
  distance: number;
  /** When both clicks landed on parallel faces (within 1°), the distance
   *  between the two face planes: the wall thickness or gap a caliper reads,
   *  which the point distance only equals if the clicks happen to line up. */
  faceGap: number | null;
  mid: Vec3;
}

const PARALLEL = Math.cos((1 * Math.PI) / 180);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.sqrt(dot(a, a));

export function measure(a: MeasurePoint, b: MeasurePoint): Measurement {
  const d = sub(b.point, a.point);
  const mid: Vec3 = [(a.point[0] + b.point[0]) / 2, (a.point[1] + b.point[1]) / 2, (a.point[2] + b.point[2]) / 2];
  let faceGap: number | null = null;
  if (a.normal && b.normal) {
    const na = len(a.normal);
    const nb = len(b.normal);
    if (na > 0 && nb > 0 && Math.abs(dot(a.normal, b.normal)) / (na * nb) >= PARALLEL) {
      faceGap = Math.abs(dot(d, a.normal)) / na;
    }
  }
  return { distance: len(d), faceGap, mid };
}

export function fmtMm(v: number): string {
  return `${v.toFixed(v >= 100 ? 1 : 2)} mm`;
}

export type Axis = 0 | 1 | 2;

/**
 * A section plane through `axis` at `offset`, as three.js's Plane wants it
 * (normal · p + constant ≥ 0 is KEPT). The normal points down the axis, so the
 * part below the offset stays and the cut face looks back along +axis, which
 * is where the camera usually sits.
 */
export function sectionPlane(axis: Axis, offset: number): { normal: Vec3; constant: number } {
  const normal: Vec3 = [0, 0, 0];
  normal[axis] = -1;
  return { normal, constant: offset };
}

/** Slider position (0..1) → offset along the axis, across the model's bounds. */
export function sectionOffset(min: Vec3, max: Vec3, axis: Axis, t: number): number {
  return min[axis] + (max[axis] - min[axis]) * Math.min(Math.max(t, 0), 1);
}
