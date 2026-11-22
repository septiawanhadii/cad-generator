import type { CadEntity, DocState, Point2D } from '../types/cadcraft';
import {
  beginUndoGroup,
  createEntityId,
  endUndoGroup,
  runJoin,
  runOverkill,
} from './docState';

type SExpr =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'symbol'; value: string }
  | { kind: 'list'; items: SExpr[] };

interface Token {
  type: 'lparen' | 'rparen' | 'quote' | 'string' | 'atom';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // Semicolon AutoLISP comment
    if (ch === ';') {
      while (i < input.length && input[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen', value: '(' });
      i += 1;
      continue;
    }

    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ')' });
      i += 1;
      continue;
    }

    if (ch === "'") {
      tokens.push({ type: 'quote', value: "'" });
      i += 1;
      continue;
    }

    if (ch === '"') {
      i += 1;
      let str = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          i += 1;
          str += input[i];
        } else {
          str += input[i];
        }
        i += 1;
      }
      if (i >= input.length) {
        throw new Error('Unterminated string literal in AutoLISP expression.');
      }
      i += 1; // closing quote
      tokens.push({ type: 'string', value: str });
      continue;
    }

    let atom = '';
    while (i < input.length && !/[\s()'";]/.test(input[i])) {
      atom += input[i];
      i += 1;
    }
    tokens.push({ type: 'atom', value: atom });
  }

  return tokens;
}

function parseTokens(tokens: Token[]): SExpr[] {
  let pos = 0;

  function parseOne(): SExpr {
    if (pos >= tokens.length) {
      throw new Error('Unexpected end of AutoLISP expression.');
    }

    const tok = tokens[pos];

    if (tok.type === 'quote') {
      pos += 1;
      const quoted = parseOne();
      return {
        kind: 'list',
        items: [{ kind: 'symbol', value: 'quote' }, quoted],
      };
    }

    if (tok.type === 'lparen') {
      pos += 1;
      const items: SExpr[] = [];
      while (pos < tokens.length && tokens[pos].type !== 'rparen') {
        items.push(parseOne());
      }
      if (pos >= tokens.length || tokens[pos].type !== 'rparen') {
        throw new Error('Unbalanced parentheses: missing closing ")".');
      }
      pos += 1;
      return { kind: 'list', items };
    }

    if (tok.type === 'rparen') {
      throw new Error('Unexpected closing ")" in AutoLISP expression.');
    }

    pos += 1;
    if (tok.type === 'string') {
      return { kind: 'string', value: tok.value };
    }

    const num = Number(tok.value);
    if (tok.value !== '' && !Number.isNaN(num) && Number.isFinite(num)) {
      return { kind: 'number', value: num };
    }
    return { kind: 'symbol', value: tok.value };
  }

  const exprs: SExpr[] = [];
  while (pos < tokens.length) {
    exprs.push(parseOne());
  }
  return exprs;
}

type EvalVal = number | string | EvalVal[] | null;

