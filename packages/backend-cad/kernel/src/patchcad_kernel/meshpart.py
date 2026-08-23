"""Imported-mesh support: STL/3MF/STEP files become graph nodes.

MeshPart wraps a watertight trimesh so it satisfies the same gate interface
as build123d shapes (volume, area, solids, is_valid, bounding_box, tessellate,
is_inside) — imported pieces run through G2/G3/G4 and export like any cooked
part. Segmentation turns one solid into printable pieces: plane cuts along
the longest axis (manifold booleans), with optional alignment/screw holes at
each cut interface. The cut planes become the pieces' mating contracts.
"""

from __future__ import annotations

import base64
import io
import os
from dataclasses import dataclass
from typing import Any

import numpy as np
import trimesh


TESSELLATION_LIMIT = 500_000  # faces; imports beyond this get decimated

# Alignment pegs (joint mode "pegs"): the PEG IS SMALLER THAN ITS SOCKET —
# 0.3 mm diametral clearance is the standard FDM slip fit; equal diameters
# never assemble off a printer.
PEG_D = 5.0
PEG_CLEARANCE = 0.3
PEG_LEN = 6.0


class _Vec:
    def __init__(self, x: float, y: float, z: float):
        self.X, self.Y, self.Z = float(x), float(y), float(z)


class _BBox:
    def __init__(self, bounds: np.ndarray):
        self.min = _Vec(*bounds[0])
        self.max = _Vec(*bounds[1])
        self.size = _Vec(*(bounds[1] - bounds[0]))


class MeshPart:
    """Duck-typed stand-in for a build123d Part, backed by a trimesh."""

    def __init__(self, mesh: trimesh.Trimesh):
        self.mesh = mesh

    # --- gate interface -----------------------------------------------------
    @property
    def volume(self) -> float:
        return float(self.mesh.volume)

    @property
    def area(self) -> float:
        return float(self.mesh.area)

    def solids(self) -> list[Any]:
        return [self] if len(self.mesh.faces) > 0 else []

    @property
    def is_valid(self) -> bool:
        return bool(self.mesh.is_watertight)

    def bounding_box(self) -> _BBox:
        return _BBox(self.mesh.bounds)

    def tessellate(self, _tolerance: float) -> tuple[list[_Vec], list[tuple[int, ...]]]:
        verts = [_Vec(*v) for v in self.mesh.vertices]
        return verts, [tuple(f) for f in self.mesh.faces]

    def is_inside(self, point: tuple[float, float, float]) -> bool:
        return bool(self.mesh.contains(np.array([point]))[0])

    # --- boolean interop: imported meshes edit like any part -----------------
    # `load_import("x.ply") - Pos(...) * Cylinder(...)` works: build123d shapes
    # tessellate to meshes and manifold does the boolean, so LLM reprompts use
    # the exact same vocabulary on imported geometry as on generated parts.
    def _coerce(self, other: Any) -> trimesh.Trimesh:
        if isinstance(other, MeshPart):
            return other.mesh  # already a volume, and NOT ours to repair in place
        # OCP tessellation duplicates vertices per face — to_trimesh welds
        # (process=True) so the result is a closed volume manifold can boolean.
        mesh = to_trimesh(other, 0.05)
        if not mesh.is_watertight:
            mesh.merge_vertices(merge_tex=True, merge_norm=True)
            trimesh.repair.fill_holes(mesh)
        return mesh

    def __sub__(self, other: Any) -> "MeshPart":
        return MeshPart(_boolean(self.mesh, "difference", self._coerce(other)))

    def __add__(self, other: Any) -> "MeshPart":
        return MeshPart(_boolean(self.mesh, "union", self._coerce(other)))

    def __and__(self, other: Any) -> "MeshPart":
        return MeshPart(_boolean(self.mesh, "intersection", self._coerce(other)))

    def export_glb(self, path: str) -> None:
        # match build123d's export convention: meters, Y-up glTF
        m = self.mesh.copy()
        m.apply_scale(0.001)
        m.apply_transform(
            np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float)
        )
        m.export(path)


