"""The vendor package: everything a shop needs to quote and make one
fabricated part, zipped.

  <name>.step          AP242 (AP242DIS, the schema this OCCT writes), mm, named
  <name>.dxf           laser_cut / sheet_metal: the cut profile, 1:1, mm
  <name>-drawing.pdf   dimensioned third-angle drawing (drawing.py)
  RFQ.md               process, material, finish, qty, critical dims, notes

Sheet metal gets a FLAT PATTERN only when the part is already flat (one
profile, two cap levels), because then the profile IS the flat pattern.
Neither build123d nor OCCT unfolds bends, so a bent part gets its three
projected views in the DXF and RFQ.md says no flat pattern is included.
A guessed bend allowance would be a faked flat pattern.
"""

from __future__ import annotations

import os
import zipfile
from typing import Any

import numpy as np

STEP_SCHEMA = "AP242DIS"


def write_step(shape: Any, name: str, path: str) -> None:
    """build123d's export_step writes AP214 whatever the static says (it
    replaces the header), so this drives the XCAF writer itself."""
    from build123d import Unit
    from build123d.exporters3d import _create_xde
    from OCP.Interface import Interface_Static
    from OCP.Message import Message, Message_Gravity
    from OCP.STEPCAFControl import STEPCAFControl_Controller, STEPCAFControl_Writer
    from OCP.STEPControl import STEPControl_Controller, STEPControl_StepModelType
    from OCP.XSControl import XSControl_WorkSession

    for printer in Message.DefaultMessenger_s().Printers():
        printer.SetTraceLevel(Message_Gravity.Message_Fail)
    STEPCAFControl_Controller.Init_s()
    STEPControl_Controller.Init_s()
    # The statics are process-wide and this is a warm worker: put them back,
    # or the next /export STEP from this worker comes out AP242 too.
    saved = {k: Interface_Static.CVal_s(k) for k in ("write.step.schema", "write.step.unit")}
    try:
        Interface_Static.SetCVal_s("write.step.schema", STEP_SCHEMA)
        Interface_Static.SetCVal_s("write.step.unit", "MM")
        shape.label = name
        doc = _create_xde(shape, Unit.MM, auto_naming=True)
        writer = STEPCAFControl_Writer(XSControl_WorkSession(), False)
        writer.SetNameMode(True)
        writer.SetColorMode(True)
        writer.Transfer(doc, STEPControl_StepModelType.STEPControl_AsIs)
        tmp = f"{path}.tmp"
        writer.Write(tmp)
        os.replace(tmp, path)
    finally:
        for k, v in saved.items():
            Interface_Static.SetCVal_s(k, v)


def _profile_dxf(shape: Any, path: str) -> float:
    """The mid-thickness section of a flat part, laid in XY. Returns thickness."""
    from build123d import ExportDXF, Plane, Unit, Vector, section

    from .dfm_process import planar_profile

    axis, levels, bad = planar_profile(shape)
    if bad or len(levels) != 2:
        raise ValueError("not a single extruded profile")
    mid = (levels[0] + levels[1]) / 2
    plane = Plane(origin=Vector(*(axis * mid)), z_dir=Vector(*axis))
    sec = plane.to_local_coords(section(shape, plane))
    dxf = ExportDXF(unit=Unit.MM)
    dxf.add_layer("CUT")
    dxf.add_shape(sec, layer="CUT")
    dxf.write(path)
    return levels[1] - levels[0]


def _views_dxf(shape: Any, path: str) -> None:
    """Front, top and right projections side by side, one layer per view."""
    import ezdxf

    from .drawing import project

    bb = shape.bounding_box()
    center = np.array([(bb.min.X + bb.max.X) / 2, (bb.min.Y + bb.max.Y) / 2, (bb.min.Z + bb.max.Z) / 2])
    ext = np.array([bb.size.X, bb.size.Y, bb.size.Z])
    gap = float(ext.max()) * 0.3 + 10
    offsets = {"FRONT": (0.0, 0.0), "TOP": (0.0, (ext[2] + ext[1]) / 2 + gap), "RIGHT": ((ext[0] + ext[1]) / 2 + gap, 0.0)}
    doc = ezdxf.new(units=ezdxf.units.MM)
    msp = doc.modelspace()
    for view, (ox, oy) in offsets.items():
        doc.layers.add(view)
        doc.layers.add(f"{view}_HIDDEN", linetype="DASHED")
        vis, hid = project(shape, view, center)
        for layer, lines in ((view, vis), (f"{view}_HIDDEN", hid)):
            for pl in lines:
                msp.add_lwpolyline([(x + ox, y + oy) for x, y in pl], dxfattribs={"layer": layer})
    doc.saveas(path)


