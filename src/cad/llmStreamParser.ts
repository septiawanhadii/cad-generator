import type { AiProviderKind } from '../types/cadcraft';

export const DEFAULT_LOCAL_TIMEOUT_SEC = 300;
export const DEFAULT_GEMINI_TIMEOUT_SEC = 75;
export const MIN_TIMEOUT_SEC = 30;
export const MAX_TIMEOUT_SEC = 900;

export function resolveProviderTimeoutMs(
  provider: AiProviderKind,
  configuredTimeoutSec?: unknown,
): number {
  const defaultSec =
    provider === 'gemini' ? DEFAULT_GEMINI_TIMEOUT_SEC : DEFAULT_LOCAL_TIMEOUT_SEC;

  if (typeof configuredTimeoutSec === 'number' && Number.isFinite(configuredTimeoutSec)) {
    const clamped = Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, Math.round(configuredTimeoutSec)));
    return clamped * 1000;
  }
  return defaultSec * 1000;
}

export function isTimeoutLikeError(err: unknown): boolean {
  if (!err) return false;
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  const causeCode =
    err instanceof Error && typeof (err as Error & { cause?: { code?: string } }).cause?.code === 'string'
      ? (err as Error & { cause?: { code?: string } }).cause!.code!
      : '';
  const combined = `${name} ${msg} ${causeCode}`.toLowerCase();
  return (
    combined.includes('timeout') ||
    combined.includes('timed out') ||
    combined.includes('etimedout') ||
    combined.includes('und_err_headers_timeout') ||
    combined.includes('und_err_body_timeout') ||
    name === 'TimeoutError'
  );
}

export function formatAiTimeoutError(
  provider: AiProviderKind,
  model: string,
  timeoutSec: number,
  reason: 'total' | 'idle' = 'total',
): string {
  const providerLabel =
    provider === 'lmstudio'
      ? 'LM Studio (Local)'
      : provider === 'ollama'
        ? 'Ollama (Local)'
        : 'Google Gemini API';

  if (provider === 'lmstudio' || provider === 'ollama') {
    const detail =
      reason === 'idle'
        ? `tidak mengirim token baru selama ${timeoutSec} detik`
        : `melewati batas waktu ${timeoutSec} detik`;
    return `${providerLabel} [${model}] ${detail}. Model lokal kemungkinan masih melakukan prefill/thinking atau terlalu berat — coba naikkan "Request Timeout" di Settings (hingga 900 dtk), aktifkan GPU offload, atau gunakan model lebih ringan (mis. 7B Q4_K_M).`;
  }

  return `${providerLabel} [${model}] melewati batas waktu ${timeoutSec} detik. Coba tekan Retry atau naikkan "Request Timeout" di Settings.`;
}

export interface ParsedLlmStreamResult {
  content: string;
  reasoning: string;
  model?: string;
  chunkCount: number;
}

export async function parseOpenAiSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onActivity?: () => void,
): Promise<ParsedLlmStreamResult> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoning = '';
  let model: string | undefined;
  let chunkCount = 0;

  const processLine = (rawLine: string): boolean => {
    const line = rawLine.trim();
    if (!line || line.startsWith(':')) return false;
    if (!line.startsWith('data:')) return false;

    const payload = line.slice(5).trim();
    if (!payload) return false;
    if (payload === '[DONE]') return true;

    try {
      const parsed = JSON.parse(payload) as {
        model?: string;
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
          };
          message?: {
            content?: string | null;
          };
        }>;
      };
      if (parsed.model && !model) {
        model = parsed.model;
      }
      const choice = parsed.choices?.[0];
      const deltaText = choice?.delta?.content ?? choice?.message?.content ?? '';
      const deltaReasoning =
        choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? '';
      if (typeof deltaText === 'string' && deltaText.length > 0) {
        content += deltaText;
      }
      if (typeof deltaReasoning === 'string' && deltaReasoning.length > 0) {
        reasoning += deltaReasoning;
      }
    } catch {
      // Ignore partial or non-JSON keepalive comments
    }
    return false;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      chunkCount += 1;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      let reachedDone = false;
      for (const line of lines) {
        if (processLine(line)) {
          reachedDone = true;
          break;
        }
      }
      if (reachedDone) break;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (processLine(line)) break;
    }
  }

  return {
    content: content || reasoning,
    reasoning,
    model,
    chunkCount,
  };
}