def to_trimesh(shape: Any, tol: float, process: bool = True) -> trimesh.Trimesh:
    """Any part → a trimesh. The one place that answers "is this a MeshPart or a
    build123d shape". Four copies of this branch existed and three of them
    sniffed for MeshPart differently (`.trimesh`, `not callable(.mesh)`,
    `isinstance(.mesh, Trimesh)`) — isinstance, never hasattr, because a
    build123d shape carries a .mesh METHOD.

    A MeshPart hands over its OWN mesh, not a copy: callers that transform or
    repair must copy first. build123d shapes tessellate at `tol` and are welded
    (process=True) unless the caller only wants the raw arrays — OCP emits
    vertices duplicated per face, and a boolean or a watertight flag read off
    an unwelded shell is nonsense."""
    if isinstance(shape, MeshPart):
        return shape.mesh
    verts, faces = shape.tessellate(tol)
    return trimesh.Trimesh(
        vertices=[(v.X, v.Y, v.Z) for v in verts],
        faces=[tuple(f) for f in faces],
        process=process,
    )


# --- loading ----------------------------------------------------------------

def load_mesh_file(filename: str, data: bytes) -> list[trimesh.Trimesh]:
    """Load STL/3MF/STEP bytes → list of watertight-ish component meshes (mm)."""
    ext = os.path.splitext(filename.lower())[1]
    if ext in (".stl", ".3mf", ".obj", ".ply"):
        # PLY loads verbatim (our own manifold-clean piece files — vertex
        # merging would break watertightness); soups get welded.
        loaded = trimesh.load(
            io.BytesIO(data), file_type=ext[1:], force="scene", process=ext != ".ply"
        )
        meshes = [g for g in loaded.geometry.values()] if isinstance(loaded, trimesh.Scene) else [loaded]
        merged = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
        parts = merged.split(only_watertight=False)
        return [p for p in parts if len(p.faces) > 0] or [merged]
    if ext in (".step", ".stp"):
        # B-rep in → tessellate each solid so segmentation is uniform mesh math.
        import tempfile
        from build123d import import_step

        with tempfile.NamedTemporaryFile(suffix=".step", delete=False) as f:
            f.write(data)
            tmp = f.name
        try:
            shape = import_step(tmp)
            solids = shape.solids() if hasattr(shape, "solids") else [shape]
            out = []
            for s in solids:
                verts, faces = s.tessellate(0.2)
                out.append(
                    trimesh.Trimesh(
                        vertices=[(v.X, v.Y, v.Z) for v in verts],
                        faces=[tuple(f_) for f_ in faces],
                        process=True,
                    )
                )
            return out
        finally:
            os.unlink(tmp)
    raise ValueError(f"unsupported import format {ext!r} — STL, 3MF, OBJ, PLY, or STEP")


# --- segmentation -----------------------------------------------------------

@dataclass
class Interface:
    piece_a: int
    piece_b: int
    """cut plane: point + normal (from piece_a toward piece_b), part-global mm"""
    origin: list[float]
    normal: list[float]
    holes: list[dict[str, Any]]  # {center: [x,y,z], diameter: float}
    pegs: list[dict[str, Any]]  # {center, peg_diameter, socket_diameter, length}
    face_size: float = 3.0  # probe extent that actually fits in material at the anchor


def _boolean(a: trimesh.Trimesh, op: str, b: trimesh.Trimesh) -> trimesh.Trimesh:
    fn = {"difference": trimesh.boolean.difference,
          "intersection": trimesh.boolean.intersection,
          "union": trimesh.boolean.union}[op]
    # manifold output is already watertight with consistent winding; a
    # validate pass would "fix" interior hole tunnels into positive shells.
    return fn([a, b], engine="manifold")


def _slab(bounds: np.ndarray, axis: int, lo: float, hi: float) -> trimesh.Trimesh:
    pad = 1.0
    mins = bounds[0] - pad
    maxs = bounds[1] + pad
    mins[axis] = lo
    maxs[axis] = hi
    return trimesh.creation.box(bounds=np.array([mins, maxs]))