def _rfq(meta: dict[str, Any], info: dict[str, Any], files: list[str], dfm: dict[str, Any] | None,
         dxf_note: str) -> str:
    ext = info["extent"]
    lines = [
        f"# RFQ: {meta.get('title') or meta.get('name')}",
        "",
        f"- Part: `{meta.get('name')}`",
        f"- Process: {meta.get('process')}",
        f"- Material: {meta.get('material') or 'not specified'}",
        f"- Finish: {meta.get('finish') or 'none specified'}",
        f"- Quantity: {meta.get('qty', 1)}",
        "- Units: mm",
        f"- Date: {meta.get('date', '')}",
        "",
        "## Files",
        "",
        *[f"- `{f}`" for f in files],
        "",
        (
            f"The STEP file is the master geometry ({STEP_SCHEMA}, millimetres). The drawing is for reference "
            "and inspection; where they disagree, the STEP governs."
        ),
        "",
        "## Critical dimensions",
        "",
        f"- Overall envelope: {ext[0]:.2f} x {ext[1]:.2f} x {ext[2]:.2f} mm (X x Y x Z)",
    ]
    for h in info["holes"]:
        got = (f", measured {'' if h['type'] == 'SLOT' else 'Ø'}{h['measured']:.3f} in the gate"
               if h["measured"] else "")
        lines.append(f"- {h['letter']} `{h['key']}` ({h['type']}): {h['text']}{got}")
    lines += ["", "## Tolerances and fits", "", *[f"- {n}" for n in info["notes"]], ""]
    if dfm:
        checked = {k: v for k, v in dfm.items() if k not in ("kind", "unchecked")}
        lines += ["## Manufacturability (G4c, passed)", "",
                  *[f"- {k}: {v}" for k, v in checked.items()]]
        for rule, why in (dfm.get("unchecked") or {}).items():
            lines.append(f"- NOT CHECKED: {rule} ({why}). Please review this by hand.")
        lines.append("")
    lines += ["## Notes", "", f"- {dxf_note}" if dxf_note else "- No DXF: this process cuts from the 3D model.",
              *[f"- {n}" for n in meta.get("notes", [])], ""]
    return "\n".join(lines)


def vendor_package(shape: Any, ports: list[dict[str, Any]], meta: dict[str, Any], out_dir: str,
                   measured: list[dict[str, Any]] | None = None, dfm: dict[str, Any] | None = None) -> dict[str, Any]:
    """Write the zip into out_dir and say what is in it."""
    from .drawing import build_sheet, svg_to_pdf

    os.makedirs(out_dir, exist_ok=True)
    name = "".join(c if c.isalnum() or c in "-_" else "_" for c in meta.get("name") or "part")
    process = meta.get("process", "")
    files: dict[str, str] = {}

    files[f"{name}.step"] = os.path.join(out_dir, f"{name}.step")
    write_step(shape, name, files[f"{name}.step"])

    dxf_note = ""
    flat_pattern = False
    if process in ("laser_cut", "sheet_metal"):
        dxf = os.path.join(out_dir, f"{name}.dxf")
        try:
            thickness = _profile_dxf(shape, dxf)
            flat_pattern = process == "sheet_metal"
            dxf_note = (f"`{name}.dxf` is the cut profile, 1:1 in mm, for {thickness:.2f} mm stock."
                        + (" The part has no bends, so this profile is its flat pattern." if process == "sheet_metal" else ""))
        except ValueError:
            if process == "laser_cut":
                raise
            _views_dxf(shape, dxf)
            dxf_note = (f"NO FLAT PATTERN INCLUDED. The part is bent and this tool cannot unfold it; `{name}.dxf` "
                        "holds the front, top and right projections of the bent part. Please develop the flat "
                        "pattern with your own bend deductions.")
        files[f"{name}.dxf"] = dxf

    if dfm and dfm.get("setups"):
        meta = {**meta, "notes": [f"MACHINED IN {dfm['setups'].upper()}.", *meta.get("notes", [])]}
    svg, info = build_sheet(shape, ports, meta, measured)
    files[f"{name}-drawing.pdf"] = os.path.join(out_dir, f"{name}-drawing.pdf")
    svg_to_pdf(svg, files[f"{name}-drawing.pdf"])

    rfq = _rfq(meta, info, [*files, "RFQ.md"], dfm, dxf_note)
    zip_path = os.path.join(out_dir, "vendor.zip")
    tmp = f"{zip_path}.tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for arc, src in files.items():
            z.write(src, arc)
        z.writestr("RFQ.md", rfq)
    os.replace(tmp, zip_path)
    return {"files": [*files, "RFQ.md"], "step_schema": STEP_SCHEMA, "flat_pattern": flat_pattern,
            "scale": info["scale"], "holes": len(info["holes"])}
