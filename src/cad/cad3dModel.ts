import type {
  CadAssemblyMate,
  CadEntity,
  CadHole2D,
  CadMaterialFinish,
  CadPart3D,
  CadPartRole,
  DocState,
} from '../types/cadcraft';
import { getEntityBounds } from './docState';

const VALID_FINISHES = new Set<CadMaterialFinish>([
  'dark_oxide',
  'cast_iron',
  'machined_steel',
  'aluminum',
  'brass',
  'anodized_blue',
]);

const VALID_ROLES = new Set<CadPartRole>([
  'fixed',
  'moving',
  'shaft',
  'actuator',
  'fastener',
]);

function pickRole(val: unknown): CadPartRole | undefined {
  if (typeof val === 'string') {
    const k = val.trim().toLowerCase() as CadPartRole;
    if (VALID_ROLES.has(k)) return k;
  }
  return undefined;
}

function num(val: unknown, fallback = 0): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const parsed = Number.parseFloat(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function posNum(val: unknown, fallback: number, min = 0.2): number {
  const v = num(val, fallback);
  return v >= min ? v : fallback;
}

function pickFinish(val: unknown): CadMaterialFinish | undefined {
  if (typeof val === 'string') {
    const k = val.trim().toLowerCase() as CadMaterialFinish;
    if (VALID_FINISHES.has(k)) return k;
  }
  return undefined;
}

function parsePoints(raw: unknown): [number, number][] {
  if (!Array.isArray(raw)) return [];
  const pts: [number, number][] = [];
  for (const item of raw) {
    if (Array.isArray(item) && item.length >= 2) {
      const x = num(item[0], NaN);
      const y = num(item[1], NaN);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        pts.push([x, y]);
      }
    } else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const x = num(obj.x, NaN);
      const y = num(obj.y, NaN);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        pts.push([x, y]);
      }
    }
  }
  return pts;
}

function parseHoles(raw: unknown): CadHole2D[] {
  if (!Array.isArray(raw)) return [];
  const holes: CadHole2D[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const h = item as Record<string, unknown>;
    const kind = String(h.kind || h.type || '').toLowerCase();
    if (kind === 'circle' || kind === 'bore' || kind === 'hole') {
      const radius =
        h.radius !== undefined || h.r !== undefined || h.radius_mm !== undefined
          ? posNum(h.radius ?? h.r ?? h.radius_mm, 3)
          : posNum(h.diameter ?? h.d ?? h.diameter_mm, 6) / 2;
      holes.push({
        kind: 'circle',
        cx: num(h.cx ?? h.x ?? h.cx_mm, 0),
        cy: num(h.cy ?? h.y ?? h.cy_mm, 0),
        radius,
      });
    } else if (kind === 'slot' || kind === 'obround') {
      const width = posNum(h.width ?? h.w ?? h.width_mm, 10);
      if (h.x1 !== undefined && h.x2 !== undefined) {
        holes.push({
          kind: 'slot',
          x1: num(h.x1, 0),
          y1: num(h.y1, 0),
          x2: num(h.x2, 0),
          y2: num(h.y2, 0),
          width,
        });
      } else {
        // Center + length + orientation fallback
        const cx = num(h.cx ?? h.x, 0);
        const cy = num(h.cy ?? h.y, 0);
        const len = posNum(h.length ?? h.len ?? h.length_mm, 40);
        const halfSpan = Math.max(0.5, (len - width) / 2);
        const axis = String(h.axis || 'y').toLowerCase();
        holes.push(
          axis === 'x'
            ? { kind: 'slot', x1: cx - halfSpan, y1: cy, x2: cx + halfSpan, y2: cy, width }
            : { kind: 'slot', x1: cx, y1: cy - halfSpan, x2: cx, y2: cy + halfSpan, width },
        );
      }
    } else if (kind === 'rect' || kind === 'rectangle' || kind === 'cutout') {
      holes.push({
        kind: 'rect',
        cx: num(h.cx ?? h.x ?? h.cx_mm, 0),
        cy: num(h.cy ?? h.y ?? h.cy_mm, 0),
        width: posNum(h.width ?? h.w ?? h.width_mm, 20),
        height: posNum(h.height ?? h.depth ?? h.d ?? h.h ?? h.height_mm, 20),
      });
    }
  }
  return holes;
}

