import * as THREE from 'three';
import type {
  CadHole2D,
  CadMaterialFinish,
  CadPart3D,
} from '../types/cadcraft';
import { computeExplodedOffset, getPart3dBounds, type Bounds3D } from './cad3dModel';

export type CadShadingMode = 'shaded_edges' | 'shaded' | 'wireframe';
export type MaterialOverride = 'auto' | CadMaterialFinish;

interface FinishSpec {
  color: number;
  metalness: number;
  roughness: number;
  edgeColor: number;
  clearcoat?: number;
}

const FINISH_PALETTE: Record<CadMaterialFinish, FinishSpec> = {
  dark_oxide: {
    color: 0x3b2d26,
    metalness: 0.42,
    roughness: 0.52,
    edgeColor: 0x0f1216,
    clearcoat: 0.15,
  },
  cast_iron: {
    color: 0x454a52,
    metalness: 0.55,
    roughness: 0.62,
    edgeColor: 0x101318,
  },
  machined_steel: {
    color: 0xa4b0be,
    metalness: 0.84,
    roughness: 0.28,
    edgeColor: 0x1b222c,
  },
  aluminum: {
    color: 0xc8d2dc,
    metalness: 0.78,
    roughness: 0.34,
    edgeColor: 0x26303d,
  },
  brass: {
    color: 0xc29b4a,
    metalness: 0.86,
    roughness: 0.28,
    edgeColor: 0x3b2c12,
  },
  anodized_blue: {
    color: 0x2f65b8,
    metalness: 0.65,
    roughness: 0.32,
    edgeColor: 0x93c5fd,
  },
};

