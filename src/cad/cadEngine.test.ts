import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginUndoGroup,
  createInitialDocState,
  endUndoGroup,
  getDocSummary,
  redoDoc,
  runJoin,
  runOverkill,
  undoDoc,
} from './docState';
import { evaluateAutoLisp, executeCmdlineList } from './lispEvaluator';
import { buildSolidWorksSpecFromDoc, exportDocToDxf, mmToMeters } from './dxfExporter';
import { extractJsonFromLlmText, normalizeAiPayload } from './aiPayloadParser';
import {
  computeAssemblyBom,
  computeExplodedOffset,
  computeKinematicTransform,
  computeParts3dBounds,
  derive2dEntitiesFromParts3d,
  deriveParts3dFrom2dDoc,
  inferAssemblyMates,
  parseAssemblyMates,
  parseParts3d,
  solveAssemblyKinematics,
} from './cad3dModel';
import { DEFAULT_BRIDGE_CONFIG } from '../types/cadcraft';

test('AutoLISP evaluates mounting plate seed and creates atomic undo group', () => {
  const initial = createInitialDocState();
  const lisp = `(progn
    (command "_RECTANG" '(0 0) '(120 80))
    (command "_CIRCLE" '(60 40) 15)
    (command "_CIRCLE" '(10 10) 3)
    (command "_CIRCLE" '(110 10) 3)
    (command "_CIRCLE" '(10 70) 3)
    (command "_CIRCLE" '(110 70) 3)
  )`;

  const res = evaluateAutoLisp(lisp, initial);
  assert.equal(res.ok, true);
  assert.equal(res.addedCount, 6);
  assert.equal(res.doc.entities.length, 6);
  assert.equal(res.doc.undoStack.length, 1);

  const summary = getDocSummary(res.doc);
  assert.equal(summary.extents?.width, 120);
  assert.equal(summary.extents?.height, 80);

  // Single Ctrl+Z reverts all 6 entities from the AI batch
  const undone = undoDoc(res.doc);
  assert.equal(undone.entities.length, 0);
  assert.equal(undone.redoStack.length, 1);

  // Redo restores all 6
  const redone = redoDoc(undone);
  assert.equal(redone.entities.length, 6);
});

test('AutoLISP rejects unbalanced parentheses with explicit error and preserves state', () => {
  const initial = createInitialDocState();
  const res = evaluateAutoLisp('(command "_CIRCLE" \'(50 50) 10', initial);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /parentheses/i);
  assert.equal(res.doc.entities.length, 0);
});

test('OVERKILL deduplicates overlapping entities and JOIN merges connected lines into polyline', () => {
  let doc = createInitialDocState();
  doc = beginUndoGroup(doc);
  const res1 = evaluateAutoLisp(
    `(progn
      (command "_CIRCLE" '(25 25) 5)
      (command "_CIRCLE" '(25 25) 5)
      (command "_LINE" '(0 0) '(100 0))
      (command "_LINE" '(100 0) '(100 50))
      (command "_LINE" '(100 50) '(0 50))
      (command "_LINE" '(0 50) '(0 0))
    )`,
    doc,
  );
  assert.equal(res1.ok, true);
  assert.equal(res1.doc.entities.length, 6);

  const over = runOverkill(res1.doc);
  assert.equal(over.removedCount, 1);
  assert.equal(over.doc.entities.length, 5);

  const joined = runJoin(over.doc);
  assert.equal(joined.joinedChains, 1);
  assert.equal(joined.doc.entities.length, 2); // 1 circle + 1 closed polyline
  const poly = joined.doc.entities.find((e) => e.kind === 'polyline');
  assert.ok(poly && poly.kind === 'polyline');
  assert.equal(poly.closed, true);
  assert.equal(poly.points.length, 4);
});

test('executeCmdlineList supports OVERKILL + JOIN and compact CLI commands', () => {
  const initial = createInitialDocState();
  const res = executeCmdlineList(
    ['RECTANG 0,0 80,60', 'CIRCLE 40,30 10', 'CIRCLE 40,30 10', 'OVERKILL'],
    initial,
  );
  assert.equal(res.ok, true);
  assert.equal(res.doc.entities.length, 2);
});

