"""
CADCraft -> SolidWorks COM Bridge (Parametric Multi-Body / Multi-Feature Builder)
Converts SolidWorksBuildSpec JSON (mm) into a native SolidWorks .sldprt file
using win32com.client.Dispatch("SldWorks.Application").

UNIT CONVERSION GUARD:
All millimeter dimensions from CADCraft MUST be divided by 1000.0 before
passing coordinates to SolidWorks COM API methods (which use Meters).
"""

import json
import math
import os
import sys
from pathlib import Path

try:
    import win32com.client  # type: ignore
    import pythoncom  # type: ignore
except ImportError:
    win32com = None
    pythoncom = None


MM_TO_M = 1.0 / 1000.0


def mm_to_m(val_mm: float) -> float:
    return float(val_mm) * MM_TO_M


def connect_solidworks(visible: bool = True):
    if win32com is None:
        raise RuntimeError(
            "pywin32 is not installed. Run: bridge/solidworks/.venv/Scripts/pip install -r bridge/solidworks/requirements.txt"
        )
    pythoncom.CoInitialize()
    sw_app = win32com.client.Dispatch("SldWorks.Application")
    sw_app.Visible = bool(visible)
    return sw_app


def _sketch_hole(sketch_mgr, hole: dict):
    kind = str(hole.get("kind", "")).lower()
    if kind == "circle":
        cx = mm_to_m(hole.get("cx", 0.0))
        cy = mm_to_m(hole.get("cy", 0.0))
        r = mm_to_m(hole.get("radius", 3.0))
        sketch_mgr.CreateCircleByRadius(cx, cy, 0.0, r)
    elif kind == "rect":
        cx = mm_to_m(hole.get("cx", 0.0))
        cy = mm_to_m(hole.get("cy", 0.0))
        hw = mm_to_m(hole.get("width", 20.0)) / 2.0
        hh = mm_to_m(hole.get("height", 20.0)) / 2.0
        sketch_mgr.CreateCornerRectangle(cx - hw, cy - hh, 0.0, cx + hw, cy + hh, 0.0)
    elif kind == "slot":
        x1 = mm_to_m(hole.get("x1", 0.0))
        y1 = mm_to_m(hole.get("y1", 0.0))
        x2 = mm_to_m(hole.get("x2", 0.0))
        y2 = mm_to_m(hole.get("y2", 0.0))
        w = mm_to_m(hole.get("width", 10.0))
        sketch_mgr.CreateSketchSlot(0, 0, w, x1, y1, 0.0, x2, y2, 0.0, 0.0, 0.0, 0.0, 1, False)


def _select_offset_plane(model, base_plane: str, offset_mm: float):
    ext = model.Extension
    feat_mgr = model.FeatureManager
    ext.SelectByID2(base_plane, "PLANE", 0, 0, 0, False, 0, None, 0)
    if abs(offset_mm) > 0.01:
        flip = offset_mm < 0
        # 8 = swRefPlaneReferenceConstraint_Distance
        ref_plane = feat_mgr.InsertRefPlane(8, abs(mm_to_m(offset_mm)), 0, 0, 0, 0)
        if ref_plane is not None:
            ref_plane.Select2(False, 0)
            return
        if flip:
            ext.SelectByID2(base_plane, "PLANE", 0, 0, 0, False, 0, None, 0)


def _extrude_boss(feat_mgr, depth_m: float, merge: bool = True):
    feat_mgr.FeatureExtrusion2(
        True,   # Sd (single direction)
        False,  # Flip
        False,  # Dir
        0,      # T1 (Blind)
        0,      # T2
        depth_m,
        0.0,
        False, False, False, False,
        0.0, 0.0,
        False, False, False, False,
        merge, True, True,
        0, 0.0, False
    )