def _area_profile(solid: trimesh.Trimesh, axis: int, stations: int = 64) -> tuple[np.ndarray, np.ndarray]:
    """Cross-section area swept along an axis (on a decimated copy — analysis
    only; cutting always happens on the full mesh)."""
    analysis = solid
    if len(analysis.faces) > 40_000:
        try:
            analysis = analysis.simplify_quadric_decimation(face_count=40_000)
        except Exception:  # noqa: BLE001
            pass
    lo, hi = float(solid.bounds[0][axis]), float(solid.bounds[1][axis])
    span = hi - lo
    xs = np.linspace(lo + span * 0.05, hi - span * 0.05, stations)
    areas = np.zeros(stations)
    for i, s in enumerate(xs):
        try:
            sec = analysis.section(plane_origin=np.eye(3)[axis] * s, plane_normal=np.eye(3)[axis])
            if sec is None or len(sec.vertices) == 0:
                areas[i] = 0.0
                continue
            planar, _ = sec.to_planar()
            areas[i] = float(sum(p.area for p in planar.polygons_full)) or 0.0
        except Exception:  # noqa: BLE001
            areas[i] = areas[i - 1] if i else 0.0
    # light smoothing so tessellation noise does not fake necks
    kernel = np.ones(3) / 3.0
    areas = np.convolve(areas, kernel, mode="same")
    return xs, areas


def find_natural_cuts(solid: trimesh.Trimesh, max_cuts: int = 6) -> tuple[int, list[float]]:
    """The minima rule: parts separate where the cross-section pinches. Sweep
    all three axes; on the best one, keep prominent local minima (a neck must
    dip below 55% of the smaller neighboring bulge) spaced at least 8% of the
    span apart. Returns (axis, cut positions) — empty when the shape has no
    convincing necks (then it is honestly one piece)."""
    extents = solid.bounds[1] - solid.bounds[0]
    best: tuple[float, int, list[float]] = (0.0, int(np.argmax(extents)), [])
    for axis in range(3):
        span = float(extents[axis])
        if span < 20.0:
            continue
        xs, areas = _area_profile(solid, axis)
        peak = float(areas.max())
        if peak <= 0:
            continue
        candidates: list[tuple[float, float]] = []  # (depth score, position)
        minima: list[tuple[float, float, float]] = []  # (depth, position, area)
        # 1. deep local minima BETWEEN bulges (two orbs touching)
        for i in range(2, len(xs) - 2):
            if not (areas[i] <= areas[i - 1] and areas[i] <= areas[i + 1]):
                continue
            left_bulge = float(areas[:i].max())
            right_bulge = float(areas[i + 1 :].max())
            bulge = min(left_bulge, right_bulge)
            if bulge <= 0:
                continue
            ratio = float(areas[i]) / bulge
            if ratio < 0.55:
                minima.append((1.0 - ratio, float(xs[i]), float(areas[i])))
        # 2. bulge boundaries against the baseline (an orb on a plain shaft):
        #    cut where the profile crosses well above its typical level.
        baseline = float(np.median(areas[areas > 0])) if (areas > 0).any() else 0.0
        threshold = max(baseline * 1.6, baseline + 0.25 * (peak - baseline))
        boundary_cuts = 0
        if baseline > 0 and peak > threshold:
            above = areas > threshold
            for i in range(1, len(xs)):
                if above[i] != above[i - 1]:
                    depth = 1.0 - baseline / max(peak, 1e-9)
                    candidates.append((depth * 0.9, float((xs[i] + xs[i - 1]) / 2)))
                    boundary_cuts += 1
        # A flat shaft plateau is not a neck: when bulge boundaries already
        # partition the shape, keep only minima that dip meaningfully below
        # the baseline region OR sit well above it (true necks between bulges).
        for depth, pos, area in minima:
            if boundary_cuts > 0 and baseline > 0 and area <= baseline * 1.15:
                continue
            candidates.append((depth, pos))
        # merge near-duplicate necks: keep the deepest within 8% of the span
        candidates.sort(key=lambda c: c[1])
        merged: list[tuple[float, float]] = []
        for depth, pos in candidates:
            if merged and abs(pos - merged[-1][1]) < span * 0.08:
                if depth > merged[-1][0]:
                    merged[-1] = (depth, pos)
            else:
                merged.append((depth, pos))
        merged.sort(key=lambda c: c[0], reverse=True)
        kept = sorted(pos for _, pos in merged[:max_cuts])
        score = sum(d for d, _ in merged[:max_cuts])
        if score > best[0]:
            best = (score, axis, kept)
    return best[1], best[2]


def _solid_on_both_sides(solid: trimesh.Trimesh, pt: np.ndarray, axis: int, eps: float = 0.5) -> bool:
    """A joint/anchor point is only real if the solid crosses the cut plane
    there — 2D section polygons lie on messy meshes (unrecorded voids)."""
    lo = pt.copy(); lo[axis] -= eps
    hi = pt.copy(); hi[axis] += eps
    try:
        return bool(solid.contains(np.array([lo, hi])).all())
    except Exception:  # noqa: BLE001
        return False