test('DXF exporter and SolidWorksBuildSpec enforce millimeter-to-meter unit guard', () => {
  const initial = createInitialDocState();
  const res = evaluateAutoLisp(
    `(progn (command "_RECTANG" '(0 0) '(120 80)) (command "_CIRCLE" '(60 40) 15))`,
    initial,
  );
  assert.equal(res.ok, true);

  const dxf = exportDocToDxf(res.doc);
  assert.match(dxf, /\$INSUNITS/);
  assert.match(dxf, /LWPOLYLINE/);
  assert.match(dxf, /CIRCLE/);
  assert.match(dxf, /EOF\s*$/);

  const spec = buildSolidWorksSpecFromDoc(res.doc, DEFAULT_BRIDGE_CONFIG, {
    partName: 'mounting_plate',
    extrudeDepthMm: 12,
  });
  assert.equal(spec.part_name, 'mounting_plate');
  assert.equal(spec.extrude_depth_mm, 12);
  assert.equal(mmToMeters(spec.extrude_depth_mm), 0.012);
  assert.equal(spec.entities.length, 2);
  assert.equal(spec.entities[0].kind, 'rectangle');
  assert.equal(spec.entities[0].width_mm, 120);
  assert.equal(spec.entities[0].height_mm, 80);
});

test('AutoLISP supports _SLOT, _POLYGON, diameter keyword, and unquoted tuple points', () => {
  const initial = createInitialDocState();
  const lisp = `(progn
    (command "_RECTANG" (-80 -70) (80 70))
    (command "_SLOT" '(-65 -50) '(-65 50) 12)
    (command "_CIRCLE" '(0 0) "D" 24)
    (command "_POLYGON" '(40 0) 8 6)
    (command "FILLET" "R" 4)
  )`;
  const res = evaluateAutoLisp(lisp, initial);
  assert.equal(res.ok, true);
  assert.equal(res.addedCount, 4);
  const circle = res.doc.entities.find((e) => e.kind === 'circle');
  assert.ok(circle && circle.kind === 'circle');
  assert.equal(circle.radius, 12);
});

test('aiPayloadParser recovers unclosed think tags, unescaped JSON newlines, trailing commas, and raw AutoLISP', () => {
  const withUnclosedThinkAndNewline = `thinking about vise...</think>
Here is the payload:
\`\`\`json
{
  "explanation": "Drill Press Vise base",
  "action_type": "solidworks_3d",
  "lisp_code": "(progn
    (command \\"_RECTANG\\" '(-80 -70) '(80 70))
    (command \\"_CIRCLE\\" '(0 0) 12)
  )",
  "part_name": "drill_press_vise_base",
  "extrude_depth_mm": "15 mm",
}
\`\`\``;
  const parsed1 = extractJsonFromLlmText(withUnclosedThinkAndNewline, 'solidworks_3d');
  const norm1 = normalizeAiPayload(parsed1, 'C:\\Exports', 12, 'solidworks_3d');
  assert.equal(norm1.action_type, 'solidworks_3d');
  assert.equal((norm1.solidworks_spec as { extrude_depth_mm: number }).extrude_depth_mm, 15);
  assert.equal(evaluateAutoLisp(String(norm1.lisp_code), createInitialDocState()).addedCount, 2);

  const rawLispOnly = `Berikut skrip AutoLISP untuk base plate:\n\`\`\`lisp\n(progn (command "_RECTANG" '(0 0) '(160 140)) (command "_CIRCLE" '(80 70) 12))\n\`\`\``;
  const parsed2 = extractJsonFromLlmText(rawLispOnly, 'solidworks_3d');
  const norm2 = normalizeAiPayload(parsed2, 'C:\\Exports', 18, 'solidworks_3d');
  assert.equal(norm2.action_type, 'solidworks_3d');
  assert.equal(evaluateAutoLisp(String(norm2.lisp_code), createInitialDocState()).addedCount, 2);
});

