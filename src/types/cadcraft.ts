export const AI_THEME_TOKENS = {
  cc_bg: '#121417',
  cc_surface: '#1B1E23',
  cc_surface_alt: '#242830',
  cc_accent: '#3B82F6',
  cc_accent_muted: '#2563EB',
  cc_sw_accent: '#E11D48',
  cc_text: '#F1F5F9',
  cc_text_muted: '#94A3B8',
  cc_border: '#2E3440',
  bg_primary: '#121417',
  bg_surface: '#1B1E23',
  text_primary: '#F1F5F9',
  text_muted: '#94A3B8',
  accent: '#3B82F6',
  accent_muted: '#2563EB',
  success: '#10B981',
  warning: '#F59E0B',
  error: '#EF4444',
  info: '#06B6D4',
} as const;

export type ChatRole = 'User' | 'Assistant' | 'SystemTool';

export type AssistantTargetMode = 'cad_2d' | 'solidworks_3d';

export type CadMaterialFinish =
  | 'dark_oxide'
  | 'cast_iron'
  | 'machined_steel'
  | 'aluminum'
  | 'brass'
  | 'anodized_blue';

export type CadHole2D =
  | {
      kind: 'circle';
      cx: number;
      cy: number;
      radius: number;
    }
  | {
      kind: 'slot';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      width: number;
    }
  | {
      kind: 'rect';
      cx: number;
      cy: number;
      width: number;
      height: number;
    };

export type CadPartRole = 'fixed' | 'moving' | 'shaft' | 'actuator' | 'fastener';

export interface CadAssemblyMate {
  id: string;
  kind: 'coincident' | 'concentric' | 'distance' | 'screw' | 'slide';
  part_a: string;
  part_b: string;
  axis?: 'x' | 'y' | 'z';
  travel_mm?: number;
  pitch_mm?: number;
  description: string;
}

export type CadPart3D =
  | {
      id: string;
      name: string;
      kind: 'plate';
      cx: number;
      cy: number;
      width: number;
      depth: number;
      z_min: number;
      height: number;
      bevel?: number;
      holes?: CadHole2D[];
      finish?: CadMaterialFinish;
      role?: CadPartRole;
      material_label?: string;
    }
  | {
      id: string;
      name: string;
      kind: 'prism';
      points: [number, number][];
      z_min: number;
      height: number;
      bevel?: number;
      holes?: CadHole2D[];
      finish?: CadMaterialFinish;
      role?: CadPartRole;
      material_label?: string;
    }
  | {
      id: string;
      name: string;
      kind: 'box';
      cx: number;
      cy: number;
      z_min: number;
      width: number;
      depth: number;
      height: number;
      bevel?: number;
      finish?: CadMaterialFinish;
      role?: CadPartRole;
      material_label?: string;
    }
  | {
      id: string;
      name: string;
      kind: 'cylinder';
      cx: number;
      cy: number;
      cz: number;
      radius: number;
      length: number;
      axis: 'x' | 'y' | 'z';
      threaded?: boolean;
      inner_radius?: number;
      finish?: CadMaterialFinish;
      role?: CadPartRole;
      material_label?: string;
    };

export interface ChatMessage {
  id: string;
  created_at: string; // ISO 8601
  role: ChatRole;
  content: string;
  lisp_payload: string | null;
  sldprt_output_path: string | null;
  dxf_content?: string | null;
  solidworks_spec?: SolidWorksBuildSpec | null;
  image_preview_url?: string | null;
  is_error?: boolean;
}

export interface SwPrimitiveEntity {
  kind: 'rectangle' | 'circle';
  width_mm?: number | null;
  height_mm?: number | null;
  cx_mm?: number | null;
  cy_mm?: number | null;
  radius_mm?: number | null;
}

export interface SolidWorksBuildSpec {
  part_name: string;
  output_mode?: 'part' | 'assembly';
  source_mode: 'from_active_dxf' | 'parametric_primitives';
  dxf_temp_path: string | null;
  extrude_depth_mm: number;
  fillet_radius_mm: number | null;
  entities: SwPrimitiveEntity[];
  parts_3d?: CadPart3D[];
  mates?: CadAssemblyMate[];
  output_sldprt_path: string;
  output_sldasm_path?: string | null;
}

export interface AiResponsePayload {
  explanation: string;
  action_type: 'lisp' | 'cmdline' | 'solidworks_3d' | 'none';
  lisp_code: string | null;
  commands: string[] | null;
  parts_3d?: CadPart3D[] | null;
  mates?: CadAssemblyMate[] | null;
  solidworks_spec: SolidWorksBuildSpec | null;
}

export type AiProviderKind = 'gemini' | 'lmstudio' | 'ollama';

export interface AiBridgeConfig {
  provider: AiProviderKind;
  model: string;
  lmstudio_url: string;
  ollama_url: string;
  request_timeout_sec: number;
  python_bin: string;
  default_extrude_mm: number;
  export_dir: string;
  show_solidworks_window: boolean;
}

export const DEFAULT_BRIDGE_CONFIG: AiBridgeConfig = {
  provider: 'gemini',
  model: 'gemini-4-hydrogen',
  lmstudio_url: 'http://localhost:1234',
  ollama_url: 'http://localhost:11434',
  request_timeout_sec: 300,
  python_bin: 'bridge/solidworks/.venv/Scripts/python.exe',
  default_extrude_mm: 12.0,
  export_dir: 'C:\\Users\\Engineer\\Documents\\CADCraft',
  show_solidworks_window: true,
};

export interface Point2D {
  x: number;
  y: number;
}

export type CadEntity =
  | {
      id: string;
      kind: 'rectangle';
      layer: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | {
      id: string;
      kind: 'circle';
      layer: string;
      cx: number;
      cy: number;
      radius: number;
    }
  | {
      id: string;
      kind: 'line';
      layer: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | {
      id: string;
      kind: 'polyline';
      layer: string;
      points: Point2D[];
      closed: boolean;
    }
  | {
      id: string;
      kind: 'arc';
      layer: string;
      cx: number;
      cy: number;
      radius: number;
      startAngleDeg: number;
      endAngleDeg: number;
    };

export interface CadLayer {
  name: string;
  color: string;
  visible: boolean;
}

export interface DocSummary {
  activeLayer: string;
  entityCount: number;
  parts3dCount?: number;
  matesCount?: number;
  unit: 'mm';
  extents: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  } | null;
  extrudeDepthMm: number;
  filletRadiusMm: number | null;
  lastPartName: string;
}

export interface DocState {
  entities: CadEntity[];
  parts3d: CadPart3D[];
  mates: CadAssemblyMate[];
  layers: CadLayer[];
  activeLayer: string;
  unit: 'mm';
  extrudeDepthMm: number;
  filletRadiusMm: number | null;
  lastPartName: string;
  undoStack: CadEntity[][];
  redoStack: CadEntity[][];
  activeUndoSnapshot: CadEntity[] | null;
}

export type SwBridgeStatus = 'ready' | 'offline' | 'checking';

export interface SwPingResult {
  status: SwBridgeStatus;
  platform: string;
  pythonFound: boolean;
  pywin32Ready: boolean;
  solidworksRunning: boolean;
  message: string;
  checkedAt: string;
}