export async function parseOllamaNdjsonStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onActivity?: () => void,
): Promise<ParsedLlmStreamResult> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoning = '';
  let model: string | undefined;
  let chunkCount = 0;

  const processLine = (rawLine: string): boolean => {
    const line = rawLine.trim();
    if (!line) return false;
    try {
      const parsed = JSON.parse(line) as {
        model?: string;
        done?: boolean;
        message?: { content?: string; thinking?: string };
      };
      if (parsed.model && !model) model = parsed.model;
      if (typeof parsed.message?.content === 'string') {
        content += parsed.message.content;
      }
      if (typeof parsed.message?.thinking === 'string') {
        reasoning += parsed.message.thinking;
      }
      return Boolean(parsed.done);
    } catch {
      return false;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      chunkCount += 1;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      let reachedDone = false;
      for (const line of lines) {
        if (processLine(line)) {
          reachedDone = true;
          break;
        }
      }
      if (reachedDone) break;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (processLine(line)) break;
    }
  }

  return {
    content: content || reasoning,
    reasoning,
    model,
    chunkCount,
  };
}

export function buildLocalSystemInstruction(mode: string, defaultExtrudeMm: number): string {
  const is3d = mode === 'solidworks_3d';
  return `You are CADCraft CAD & SolidWorks Engineer. Output ONLY one valid compact JSON object (no markdown, no prose outside JSON).
Mode: ${is3d ? 'solidworks_3d (2D + 3D multi-part assembly)' : 'cad_2d'}. Units: mm, centered X=0, Y=0, base bottom Z=0. Default extrude: ${defaultExtrudeMm}mm.

JSON format:
{
  "explanation": "1-2 short sentences in user language",
  "action_type": "${is3d ? 'solidworks_3d' : 'lisp'}",
  "lisp_code": "(progn (command \\"_RECTANG\\" '(-80 -70) '(80 70)))",
  "commands": null,
  "part_name": "snake_case_name",
  "extrude_depth_mm": ${defaultExtrudeMm},
  "fillet_radius_mm": null,
  "parts_3d": [
    {"name":"Base Plate","kind":"plate","cx":0,"cy":0,"width":160,"depth":140,"z_min":0,"height":14,"finish":"dark_oxide","role":"fixed","holes":[{"kind":"slot","x1":-66,"y1":-48,"x2":-66,"y2":48,"width":12},{"kind":"circle","cx":0,"cy":0,"radius":10}]},
    {"name":"Block","kind":"box","cx":0,"cy":56,"z_min":14,"width":96,"depth":22,"height":24,"finish":"dark_oxide","role":"fixed"},
    {"name":"V-Jaw","kind":"prism","points":[[-44,-46],[44,-46],[44,-24],[18,-10],[-18,-10],[-44,-24]],"z_min":14,"height":26,"finish":"machined_steel","role":"moving"},
    {"name":"Lead Screw","kind":"cylinder","cx":0,"cy":24,"cz":26,"radius":6,"length":92,"axis":"y","threaded":true,"finish":"machined_steel","role":"shaft"}
  ],
  "mates": [
    {"kind":"coincident","part_a":"Block","part_b":"Base Plate","axis":"z","description":"Flush on base"},
    {"kind":"slide","part_a":"V-Jaw","part_b":"Base Plate","axis":"y","travel_mm":28,"description":"Slides along Y"},
    {"kind":"screw","part_a":"Lead Screw","part_b":"Block","axis":"y","travel_mm":28,"pitch_mm":4,"description":"Drives V-Jaw"}
  ]
}

Rules:
- AutoLISP commands: _RECTANG '(x1 y1) '(x2 y2), _CIRCLE '(cx cy) radius, _LINE, _PLINE ... "C", _SLOT '(x1 y1) '(x2 y2) width, _ARC, _POLYGON, OVERKILL, JOIN.
- Use radius = diameter / 2.
- For 3D mechanical parts/assemblies, stack 3-10 solid parts flush on realistic Z levels in parts_3d (plate holes use kind "circle"|"slot"|"rect") and add mates. Keep JSON compact and valid.`;
}