function toPoint2D(val: EvalVal, label: string): Point2D {
  if (!Array.isArray(val) || val.length < 2) {
    throw new Error(`Expected 2D coordinate list '(x y) for ${label}.`);
  }
  const x = Number(val[0]);
  const y = Number(val[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid numeric coordinates for ${label}.`);
  }
  return { x, y };
}

function toNumber(val: EvalVal, label: string): number {
  const n = Number(val);
  if (!Number.isFinite(n)) {
    throw new Error(`Expected finite number for ${label}.`);
  }
  return n;
}

export interface LispEvalResult {
  ok: boolean;
  doc: DocState;
  logs: string[];
  addedCount: number;
  error?: string;
}

export function evaluateAutoLisp(input: string, initialDoc: DocState): LispEvalResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      ok: false,
      doc: initialDoc,
      logs: [],
      addedCount: 0,
      error: 'Empty AutoLISP expression.',
    };
  }

  let exprs: SExpr[];
  try {
    const tokens = tokenize(trimmed);
    if (tokens.length === 0) {
      return {
        ok: false,
        doc: initialDoc,
        logs: [],
        addedCount: 0,
        error: 'No executable AutoLISP tokens found.',
      };
    }
    exprs = parseTokens(tokens);
  } catch (err) {
    return {
      ok: false,
      doc: initialDoc,
      logs: [],
      addedCount: 0,
      error: err instanceof Error ? err.message : 'AutoLISP syntax error.',
    };
  }

  let doc = beginUndoGroup(initialDoc);
  const env = new Map<string, EvalVal>();
  const logs: string[] = [];
  let addedCount = 0;

  function evalExpr(expr: SExpr): EvalVal {
    if (expr.kind === 'number') return expr.value;
    if (expr.kind === 'string') return expr.value;
    if (expr.kind === 'symbol') {
      const upper = expr.value.toUpperCase();
      if (upper === 'NIL') return null;
      if (upper === 'T') return 1;
      if (upper === 'PI') return Math.PI;
      if (env.has(upper)) return env.get(upper) ?? null;
      return expr.value;
    }

    if (expr.items.length === 0) return null;
    const head = expr.items[0];
    if (head.kind === 'number') {
      // Allow unquoted numeric point lists like (10 20) or (10 20 0)
      return expr.items.map(evalExpr);
    }
    if (head.kind !== 'symbol') {
      throw new Error('First element of AutoLISP list must be a function symbol.');
    }

    const op = head.value.toUpperCase();
    const args = expr.items.slice(1);

    if (op === 'QUOTE') {
      if (args.length !== 1) throw new Error('quote requires 1 argument.');
      const inner = args[0];
      if (inner.kind === 'list') {
        return inner.items.map(evalExpr);
      }
      if (inner.kind === 'number') return inner.value;
      if (inner.kind === 'string') return inner.value;
      return inner.value;
    }

    if (op === 'LIST') {
      return args.map(evalExpr);
    }

    if (op === 'PROGN') {
      let last: EvalVal = null;
      for (const a of args) {
        last = evalExpr(a);
      }
      return last;
    }

    if (op === 'SETQ') {
      let last: EvalVal = null;
      for (let i = 0; i + 1 < args.length; i += 2) {
        const sym = args[i];
        if (sym.kind !== 'symbol') throw new Error('setq target must be a symbol.');
        last = evalExpr(args[i + 1]);
        env.set(sym.value.toUpperCase(), last);
      }
      return last;
    }

    if (op === '+' || op === '-' || op === '*' || op === '/') {
      const nums = args.map((a) => toNumber(evalExpr(a), op));
      if (nums.length === 0) return 0;
      if (op === '+') return nums.reduce((a, b) => a + b, 0);
      if (op === '*') return nums.reduce((a, b) => a * b, 1);
      if (op === '-') {
        return nums.length === 1 ? -nums[0] : nums.slice(1).reduce((a, b) => a - b, nums[0]);
      }
      return nums.slice(1).reduce((a, b) => {
        if (b === 0) throw new Error('Division by zero in AutoLISP.');
        return a / b;
      }, nums[0]);
    }

    if (op === 'COMMAND') {
      if (args.length === 0) return null;
      const evaluated = args.map(evalExpr);
      const rawCmd = String(evaluated[0] ?? '')
        .trim()
        .replace(/^_+/, '')
        .toUpperCase();

      if (rawCmd === 'RECTANG' || rawCmd === 'RECTANGLE' || rawCmd === 'BOX') {
        const p1 = toPoint2D(evaluated[1], 'RECTANG corner 1');
        const p2 = toPoint2D(evaluated[2], 'RECTANG corner 2');
        const ent: CadEntity = {
          id: createEntityId('rect'),
          kind: 'rectangle',
          layer: doc.activeLayer,
          x1: p1.x,
          y1: p1.y,
          x2: p2.x,
          y2: p2.y,
        };
        doc = { ...doc, entities: [...doc.entities, ent] };
        addedCount += 1;
        logs.push(`RECTANG (${p1.x}, ${p1.y}) -> (${p2.x}, ${p2.y})`);
        return 'RECTANG';
      }

      if (rawCmd === 'CIRCLE' || rawCmd === 'CYLINDER') {
        const center = toPoint2D(evaluated[1], 'CIRCLE center');
        let radius: number;
        const second = evaluated[2];
        if (typeof second === 'string' && second.replace(/^_+/, '').toUpperCase() === 'D') {
          radius = toNumber(evaluated[3], 'CIRCLE diameter') / 2.0;
        } else {
          radius = toNumber(second, 'CIRCLE radius');
        }
        if (radius <= 0) throw new Error('CIRCLE radius must be > 0.');
        const ent: CadEntity = {
          id: createEntityId('circ'),
          kind: 'circle',
          layer: doc.activeLayer,
          cx: center.x,
          cy: center.y,
          radius,
        };
        doc = { ...doc, entities: [...doc.entities, ent] };
        addedCount += 1;
        logs.push(`CIRCLE center=(${center.x}, ${center.y}) R=${radius}`);
        return 'CIRCLE';
      }

      if (rawCmd === 'LINE') {
        const pts: Point2D[] = [];
        for (let i = 1; i < evaluated.length; i++) {
          const v = evaluated[i];
          if (v === null || v === '') break;
          if (typeof v === 'string' && ['C', '_C', 'CLOSE', '_CLOSE'].includes(v.toUpperCase())) {
            if (pts.length >= 2) pts.push({ ...pts[0] });
            break;
          }
          pts.push(toPoint2D(v, `LINE point ${i}`));
        }
        if (pts.length < 2) {
          throw new Error('LINE command requires at least 2 points.');
        }
        const newLines: CadEntity[] = [];
        for (let i = 0; i + 1 < pts.length; i++) {
          newLines.push({
            id: createEntityId('line'),
            kind: 'line',
            layer: doc.activeLayer,
            x1: pts[i].x,
            y1: pts[i].y,
            x2: pts[i + 1].x,
            y2: pts[i + 1].y,
          });
        }
        doc = { ...doc, entities: [...doc.entities, ...newLines] };
        addedCount += newLines.length;
        logs.push(`LINE segments=${newLines.length}`);
        return 'LINE';
      }

      if (rawCmd === 'PLINE' || rawCmd === 'POLYLINE') {
        const pts: Point2D[] = [];
        let closed = false;
        for (let i = 1; i < evaluated.length; i++) {
          const v = evaluated[i];
          if (typeof v === 'string' && ['C', '_C', 'CLOSE', '_CLOSE'].includes(v.toUpperCase())) {
            closed = true;
            break;
          }
          if (v === null || v === '') break;
          pts.push(toPoint2D(v, `PLINE point ${i}`));
        }
        if (pts.length < 2) throw new Error('PLINE requires at least 2 points.');
        const ent: CadEntity = {
          id: createEntityId('poly'),
          kind: 'polyline',
          layer: doc.activeLayer,
          points: pts,
          closed,
        };
        doc = { ...doc, entities: [...doc.entities, ent] };
        addedCount += 1;
        logs.push(`PLINE vertices=${pts.length} closed=${closed}`);
        return 'PLINE';
      }

      if (rawCmd === 'ARC') {
        const center = toPoint2D(evaluated[1], 'ARC center');
        const radius = toNumber(evaluated[2], 'ARC radius');
        const startAngleDeg = toNumber(evaluated[3] ?? 0, 'ARC start angle');
        const endAngleDeg = toNumber(evaluated[4] ?? 180, 'ARC end angle');
        if (radius <= 0) throw new Error('ARC radius must be > 0.');
        const ent: CadEntity = {
          id: createEntityId('arc'),
          kind: 'arc',
          layer: doc.activeLayer,
          cx: center.x,
          cy: center.y,
          radius,
          startAngleDeg,
          endAngleDeg,
        };
        doc = { ...doc, entities: [...doc.entities, ent] };
        addedCount += 1;
        logs.push(`ARC center=(${center.x}, ${center.y}) R=${radius}`);
        return 'ARC';
      }

      if (rawCmd === 'SLOT') {
        const p1 = toPoint2D(evaluated[1], 'SLOT start');
        const p2 = toPoint2D(evaluated[2], 'SLOT end');
        const width = Math.max(0.5, toNumber(evaluated[3] ?? 10, 'SLOT width'));
        const r = width / 2;
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const baseAngle = Math.atan2(dy, dx);
        const pts: Point2D[] = [];
        const steps = 10;
        for (let i = 0; i <= steps; i++) {
          const a = baseAngle + Math.PI / 2 + (i / steps) * Math.PI;
          pts.push({ x: p1.x + Math.cos(a) * r, y: p1.y + Math.sin(a) * r });
        }
        for (let i = 0; i <= steps; i++) {
          const a = baseAngle - Math.PI / 2 + (i / steps) * Math.PI;
          pts.push({ x: p2.x + Math.cos(a) * r, y: p2.y + Math.sin(a) * r });
        }
        const ent: CadEntity = {
          id: createEntityId('slot'),
          kind: 'polyline',
          layer: doc.activeLayer,
          points: pts,
          closed: true,
        };
        doc = { ...doc, entities: [...doc.entities, ent] };
        addedCount += 1;
        logs.push(`SLOT (${p1.x},${p1.y})->(${p2.x},${p2.y}) W=${width}`);
        return 'SLOT';
      }

      if (rawCmd === 'POLYGON') {
        const center = toPoint2D(evaluated[1], 'POLYGON center');
        const radius = toNumber(evaluated[2], 'POLYGON radius');
        const sides = Math.max(3, Math.round(toNumber(evaluated[3] ?? 6, 'POLYGON sides')));
        const pts: Point2D[] = [];
        for (let i = 0; i < sides; i++) {
          const a = (i / sides) * Math.PI * 2;
          pts.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius });
        }
        const ent: CadEntity = {
          id: createEntityId('poly'),
          kind: 'polyline',
          layer: doc.activeLayer,
          points: pts,
          closed: true,
        };
        doc = { ...doc, entities: [...doc.entities, ent] };
        addedCount += 1;
        logs.push(`POLYGON sides=${sides} R=${radius}`);
        return 'POLYGON';
      }

      if (rawCmd === 'OVERKILL') {
        const res = runOverkill(doc);
        doc = res.doc;
        logs.push(`OVERKILL removed=${res.removedCount} duplicate(s)`);
        return 'OVERKILL';
      }

      if (rawCmd === 'JOIN') {
        const res = runJoin(doc);
        doc = res.doc;
        logs.push(`JOIN merged=${res.joinedChains} polyline chain(s)`);
        return 'JOIN';
      }

      if (rawCmd === 'ERASE' || rawCmd === 'CLEAR') {
        const cleared = doc.entities.length;
        doc = { ...doc, entities: [] };
        logs.push(`CLEAR removed=${cleared} entities`);
        return 'CLEAR';
      }

      if (rawCmd === 'CLAYER' && evaluated[1]) {
        const layerName = String(evaluated[1]);
        const exists = doc.layers.some((l) => l.name === layerName);
        doc = {
          ...doc,
          activeLayer: layerName,
          layers: exists ? doc.layers : [...doc.layers, { name: layerName, color: '#3B82F6', visible: true }],
        };
        logs.push(`CLAYER=${layerName}`);
        return layerName;
      }

      if (['ZOOM', 'REGEN', 'UNITS', 'FILLET', 'CHAMFER', 'TEXT', 'MTEXT', 'DIMLINEAR'].includes(rawCmd)) {
        logs.push(`${rawCmd} acknowledged`);
        return rawCmd;
      }

      throw new Error(`Unsupported CAD command in AutoLISP: "${rawCmd}"`);
    }

    throw new Error(`Unsupported AutoLISP function: "${head.value}"`);
  }

  try {
    for (const expr of exprs) {
      evalExpr(expr);
    }
    doc = endUndoGroup(doc);
    return {
      ok: true,
      doc,
      logs,
      addedCount,
    };
  } catch (err) {
    return {
      ok: false,
      doc: initialDoc,
      logs,
      addedCount: 0,
      error: err instanceof Error ? err.message : 'AutoLISP evaluation failed.',
    };
  }
}

export function executeCmdlineList(commands: string[], initialDoc: DocState): LispEvalResult {
  let doc = beginUndoGroup(initialDoc);
  const logs: string[] = [];
  let addedCount = 0;

  try {
    for (const raw of commands) {
      const cmd = raw.trim();
      if (!cmd) continue;
      if (cmd.startsWith('(')) {
        const res = evaluateAutoLisp(cmd, doc);
        if (!res.ok) {
          throw new Error(res.error || 'AutoLISP command failed');
        }
        doc = res.doc;
        addedCount += res.addedCount;
        logs.push(...res.logs);
        continue;
      }

      const upper = cmd.toUpperCase();
      if (upper === 'OVERKILL') {
        const res = runOverkill(doc);
        doc = res.doc;
        logs.push(`OVERKILL removed=${res.removedCount} duplicate(s)`);
      } else if (upper === 'JOIN') {
        const res = runJoin(doc);
        doc = res.doc;
        logs.push(`JOIN merged=${res.joinedChains} polyline chain(s)`);
      } else if (upper === 'CLEAR' || upper === 'ERASE ALL') {
        const count = doc.entities.length;
        doc = { ...doc, entities: [] };
        logs.push(`CLEAR removed=${count} entities`);
      } else {
        // Parse compact CLI syntax e.g. "RECTANG 0,0 120,80" or "CIRCLE 60,40 15"
        const parts = cmd.split(/\s+/);
        const verb = parts[0].replace(/^_/, '').toUpperCase();
        if (verb === 'RECTANG' && parts.length >= 3) {
          const [x1, y1] = parts[1].split(',').map(Number);
          const [x2, y2] = parts[2].split(',').map(Number);
          const lisp = `(command "_RECTANG" '(${x1} ${y1}) '(${x2} ${y2}))`;
          const res = evaluateAutoLisp(lisp, doc);
          if (!res.ok) throw new Error(res.error);
          doc = res.doc;
          addedCount += res.addedCount;
          logs.push(...res.logs);
        } else if (verb === 'CIRCLE' && parts.length >= 3) {
          const [cx, cy] = parts[1].split(',').map(Number);
          const r = Number(parts[2]);
          const lisp = `(command "_CIRCLE" '(${cx} ${cy}) ${r})`;
          const res = evaluateAutoLisp(lisp, doc);
          if (!res.ok) throw new Error(res.error);
          doc = res.doc;
          addedCount += res.addedCount;
          logs.push(...res.logs);
        } else if (verb === 'LINE' && parts.length >= 3) {
          const [x1, y1] = parts[1].split(',').map(Number);
          const [x2, y2] = parts[2].split(',').map(Number);
          const lisp = `(command "_LINE" '(${x1} ${y1}) '(${x2} ${y2}))`;
          const res = evaluateAutoLisp(lisp, doc);
          if (!res.ok) throw new Error(res.error);
          doc = res.doc;
          addedCount += res.addedCount;
          logs.push(...res.logs);
        } else {
          throw new Error(`Unrecognized command: "${cmd}"`);
        }
      }
    }

    doc = endUndoGroup(doc);
    return { ok: true, doc, logs, addedCount };
  } catch (err) {
    return {
      ok: false,
      doc: initialDoc,
      logs,
      addedCount: 0,
      error: err instanceof Error ? err.message : 'Command execution failed.',
    };
  }
}