export function parseParts3d(raw: unknown): CadPart3D[] {
  let list: unknown[] = [];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) list = parsed;
      else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).parts)) {
        list = (parsed as Record<string, unknown>).parts as unknown[];
      }
    } catch {
      return [];
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  } else {
    return [];
  }

  const parts: CadPart3D[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const kind = String(p.kind || p.type || '').toLowerCase();
    const id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : `part-${i + 1}`;
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `Part ${i + 1}`;
    const finish = pickFinish(p.finish ?? p.material);
    const role = pickRole(p.role);
    const material_label =
      typeof p.material_label === 'string' && p.material_label.trim()
        ? p.material_label.trim()
        : undefined;

    if (kind === 'plate' || kind === 'extruded_plate' || kind === 'base_plate') {
      const width = posNum(p.width ?? p.w ?? p.width_mm, 100);
      const depth = posNum(p.depth ?? p.d ?? p.depth_mm ?? p.length ?? p.l, 80);
      const height = posNum(p.height ?? p.h ?? p.height_mm ?? p.thickness ?? p.extrude_mm, 12);
      const zMin = num(p.z_min ?? p.z ?? p.z_min_mm, 0);
      const bevel = Math.min(num(p.bevel ?? p.chamfer, 0.8), Math.min(width, depth, height) * 0.2);
      const holes = parseHoles(p.holes ?? p.cutouts);
      parts.push({
        id,
        name,
        kind: 'plate',
        cx: num(p.cx ?? p.x ?? p.cx_mm, 0),
        cy: num(p.cy ?? p.y ?? p.cy_mm, 0),
        width,
        depth,
        z_min: zMin,
        height,
        bevel: bevel >= 0 ? bevel : 0.6,
        holes,
        finish,
        role,
        material_label,
      });
    } else if (kind === 'prism' || kind === 'wedge' || kind === 'polygon' || kind === 'extrude') {
      const points = parsePoints(p.points ?? p.vertices ?? p.profile);
      if (points.length < 3) continue;
      const height = posNum(p.height ?? p.h ?? p.height_mm ?? p.extrude_mm, 20);
      const zMin = num(p.z_min ?? p.z ?? p.z_min_mm, 0);
      const bevel = Math.max(0, Math.min(num(p.bevel ?? p.chamfer, 0.6), height * 0.2));
      const holes = parseHoles(p.holes ?? p.cutouts);
      parts.push({
        id,
        name,
        kind: 'prism',
        points,
        z_min: zMin,
        height,
        bevel,
        holes,
        finish,
        role,
        material_label,
      });
    } else if (kind === 'box' || kind === 'block' || kind === 'jaw' || kind === 'rail') {
      const width = posNum(p.width ?? p.w ?? p.width_mm, 40);
      const depth = posNum(p.depth ?? p.d ?? p.depth_mm, 25);
      const height = posNum(p.height ?? p.h ?? p.height_mm, 20);
      const zMin = num(p.z_min ?? p.z ?? p.z_min_mm, 0);
      const bevel = Math.max(0, Math.min(num(p.bevel ?? p.chamfer, 0.6), Math.min(width, depth, height) * 0.2));
      parts.push({
        id,
        name,
        kind: 'box',
        cx: num(p.cx ?? p.x ?? p.cx_mm, 0),
        cy: num(p.cy ?? p.y ?? p.cy_mm, 0),
        z_min: zMin,
        width,
        depth,
        height,
        bevel,
        finish,
        role,
        material_label,
      });
    } else if (kind === 'cylinder' || kind === 'shaft' || kind === 'screw' || kind === 'rod' || kind === 'handle') {
      const radius =
        p.radius !== undefined || p.r !== undefined || p.radius_mm !== undefined
          ? posNum(p.radius ?? p.r ?? p.radius_mm, 6)
          : posNum(p.diameter ?? p.d ?? p.diameter_mm, 12) / 2;
      const length = posNum(p.length ?? p.len ?? p.length_mm ?? p.height ?? p.h, 50);
      const axisRaw = String(p.axis || (kind === 'screw' || kind === 'handle' || kind === 'rod' ? 'y' : 'z')).toLowerCase();
      const axis: 'x' | 'y' | 'z' = axisRaw === 'x' ? 'x' : axisRaw === 'y' ? 'y' : 'z';
      const innerRaw = num(p.inner_radius ?? p.inner_r, 0);
      parts.push({
        id,
        name,
        kind: 'cylinder',
        cx: num(p.cx ?? p.x ?? p.cx_mm, 0),
        cy: num(p.cy ?? p.y ?? p.cy_mm, 0),
        cz: num(p.cz ?? p.z ?? p.cz_mm, 0),
        radius,
        length,
        axis,
        threaded: Boolean(p.threaded) || kind === 'screw',
        inner_radius: innerRaw > 0 && innerRaw < radius ? innerRaw : undefined,
        finish,
        role: role ?? (Boolean(p.threaded) || kind === 'screw' ? 'shaft' : kind === 'handle' ? 'actuator' : undefined),
        material_label,
      });
    }
  }
  return parts;
}

function isBoxStrictlyInside(
  inner: { minX: number; minY: number; maxX: number; maxY: number },
  outer: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  const margin = 0.05;
  return (
    inner.minX > outer.minX + margin &&
    inner.maxX < outer.maxX - margin &&
    inner.minY > outer.minY + margin &&
    inner.maxY < outer.maxY - margin
  );
}

function detectSlotFromPolyline(ent: Extract<CadEntity, { kind: 'polyline' }>): CadHole2D | null {
  if (!ent.closed || ent.points.length < 12) return null;
  const b = getEntityBounds(ent);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  if (w > h * 1.15) {
    const r = h / 2;
    return { kind: 'slot', x1: b.minX + r, y1: cy, x2: b.maxX - r, y2: cy, width: h };
  }
  if (h > w * 1.15) {
    const r = w / 2;
    return { kind: 'slot', x1: cx, y1: b.minY + r, x2: cx, y2: b.maxY - r, width: w };
  }
  return { kind: 'circle', cx, cy, radius: Math.min(w, h) / 2 };
}

/**
 * Automatically converts pure 2D CAD entities into solid 3D parts with true boolean holes
 * (circles, obround slots, and inner rectangular cutouts inside the outer plate boundary).
 */
