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