def _crossing_spans(
    solid: trimesh.Trimesh, axis: int, plane: float, lines: int = 25, eps: float = 0.5
) -> list[tuple[float, float, float]]:
    """Material spans that CROSS the cut plane, as (width, u_mid, v) sorted
    widest-first. Ray-casts the two offset planes (plane ± eps) along u for a
    fan of v lines and intersects the solid intervals — immune to the phantom
    polygons that 2D sections produce on messy meshes. A connected solid
    always has at least one crossing span at any interior cut."""
    u, v = [a for a in range(3) if a != axis]
    lo, hi = solid.bounds
    spans: list[tuple[float, float, float]] = []
    for vv in np.linspace(lo[v], hi[v], lines + 2)[1:-1]:
        sides: list[list[tuple[float, float]]] = []
        for side in (-eps, eps):
            origin = np.zeros(3)
            origin[axis] = plane + side
            origin[u] = lo[u] - 1.0
            origin[v] = vv
            direction = np.zeros(3)
            direction[u] = 1.0
            try:
                locs = solid.ray.intersects_location(
                    ray_origins=[origin], ray_directions=[direction]
                )[0]
            except Exception:  # noqa: BLE001
                locs = np.zeros((0, 3))
            ts = np.unique(np.round(locs[:, u], 6)) if len(locs) else np.zeros(0)
            if len(ts) % 2:  # grazing hit broke entry/exit parity — skip line
                sides.append([])
                continue
            sides.append([(float(ts[j]), float(ts[j + 1])) for j in range(0, len(ts), 2)])
        for a0, a1 in sides[0]:
            for b0, b1 in sides[1]:
                s0, s1 = max(a0, b0), min(a1, b1)
                if s1 - s0 > 1.0:
                    spans.append((s1 - s0, (s0 + s1) / 2, float(vv)))
    spans.sort(key=lambda s: s[0], reverse=True)
    return spans


def _probed_face_size(solid: trimesh.Trimesh, anchor: np.ndarray, axis: int, cap: float = 3.0) -> float:
    """Largest probe grid (G3 samples corners at ±size/2) proven to sit in
    material on both sides of the plane; 0.6 = center-only probe."""
    uv = [a for a in range(3) if a != axis]
    off = np.zeros(3)
    off[axis] = 0.5
    for s in (min(cap, 3.0) / 2, 0.75, 0.375):
        if s < 0.35:
            continue
        corners = []
        for du in (-s, s):
            for dv in (-s, s):
                c = anchor.copy()
                c[uv[0]] += du
                c[uv[1]] += dv
                corners.append(c)
        arr = np.array(corners)
        try:
            if solid.contains(arr - off).all() and solid.contains(arr + off).all():
                return round(s * 2, 2)
        except Exception:  # noqa: BLE001
            pass
    return 0.6