export function deriveParts3dFrom2dDoc(doc: DocState): CadPart3D[] {
  if (doc.entities.length === 0) return [];
  const depth = Math.max(0.5, doc.extrudeDepthMm || 12);

  // Find largest outer rectangular boundary to act as base plate if present
  const rects = doc.entities
    .map((e, idx) => ({ e, idx, b: getEntityBounds(e) }))
    .filter((item) => item.e.kind === 'rectangle');

  rects.sort((a, b) => {
    const areaA = (a.b.maxX - a.b.minX) * (a.b.maxY - a.b.minY);
    const areaB = (b.b.maxX - b.b.minX) * (b.b.maxY - b.b.minY);
    return areaB - areaA;
  });

  const consumed = new Set<number>();
  const parts: CadPart3D[] = [];

  if (rects.length > 0) {
    const main = rects[0];
    consumed.add(main.idx);
    const holes: CadHole2D[] = [];

    doc.entities.forEach((ent, idx) => {
      if (consumed.has(idx)) return;
      const eb = getEntityBounds(ent);
      if (!isBoxStrictlyInside(eb, main.b)) return;

      if (ent.kind === 'circle') {
        holes.push({ kind: 'circle', cx: ent.cx, cy: ent.cy, radius: ent.radius });
        consumed.add(idx);
      } else if (ent.kind === 'polyline' && ent.closed && ent.id.startsWith('slot-')) {
        const slot = detectSlotFromPolyline(ent);
        if (slot) {
          holes.push(slot);
          consumed.add(idx);
        }
      } else if (ent.kind === 'polyline' && ent.closed && ent.points.length >= 16) {
        const slot = detectSlotFromPolyline(ent);
        if (slot) {
          holes.push(slot);
          consumed.add(idx);
        }
      }
    });

    parts.push({
      id: 'base-plate-2d',
      name: doc.lastPartName || 'Base Plate',
      kind: 'plate',
      cx: (main.b.minX + main.b.maxX) / 2,
      cy: (main.b.minY + main.b.maxY) / 2,
      width: Math.max(0.5, main.b.maxX - main.b.minX),
      depth: Math.max(0.5, main.b.maxY - main.b.minY),
      z_min: 0,
      height: depth,
      bevel: Math.min(0.8, depth * 0.08),
      holes,
      finish: 'machined_steel',
    });
  }

  // Convert remaining unconsumed 2D entities into separate 3D features
  doc.entities.forEach((ent, idx) => {
    if (consumed.has(idx)) return;
    if (ent.kind === 'rectangle') {
      const b = getEntityBounds(ent);
      parts.push({
        id: ent.id,
        name: `Block ${parts.length + 1}`,
        kind: 'box',
        cx: (b.minX + b.maxX) / 2,
        cy: (b.minY + b.maxY) / 2,
        z_min: 0,
        width: Math.max(0.5, b.maxX - b.minX),
        depth: Math.max(0.5, b.maxY - b.minY),
        height: depth,
        bevel: Math.min(0.6, depth * 0.08),
        finish: 'dark_oxide',
      });
    } else if (ent.kind === 'circle') {
      parts.push({
        id: ent.id,
        name: `Cylinder ${parts.length + 1}`,
        kind: 'cylinder',
        cx: ent.cx,
        cy: ent.cy,
        cz: depth / 2,
        radius: ent.radius,
        length: depth,
        axis: 'z',
        finish: 'machined_steel',
      });
    } else if (ent.kind === 'polyline' && ent.points.length >= 3) {
      parts.push({
        id: ent.id,
        name: `Profile ${parts.length + 1}`,
        kind: 'prism',
        points: ent.points.map((p) => [p.x, p.y] as [number, number]),
        z_min: 0,
        height: depth,
        bevel: Math.min(0.6, depth * 0.08),
        finish: 'cast_iron',
      });
    }
  });

  return parts;
}

export interface Bounds3D {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  width: number;
  depth: number;
  height: number;
  centerX: number;
  centerY: number;
  centerZ: number;
}

export function getPart3dBounds(part: CadPart3D): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
} {
  switch (part.kind) {
    case 'plate':
    case 'box':
      return {
        minX: part.cx - part.width / 2,
        maxX: part.cx + part.width / 2,
        minY: part.cy - part.depth / 2,
        maxY: part.cy + part.depth / 2,
        minZ: part.z_min,
        maxZ: part.z_min + part.height,
      };
    case 'prism': {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [x, y] of part.points) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return {
        minX,
        maxX,
        minY,
        maxY,
        minZ: part.z_min,
        maxZ: part.z_min + part.height,
      };
    }
    case 'cylinder': {
      const halfLen = part.length / 2;
      if (part.axis === 'x') {
        return {
          minX: part.cx - halfLen,
          maxX: part.cx + halfLen,
          minY: part.cy - part.radius,
          maxY: part.cy + part.radius,
          minZ: part.cz - part.radius,
          maxZ: part.cz + part.radius,
        };
      }
      if (part.axis === 'y') {
        return {
          minX: part.cx - part.radius,
          maxX: part.cx + part.radius,
          minY: part.cy - halfLen,
          maxY: part.cy + halfLen,
          minZ: part.cz - part.radius,
          maxZ: part.cz + part.radius,
        };
      }
      return {
        minX: part.cx - part.radius,
        maxX: part.cx + part.radius,
        minY: part.cy - part.radius,
        maxY: part.cy + part.radius,
        minZ: part.cz - halfLen,
        maxZ: part.cz + halfLen,
      };
    }
  }
}

export function computeParts3dBounds(parts: CadPart3D[]): Bounds3D | null {
  if (parts.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const part of parts) {
    const b = getPart3dBounds(part);
    if (b.minX < minX) minX = b.minX;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxY > maxY) maxY = b.maxY;
    if (b.minZ < minZ) minZ = b.minZ;
    if (b.maxZ > maxZ) maxZ = b.maxZ;
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    width: Math.round((maxX - minX) * 10) / 10,
    depth: Math.round((maxY - minY) * 10) / 10,
    height: Math.round((maxZ - minZ) * 10) / 10,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}

export function computeExplodedOffset(
  part: CadPart3D,
  bounds: Bounds3D,
  explodeFactor: number,
): { dx: number; dy: number; dz: number } {
  if (explodeFactor <= 0.001) return { dx: 0, dy: 0, dz: 0 };
  const pb = getPart3dBounds(part);
  const pcx = (pb.minX + pb.maxX) / 2;
  const pcy = (pb.minY + pb.maxY) / 2;
  const pcz = (pb.minZ + pb.maxZ) / 2;

  const span = Math.max(bounds.width, bounds.depth, bounds.height, 40);
  const dist = span * 0.35 * explodeFactor;

  // Keep the lowest base plate grounded at z = 0; lift upper parts & slide axial shafts outward
  const isBase = pb.minZ <= bounds.minZ + 0.5 && part.kind === 'plate';
  if (isBase) return { dx: 0, dy: 0, dz: 0 };

  if (part.kind === 'cylinder' && part.axis !== 'z') {
    const dirX = part.axis === 'x' ? (pcx >= bounds.centerX ? 1 : -1) : 0;
    const dirY = part.axis === 'y' ? (pcy >= bounds.centerY ? 1 : -1) : 0;
    return {
      dx: dirX * dist * 0.9,
      dy: dirY * dist * 0.9,
      dz: dist * 0.55,
    };
  }

  const vx = pcx - bounds.centerX;
  const vy = pcy - bounds.centerY;
  const vz = Math.max(0.25, (pcz - bounds.minZ) / Math.max(bounds.height, 1));
  const lenXY = Math.hypot(vx, vy) || 1;
  return {
    dx: (vx / lenXY) * dist * 0.35,
    dy: (vy / lenXY) * dist * 0.35,
    dz: vz * dist * 0.95,
  };
}

/**
 * Generates a clean top-down (XY) 2D CAD projection from a 3D multi-part assembly
 * whenever an AI response returns `parts_3d` without accompanying AutoLISP 2D entities,
 * keeping Canvas 2D and DXF exports synchronized with 3D SolidView.
 */