test('cad3dModel parses multi-part 3D assemblies, derives boolean holes from 2D sketches, and computes bounds/explode', () => {
  // 1. 2D sketch with outer rect + circle + obround slot -> single plate with 2 boolean holes
  const docRes = evaluateAutoLisp(
    `(progn
      (command "_RECTANG" '(-80 -70) '(80 70))
      (command "_CIRCLE" '(0 0) 14)
      (command "_SLOT" '(-65 -45) '(-65 45) 12)
    )`,
    createInitialDocState(),
  );
  assert.equal(docRes.ok, true);
  const derived = deriveParts3dFrom2dDoc({ ...docRes.doc, extrudeDepthMm: 14 });
  assert.equal(derived.length, 1);
  assert.equal(derived[0].kind, 'plate');
  assert.equal(derived[0].height, 14);
  assert.equal(derived[0].holes?.length, 2);

  // 2. Multi-part assembly via parts_3d_json string in AI payload
  const partsJson = JSON.stringify([
    {
      name: 'base_plate',
      kind: 'plate',
      cx: 0,
      cy: 0,
      width: 160,
      depth: 140,
      z_min: 0,
      height: 14,
      holes: [
        { kind: 'slot', x1: -66, y1: -50, x2: -66, y2: 50, width: 12 },
        { kind: 'rect', cx: 0, cy: 5, width: 32, height: 74 },
      ],
      finish: 'dark_oxide',
    },
    {
      name: 'v_jaw',
      kind: 'prism',
      points: [
        [-45, -55],
        [45, -55],
        [45, -30],
        [0, -10],
        [-45, -30],
      ],
      z_min: 14,
      height: 22,
      finish: 'dark_oxide',
    },
    {
      name: 'lead_screw',
      kind: 'cylinder',
      cx: 0,
      cy: 20,
      cz: 25,
      radius: 8,
      length: 130,
      axis: 'y',
      threaded: true,
      finish: 'machined_steel',
    },
  ]);

  const norm = normalizeAiPayload(
    {
      explanation: 'Drill press vise assembly',
      action_type: 'solidworks_3d',
      lisp_code: `(progn (command "_RECTANG" '(-80 -70) '(80 70)))`,
      part_name: 'drill_press_vise',
      extrude_depth_mm: 14,
      parts_3d_json: partsJson,
    },
    'C:\\Exports',
    12,
    'solidworks_3d',
  );

  const parsedParts = parseParts3d(norm.parts_3d);
  assert.equal(parsedParts.length, 3);
  assert.equal(parsedParts[0].kind, 'plate');
  assert.equal(parsedParts[1].kind, 'prism');
  assert.equal(parsedParts[2].kind, 'cylinder');

  const bounds = computeParts3dBounds(parsedParts);
  assert.ok(bounds);
  assert.equal(bounds.width, 160);
  assert.ok(bounds.height >= 36);

  const explodeZero = computeExplodedOffset(parsedParts[2], bounds, 0);
  assert.deepEqual(explodeZero, { dx: 0, dy: 0, dz: 0 });
  const explodeHalf = computeExplodedOffset(parsedParts[2], bounds, 0.5);
  assert.ok(explodeHalf.dx !== 0 || explodeHalf.dy !== 0 || explodeHalf.dz !== 0);

  const projected2d = derive2dEntitiesFromParts3d(parsedParts);
  assert.ok(projected2d.length >= 5);
});