function createMaterial(
  finish: CadMaterialFinish,
  shadingMode: CadShadingMode,
): THREE.MeshPhysicalMaterial {
  const spec = FINISH_PALETTE[finish] ?? FINISH_PALETTE.machined_steel;
  if (shadingMode === 'wireframe') {
    return new THREE.MeshPhysicalMaterial({
      color: 0x60a5fa,
      metalness: 0.1,
      roughness: 0.8,
      wireframe: true,
    });
  }
  return new THREE.MeshPhysicalMaterial({
    color: spec.color,
    metalness: spec.metalness,
    roughness: spec.roughness,
    clearcoat: spec.clearcoat ?? 0.08,
    clearcoatRoughness: 0.35,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

function addHolePathToShape(shape: THREE.Shape, hole: CadHole2D) {
  if (hole.kind === 'circle') {
    if (hole.radius <= 0.1) return;
    const path = new THREE.Path();
    path.absarc(hole.cx, hole.cy, hole.radius, 0, Math.PI * 2, true);
    shape.holes.push(path);
    return;
  }

  if (hole.kind === 'rect') {
    const hw = hole.width / 2;
    const hh = hole.height / 2;
    if (hw <= 0.1 || hh <= 0.1) return;
    const path = new THREE.Path();
    path.moveTo(hole.cx - hw, hole.cy - hh);
    path.lineTo(hole.cx - hw, hole.cy + hh);
    path.lineTo(hole.cx + hw, hole.cy + hh);
    path.lineTo(hole.cx + hw, hole.cy - hh);
    path.closePath();
    shape.holes.push(path);
    return;
  }

  if (hole.kind === 'slot') {
    const r = Math.max(0.25, hole.width / 2);
    const dx = hole.x2 - hole.x1;
    const dy = hole.y2 - hole.y1;
    const baseAngle = Math.atan2(dy, dx);
    const path = new THREE.Path();
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const a = baseAngle + Math.PI / 2 + (i / steps) * Math.PI;
      const x = hole.x1 + Math.cos(a) * r;
      const y = hole.y1 + Math.sin(a) * r;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    for (let i = 0; i <= steps; i++) {
      const a = baseAngle - Math.PI / 2 + (i / steps) * Math.PI;
      const x = hole.x2 + Math.cos(a) * r;
      const y = hole.y2 + Math.sin(a) * r;
      path.lineTo(x, y);
    }
    path.closePath();
    shape.holes.push(path);
  }
}

function sanitizePolygonPoints(raw: [number, number][]): [number, number][] {
  const deduped: [number, number][] = [];
  for (const pt of raw) {
    const prev = deduped[deduped.length - 1];
    if (!prev || Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 1e-3) {
      deduped.push([pt[0], pt[1]]);
    }
  }
  if (
    deduped.length > 2 &&
    Math.hypot(
      deduped[0][0] - deduped[deduped.length - 1][0],
      deduped[0][1] - deduped[deduped.length - 1][1],
    ) <= 1e-3
  ) {
    deduped.pop();
  }
  if (deduped.length < 3) return deduped;

  // Enforce counter-clockwise (CCW, positive signed area) winding so Three.js ExtrudeGeometry
  // faces always point outward and never back-face cull when combined with CW holes.
  let signedArea2 = 0;
  for (let i = 0; i < deduped.length; i++) {
    const [x1, y1] = deduped[i];
    const [x2, y2] = deduped[(i + 1) % deduped.length];
    signedArea2 += x1 * y2 - x2 * y1;
  }
  return signedArea2 < 0 ? [...deduped].reverse() : deduped;
}

function isPointInPolygon(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function holeCenter(hole: CadHole2D): [number, number] {
  if (hole.kind === 'slot') {
    return [(hole.x1 + hole.x2) / 2, (hole.y1 + hole.y2) / 2];
  }
  return [hole.cx, hole.cy];
}

function buildRoundedRectShape(
  cx: number,
  cy: number,
  width: number,
  depth: number,
  cornerRadius = 0,
): THREE.Shape {
  const x = cx - width / 2;
  const y = cy - depth / 2;
  const r = Math.max(0, Math.min(cornerRadius, width * 0.25, depth * 0.25));
  const shape = new THREE.Shape();
  if (r <= 0.05) {
    shape.moveTo(x, y);
    shape.lineTo(x + width, y);
    shape.lineTo(x + width, y + depth);
    shape.lineTo(x, y + depth);
    shape.closePath();
  } else {
    shape.moveTo(x + r, y);
    shape.lineTo(x + width - r, y);
    shape.quadraticCurveTo(x + width, y, x + width, y + r);
    shape.lineTo(x + width, y + depth - r);
    shape.quadraticCurveTo(x + width, y + depth, x + width - r, y + depth);
    shape.lineTo(x + r, y + depth);
    shape.quadraticCurveTo(x, y + depth, x, y + depth - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    shape.closePath();
  }
  return shape;
}

function buildThreadedShaftGeometry(radius: number, length: number): THREE.BufferGeometry {
  const halfLen = length / 2;
  const pitch = Math.max(1.2, Math.min(3.0, radius * 0.36));
  const threadDepth = Math.min(radius * 0.22, pitch * 0.42);
  const rootR = Math.max(0.4, radius - threadDepth);
  const count = Math.max(4, Math.min(56, Math.floor(length / pitch)));
  const actualPitch = length / count;

  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.001, -halfLen),
    new THREE.Vector2(rootR, -halfLen),
  ];

  for (let i = 0; i < count; i++) {
    const y0 = -halfLen + i * actualPitch;
    const yMid = y0 + actualPitch * 0.5;
    const y1 = y0 + actualPitch;
    pts.push(new THREE.Vector2(radius, yMid));
    pts.push(new THREE.Vector2(rootR, y1));
  }

  pts.push(new THREE.Vector2(0.001, halfLen));
  const geo = new THREE.LatheGeometry(pts, 28);

  // Add subtle helical thread lead so turning the screw visibly advances the helical ridges
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r > rootR * 0.5 && Math.abs(y) < halfLen - actualPitch * 0.45) {
      const theta = Math.atan2(z, x); // -PI..PI
      const leadShift = (theta / (Math.PI * 2)) * actualPitch;
      pos.setY(i, Math.max(-halfLen + 0.15, Math.min(halfLen - 0.15, y + leadShift)));
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function buildFlutedHandleGeometry(radius: number, length: number): THREE.BufferGeometry {
  // 8-flute ergonomic machined grip cross-section so handle rotation is crisp and unmistakable
  const shape = new THREE.Shape();
  const flutes = 8;
  const steps = flutes * 6;
  const amp = Math.min(radius * 0.08, 0.7);
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r = radius - amp * (0.5 - 0.5 * Math.cos(a * flutes));
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const bevel = Math.min(0.6, radius * 0.12, length * 0.08);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.5, length - bevel * 2),
    bevelEnabled: bevel > 0.05,
    bevelThickness: bevel,
    bevelSize: bevel * 0.65,
    bevelSegments: 2,
    curveSegments: 16,
  });
  geo.translate(0, 0, -(length - bevel * 2) / 2);
  geo.rotateX(Math.PI / 2);
  return geo;
}

function buildKeyedShaftGeometry(radius: number, length: number): THREE.BufferGeometry {
  // Smooth circular shaft with a crisp DIN 6885 machined flat/keyway notch for visible rotation
  const shape = new THREE.Shape();
  const steps = 36;
  const notchHalfAngle = 0.22; // ~12.5 deg each side
  const notchRadius = radius * 0.84;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const isNotch = a < notchHalfAngle || a > Math.PI * 2 - notchHalfAngle;
    const r = isNotch ? notchRadius : radius;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: length,
    bevelEnabled: false,
    curveSegments: 12,
  });
  geo.translate(0, 0, -length / 2);
  geo.rotateX(Math.PI / 2);
  return geo;
}

