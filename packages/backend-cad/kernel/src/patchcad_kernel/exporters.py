"""Getting geometry back OUT.

Everything upstream of this file exists to make a part correct; none of it is
worth much if the part cannot leave. Three audiences, three answers:

  - A slicer wants a MESH of one part, in its own frame, lying however it was
    modelled. STL is the universal answer, 3MF the better one (it carries
    units, so nothing arrives at 1/1000 scale).
  - Another CAD tool wants B-REP, which only build123d shapes have. A posed
    assembly is an XCAF assembly: one named, coloured child per placed copy,
    each the part moved by its world matrix. A fused solid would be useless.
  - A posed assembly as a mesh: 3MF keeps one named object per part, STL has
    no objects and gets one combined mesh.
"""

from __future__ import annotations

import os
from typing import Any

import numpy as np

from .gates import GateError
from .meshpart import EXPORT_TOL_MM, MeshPart, to_trimesh, weld
from .render import _mesh_arrays, combine, transform

MESH_FORMATS = {"stl", "3mf", "obj"}
BREP_FORMATS = {"step"}
SUPPORTED = MESH_FORMATS | BREP_FORMATS

#: 3MF and STEP record units; STL and OBJ do not, and every slicer on earth
#: assumes millimetres for them. The kernel works in millimetres throughout,
#: so nothing needs scaling — this is only here to explain why.
UNITS = "mm"

#: Assembly STEP colours, cycled per part so neighbours read apart in another
#: CAD tool. Muted on purpose: these are for telling parts apart, not branding.
PALETTE = [(0.54, 0.54, 0.52), (0.30, 0.45, 0.62), (0.70, 0.55, 0.35),
           (0.42, 0.58, 0.42), (0.62, 0.40, 0.40), (0.50, 0.42, 0.62)]


def _rows(matrix: list[float]) -> np.ndarray:
    """Column-major 16 floats (the solver's layout) → a row-major 4x4."""
    return np.asarray(matrix, dtype=np.float64).reshape(4, 4).T if len(matrix) == 16 else np.eye(4)


def _posed(shape: Any, matrix: list[float]) -> Any:
    from build123d import Location
    from OCP.gp import gp_Trsf

    if len(matrix) != 16:
        return shape
    m = _rows(matrix)
    t = gp_Trsf()
    t.SetValues(*m[0], *m[1], *m[2])
    return shape.moved(Location(t))


def _copies(name: str, matrices: list[list[float]]) -> list[tuple[str, list[float]]]:
    """(label, matrix) per placed copy: `bracket`, or `skid#1`, `skid#2`."""
    if len(matrices) <= 1:
        return [(name, matrices[0] if matrices else [])]
    return [(f"{name}#{k + 1}", m) for k, m in enumerate(matrices)]


def export_parts(parts: list[dict[str, Any]], path: str, fmt: str) -> dict[str, Any]:
    """Write `parts` to `path` in `fmt`. Each part is `{shape, name, matrices}`:
    one world matrix per placed copy, `[[]]` for a part in its own frame.

    Writes through a temp file and renames, because the cache keys on the
    file merely EXISTING: an export that dies part-way (a missing optional
    dependency, say) would otherwise leave a zero-byte file that every later
    request happily serves as a cache hit, poisoning that hash permanently.
    """
    fmt = fmt.lower()
    if fmt not in SUPPORTED:
        raise GateError("EXPORT", f"unsupported format {fmt!r}", f"use one of: {', '.join(sorted(SUPPORTED))}")
    if not parts:
        raise GateError("EXPORT", "nothing to export", "cook at least one part first")
    tmp = f"{path}.part"
    if fmt in BREP_FORMATS:
        info = _export_step(parts, tmp)
    elif fmt == "3mf":
        info = _export_3mf(parts, tmp)
    else:
        info = _export_combined(parts, tmp, fmt)
    os.replace(tmp, path)
    return {"format": fmt, "units": UNITS, **info}


def _export_step(parts: list[dict[str, Any]], tmp: str) -> dict[str, Any]:
    from build123d import Color, Compound, export_step

    # An imported mesh has no B-rep. Sewing every triangle into a face would
    # write a STEP file nobody can edit and that takes minutes on a scan, so
    # those parts are left out and NAMED in the result instead of vanishing.
    skipped = [p["name"] for p in parts if isinstance(p["shape"], MeshPart)]
    brep = [p for p in parts if not isinstance(p["shape"], MeshPart)]
    if not brep:
        raise GateError(
            "EXPORT",
            "every part here is an imported mesh and has no B-rep to write",
            "imported geometry can only leave as stl/3mf/obj",
        )
    children = []
    for i, part in enumerate(brep):
        # Copies share one product in XCAF, and a product has ONE name: label
        # them `skid#1`/`skid#2` and both come back `skid#2`. So every copy
        # carries the part's name, which is what an instance is anyway.
        for _, matrix in _copies(part["name"], part["matrices"]):
            child = _posed(part["shape"], matrix)
            child.label = part["name"]
            child.color = Color(*PALETTE[i % len(PALETTE)])
            children.append(child)
    if len(children) == 1:
        export_step(children[0], tmp)
    else:
        export_step(Compound(children=children, label="assembly"), tmp)
    out: dict[str, Any] = {"parts": len(brep), "solids": len(children), "names": [c.label for c in children]}
    if skipped:
        out["skipped"] = skipped
        out["warning"] = f"imported mesh part(s) left out of STEP, no B-rep: {', '.join(skipped)}"
    return out


def _welded(shape: Any) -> Any:
    # Tessellation emits coincident vertices per face, which leaves every mesh
    # reading as open even when the solid is closed — and a slicer trusts that
    # flag. G2 checks this same weld (gates._g2_watertight).
    return weld(to_trimesh(shape, EXPORT_TOL_MM, process=False).copy())  # finer than a render: this gets printed


def _export_3mf(parts: list[dict[str, Any]], tmp: str) -> dict[str, Any]:
    """One named object per part; instanced copies are build items that share
    their part's mesh, each with its own transform."""
    import trimesh

    scene = trimesh.Scene()
    triangles, watertight, names = 0, True, []
    for part in parts:
        mesh = _welded(part["shape"])
        watertight &= bool(mesh.is_watertight)
        name = scene.add_geometry(mesh, geom_name=part["name"])
        scene.graph.transforms.remove_node(name)  # add_geometry placed it once at identity
        for label, matrix in _copies(part["name"], part["matrices"]):
            # add_geometry per copy would write the mesh N times under
            # renamed objects; a graph edge reuses the one object.
            scene.graph.update(frame_to=label, frame_from=scene.graph.base_frame,
                               matrix=_rows(matrix), geometry=name)
            triangles += len(mesh.faces)
            names.append(label)
    scene.export(tmp, file_type="3mf")
    return {"parts": len(parts), "objects": len(names), "names": names,
            "triangles": triangles, "watertight": watertight}


def _export_combined(parts: list[dict[str, Any]], tmp: str, fmt: str) -> dict[str, Any]:
    """STL and OBJ: one mesh, every copy transformed into place."""
    import trimesh

    meshed = []
    for part in parts:
        v, t = _mesh_arrays(part["shape"], tol=EXPORT_TOL_MM)
        for _, matrix in _copies(part["name"], part["matrices"]):
            meshed.append((transform(v, matrix) if matrix else v, t))
    v, t = combine(meshed)
    mesh = trimesh.Trimesh(vertices=v, faces=t, process=False)
    weld(mesh)  # see _welded
    mesh.export(tmp, file_type=fmt)
    return {"parts": len(parts), "triangles": len(t), "watertight": bool(mesh.is_watertight)}