test('Assembly engine infers & parses mates, computes kinematic screw/slide motion, and calculates BOM mass', () => {
  const parts = parseParts3d([
    {
      id: 'base',
      name: 'Base Plate',
      kind: 'plate',
      cx: 0,
      cy: 0,
      width: 160,
      depth: 140,
      z_min: 0,
      height: 14,
      holes: [{ kind: 'rect', cx: 0, cy: 0, width: 32, height: 60 }],
      finish: 'cast_iron',
      role: 'fixed',
    },
    {
      id: 'jaw',
      name: 'Movable V-Jaw',
      kind: 'prism',
      points: [
        [-40, -40],
        [40, -40],
        [40, -20],
        [0, -10],
        [-40, -20],
      ],
      z_min: 14,
      height: 24,
      finish: 'dark_oxide',
      role: 'moving',
    },
    {
      id: 'screw',
      name: 'Lead Screw',
      kind: 'cylinder',
      cx: 0,
      cy: 20,
      cz: 26,
      radius: 8,
      length: 100,
      axis: 'y',
      threaded: true,
      finish: 'machined_steel',
    },
    {
      id: 'handle',
      name: 'Handle Grip',
      kind: 'cylinder',
      cx: 0,
      cy: 85,
      cz: 26,
      radius: 10,
      length: 40,
      axis: 'y',
      finish: 'aluminum',
    },
  ]);

  const inferred = inferAssemblyMates(parts);
  assert.equal(inferred.length, 3);
  assert.ok(inferred.some((m) => m.kind === 'slide' && m.part_a === 'jaw'));
  assert.ok(inferred.some((m) => m.kind === 'screw' && m.part_a === 'screw'));

  const explicit = parseAssemblyMates(
    JSON.stringify([
      { kind: 'slide', part_a: 'Movable V-Jaw', part_b: 'Base Plate', axis: 'y', travel_mm: 30 },
      { kind: 'screw', part_a: 'Lead Screw', part_b: 'Base Plate', axis: 'y', travel_mm: 30, pitch_mm: 5 },
      { kind: 'concentric', part_a: 'Handle Grip', part_b: 'Lead Screw', axis: 'y' },
    ]),
    parts,
  );
  assert.equal(explicit.length, 3);

  // Coupled screw-slide: Movable V-Jaw, Lead Screw, AND Handle Grip ALL translate by the exact same dy (15mm at 50%)
  // while Lead Screw and Handle Grip rotate together by 3 full revolutions (15/5 * 2*PI), and Base Plate stays fixed!
  const solved = solveAssemblyKinematics(parts, explicit, 0.5);
  assert.equal(solved.mechanismType, 'screw_slide');
  assert.equal(solved.deltas.base.dy, 0);
  assert.equal(solved.deltas.jaw.dy, 15);
  assert.equal(solved.deltas.screw.dy, 15);
  assert.equal(solved.deltas.handle.dy, 15);
  assert.equal(solved.deltas.jaw.ry, 0);
  assert.ok(Math.abs(solved.deltas.screw.ry - 3 * Math.PI * 2) < 1e-6);
  assert.ok(Math.abs(solved.deltas.handle.ry - 3 * Math.PI * 2) < 1e-6);

  // Collision clamping: add fixed Rear Nut Block at Y=[20..42] (only 30mm gap from Jaw maxY=-10 -> safe <= 27mm)
  const partsWithStop = parseParts3d([
    ...parts,
    { id: 'nut', name: 'Rear Nut Block', kind: 'box', cx: 0, cy: 31, z_min: 14, width: 90, depth: 22, height: 24, role: 'fixed' },
  ]);
  const overshotMates = parseAssemblyMates(
    JSON.stringify([
      { kind: 'slide', part_a: 'jaw', part_b: 'base', axis: 'y', travel_mm: 120 },
      { kind: 'screw', part_a: 'screw', part_b: 'nut', axis: 'y', travel_mm: 120, pitch_mm: 4 },
    ]),
    partsWithStop,
  );
  const clamped = solveAssemblyKinematics(partsWithStop, overshotMates, 1.0);
  // Jaw maxY=-10, Nut minY=20, margin=3 -> max safe stroke <= 27mm (never penetrates Nut Block!)
  assert.ok(Math.abs(clamped.deltas.jaw.dy) <= 27.01);
  assert.equal(clamped.deltas.screw.dy, clamped.deltas.jaw.dy);

  // Pure rotary assembly (Pillow Block Bearing): shaft spins in place with ZERO axial translation
  const bearingParts = parseParts3d([
    { id: 'bbase', name: 'Pillow Base', kind: 'plate', cx: 0, cy: 0, width: 140, depth: 48, z_min: 0, height: 16, role: 'fixed' },
    { id: 'bshaft', name: 'Steel Shaft', kind: 'cylinder', cx: 0, cy: 0, cz: 40, radius: 15, length: 120, axis: 'y', role: 'shaft' },
  ]);
  const bearingMates = inferAssemblyMates(bearingParts);
  const bearingKin = solveAssemblyKinematics(bearingParts, bearingMates, 0.5);
  assert.equal(bearingKin.mechanismType, 'rotary');
  assert.equal(bearingKin.deltas.bshaft.dy, 0);
  assert.equal(bearingKin.angleDeg, 360);

  const bom = computeAssemblyBom(parts, explicit);
  assert.equal(bom.rows.length, 4);
  assert.ok(bom.totalMassGrams > 1500);
  assert.ok(bom.totalVolumeCm3 > 200);
});



