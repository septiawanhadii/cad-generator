"""
CADCraft -> SolidWorks COM Bridge (DXF to .sldprt Converter)
Imports a cleaned 2D DXF (after OVERKILL + JOIN) directly into a SolidWorks
Front Plane sketch, extrudes it by extrude_depth_mm / 1000.0, and saves .sldprt.
"""

import json
import os
import sys
from pathlib import Path

from sw_builder import connect_solidworks, mm_to_m


def convert_dxf_to_sldprt(dxf_path: str, output_sldprt_path: str, extrude_depth_mm: float = 12.0, visible: bool = True) -> dict:
    if not os.path.exists(dxf_path):
        raise FileNotFoundError(f"DXF file not found: {dxf_path}")

    os.makedirs(os.path.dirname(os.path.abspath(output_sldprt_path)), exist_ok=True)
    extrude_depth_m = mm_to_m(extrude_depth_mm)

    sw_app = connect_solidworks(visible=visible)
    import_data = sw_app.GetImportFileData(dxf_path)
    if import_data is not None:
        # Import DXF as 2D sketch on Front Plane in Millimeters (unit code 2)
        import_data.ImportMethod(0)

    errors = 0
    model = sw_app.LoadFile4(dxf_path, "r", import_data, errors)
    if model is None:
        raise RuntimeError(f"SolidWorks failed to import DXF: {dxf_path}")

    feat_mgr = model.FeatureManager
    feat_mgr.FeatureExtrusion2(
        True, False, False,
        0, 0,
        extrude_depth_m,
        0.0,
        False, False, False, False,
        0.0, 0.0,
        False, False, False, False,
        True, True, True,
        0, 0.0, False
    )

    model.ViewZoomtofit2()
    model.SaveAs3(output_sldprt_path, 0, 2)

    return {
        "status": "ok",
        "dxf_source": dxf_path,
        "extrude_depth_mm": extrude_depth_mm,
        "extrude_depth_m": extrude_depth_m,
        "output_sldprt_path": output_sldprt_path,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"status": "error", "error": "Usage: dxf_to_sldprt.py <spec.json> [--headless]"}))
        return 1

    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    visible = "--headless" not in sys.argv
    result = convert_dxf_to_sldprt(
        dxf_path=spec["dxf_temp_path"],
        output_sldprt_path=spec["output_sldprt_path"],
        extrude_depth_mm=float(spec.get("extrude_depth_mm", 12.0)),
        visible=visible,
    )
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
