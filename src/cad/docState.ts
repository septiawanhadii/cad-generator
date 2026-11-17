import type { CadEntity, DocState, DocSummary, Point2D } from '../types/cadcraft';

const EPSILON = 1e-3;

let nextEntitySeq = 1;

export function createEntityId(prefix = 'ent'): string {
  nextEntitySeq += 1;
  return `${prefix}-${nextEntitySeq.toString(36)}`;
}

export function cloneEntities(entities: CadEntity[]): CadEntity[] {
  return entities.map((ent) => {
    if (ent.kind === 'polyline') {
      return { ...ent, points: ent.points.map((p) => ({ ...p })) };
    }
    return { ...ent };
  });
}

export function createInitialDocState(): DocState {
  return {
    entities: [],
    layers: [
      { name: '0', color: '#F1F5F9', visible: true },
      { name: 'CUTOUTS', color: '#06B6D4', visible: true },
      { name: 'CONSTRUCTION', color: '#94A3B8', visible: true },
    ],
    activeLayer: '0',
    unit: 'mm',
    extrudeDepthMm: 12.0,
    filletRadiusMm: null,
    lastPartName: 'cadcraft_part',
    undoStack: [],
    redoStack: [],
    activeUndoSnapshot: null,
  };
}

export function beginUndoGroup(doc: DocState): DocState {
  if (doc.activeUndoSnapshot !== null) {
    return doc;
  }
  return {
    ...doc,
    activeUndoSnapshot: cloneEntities(doc.entities),
  };
}

export function endUndoGroup(doc: DocState): DocState {
  if (doc.activeUndoSnapshot === null) {
    return doc;
  }
  const before = JSON.stringify(doc.activeUndoSnapshot);
  const after = JSON.stringify(doc.entities);
  if (before === after) {
    return {
      ...doc,
      activeUndoSnapshot: null,
    };
  }
  return {
    ...doc,
    undoStack: [...doc.undoStack, doc.activeUndoSnapshot],
    redoStack: [],
    activeUndoSnapshot: null,
  };
}

export function pushImmediateUndo(doc: DocState, nextEntities: CadEntity[]): DocState {
  const snapshot = cloneEntities(doc.entities);
  return {
    ...doc,
    entities: nextEntities,
    undoStack: [...doc.undoStack, snapshot],
    redoStack: [],
    activeUndoSnapshot: null,
  };
}

export function undoDoc(doc: DocState): DocState {
  if (doc.undoStack.length === 0) {
    return doc;
  }
  const previous = doc.undoStack[doc.undoStack.length - 1];
  return {
    ...doc,
    entities: cloneEntities(previous),
    undoStack: doc.undoStack.slice(0, -1),
    redoStack: [...doc.redoStack, cloneEntities(doc.entities)],
    activeUndoSnapshot: null,
  };
}

export function redoDoc(doc: DocState): DocState {
  if (doc.redoStack.length === 0) {
    return doc;
  }
  const next = doc.redoStack[doc.redoStack.length - 1];
  return {
    ...doc,
    entities: cloneEntities(next),
    undoStack: [...doc.undoStack, cloneEntities(doc.entities)],
    redoStack: doc.redoStack.slice(0, -1),
    activeUndoSnapshot: null,
  };
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPSILON;
}

function samePoint(a: Point2D, b: Point2D): boolean {
  return near(a.x, b.x) && near(a.y, b.y);
}

function canonicalEntitySignature(ent: CadEntity): string {
  const q = (n: number) => Math.round(n * 1000) / 1000;
  switch (ent.kind) {
    case 'rectangle': {
      const minX = q(Math.min(ent.x1, ent.x2));
      const maxX = q(Math.max(ent.x1, ent.x2));
      const minY = q(Math.min(ent.y1, ent.y2));
      const maxY = q(Math.max(ent.y1, ent.y2));
      return `rect:${ent.layer}:${minX},${minY},${maxX},${maxY}`;
    }
    case 'circle':
      return `circle:${ent.layer}:${q(ent.cx)},${q(ent.cy)},${q(ent.radius)}`;
    case 'line': {
      const p1 = `${q(ent.x1)},${q(ent.y1)}`;
      const p2 = `${q(ent.x2)},${q(ent.y2)}`;
      const ordered = p1 <= p2 ? `${p1}->${p2}` : `${p2}->${p1}`;
      return `line:${ent.layer}:${ordered}`;
    }
    case 'arc':
      return `arc:${ent.layer}:${q(ent.cx)},${q(ent.cy)},${q(ent.radius)},${q(ent.startAngleDeg)},${q(ent.endAngleDeg)}`;
    case 'polyline':
      return `poly:${ent.layer}:${ent.closed}:${ent.points.map((p) => `${q(p.x)},${q(p.y)}`).join('|')}`;
  }
}