function buildPartGeometry(part: CadPart3D): {
  geometry: THREE.BufferGeometry;
  applyTransform: (obj: THREE.Object3D) => void;
} {
  if (part.kind === 'plate') {
    const shape = buildRoundedRectShape(part.cx, part.cy, part.width, part.depth, 0.8);
    if (part.holes) {
      for (const hole of part.holes) {
        addHolePathToShape(shape, hole);
      }
    }
    const bevel = Math.max(0, Math.min(part.bevel ?? 0.6, part.height * 0.16, 1.5));
    const innerDepth = Math.max(0.2, part.height - bevel * 2);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: innerDepth,
      bevelEnabled: bevel > 0.05,
      bevelThickness: bevel,
      bevelSize: bevel * 0.65,
      bevelSegments: 2,
      curveSegments: 24,
    });
    return {
      geometry,
      applyTransform: (obj) => {
        obj.rotation.x = -Math.PI / 2;
        obj.position.set(0, part.z_min + (bevel > 0.05 ? bevel : 0), 0);
      },
    };
  }

  if (part.kind === 'box') {
    const shape = buildRoundedRectShape(part.cx, part.cy, part.width, part.depth, 0.4);
    const bevel = Math.max(0, Math.min(part.bevel ?? 0.5, part.height * 0.15, 1.2));
    const innerDepth = Math.max(0.2, part.height - bevel * 2);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: innerDepth,
      bevelEnabled: bevel > 0.05,
      bevelThickness: bevel,
      bevelSize: bevel * 0.6,
      bevelSegments: 2,
      curveSegments: 16,
    });
    return {
      geometry,
      applyTransform: (obj) => {
        obj.rotation.x = -Math.PI / 2;
        obj.position.set(0, part.z_min + (bevel > 0.05 ? bevel : 0), 0);
      },
    };
  }

  if (part.kind === 'prism') {
    const ccwPoints = sanitizePolygonPoints(part.points);
    const shape = new THREE.Shape();
    ccwPoints.forEach(([x, y], idx) => {
      if (idx === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
    shape.closePath();
    if (part.holes && ccwPoints.length >= 3) {
      for (const hole of part.holes) {
        const [hx, hy] = holeCenter(hole);
        if (isPointInPolygon(hx, hy, ccwPoints)) {
          addHolePathToShape(shape, hole);
        }
      }
    }
    const bevel = Math.max(0, Math.min(part.bevel ?? 0.5, part.height * 0.15, 1.2));
    const innerDepth = Math.max(0.2, part.height - bevel * 2);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: innerDepth,
      bevelEnabled: bevel > 0.05,
      bevelThickness: bevel,
      bevelSize: bevel * 0.55,
      bevelSegments: 2,
      curveSegments: 20,
    });
    return {
      geometry,
      applyTransform: (obj) => {
        obj.rotation.x = -Math.PI / 2;
        obj.position.set(0, part.z_min + (bevel > 0.05 ? bevel : 0), 0);
      },
    };
  }

  // Cylinder (supports x, y, z axes, helical threaded screw, fluted handle, keyed shaft, or hollow pipe)
  let geometry: THREE.BufferGeometry;
  const lowerName = part.name.toLowerCase();
  if (part.threaded) {
    geometry = buildThreadedShaftGeometry(part.radius, part.length);
  } else if (part.inner_radius && part.inner_radius > 0.1 && part.inner_radius < part.radius) {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, part.radius, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, part.inner_radius, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    geometry = new THREE.ExtrudeGeometry(shape, {
      depth: part.length,
      bevelEnabled: false,
      curveSegments: 32,
    });
    geometry.translate(0, 0, -part.length / 2);
    geometry.rotateX(Math.PI / 2);
  } else if (part.role === 'actuator' || /handle|grip|knob/i.test(lowerName)) {
    geometry = buildFlutedHandleGeometry(part.radius, part.length);
  } else if (part.role === 'shaft' || /shaft|spindle|coupler|rotor/i.test(lowerName)) {
    geometry = buildKeyedShaftGeometry(part.radius, part.length);
  } else {
    geometry = new THREE.CylinderGeometry(part.radius, part.radius, part.length, 32, 1, false);
  }

  return {
    geometry,
    applyTransform: (obj) => {
      obj.position.set(part.cx, part.cz, -part.cy);
      if (part.axis === 'x') {
        obj.rotation.set(0, 0, -Math.PI / 2);
      } else if (part.axis === 'y') {
        obj.rotation.set(Math.PI / 2, 0, 0);
      } else {
        obj.rotation.set(0, 0, 0);
      }
    },
  };
}