export function derive2dEntitiesFromParts3d(parts: CadPart3D[], layer = '0'): CadEntity[] {
  const entities: CadEntity[] = [];
  let seq = 1;
  const nextId = (prefix: string) => `p2d-${prefix}-${seq++}`;

  const addHole2d = (h: CadHole2D) => {
    if (h.kind === 'circle') {
      entities.push({
        id: nextId('cir'),
        kind: 'circle',
        layer,
        cx: h.cx,
        cy: h.cy,
        radius: h.radius,
      });
    } else if (h.kind === 'rect') {
      entities.push({
        id: nextId('rect'),
        kind: 'rectangle',
        layer,
        x1: h.cx - h.width / 2,
        y1: h.cy - h.height / 2,
        x2: h.cx + h.width / 2,
        y2: h.cy + h.height / 2,
      });
    } else if (h.kind === 'slot') {
      const dx = h.x2 - h.x1;
      const dy = h.y2 - h.y1;
      const len = Math.hypot(dx, dy);
      const r = h.width / 2;
      if (len < 0.05) {
        entities.push({ id: nextId('cir'), kind: 'circle', layer, cx: h.x1, cy: h.y1, radius: r });
        return;
      }
      const angle = Math.atan2(dy, dx);
      const pts: { x: number; y: number }[] = [];
      const steps = 10;
      for (let i = 0; i <= steps; i++) {
        const a = angle - Math.PI / 2 + (Math.PI * i) / steps;
        pts.push({ x: h.x2 + Math.cos(a) * r, y: h.y2 + Math.sin(a) * r });
      }
      for (let i = 0; i <= steps; i++) {
        const a = angle + Math.PI / 2 + (Math.PI * i) / steps;
        pts.push({ x: h.x1 + Math.cos(a) * r, y: h.y1 + Math.sin(a) * r });
      }
      entities.push({
        id: nextId('slot'),
        kind: 'polyline',
        layer,
        points: pts,
        closed: true,
      });
    }
  };

  for (const part of parts) {
    if (part.kind === 'plate') {
      entities.push({
        id: nextId('plate'),
        kind: 'rectangle',
        layer,
        x1: part.cx - part.width / 2,
        y1: part.cy - part.depth / 2,
        x2: part.cx + part.width / 2,
        y2: part.cy + part.depth / 2,
      });
      for (const h of part.holes ?? []) addHole2d(h);
    } else if (part.kind === 'box') {
      entities.push({
        id: nextId('box'),
        kind: 'rectangle',
        layer,
        x1: part.cx - part.width / 2,
        y1: part.cy - part.depth / 2,
        x2: part.cx + part.width / 2,
        y2: part.cy + part.depth / 2,
      });
    } else if (part.kind === 'prism') {
      if (part.points.length >= 3) {
        entities.push({
          id: nextId('prism'),
          kind: 'polyline',
          layer,
          points: part.points.map(([x, y]) => ({ x, y })),
          closed: true,
        });
      }
      for (const h of part.holes ?? []) addHole2d(h);
    } else if (part.kind === 'cylinder') {
      if (part.axis === 'z') {
        entities.push({
          id: nextId('cyl'),
          kind: 'circle',
          layer,
          cx: part.cx,
          cy: part.cy,
          radius: part.radius,
        });
      } else if (part.axis === 'x') {
        entities.push({
          id: nextId('shaft'),
          kind: 'rectangle',
          layer,
          x1: part.cx - part.length / 2,
          y1: part.cy - part.radius,
          x2: part.cx + part.length / 2,
          y2: part.cy + part.radius,
        });
      } else {
        entities.push({
          id: nextId('shaft'),
          kind: 'rectangle',
          layer,
          x1: part.cx - part.radius,
          y1: part.cy - part.length / 2,
          x2: part.cx + part.radius,
          y2: part.cy + part.length / 2,
        });
      }
    }
  }

  return entities;
}

const VALID_MATE_KINDS = new Set<CadAssemblyMate['kind']>([
  'coincident',
  'concentric',
  'distance',
  'screw',
  'slide',
]);

function resolvePartId(ref: unknown, parts: CadPart3D[]): string | null {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const q = ref.trim().toLowerCase();
  const byId = parts.find((p) => p.id.toLowerCase() === q);
  if (byId) return byId.id;
  const byName = parts.find((p) => p.name.toLowerCase() === q);
  if (byName) return byName.id;
  const partial = parts.find((p) => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
  return partial ? partial.id : null;
}

export function parseAssemblyMates(raw: unknown, parts: CadPart3D[]): CadAssemblyMate[] {
  let list: unknown[] = [];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) list = parsed;
      else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).mates)) {
        list = (parsed as Record<string, unknown>).mates as unknown[];
      }
    } catch {
      return [];
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  } else {
    return [];
  }

  const mates: CadAssemblyMate[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const rawKind = String(m.kind || m.type || 'coincident').toLowerCase() as CadAssemblyMate['kind'];
    const kind: CadAssemblyMate['kind'] = VALID_MATE_KINDS.has(rawKind) ? rawKind : 'coincident';
    const partA = resolvePartId(m.part_a ?? m.a ?? m.part1, parts);
    const partB = resolvePartId(m.part_b ?? m.b ?? m.part2, parts);
    if (!partA || !partB || partA === partB) continue;
    const axisRaw = typeof m.axis === 'string' ? m.axis.toLowerCase() : undefined;
    const axis: 'x' | 'y' | 'z' | undefined =
      axisRaw === 'x' || axisRaw === 'y' || axisRaw === 'z' ? axisRaw : undefined;
    const travel = m.travel_mm !== undefined ? posNum(m.travel_mm, 24, 1) : undefined;
    const pitch = m.pitch_mm !== undefined ? posNum(m.pitch_mm, 3, 0.5) : undefined;
    const nameA = parts.find((p) => p.id === partA)?.name ?? partA;
    const nameB = parts.find((p) => p.id === partB)?.name ?? partB;
    mates.push({
      id: typeof m.id === 'string' && m.id.trim() ? m.id.trim() : `mate-${i + 1}`,
      kind,
      part_a: partA,
      part_b: partB,
      axis,
      travel_mm: travel,
      pitch_mm: pitch,
      description:
        typeof m.description === 'string' && m.description.trim()
          ? m.description.trim()
          : `${kind[0].toUpperCase()}${kind.slice(1)}: ${nameA} ↔ ${nameB}${axis ? ` (${axis.toUpperCase()})` : ''}`,
    });
  }
  return mates;
}