export function runOverkill(doc: DocState): { doc: DocState; removedCount: number } {
  const seen = new Set<string>();
  const kept: CadEntity[] = [];
  let removedCount = 0;

  for (const ent of doc.entities) {
    // Drop degenerate zero-length lines or zero-radius circles
    if (ent.kind === 'line' && near(ent.x1, ent.x2) && near(ent.y1, ent.y2)) {
      removedCount += 1;
      continue;
    }
    if (ent.kind === 'circle' && ent.radius <= EPSILON) {
      removedCount += 1;
      continue;
    }
    const sig = canonicalEntitySignature(ent);
    if (seen.has(sig)) {
      removedCount += 1;
      continue;
    }
    seen.add(sig);
    kept.push(ent);
  }

  if (removedCount === 0) {
    return { doc, removedCount: 0 };
  }

  const nextDoc =
    doc.activeUndoSnapshot !== null
      ? { ...doc, entities: kept }
      : pushImmediateUndo(doc, kept);

  return { doc: nextDoc, removedCount };
}

export function runJoin(doc: DocState): { doc: DocState; joinedChains: number } {
  const lines = doc.entities.filter((e): e is Extract<CadEntity, { kind: 'line' }> => e.kind === 'line');
  const others = doc.entities.filter((e) => e.kind !== 'line');

  if (lines.length < 2) {
    return { doc, joinedChains: 0 };
  }

  const used = new Array<boolean>(lines.length).fill(false);
  const resultingEntities: CadEntity[] = [...others];
  let joinedChains = 0;

  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const base = lines[i];
    const chain: Point2D[] = [
      { x: base.x1, y: base.y1 },
      { x: base.x2, y: base.y2 },
    ];
    let merged = 0;
    let progress = true;

    while (progress) {
      progress = false;
      const head = chain[0];
      const tail = chain[chain.length - 1];
      for (let j = 0; j < lines.length; j++) {
        if (used[j] || lines[j].layer !== base.layer) continue;
        const seg = lines[j];
        const a: Point2D = { x: seg.x1, y: seg.y1 };
        const b: Point2D = { x: seg.x2, y: seg.y2 };

        if (samePoint(tail, a)) {
          chain.push(b);
          used[j] = true;
          merged += 1;
          progress = true;
          break;
        }
        if (samePoint(tail, b)) {
          chain.push(a);
          used[j] = true;
          merged += 1;
          progress = true;
          break;
        }
        if (samePoint(head, b)) {
          chain.unshift(a);
          used[j] = true;
          merged += 1;
          progress = true;
          break;
        }
        if (samePoint(head, a)) {
          chain.unshift(b);
          used[j] = true;
          merged += 1;
          progress = true;
          break;
        }
      }
    }

    if (merged > 0) {
      joinedChains += 1;
      const closed = chain.length >= 3 && samePoint(chain[0], chain[chain.length - 1]);
      const finalPoints = closed ? chain.slice(0, -1) : chain;
      resultingEntities.push({
        id: createEntityId('poly'),
        kind: 'polyline',
        layer: base.layer,
        points: finalPoints,
        closed,
      });
    } else {
      resultingEntities.push(base);
    }
  }

  if (joinedChains === 0) {
    return { doc, joinedChains: 0 };
  }

  const nextDoc =
    doc.activeUndoSnapshot !== null
      ? { ...doc, entities: resultingEntities }
      : pushImmediateUndo(doc, resultingEntities);

  return { doc: nextDoc, joinedChains };
}

export function getEntityBounds(ent: CadEntity): { minX: number; minY: number; maxX: number; maxY: number } {
  switch (ent.kind) {
    case 'rectangle':
      return {
        minX: Math.min(ent.x1, ent.x2),
        minY: Math.min(ent.y1, ent.y2),
        maxX: Math.max(ent.x1, ent.x2),
        maxY: Math.max(ent.y1, ent.y2),
      };
    case 'circle':
    case 'arc':
      return {
        minX: ent.cx - ent.radius,
        minY: ent.cy - ent.radius,
        maxX: ent.cx + ent.radius,
        maxY: ent.cy + ent.radius,
      };
    case 'line':
      return {
        minX: Math.min(ent.x1, ent.x2),
        minY: Math.min(ent.y1, ent.y2),
        maxX: Math.max(ent.x1, ent.x2),
        maxY: Math.max(ent.y1, ent.y2),
      };
    case 'polyline': {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of ent.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { minX, minY, maxX, maxY };
    }
  }
}

export function getDocSummary(doc: DocState): DocSummary {
  if (doc.entities.length === 0) {
    return {
      activeLayer: doc.activeLayer,
      entityCount: 0,
      unit: doc.unit,
      extents: null,
      extrudeDepthMm: doc.extrudeDepthMm,
      filletRadiusMm: doc.filletRadiusMm,
      lastPartName: doc.lastPartName,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const ent of doc.entities) {
    const b = getEntityBounds(ent);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }

  return {
    activeLayer: doc.activeLayer,
    entityCount: doc.entities.length,
    unit: doc.unit,
    extents: {
      minX: Math.round(minX * 100) / 100,
      minY: Math.round(minY * 100) / 100,
      maxX: Math.round(maxX * 100) / 100,
      maxY: Math.round(maxY * 100) / 100,
      width: Math.round((maxX - minX) * 100) / 100,
      height: Math.round((maxY - minY) * 100) / 100,
    },
    extrudeDepthMm: doc.extrudeDepthMm,
    filletRadiusMm: doc.filletRadiusMm,
    lastPartName: doc.lastPartName,
  };
}