export interface BuiltPartEntry {
  part: CadPart3D;
  wrapper: THREE.Group;
  pivotGroup: THREE.Group;
  pivotCenter: THREE.Vector3;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments | null;
  defaultEdgeColor: number;
  defaultEdgeOpacity: number;
}

export type PartHighlightState = 'none' | 'selected' | 'mated';

export function applyPartVisualState(
  entry: BuiltPartEntry,
  highlight: PartHighlightState,
  visible: boolean,
) {
  entry.wrapper.visible = visible;
  const mat = entry.mesh.material as THREE.MeshPhysicalMaterial;
  if (mat && 'emissive' in mat) {
    if (highlight === 'selected') {
      mat.emissive.setHex(0x2563eb);
      mat.emissiveIntensity = 0.48;
    } else if (highlight === 'mated') {
      mat.emissive.setHex(0x06b6d4);
      mat.emissiveIntensity = 0.32;
    } else {
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 0;
    }
  }
  if (entry.edges) {
    const edgeMat = entry.edges.material as THREE.LineBasicMaterial;
    if (highlight === 'selected') {
      edgeMat.color.setHex(0x60a5fa);
      edgeMat.opacity = 1;
    } else if (highlight === 'mated') {
      edgeMat.color.setHex(0x22d3ee);
      edgeMat.opacity = 0.95;
    } else {
      edgeMat.color.setHex(entry.defaultEdgeColor);
      edgeMat.opacity = entry.defaultEdgeOpacity;
    }
  }
}

export function buildCadAssemblyGroup(
  parts: CadPart3D[],
  bounds: Bounds3D,
  shadingMode: CadShadingMode,
  materialOverride: MaterialOverride,
  explodeFactor: number,
): { group: THREE.Group; entries: BuiltPartEntry[] } {
  const root = new THREE.Group();
  const entries: BuiltPartEntry[] = [];

  // Center assembly horizontally on XZ and ground its lowest Z flush at Y = 0
  root.position.set(-bounds.centerX, -bounds.minZ, bounds.centerY);

  parts.forEach((part, idx) => {
    const defaultFinishes: CadMaterialFinish[] = [
      'dark_oxide',
      'cast_iron',
      'machined_steel',
      'dark_oxide',
    ];
    const resolvedFinish: CadMaterialFinish =
      materialOverride !== 'auto'
        ? materialOverride
        : part.finish ?? defaultFinishes[idx % defaultFinishes.length];

    const pb = getPart3dBounds(part);
    const pivotCenter = new THREE.Vector3(
      (pb.minX + pb.maxX) / 2,
      (pb.minZ + pb.maxZ) / 2,
      -(pb.minY + pb.maxY) / 2,
    );

    const wrapper = new THREE.Group();
    wrapper.name = part.name;
    wrapper.userData.partId = part.id;

    const pivotGroup = new THREE.Group();
    wrapper.add(pivotGroup);

    const { geometry, applyTransform } = buildPartGeometry(part);
    const mat = createMaterial(resolvedFinish, shadingMode);
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.partId = part.id;
    applyTransform(mesh);
    mesh.position.sub(pivotCenter);
    pivotGroup.add(mesh);

    const spec = FINISH_PALETTE[resolvedFinish] ?? FINISH_PALETTE.machined_steel;
    const defaultEdgeColor = spec.edgeColor;
    const defaultEdgeOpacity = part.kind === 'cylinder' && part.threaded ? 0.35 : 0.72;
    let lines: THREE.LineSegments | null = null;

    if (shadingMode === 'shaded_edges') {
      const edgeThreshold = part.kind === 'cylinder' && part.threaded ? 38 : 22;
      const edgesGeo = new THREE.EdgesGeometry(geometry, edgeThreshold);
      const edgeMat = new THREE.LineBasicMaterial({
        color: defaultEdgeColor,
        transparent: true,
        opacity: defaultEdgeOpacity,
      });
      lines = new THREE.LineSegments(edgesGeo, edgeMat);
      applyTransform(lines);
      lines.position.sub(pivotCenter);
      pivotGroup.add(lines);
    }

    const offset = computeExplodedOffset(part, bounds, explodeFactor);
    wrapper.position.set(
      pivotCenter.x + offset.dx,
      pivotCenter.y + offset.dz,
      pivotCenter.z - offset.dy,
    );
    root.add(wrapper);

    entries.push({
      part,
      wrapper,
      pivotGroup,
      pivotCenter,
      mesh,
      edges: lines,
      defaultEdgeColor,
      defaultEdgeOpacity,
    });
  });

  return { group: root, entries };
}

export function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach((m) => m.dispose());
      } else {
        child.material.dispose();
      }
    }
  });
}
