import { inferAssemblyMates, parseAssemblyMates, parseParts3d } from './cad3dModel';

export function stripThinkingTags(raw: string): string {
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const closingIdx = cleaned.search(/<\/think>/i);
  if (closingIdx !== -1) {
    cleaned = cleaned.slice(closingIdx + '</think>'.length).trim();
  }
  cleaned = cleaned.replace(/<\/?think>/gi, '').trim();
  return cleaned;
}

export function repairJsonString(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    // Strip // line comments outside JSON strings
    if (ch === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') {
        i += 1;
      }
      out += '\n';
      continue;
    }

    out += ch;
  }

  // Remove trailing commas before closing } or ]
  return out.replace(/,\s*([}\]])/g, '$1').trim();
}

function tryParseObject(text: string): Record<string, unknown> | null {
  const attempts = [text.trim(), repairJsonString(text)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try next repair strategy
    }
  }
  return null;
}

function extractBalancedJsonObjects(text: string): string[] {
  const results: string[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          results.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return results;
}

function extractBalancedLisp(text: string): string | null {
  const match = text.match(/\(\s*(?:progn|command)\b/i);
  if (!match || match.index === undefined) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const start = match.index;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1).trim();
      }
    }
  }
  return null;
}

export function extractJsonFromLlmText(
  raw: string,
  mode: string = 'cad_2d',
): Record<string, unknown> {
  const cleaned = stripThinkingTags(raw);

  // 1. Direct parse of full cleaned payload
  const direct = tryParseObject(cleaned);
  if (direct) return direct;

  // 2. Check all fenced markdown blocks (preferring json-tagged blocks first)
  const fencedBlocks: { lang: string; body: string }[] = [];
  const fenceRegex = /```([a-zA-Z0-9_-]*)\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(cleaned)) !== null) {
    fencedBlocks.push({ lang: (m[1] || '').toLowerCase(), body: m[2].trim() });
  }
  fencedBlocks.sort((a, b) => (a.lang === 'json' ? -1 : b.lang === 'json' ? 1 : 0));

  for (const block of fencedBlocks) {
    const parsed = tryParseObject(block.body);
    if (parsed) return parsed;
  }

  // 3. Extract balanced { ... } objects anywhere in cleaned output
  const balancedObjects = extractBalancedJsonObjects(cleaned);
  for (const objStr of balancedObjects) {
    const parsed = tryParseObject(objStr);
    if (parsed) return parsed;
  }

  // 4. Fallback: slice outermost { ... } with repair
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const parsed = tryParseObject(cleaned.slice(firstBrace, lastBrace + 1));
    if (parsed) return parsed;
  }

  // 5. Fallback recovery if local model emitted raw AutoLISP without JSON wrapper
  const rawLisp = extractBalancedLisp(cleaned);
  if (rawLisp) {
    return {
      explanation: 'Geometri AutoLISP berhasil diekstrak dan dijalankan ke kanvas CAD.',
      action_type: mode === 'solidworks_3d' ? 'solidworks_3d' : 'lisp',
      lisp_code: rawLisp,
      commands: null,
    };
  }

  const snippet = cleaned.slice(0, 140).replace(/\s+/g, ' ');
  throw new Error(
    snippet
      ? `Model tidak mengembalikan JSON AiResponsePayload yang valid (output: "${snippet}...").`
      : 'Model tidak mengembalikan JSON AiResponsePayload yang valid (respons kosong).',
  );
}

function parseOptionalNumber(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const parsed = Number.parseFloat(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function normalizeAiPayload(
  raw: Record<string, unknown>,
  exportDir: string,
  defaultExtrudeMm: number,
  mode: string = 'cad_2d',
): Record<string, unknown> {
  const existingSpec =
    raw.solidworks_spec && typeof raw.solidworks_spec === 'object'
      ? (raw.solidworks_spec as Record<string, unknown>)
      : null;

  const partNameRaw =
    (typeof raw.part_name === 'string' && raw.part_name.trim()) ||
    (existingSpec && typeof existingSpec.part_name === 'string' && existingSpec.part_name.trim()) ||
    'cadcraft_part';
  const partName = partNameRaw.replace(/[^a-zA-Z0-9_-]/g, '_');

  const depthParsed =
    parseOptionalNumber(raw.extrude_depth_mm) ??
    (existingSpec ? parseOptionalNumber(existingSpec.extrude_depth_mm) : null) ??
    defaultExtrudeMm;
  const extrudeDepth = Number.isFinite(depthParsed) && depthParsed > 0.01 ? depthParsed : defaultExtrudeMm;

  const filletRaw =
    parseOptionalNumber(raw.fillet_radius_mm) ??
    (existingSpec ? parseOptionalNumber(existingSpec.fillet_radius_mm) : null);

  const sep = exportDir.includes('/') && !exportDir.includes('\\') ? '/' : '\\';
  const baseDir = exportDir.replace(/[\\/]+$/, '');

  const actionType =
    typeof raw.action_type === 'string' && raw.action_type.trim()
      ? raw.action_type.trim()
      : mode === 'solidworks_3d'
        ? 'solidworks_3d'
        : 'lisp';

  const parsedParts3d = parseParts3d(
    raw.parts_3d ?? raw.parts_3d_json ?? existingSpec?.parts_3d ?? null,
  );
  const explicitMates = parseAssemblyMates(
    raw.mates ?? raw.mates_json ?? existingSpec?.mates ?? null,
    parsedParts3d,
  );
  const resolvedMates =
    explicitMates.length > 0 ? explicitMates : inferAssemblyMates(parsedParts3d);
  const isAssembly = parsedParts3d.length > 1;

  const shouldAttachSpec =
    actionType === 'solidworks_3d' ||
    mode === 'solidworks_3d' ||
    existingSpec !== null ||
    parsedParts3d.length > 0 ||
    Boolean(raw.part_name) ||
    raw.extrude_depth_mm !== undefined;

  const solidworksSpec = shouldAttachSpec
    ? {
        part_name: partName,
        output_mode: isAssembly ? 'assembly' : 'part',
        source_mode: 'parametric_primitives',
        dxf_temp_path: null,
        extrude_depth_mm: extrudeDepth,
        fillet_radius_mm: filletRaw,
        entities: Array.isArray(existingSpec?.entities) ? existingSpec.entities : [],
        parts_3d: parsedParts3d,
        mates: resolvedMates,
        output_sldprt_path: `${baseDir}${sep}${partName}.sldprt`,
        output_sldasm_path: isAssembly ? `${baseDir}${sep}${partName}.sldasm` : null,
      }
    : null;

  return {
    explanation:
      typeof raw.explanation === 'string' && raw.explanation.trim()
        ? raw.explanation.trim()
        : 'Geometri CAD berhasil disusun.',
    action_type: actionType,
    lisp_code: typeof raw.lisp_code === 'string' && raw.lisp_code.trim() ? raw.lisp_code.trim() : null,
    commands: Array.isArray(raw.commands) ? raw.commands : null,
    parts_3d: parsedParts3d.length > 0 ? parsedParts3d : null,
    mates: resolvedMates.length > 0 ? resolvedMates : null,
    solidworks_spec: solidworksSpec,
  };
}