/**
 * Infers realistic mechanical Assembly Mates automatically from part geometry & names
 * whenever an assembly has 2+ components and no explicit mates were provided by the AI.
 */
export function inferAssemblyMates(parts: CadPart3D[]): CadAssemblyMate[] {
  if (parts.length < 2) return [];
  const mates: CadAssemblyMate[] = [];
  let seq = 1;

  // Identify grounded base plate (lowest plate or largest footprint)
  const sortedByBase = [...parts].sort((a, b) => {
    const aPlate = a.kind === 'plate' ? 0 : 1;
    const bPlate = b.kind === 'plate' ? 0 : 1;
    if (aPlate !== bPlate) return aPlate - bPlate;
    return getPart3dBounds(a).minZ - getPart3dBounds(b).minZ;
  });
  const base = sortedByBase[0];

  const shafts = parts.filter(
    (p): p is Extract<CadPart3D, { kind: 'cylinder' }> =>
      p.kind === 'cylinder' && (Boolean(p.threaded) || /screw|shaft|spindle|rod|lead|handle|bolt/i.test(p.name)),
  );
  const primaryScrew = shafts.find((s) => s.threaded) ?? shafts[0] ?? null;

  for (const part of parts) {
    if (part.id === base.id) continue;
    const lower = part.name.toLowerCase();

    if (part.kind === 'cylinder') {
      const isHandle = /handle|grip|knob|bar|coupler/i.test(lower);
      if (isHandle && primaryScrew && primaryScrew.id !== part.id) {
        mates.push({
          id: `mate-${seq++}`,
          kind: 'concentric',
          part_a: part.id,
          part_b: primaryScrew.id,
          axis: primaryScrew.axis,
          pitch_mm: 4,
          travel_mm: 28,
          description: `Concentric: ${part.name} ↔ ${primaryScrew.name} (Axis ${primaryScrew.axis.toUpperCase()})`,
        });
      } else {
        // Find housing/nut block closest to the shaft
        const housing =
          parts.find(
            (p) =>
              p.id !== part.id &&
              p.id !== base.id &&
              p.kind !== 'cylinder' &&
              /nut|spindle|housing|rear|fixed|bearing|block|arm/i.test(p.name),
          ) ?? base;
        mates.push({
          id: `mate-${seq++}`,
          kind: part.threaded ? 'screw' : 'concentric',
          part_a: part.id,
          part_b: housing.id,
          axis: part.axis,
          travel_mm: part.threaded ? Math.min(34, Math.max(12, Math.round(part.length * 0.28))) : undefined,
          pitch_mm: part.threaded ? 4 : undefined,
          description: part.threaded
            ? `Screw: ${part.name} ↔ ${housing.name} (Axis ${part.axis.toUpperCase()}, Pitch 4 mm)`
            : `Concentric: ${part.name} ↔ ${housing.name} (Axis ${part.axis.toUpperCase()})`,
        });
      }
      continue;
    }

    const isMovableJaw =
      part.role === 'moving' || /movable|sliding|v-jaw|jaw|ram|press|clamp|platen/i.test(lower);
    if (isMovableJaw && primaryScrew && !/fixed|rear|nut|housing/i.test(lower)) {
      const travel = Math.min(34, Math.max(14, Math.round(primaryScrew.length * 0.28)));
      mates.push({
        id: `mate-${seq++}`,
        kind: 'slide',
        part_a: part.id,
        part_b: base.id,
        axis: primaryScrew.axis,
        travel_mm: travel,
        description: `Slide: ${part.name} along ${base.name} (Axis ${primaryScrew.axis.toUpperCase()}, ${travel} mm)`,
      });
    } else {
      mates.push({
        id: `mate-${seq++}`,
        kind: 'coincident',
        part_a: part.id,
        part_b: base.id,
        axis: 'z',
        description: `Coincident: ${part.name} flush on ${base.name}`,
      });
    }
  }

  return mates;
}

export interface KinematicDelta {
  dx: number;
  dy: number;
  dz: number;
  rx: number;
  ry: number;
  rz: number;
}

export interface AssemblyKinematicsResult {
  deltas: Record<string, KinematicDelta>;
  mechanismType: 'screw_slide' | 'linear_slide' | 'screw_valve' | 'rotary' | 'static';
  strokeMm: number;
  revolutions: number;
  angleDeg: number;
  label: string;
}

const ZERO_DELTA: KinematicDelta = { dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0 };

function rotatePointAroundAxis(
  px: number,
  py: number,
  pz: number,
  ox: number,
  oy: number,
  oz: number,
  axis: 'x' | 'y' | 'z',
  angle: number,
): [number, number, number] {
  const rx = px - ox;
  const ry = py - oy;
  const rz = pz - oz;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (axis === 'x') {
    return [ox + rx, oy + (ry * c - rz * s), oz + (ry * s + rz * c)];
  }
  if (axis === 'y') {
    return [ox + (rx * c + rz * s), oy + ry, oz + (-rx * s + rz * c)];
  }
  return [ox + (rx * c - ry * s), oy + (rx * s + ry * c), oz + rz];
}

function axisRange(b: ReturnType<typeof getPart3dBounds>, axis: 'x' | 'y' | 'z'): [number, number] {
  if (axis === 'x') return [b.minX, b.maxX];
  if (axis === 'y') return [b.minY, b.maxY];
  return [b.minZ, b.maxZ];
}

function transverseOverlaps(
  a: ReturnType<typeof getPart3dBounds>,
  b: ReturnType<typeof getPart3dBounds>,
  axis: 'x' | 'y' | 'z',
): boolean {
  const eps = 0.5;
  const xOv = a.maxX > b.minX + eps && b.maxX > a.minX + eps;
  const yOv = a.maxY > b.minY + eps && b.maxY > a.minY + eps;
  const zOv = a.maxZ > b.minZ + eps && b.maxZ > a.minZ + eps;
  if (axis === 'x') return yOv && zOv;
  if (axis === 'y') return xOv && zOv;
  return xOv && yOv;
}

