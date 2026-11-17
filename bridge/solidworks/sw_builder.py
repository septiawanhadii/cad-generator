"""
CADCraft -> SolidWorks COM Bridge (Parametric Primitives Builder)
Converts SolidWorksBuildSpec JSON (mm) into a native SolidWorks .sldprt file
using win32com.client.Dispatch("SldWorks.Application").

UNIT CONVERSION GUARD:
All millimeter dimensions from CADCraft MUST be divided by 1000.0 before
passing coordinates to SolidWorks COM API methods (which use Meters).
"""

import json
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


def build_part_from_spec(spec: dict, visible: bool = True) -> dict:
    part_name = spec.get("part_name", "cadcraft_part")
    extrude_depth_m = mm_to_m(spec.get("extrude_depth_mm", 10.0))
    entities = spec.get("entities", [])
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

    sketch_mgr = model.SketchManager
    feat_mgr = model.FeatureManager
    ext = model.Extension

    # Select Front Plane and start 2D Sketch
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

    # Close sketch
    sketch_mgr.InsertSketch(True)

    # Extrude Boss/Base (FeatureExtrusion2 backward-compatible across SW 2022-2025)
    feat_mgr.FeatureExtrusion2(
        True,   # Sd (single direction)
        False,  # Flip
        False,  # Dir
        0,      # T1 (Blind)
        0,      # T2
        extrude_depth_m,
        0.0,
        False, False, False, False,
        0.0, 0.0,
        False, False, False, False,
        True, True, True,
        0, 0.0, False
    )

    model.ViewZoomtofit2()
    errors = 0
    warnings = 0
    model.SaveAs3(output_path, 0, 2)

    return {
        "status": "ok",
        "part_name": part_name,
        "extrude_depth_m": extrude_depth_m,
        "entity_count": len(entities),
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