def _build_parts_3d(model, parts_3d: list) -> int:
    sketch_mgr = model.SketchManager
    feat_mgr = model.FeatureManager
    built = 0

    for part in parts_3d:
        kind = str(part.get("kind", "")).lower()
        if kind in ("plate", "box"):
            z_min = float(part.get("z_min", 0.0))
            height_m = mm_to_m(part.get("height", 12.0))
            cx = mm_to_m(part.get("cx", 0.0))
            cy = mm_to_m(part.get("cy", 0.0))
            hw = mm_to_m(part.get("width", 100.0)) / 2.0
            hh = mm_to_m(part.get("depth", 80.0)) / 2.0

            _select_offset_plane(model, "Top Plane", z_min)
            sketch_mgr.InsertSketch(True)
            sketch_mgr.CreateCornerRectangle(cx - hw, cy - hh, 0.0, cx + hw, cy + hh, 0.0)
            for hole in part.get("holes") or []:
                _sketch_hole(sketch_mgr, hole)
            sketch_mgr.InsertSketch(True)
            _extrude_boss(feat_mgr, height_m, merge=True)
            built += 1

        elif kind == "prism":
            points = part.get("points") or []
            if len(points) < 3:
                continue
            z_min = float(part.get("z_min", 0.0))
            height_m = mm_to_m(part.get("height", 20.0))
            _select_offset_plane(model, "Top Plane", z_min)
            sketch_mgr.InsertSketch(True)
            for idx in range(len(points)):
                p1 = points[idx]
                p2 = points[(idx + 1) % len(points)]
                sketch_mgr.CreateLine(
                    mm_to_m(p1[0]), mm_to_m(p1[1]), 0.0,
                    mm_to_m(p2[0]), mm_to_m(p2[1]), 0.0,
                )
            for hole in part.get("holes") or []:
                _sketch_hole(sketch_mgr, hole)
            sketch_mgr.InsertSketch(True)
            _extrude_boss(feat_mgr, height_m, merge=True)
            built += 1

        elif kind == "cylinder":
            axis = str(part.get("axis", "z")).lower()
            cx = float(part.get("cx", 0.0))
            cy = float(part.get("cy", 0.0))
            cz = float(part.get("cz", 0.0))
            r_m = mm_to_m(part.get("radius", 6.0))
            length = float(part.get("length", 40.0))
            length_m = mm_to_m(length)

            if axis == "y":
                _select_offset_plane(model, "Front Plane", cy - length / 2.0)
                sketch_mgr.InsertSketch(True)
                sketch_mgr.CreateCircleByRadius(mm_to_m(cx), mm_to_m(cz), 0.0, r_m)
                sketch_mgr.InsertSketch(True)
                _extrude_boss(feat_mgr, length_m, merge=False)
            elif axis == "x":
                _select_offset_plane(model, "Right Plane", cx - length / 2.0)
                sketch_mgr.InsertSketch(True)
                sketch_mgr.CreateCircleByRadius(mm_to_m(cy), mm_to_m(cz), 0.0, r_m)
                sketch_mgr.InsertSketch(True)
                _extrude_boss(feat_mgr, length_m, merge=False)
            else:
                _select_offset_plane(model, "Top Plane", cz - length / 2.0)
                sketch_mgr.InsertSketch(True)
                sketch_mgr.CreateCircleByRadius(mm_to_m(cx), mm_to_m(cy), 0.0, r_m)
                sketch_mgr.InsertSketch(True)
                _extrude_boss(feat_mgr, length_m, merge=True)
            built += 1

    return built


def _safe_filename(name: str, fallback: str) -> str:
    cleaned = "".join(ch if (ch.isalnum() or ch in ("_", "-")) else "_" for ch in str(name or "").strip())
    return cleaned.strip("_") or fallback


def build_assembly_from_spec(spec: dict, visible: bool = True) -> dict:
    """
    True SolidWorks Assembly (.sldasm) builder:
    1. Generates each component in `parts_3d` as its own standalone `.sldprt` file.
    2. Creates a new SolidWorks Assembly document (`.asmdot`).
    3. Inserts every component via `AddComponent5` at exact origin (already positioned in mm -> meters).
    4. Fixes grounded components and saves the native `.sldasm` assembly.
    """
    part_name = spec.get("part_name", "cadcraft_assembly")
    parts_3d = spec.get("parts_3d") or []
    mates = spec.get("mates") or []
    output_sldasm = spec.get("output_sldasm_path") or f"{part_name}.sldasm"
    asm_dir = os.path.dirname(os.path.abspath(output_sldasm))
    components_dir = os.path.join(asm_dir, f"{_safe_filename(part_name, 'assembly')}_parts")
    os.makedirs(components_dir, exist_ok=True)

    sw_app = connect_solidworks(visible=visible)

    part_template = sw_app.GetUserPreferenceStringValue(0)
    if not part_template:
        part_template = r"C:\ProgramData\SOLIDWORKS\SOLIDWORKS 2024\templates\Part.prtdot"

    asm_template = sw_app.GetUserPreferenceStringValue(1)
    if not asm_template:
        asm_template = r"C:\ProgramData\SOLIDWORKS\SOLIDWORKS 2024\templates\Assembly.asmdot"

    built_components = []
    for idx, part in enumerate(parts_3d):
        comp_slug = _safe_filename(part.get("name"), f"component_{idx + 1}")
        comp_path = os.path.join(components_dir, f"{idx + 1:02d}_{comp_slug}.sldprt")
        comp_doc = sw_app.NewDocument(part_template, 0, 0, 0)
        if comp_doc is None:
            raise RuntimeError(f"Failed to create component part document for {comp_slug}.")
        _build_parts_3d(comp_doc, [part])
        comp_doc.ViewZoomtofit2()
        comp_doc.SaveAs3(comp_path, 0, 2)
        built_components.append((part, comp_path))

    asm_doc = sw_app.NewDocument(asm_template, 0, 0, 0)
    if asm_doc is None:
        raise RuntimeError("Failed to create new SolidWorks Assembly (.sldasm) document.")

    inserted_paths = []
    for idx, (part, comp_path) in enumerate(built_components):
        # Insert each pre-positioned component at assembly origin (0, 0, 0) in meters
        comp_obj = asm_doc.AddComponent5(comp_path, 0, "", False, "", 0.0, 0.0, 0.0)
        if comp_obj is not None:
            inserted_paths.append(comp_path)
            role = str(part.get("role") or ("fixed" if idx == 0 else "")).lower()
            if idx == 0 or role == "fixed":
                asm_doc.ClearSelection2(True)
                comp_obj.Select4(False, None, False)
                asm_doc.FixComponent()

    asm_doc.ViewZoomtofit2()
    asm_doc.SaveAs3(output_sldasm, 0, 2)

    return {
        "status": "ok",
        "output_mode": "assembly",
        "part_name": part_name,
        "component_count": len(inserted_paths),
        "mate_count": len(mates),
        "components_dir": components_dir,
        "output_sldasm_path": output_sldasm,
        "output_sldprt_path": output_sldasm,
    }


