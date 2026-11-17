import type {
  AiBridgeConfig,
  CadEntity,
  DocState,
  SolidWorksBuildSpec,
  SwPrimitiveEntity,
} from '../types/cadcraft';

export function mmToMeters(mm: number): number {
  return mm / 1000.0;
}

export function exportDocToDxf(doc: DocState): string {
  const lines: string[] = [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$ACADVER',
    '1',
    'AC1015',
    '9',
    '$INSUNITS',
    '70',
    '4', // 4 = Millimeters
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'ENTITIES',
  ];

  for (const ent of doc.entities) {
    lines.push(...entityToDxfLines(ent));
  }

  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n') + '\n';
}

function entityToDxfLines(ent: CadEntity): string[] {
  switch (ent.kind) {
    case 'rectangle': {
      const minX = Math.min(ent.x1, ent.x2);
      const maxX = Math.max(ent.x1, ent.x2);
      const minY = Math.min(ent.y1, ent.y2);
      const maxY = Math.max(ent.y1, ent.y2);
      return [
        '0',
        'LWPOLYLINE',
        '8',
        ent.layer,
        '90',
        '4',
        '70',
        '1', // Closed polyline
        '10',
        String(minX),
        '20',
        String(minY),
        '10',
        String(maxX),
        '20',
        String(minY),
        '10',
        String(maxX),
        '20',
        String(maxY),
        '10',
        String(minX),
        '20',
        String(maxY),
      ];
    }
    case 'circle':
      return [
        '0',
        'CIRCLE',
        '8',
        ent.layer,
        '10',
        String(ent.cx),
        '20',
        String(ent.cy),
        '30',
        '0.0',
        '40',
        String(ent.radius),
      ];
    case 'line':
      return [
        '0',
        'LINE',
        '8',
        ent.layer,
        '10',
        String(ent.x1),
        '20',
        String(ent.y1),
        '30',
        '0.0',
        '11',
        String(ent.x2),
        '21',
        String(ent.y2),
        '31',
        '0.0',
      ];
    case 'arc':
      return [
        '0',
        'ARC',
        '8',
        ent.layer,
        '10',
        String(ent.cx),
        '20',
        String(ent.cy),
        '30',
        '0.0',
        '40',
        String(ent.radius),
        '50',
        String(ent.startAngleDeg),
        '51',
        String(ent.endAngleDeg),
      ];
    case 'polyline': {
      const out = [
        '0',
        'LWPOLYLINE',
        '8',
        ent.layer,
        '90',
        String(ent.points.length),
        '70',
        ent.closed ? '1' : '0',
      ];
      for (const pt of ent.points) {
        out.push('10', String(pt.x), '20', String(pt.y));
      }
      return out;
    }
  }
}

export function buildSolidWorksSpecFromDoc(
  doc: DocState,
  config: AiBridgeConfig,
  overrides?: {
    partName?: string;
    extrudeDepthMm?: number;
    filletRadiusMm?: number | null;
    sourceMode?: 'from_active_dxf' | 'parametric_primitives';
  },
): SolidWorksBuildSpec {
  const partName = (overrides?.partName || doc.lastPartName || 'cadcraft_part').replace(/[^a-zA-Z0-9_-]/g, '_');
  const extrudeDepthMm = overrides?.extrudeDepthMm ?? doc.extrudeDepthMm ?? config.default_extrude_mm;
  const filletRadiusMm = overrides?.filletRadiusMm !== undefined ? overrides.filletRadiusMm : doc.filletRadiusMm;

  const entities: SwPrimitiveEntity[] = [];
  for (const ent of doc.entities) {
    if (ent.kind === 'rectangle') {
      const w = Math.abs(ent.x2 - ent.x1);
      const h = Math.abs(ent.y2 - ent.y1);
      const cx = (ent.x1 + ent.x2) / 2;
      const cy = (ent.y1 + ent.y2) / 2;
      entities.push({
        kind: 'rectangle',
        width_mm: w,
        height_mm: h,
        cx_mm: cx,
        cy_mm: cy,
        radius_mm: null,
      });
    } else if (ent.kind === 'circle') {
      entities.push({
        kind: 'circle',
        cx_mm: ent.cx,
        cy_mm: ent.cy,
        radius_mm: ent.radius,
        width_mm: null,
        height_mm: null,
      });
    }
  }

  const baseDir = config.export_dir.replace(/[\\/]+$/, '');
  const sep = baseDir.includes('/') && !baseDir.includes('\\') ? '/' : '\\';
  const sourceMode = overrides?.sourceMode || (entities.length > 0 && entities.length === doc.entities.length ? 'parametric_primitives' : 'from_active_dxf');

  return {
    part_name: partName,
    source_mode: sourceMode,
    dxf_temp_path: `${baseDir}${sep}${partName}_sketch.dxf`,
    extrude_depth_mm: extrudeDepthMm,
    fillet_radius_mm: filletRadiusMm,
    entities,
    output_sldprt_path: `${baseDir}${sep}${partName}.sldprt`,
  };
}