/**
 * Computes collision-free signed travel (mm) for a sliding part along `axis`
 * based on real 3D bounding-box clearances against fixed assembly obstacles and base plate limits.
 */
function computeSafeSlideStroke(
  movingPart: CadPart3D,
  axis: 'x' | 'y' | 'z',
  requestedTravel: number,
  parts: CadPart3D[],
  movingIds: Set<string>,
): { signedTravel: number; maxSafeMagnitude: number } {
  const mb = getPart3dBounds(movingPart);
  const [mMin, mMax] = axisRange(mb, axis);
  const margin = 3.0;

  let posLimit = Infinity;
  let negLimit = Infinity;

  // Base plate horizontal boundary guard (so sliding jaw never falls off the base plate)
  const basePlate = parts.find((p) => p.kind === 'plate' && !movingIds.has(p.id));
  if (basePlate && axis !== 'z') {
    const bb = getPart3dBounds(basePlate);
    const [bMin, bMax] = axisRange(bb, axis);
    posLimit = Math.min(posLimit, Math.max(0, bMax - mMax - margin));
    negLimit = Math.min(negLimit, Math.max(0, mMin - bMin - margin));
  }

  for (const other of parts) {
    if (movingIds.has(other.id)) continue;
    // Skip cylinders (e.g. guide rods/lead screw passing through)
    if (other.kind === 'cylinder') continue;
    const ob = getPart3dBounds(other);
    if (!transverseOverlaps(mb, ob, axis)) continue;
    const [oMin, oMax] = axisRange(ob, axis);
    if (oMin >= mMax - 0.5) {
      posLimit = Math.min(posLimit, Math.max(0, oMin - mMax - margin));
    } else if (oMax <= mMin + 0.5) {
      negLimit = Math.min(negLimit, Math.max(0, mMin - oMax - margin));
    }
  }

  if (!Number.isFinite(posLimit)) posLimit = requestedTravel;
  if (!Number.isFinite(negLimit)) negLimit = requestedTravel;

  // Vertical press/jig always presses downward (-Z toward base) if room exists
  if (axis === 'z') {
    if (negLimit >= 2) {
      const mag = Math.min(requestedTravel, negLimit);
      return { signedTravel: -mag, maxSafeMagnitude: mag };
    }
    const mag = Math.min(requestedTravel, posLimit);
    return { signedTravel: mag, maxSafeMagnitude: mag };
  }

  // Horizontal slide (e.g. Drill Press Vise): choose direction with larger collision-free stroke
  if (posLimit >= negLimit) {
    const mag = Math.min(requestedTravel, posLimit);
    return { signedTravel: mag, maxSafeMagnitude: mag };
  }
  const mag = Math.min(requestedTravel, negLimit);
  return { signedTravel: -mag, maxSafeMagnitude: mag };
}

function buildDelta(
  dx: number,
  dy: number,
  dz: number,
  axis: 'x' | 'y' | 'z',
  angle: number,
): KinematicDelta {
  return {
    dx,
    dy,
    dz,
    rx: axis === 'x' ? angle : 0,
    ry: axis === 'y' ? angle : 0,
    rz: axis === 'z' ? angle : 0,
  };
}

/**
 * Full coupled rigid-body kinematic solver for mechanical assemblies:
 * - Screw + Slide (Drill Press Vise, Arbor Press, Clamp):
 *   Lead screw rotates & translates axially, rigidly carrying its handle/T-bar around the screw axis,
 *   while driving the sliding jaw/ram by the EXACT same collision-clamped axial stroke (zero clipping!).
 * - Screw Valve / Clamping Bolt (Screw without sliding jaw):
 *   Screw & attached handle rotate & advance modestly along the screw axis.
 * - Pure Rotary (Pillow Block Bearing, NEMA 23 Motor + Coupler):
 *   Shaft & coupled coaxial components rotate smoothly in-place with zero axial drift.
 */