def build_part_from_spec(spec: dict, visible: bool = True) -> dict:
    part_name = spec.get("part_name", "cadcraft_part")
    extrude_depth_m = mm_to_m(spec.get("extrude_depth_mm", 10.0))
    entities = spec.get("entities", [])
    parts_3d = spec.get("parts_3d") or []
    output_mode = str(spec.get("output_mode") or ("assembly" if len(parts_3d) > 1 else "part")).lower()

    if output_mode == "assembly" and len(parts_3d) > 1:
        return build_assembly_from_spec(spec, visible=visible)

    output_path = spec.get("output_sldprt_path") or f"{part_name}.sldprt"

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    sw_app = connect_solidworks(visible=visible)

    # Get default part template (fallback to metric standard template)
    template = sw_app.GetUserPreferenceStringValue(0)
    if not template:
        template = r"C:\ProgramData\SOLIDWORKS\SOLIDWORKS 2024\templates\Part.prtdot"

    model = sw_app.NewDocument(template, 0, 0, 0)
    if model is None:
        raise RuntimeError("Failed to create new SolidWorks Part document.")

    if parts_3d:
        built_count = _build_parts_3d(model, parts_3d)
    else:
        sketch_mgr = model.SketchManager
        feat_mgr = model.FeatureManager
        ext = model.Extension

        ext.SelectByID2("Front Plane", "PLANE", 0, 0, 0, False, 0, None, 0)
        sketch_mgr.InsertSketch(True)

        for ent in entities:
            kind = ent.get("kind")
            if kind == "rectangle":
                cx = mm_to_m(ent.get("cx_mm") or 0.0)
                cy = mm_to_m(ent.get("cy_mm") or 0.0)
                w = mm_to_m(ent.get("width_mm") or 100.0)
                h = mm_to_m(ent.get("height_mm") or 80.0)
                x1 = cx - w / 2.0
                y1 = cy - h / 2.0
                x2 = cx + w / 2.0
                y2 = cy + h / 2.0
                sketch_mgr.CreateCornerRectangle(x1, y1, 0.0, x2, y2, 0.0)
            elif kind == "circle":
                cx = mm_to_m(ent.get("cx_mm") or 0.0)
                cy = mm_to_m(ent.get("cy_mm") or 0.0)
                r = mm_to_m(ent.get("radius_mm") or 5.0)
                sketch_mgr.CreateCircleByRadius(cx, cy, 0.0, r)

        sketch_mgr.InsertSketch(True)
        _extrude_boss(feat_mgr, extrude_depth_m, merge=True)
        built_count = len(entities)

    model.ViewZoomtofit2()
    errors = 0
    warnings = 0
    model.SaveAs3(output_path, 0, 2)

    return {
        "status": "ok",
        "output_mode": "part",
        "part_name": part_name,
        "extrude_depth_m": extrude_depth_m,
        "feature_count": built_count,
        "output_sldprt_path": output_path,
        "errors": errors,
        "warnings": warnings,
    }


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--ping":
        try:
            sw = connect_solidworks(visible=False)
            rev = sw.RevisionNumber()
            print(json.dumps({"status": "ready", "revision": rev}))
            return 0
        except Exception as exc:
            print(json.dumps({"status": "offline", "error": str(exc)}))
            return 1

    if len(sys.argv) < 2:
        print(json.dumps({"status": "error", "error": "Usage: sw_builder.py <spec.json> [--headless]"}))
        return 1

    spec_path = Path(sys.argv[1])
    visible = "--headless" not in sys.argv
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    result = build_part_from_spec(spec, visible=visible)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())