def segment(
    components: list[trimesh.Trimesh],
    pieces: int,
    joints: str,
    thread: str,
) -> tuple[list[trimesh.Trimesh], list[Interface]]:
    """Multi-body files: one piece per body (no cutting). Single solids with
    pieces > 1: equal slabs along the longest axis. Joints at each cut:
    "holes" = thread-clearance through-holes for screws; "pegs" = an alignment
    peg grown on the low side + a CLEARANCE-FIT socket cut into the high side."""
    join_holes = joints in ("holes", "pegs")  # both modes need placement points
    if len(components) > 1 or pieces == 1:
        return components, []

    solid = components[0]
    bounds = solid.bounds
    extents = bounds[1] - bounds[0]

    if pieces == 0:  # auto: cut at the shape's natural necks
        axis, planes = find_natural_cuts(solid)
        if not planes:
            return components, []  # no convincing necks — honestly one piece
    else:
        axis = int(np.argmax(extents))
        lo0, hi0 = float(bounds[0][axis]), float(bounds[1][axis])
        step = (hi0 - lo0) / pieces
        planes = [lo0 + step * i for i in range(1, pieces)]

    lo, hi = float(bounds[0][axis]), float(bounds[1][axis])
    # The slab boundaries are what a joining hole has to reach, so they are
    # computed here rather than at the cut, and the cut reads them.
    boundaries = [lo - 1.0, *planes, hi + 1.0]

    # Kernel-side mirror of the TS fastener registry's clearance dims (mm).
    # Single source of truth is packages/backend-cad/src/registry.ts. The
    # cross-language duplication is unavoidable; a whole module for one 3-entry
    # dict with one reader was not.
    hole_d = {"M3": 3.4, "M4": 4.5, "M5": 5.5}.get(thread.upper(), 4.5)
    interfaces: list[Interface] = []
    hole_cutters: list[trimesh.Trimesh] = []

    for i, plane in enumerate(planes, start=1):
        # Placement never trusts 2D section polygons (they mis-nest on messy
        # meshes and claim material over voids). Everything — joints and the
        # mating-face anchor — comes from ray-cast crossing spans, each point
        # 3D-validated on the actual solid before it is declared.
        spans = _crossing_spans(solid, axis, plane)
        u, v = [a for a in range(3) if a != axis]

        def to3(u_val: float, v_val: float, _u: int = u, _v: int = v) -> np.ndarray:
            pt = np.zeros(3)
            pt[axis] = plane
            pt[_u] = u_val
            pt[_v] = v_val
            return pt

        hole_pts: list[np.ndarray] = []
        if join_holes:
            for width, u_mid, v_val in spans:
                if width < hole_d + 2:
                    continue
                # wide spans offer spread-out candidates (anti-rotation pairs)
                offsets = [0.0] if width < hole_d * 4 else [-width / 4, width / 4, 0.0]
                for du in offsets:
                    cand = to3(u_mid + du, v_val)
                    if any(np.linalg.norm(cand - hp) < hole_d * 2 for hp in hole_pts):
                        continue
                    if _solid_on_both_sides(solid, cand, axis, eps=1.5):
                        hole_pts.append(cand)
                    if len(hole_pts) == 2:
                        break
                if len(hole_pts) == 2:
                    break

        anchor3: np.ndarray | None = None
        face_size = 0.6
        for width, u_mid, v_val in spans:
            cand = to3(u_mid, v_val)
            if any(np.linalg.norm(cand - hp) < hole_d / 2 + 3.0 for hp in hole_pts):
                continue
            if _solid_on_both_sides(solid, cand, axis):
                anchor3 = cand
                face_size = _probed_face_size(solid, cand, axis, cap=width - 0.4)
                break
        if anchor3 is None:
            # no verifiable crossing found — bbox centre; G3 reports honestly
            anchor3 = (bounds[0] + bounds[1]) / 2
            anchor3[axis] = plane

        holes: list[dict[str, Any]] = []
        pegs: list[dict[str, Any]] = []
        for hp in hole_pts:
            hp[axis] = plane
            if joints == "holes":
                holes.append({"center": [round(float(c), 3) for c in hp], "diameter": hole_d})
                # SPANS THE TWO SLABS THIS PLANE DIVIDES, and nothing else.
                # A screw needs to cross both pieces it joins, so the reach is
                # each neighbour's own length, not a constant and not the whole
                # model. A fixed 40mm cutter left a BLIND hole in any piece
                # thicker than 20mm; a whole-model cutter is centred on the
                # plane, so it reaches L/2 each way and goes blind again for any
                # cut more than a hair off centre, which is exactly what the
                # natural-neck path produces. It also over-drilled: on a 3-way
                # split its far end bored 21mm into a piece that does not touch
                # this interface at all.
                back = plane - boundaries[i - 1]
                fwd = boundaries[i + 1] - plane
                cyl = trimesh.creation.cylinder(radius=hole_d / 2, height=back + fwd)
                align = trimesh.geometry.align_vectors([0, 0, 1], np.eye(3)[axis])
                cyl.apply_transform(align)
                centre = hp.copy()
                centre[axis] = plane + (fwd - back) / 2
                cyl.apply_translation(centre)
                hole_cutters.append(cyl)
            elif joints == "pegs":
                pegs.append({
                    "center": [round(float(c), 3) for c in hp],
                    "peg_diameter": PEG_D,
                    "socket_diameter": round(PEG_D + PEG_CLEARANCE, 3),
                    "length": PEG_LEN,
                })

        interfaces.append(
            Interface(
                piece_a=i - 1,
                piece_b=i,
                origin=[round(float(c), 3) for c in anchor3],
                normal=[float(v) for v in np.eye(3)[axis]],
                holes=holes,
                pegs=pegs,
                face_size=round(float(face_size), 2),
            )
        )

    drilled = solid
    for cutter in hole_cutters:
        drilled = _boolean(drilled, "difference", cutter)

    result: list[trimesh.Trimesh] = []
    for i in range(len(boundaries) - 1):
        slab = _slab(bounds, axis, boundaries[i], boundaries[i + 1])
        piece = _boolean(drilled, "intersection", slab)
        if len(piece.faces) == 0:
            raise ValueError(f"cut produced an empty piece at slab {i} — try fewer pieces")
        result.append(piece)

    if joints == "pegs":
        align = trimesh.geometry.align_vectors([0, 0, 1], np.eye(3)[axis])
        for itf in interfaces:
            for peg in itf.pegs:
                center = np.asarray(peg["center"], dtype=float)
                # peg: Ø PEG_D spanning ±PEG_LEN across the plane — the minus
                # half anchors inside piece_a, the plus half protrudes into B's space
                peg_cyl = trimesh.creation.cylinder(radius=peg["peg_diameter"] / 2, height=2 * PEG_LEN)
                peg_cyl.apply_transform(align)
                peg_cyl.apply_translation(center)
                result[itf.piece_a] = _boolean(result[itf.piece_a], "union", peg_cyl)
                # socket: clearance-fit Ø, slightly deeper than the peg protrudes
                sock = trimesh.creation.cylinder(radius=peg["socket_diameter"] / 2, height=2 * (PEG_LEN + 0.8))
                sock.apply_transform(align)
                sock.apply_translation(center)
                result[itf.piece_b] = _boolean(result[itf.piece_b], "difference", sock)

    return result, interfaces


