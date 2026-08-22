"""Getting geometry back OUT.

Everything upstream of this file exists to make a part correct; none of it is
worth much if the part cannot leave. Two audiences, two answers:

  - A slicer wants a MESH of one part, in its own frame, lying however it was
    modelled. STL is the universal answer, 3MF the better one (it carries
    units, so nothing arrives at 1/1000 scale).
  - Another CAD tool wants B-REP, which only build123d shapes have. STEP is
    per-part by design here: a posed assembly would need every part's world
    transform pushed into OCCT, and a single fused solid is not what anyone
    wants to open anyway.

The posed assembly is offered as a mesh only, for reference and for anyone who
wants to print the whole thing as one object.
"""

from __future__ import annotations

import os
from typing import Any

from .gates import GateError
from .render import _mesh_arrays, combine, transform

MESH_FORMATS = {"stl", "3mf", "obj"}
BREP_FORMATS = {"step"}
SUPPORTED = MESH_FORMATS | BREP_FORMATS

#: 3MF and STEP record units; STL and OBJ do not, and every slicer on earth
#: assumes millimetres for them. The kernel works in millimetres throughout,
#: so nothing needs scaling — this is only here to explain why.
UNITS = "mm"


def export_parts(parts: list[tuple[Any, list[float]]], path: str, fmt: str) -> dict[str, Any]:
    """Write `parts` (shape, world-matrix) to `path` in `fmt`.

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

    if fmt in BREP_FORMATS:
        if len(parts) != 1:
            raise GateError(
                "EXPORT",
                "STEP export is one part at a time",
                "export each part separately, or choose stl/3mf for the whole assembly",
            )
        shape = parts[0][0]
        if not hasattr(shape, "wrapped"):
            raise GateError(
                "EXPORT",
                "this part is an imported mesh and has no B-rep to write",
                "imported geometry can only leave as stl/3mf/obj",
            )
        from build123d import export_step

        tmp = f"{path}.part"
        export_step(shape, tmp)
        os.replace(tmp, path)
        return {"format": fmt, "parts": 1, "units": UNITS}

    import trimesh

    meshed = []
    for shape, matrix in parts:
        v, t = _mesh_arrays(shape, tol=0.05)  # finer than a render: this gets printed
        meshed.append((transform(v, matrix) if matrix else v, t))
    v, t = combine(meshed)
    mesh = trimesh.Trimesh(vertices=v, faces=t, process=False)
    # Tessellation emits coincident vertices per face, which leaves every mesh
    # reading as open even when the solid is closed — and a slicer trusts that
    # flag. merge_vertices only welds duplicates; it is NOT process(validate=True),
    # which is documented to turn interior hole tunnels inside out.
    mesh.merge_vertices()
    tmp = f"{path}.part"
    mesh.export(tmp, file_type=fmt)
    os.replace(tmp, path)
    return {
        "format": fmt,
        "parts": len(parts),
        "units": UNITS,
        "triangles": int(len(t)),
        "watertight": bool(mesh.is_watertight),
    }