export function solveAssemblyKinematics(
  parts: CadPart3D[],
  mates: CadAssemblyMate[],
  motionFactor: number,
): AssemblyKinematicsResult {
  const deltas: Record<string, KinematicDelta> = {};
  for (const p of parts) {
    deltas[p.id] = { ...ZERO_DELTA };
  }

  const clampedFactor = Math.max(0, Math.min(1, motionFactor));
  const slideMate = mates.find((m) => m.kind === 'slide');
  const screwMate = mates.find((m) => m.kind === 'screw');
  const concentricMates = mates.filter((m) => m.kind === 'concentric');

  // Helper: collect all parts concentrically attached to a driving shaft (e.g., handle, T-bar, knob, coupler)
  const collectCoupledRotatingParts = (driverId: string): CadPart3D[] => {
    const visited = new Set<string>([driverId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of concentricMates) {
        if (visited.has(m.part_a) && !visited.has(m.part_b)) {
          const target = parts.find((p) => p.id === m.part_b);
          if (target && (target.kind === 'cylinder' || target.role === 'actuator' || /handle|grip|bar|knob|coupler|wheel|pulley/i.test(target.name))) {
            visited.add(target.id);
            changed = true;
          }
        } else if (visited.has(m.part_b) && !visited.has(m.part_a)) {
          const target = parts.find((p) => p.id === m.part_a);
          if (target && (target.kind === 'cylinder' || target.role === 'actuator' || /handle|grip|bar|knob|coupler|wheel|pulley/i.test(target.name))) {
            visited.add(target.id);
            changed = true;
          }
        }
      }
    }
    return parts.filter((p) => visited.has(p.id));
  };

  // CASE 1: Coupled Screw + Sliding Jaw / Ram (Drill Press Vise, Drill Jig Press, Clamp)
  if (slideMate) {
    const sliderPart = parts.find((p) => p.id === slideMate.part_a);
    const axis: 'x' | 'y' | 'z' =
      slideMate.axis ??
      screwMate?.axis ??
      (parts.find((p) => p.id === screwMate?.part_a && p.kind === 'cylinder') as Extract<CadPart3D, { kind: 'cylinder' }> | undefined)?.axis ??
      'y';

    const driverScrew =
      (screwMate ? parts.find((p) => p.id === screwMate.part_a) : undefined) ??
      parts.find((p) => p.kind === 'cylinder' && p.threaded && p.axis === axis);

    const coupledRotating = driverScrew ? collectCoupledRotatingParts(driverScrew.id) : [];
    const movingIds = new Set<string>([
      ...(sliderPart ? [sliderPart.id] : []),
      ...coupledRotating.map((p) => p.id),
    ]);

    // Also carry any secondary presser pad/foot attached to a vertical press screw
    if (axis === 'z' && driverScrew) {
      for (const p of parts) {
        if (!movingIds.has(p.id) && /pad|foot|platen|ram|punch|head/i.test(p.name) && p.role !== 'fixed') {
          movingIds.add(p.id);
        }
      }
    }

    const requestedTravel = slideMate.travel_mm ?? screwMate?.travel_mm ?? 26;
    const { signedTravel } = sliderPart
      ? computeSafeSlideStroke(sliderPart, axis, requestedTravel, parts, movingIds)
      : { signedTravel: requestedTravel };

    const axialDelta = signedTravel * clampedFactor;
    const pitch = screwMate?.pitch_mm ?? 4;
    const revs = Math.abs(axialDelta) / Math.max(0.5, pitch);
    const theta = (axialDelta / Math.max(0.5, pitch)) * Math.PI * 2;

    const axDx = axis === 'x' ? axialDelta : 0;
    const axDy = axis === 'y' ? axialDelta : 0;
    const axDz = axis === 'z' ? axialDelta : 0;

    // 1. Translate all purely sliding parts (V-Jaw / presser pad) with ZERO rotation
    for (const id of movingIds) {
      if (coupledRotating.some((r) => r.id === id)) continue;
      deltas[id] = { dx: axDx, dy: axDy, dz: axDz, rx: 0, ry: 0, rz: 0 };
    }

    // 2. Rotate & translate the driving Lead Screw + Handle/T-Bar rigidly around the Lead Screw centerline
    if (driverScrew) {
      const sb = getPart3dBounds(driverScrew);
      const ox = (sb.minX + sb.maxX) / 2;
      const oy = (sb.minY + sb.maxY) / 2;
      const oz = (sb.minZ + sb.maxZ) / 2;

      for (const rotPart of coupledRotating) {
        const pb = getPart3dBounds(rotPart);
        const px = (pb.minX + pb.maxX) / 2;
        const py = (pb.minY + pb.maxY) / 2;
        const pz = (pb.minZ + pb.maxZ) / 2;
        const [nx, ny, nz] = rotatePointAroundAxis(px, py, pz, ox, oy, oz, axis, theta);
        deltas[rotPart.id] = buildDelta(
          axDx + (nx - px),
          axDy + (ny - py),
          axDz + (nz - pz),
          axis,
          theta,
        );
      }
    }

    return {
      deltas,
      mechanismType: driverScrew ? 'screw_slide' : 'linear_slide',
      strokeMm: Math.round(Math.abs(axialDelta) * 10) / 10,
      revolutions: Math.round(revs * 10) / 10,
      angleDeg: Math.round(((revs * 360) % 360) * 10) / 10,
      label: driverScrew ? 'Screw-Drive' : 'Linear Slide',
    };
  }

  // CASE 2: Screw Valve / Vertical Press Screw / Clamping Bolt (has screw mate, no separate slide mate)
  if (screwMate) {
    const driverScrew = parts.find((p) => p.id === screwMate.part_a);
    if (driverScrew) {
      const axis: 'x' | 'y' | 'z' =
        screwMate.axis ?? (driverScrew.kind === 'cylinder' ? driverScrew.axis : 'z');
      const coupledRotating = collectCoupledRotatingParts(driverScrew.id);
      const screwLen = driverScrew.kind === 'cylinder' ? driverScrew.length : 40;
      const maxTravel = Math.min(screwMate.travel_mm ?? 16, Math.max(4, screwLen * 0.22));
      const sign = axis === 'z' ? -1 : 1;
      const axialDelta = sign * maxTravel * clampedFactor;
      const pitch = screwMate.pitch_mm ?? 3;
      const revs = Math.abs(axialDelta) / Math.max(0.5, pitch);
      const theta = (axialDelta / Math.max(0.5, pitch)) * Math.PI * 2;

      const axDx = axis === 'x' ? axialDelta : 0;
      const axDy = axis === 'y' ? axialDelta : 0;
      const axDz = axis === 'z' ? axialDelta : 0;

      const sb = getPart3dBounds(driverScrew);
      const ox = (sb.minX + sb.maxX) / 2;
      const oy = (sb.minY + sb.maxY) / 2;
      const oz = (sb.minZ + sb.maxZ) / 2;

      for (const rotPart of coupledRotating) {
        const pb = getPart3dBounds(rotPart);
        const px = (pb.minX + pb.maxX) / 2;
        const py = (pb.minY + pb.maxY) / 2;
        const pz = (pb.minZ + pb.maxZ) / 2;
        const [nx, ny, nz] = rotatePointAroundAxis(px, py, pz, ox, oy, oz, axis, theta);
        deltas[rotPart.id] = buildDelta(
          axDx + (nx - px),
          axDy + (ny - py),
          axDz + (nz - pz),
          axis,
          theta,
        );
      }

      return {
        deltas,
        mechanismType: 'screw_valve',
        strokeMm: Math.round(Math.abs(axialDelta) * 10) / 10,
        revolutions: Math.round(revs * 10) / 10,
        angleDeg: Math.round(((revs * 360) % 360) * 10) / 10,
        label: 'Threaded Drive',
      };
    }
  }

  // CASE 3: Pure Rotary Shaft Assembly (Pillow Block Bearing, NEMA 23 Stepper + Coupler)
  const primaryRotaryMate = concentricMates[0];
  if (primaryRotaryMate) {
    const shaft =
      parts.find((p) => p.id === primaryRotaryMate.part_a && p.kind === 'cylinder') ??
      parts.find((p) => p.id === primaryRotaryMate.part_b && p.kind === 'cylinder');
    if (shaft && shaft.kind === 'cylinder') {
      const axis = primaryRotaryMate.axis ?? shaft.axis;
      const coupledRotating = collectCoupledRotatingParts(shaft.id);
      const revs = 2.0 * clampedFactor;
      const theta = revs * Math.PI * 2;
      const sb = getPart3dBounds(shaft);
      const ox = (sb.minX + sb.maxX) / 2;
      const oy = (sb.minY + sb.maxY) / 2;
      const oz = (sb.minZ + sb.maxZ) / 2;

      for (const rotPart of coupledRotating) {
        const pb = getPart3dBounds(rotPart);
        const px = (pb.minX + pb.maxX) / 2;
        const py = (pb.minY + pb.maxY) / 2;
        const pz = (pb.minZ + pb.maxZ) / 2;
        const [nx, ny, nz] = rotatePointAroundAxis(px, py, pz, ox, oy, oz, axis, theta);
        deltas[rotPart.id] = buildDelta(nx - px, ny - py, nz - pz, axis, theta);
      }

      return {
        deltas,
        mechanismType: 'rotary',
        strokeMm: 0,
        revolutions: Math.round(revs * 10) / 10,
        angleDeg: Math.round(revs * 360),
        label: 'Rotary Shaft',
      };
    }
  }

  return {
    deltas,
    mechanismType: 'static',
    strokeMm: 0,
    revolutions: 0,
    angleDeg: 0,
    label: 'Static',
  };
}