def run_import(job: dict[str, Any]) -> dict[str, Any]:
    """Worker entrypoint: decode, segment, write piece STLs + GLBs, report."""
    data = base64.b64decode(job["data_b64"])
    components = load_mesh_file(job["filename"], data)
    joints = str(job.get("joints") or "none")
    pieces, interfaces = segment(
        components,
        pieces=int(job.get("pieces", 1)),
        joints=joints,
        thread=str(job.get("thread", "M4")),
    )

    out_dir = job["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    report = []
    for i, mesh in enumerate(pieces):
        if len(mesh.faces) > TESSELLATION_LIMIT:
            mesh = mesh.simplify_quadric_decimation(face_count=TESSELLATION_LIMIT)
        # PLY, not STL: STL is a triangle soup — the reload re-merges vertices
        # and complex organic meshes come back non-watertight, failing G2.
        # Binary PLY round-trips the exact vertex/face arrays.
        mesh.export(os.path.join(out_dir, f"piece-{i}.ply"))
        part = MeshPart(mesh)
        part.export_glb(os.path.join(out_dir, f"piece-{i}.glb"))
        b = mesh.bounds
        report.append(
            {
                "index": i,
                "file": f"piece-{i}.ply",
                "volume_mm3": round(float(mesh.volume), 1),
                "watertight": bool(mesh.is_watertight),
                "bbox": {
                    "min": [round(float(v), 2) for v in b[0]],
                    "max": [round(float(v), 2) for v in b[1]],
                },
                "faces": len(mesh.faces),
            }
        )
    return {
        "ok": True,
        "pieces": report,
        "interfaces": [
            {
                "piece_a": itf.piece_a,
                "piece_b": itf.piece_b,
                "origin": itf.origin,
                "normal": itf.normal,
                "holes": itf.holes,
                "pegs": itf.pegs,
                "face_size": itf.face_size,
            }
            for itf in interfaces
        ],
    }


def load_import_part(import_dir: str, name: str, scale: float = 1.0) -> MeshPart:
    """`load_import("piece-0.ply", scale=p.scale)` inside node code — the
    build(p) body for imported pieces. Scale is the T0 dimension surface."""
    safe = os.path.basename(name)
    path = os.path.join(import_dir, safe)
    # process=False: the stored PLY is manifold-clean; trimesh's default vertex
    # merging fuses near-duplicates on dense organic meshes and breaks
    # watertightness (real 300k-face STL regression).
    mesh = trimesh.load(path, force="mesh", process=False)
    if scale and float(scale) != 1.0:
        mesh = mesh.copy()
        mesh.apply_scale(float(scale))
    return MeshPart(mesh)