/**
 * Convenience single-part wrapper around `solveAssemblyKinematics`.
 */
export function computeKinematicTransform(
  part: CadPart3D,
  mates: CadAssemblyMate[],
  motionFactor: number,
  allParts?: CadPart3D[],
): KinematicDelta {
  const res = solveAssemblyKinematics(allParts && allParts.length > 0 ? allParts : [part], mates, motionFactor);
  return res.deltas[part.id] ?? { ...ZERO_DELTA };
}

export interface AssemblyBomRow {
  id: string;
  name: string;
  kind: CadPart3D['kind'];
  role: CadPartRole;
  material: string;
  dimensionsMm: string;
  volumeCm3: number;
  massGrams: number;
}

export interface AssemblyBomSummary {
  rows: AssemblyBomRow[];
  totalVolumeCm3: number;
  totalMassGrams: number;
}

const MATERIAL_SPECS: Record<CadMaterialFinish, { label: string; densityGcm3: number }> = {
  dark_oxide: { label: 'AISI 1045 Steel (Oxide)', densityGcm3: 7.85 },
  cast_iron: { label: 'ASTM A48 Cast Iron', densityGcm3: 7.2 },
  machined_steel: { label: 'AISI 1045 Machined Steel', densityGcm3: 7.85 },
  aluminum: { label: '6061-T6 Aluminum', densityGcm3: 2.7 },
  brass: { label: 'C360 Free-Machining Brass', densityGcm3: 8.5 },
  anodized_blue: { label: '6061-T6 Anodized Alu', densityGcm3: 2.7 },
};

function polygonArea2D(points: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function holesAreaMm2(holes?: CadHole2D[]): number {
  if (!holes) return 0;
  let area = 0;
  for (const h of holes) {
    if (h.kind === 'circle') area += Math.PI * h.radius * h.radius;
    else if (h.kind === 'rect') area += h.width * h.height;
    else if (h.kind === 'slot') {
      const len = Math.hypot(h.x2 - h.x1, h.y2 - h.y1);
      const r = h.width / 2;
      area += len * h.width + Math.PI * r * r;
    }
  }
  return area;
}

export function computeAssemblyBom(parts: CadPart3D[], mates: CadAssemblyMate[] = []): AssemblyBomSummary {
  const rows: AssemblyBomRow[] = [];
  let totalVolumeCm3 = 0;
  let totalMassGrams = 0;

  parts.forEach((part, idx) => {
    const finish: CadMaterialFinish = part.finish ?? (idx % 2 === 0 ? 'dark_oxide' : 'cast_iron');
    const mat = MATERIAL_SPECS[finish] ?? MATERIAL_SPECS.machined_steel;

    let volumeMm3 = 0;
    let dims = '';
    if (part.kind === 'plate') {
      const netArea = Math.max(10, part.width * part.depth - holesAreaMm2(part.holes));
      volumeMm3 = netArea * part.height;
      dims = `${part.width.toFixed(0)}×${part.depth.toFixed(0)}×${part.height.toFixed(0)}`;
    } else if (part.kind === 'box') {
      volumeMm3 = part.width * part.depth * part.height;
      dims = `${part.width.toFixed(0)}×${part.depth.toFixed(0)}×${part.height.toFixed(0)}`;
    } else if (part.kind === 'prism') {
      const netArea = Math.max(10, polygonArea2D(part.points) - holesAreaMm2(part.holes));
      volumeMm3 = netArea * part.height;
      const b = getPart3dBounds(part);
      dims = `${(b.maxX - b.minX).toFixed(0)}×${(b.maxY - b.minY).toFixed(0)}×${part.height.toFixed(0)}`;
    } else {
      const outer = Math.PI * part.radius * part.radius;
      const inner = part.inner_radius ? Math.PI * part.inner_radius * part.inner_radius : 0;
      volumeMm3 = Math.max(5, outer - inner) * part.length;
      dims = `Ø${(part.radius * 2).toFixed(0)}×L${part.length.toFixed(0)}`;
    }

    const volumeCm3 = Math.round((volumeMm3 / 1000) * 10) / 10;
    const massGrams = Math.round(volumeCm3 * mat.densityGcm3);
    totalVolumeCm3 += volumeCm3;
    totalMassGrams += massGrams;

    const inferredRole: CadPartRole =
      part.role ??
      (mates.some((m) => m.kind === 'slide' && m.part_a === part.id)
        ? 'moving'
        : part.kind === 'cylinder'
          ? part.threaded
            ? 'shaft'
            : 'actuator'
          : 'fixed');

    rows.push({
      id: part.id,
      name: part.name,
      kind: part.kind,
      role: inferredRole,
      material: part.material_label || mat.label,
      dimensionsMm: dims,
      volumeCm3,
      massGrams,
    });
  });

  return {
    rows,
    totalVolumeCm3: Math.round(totalVolumeCm3 * 10) / 10,
    totalMassGrams,
  };
}


