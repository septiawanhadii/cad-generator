import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { extractJsonFromLlmText, normalizeAiPayload } from './src/cad/aiPayloadParser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

const ALLOWED_GEMINI_MODELS = new Set([
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
]);

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const AI_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    explanation: {
      type: Type.STRING,
      description: 'Concise engineering explanation of the generated CAD geometry or operation.',
    },
    action_type: {
      type: Type.STRING,
      description: 'One of: lisp, cmdline, solidworks_3d, none',
    },
    lisp_code: {
      type: Type.STRING,
      nullable: true,
      description: 'Valid AutoLISP expression using (progn (command ...)) for CADCraft.',
    },
    commands: {
      type: Type.ARRAY,
      nullable: true,
      items: { type: Type.STRING },
      description: 'Optional list of CAD command-line instructions like OVERKILL or JOIN.',
    },
    part_name: {
      type: Type.STRING,
      nullable: true,
      description: 'Snake_case part name for SolidWorks export (e.g. drill_press_vise_base).',
    },
    extrude_depth_mm: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Extrusion depth in millimeters (e.g. 15).',
    },
    fillet_radius_mm: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Optional fillet radius in millimeters.',
    },
    parts_3d_json: {
      type: Type.STRING,
      nullable: true,
      description:
        'Compact JSON array string of multi-level 3D CAD solid parts (plate with holes, prism, box, oriented/threaded cylinder) in mm so the 3D viewport and SolidWorks COM bridge render an accurate 3D solid assembly.',
    },
    mates_json: {
      type: Type.STRING,
      nullable: true,
      description:
        'Optional compact JSON array string of SolidWorks Assembly Mates linking parts_3d components (coincident, concentric, screw, slide) with axis and travel_mm/pitch_mm for kinematic motion simulation.',
    },
  },
  required: ['explanation', 'action_type'],
};

function buildSystemInstruction(mode: string, exportDir: string, defaultExtrudeMm: number): string {
  return `You are CADCraft AI Design Assistant, a senior SolidWorks & mechanical CAD systems engineer.
You translate natural language mechanical design requests (and optional reference images) into BOTH:
1. Accurate 2D plan-view AutoLISP (lisp_code) for CADCraft 2D canvas.
2. Accurate multi-level, multi-part parametric 3D solid assembly features (parts_3d_json) in millimeters (mm) for SolidWorks 3D & real-time PBR rendering.

Target mode: ${mode === 'solidworks_3d' ? '2D + 3D SolidWorks (.sldprt)' : '2D CADCraft'}.
Units: Always use millimeters (mm), centered symmetrically around X=0, Y=0, with the bottom resting at Z=0.
Default extrude depth: ${defaultExtrudeMm} mm.
Default export directory: ${exportDir}

Supported AutoLISP commands in CADCraft 2D:
- (progn ...)
- (command "_RECTANG" '(x1 y1) '(x2 y2))
- (command "_CIRCLE" '(cx cy) radius)  [NOTE: pass RADIUS, not diameter!]
- (command "_LINE" '(x1 y1) '(x2 y2))
- (command "_PLINE" '(x1 y1) '(x2 y2) '(x3 y3) "C")
- (command "_ARC" '(cx cy) radius startDeg endDeg)
- (command "_SLOT" '(x1 y1) '(x2 y2) width)  [obround slot between 2 centers]
- (command "_POLYGON" '(cx cy) radius sides)
- (command "OVERKILL")
- (command "JOIN")
- (command "CLEAR")

3D SOLID FEATURE SCHEMA for "parts_3d_json" (MUST be a valid compact JSON array string whenever generating 3D parts or mechanical objects):
Coordinate system: X = width (left/right), Y = depth (front/back), Z = height (up from 0).
Supported part kinds:
1. "plate" (base/flange with real boolean through-holes/cutouts):
   {"name":"Base Plate","kind":"plate","cx":0,"cy":0,"width":160,"depth":140,"z_min":0,"height":14,"finish":"dark_oxide","holes":[{"kind":"slot","x1":-66,"y1":-48,"x2":-66,"y2":48,"width":12},{"kind":"slot","x1":66,"y1":-48,"x2":66,"y2":48,"width":12},{"kind":"rect","cx":0,"cy":6,"width":36,"height":68}]}
2. "box" (stepped jaw, rib, guide rail, mounting foot, rear nut block):
   {"name":"Rear Nut Block","kind":"box","cx":0,"cy":56,"z_min":14,"width":96,"depth":22,"height":24,"finish":"dark_oxide"}
3. "prism" (extruded custom 2D XY polygon for chamfered jaws, V-groove jaws, triangular blocks, gussets, brackets):
   {"name":"Movable V-Jaw","kind":"prism","points":[[-44,-46],[44,-46],[44,-24],[18,-10],[-18,-10],[-44,-24]],"z_min":14,"height":26,"finish":"dark_oxide","holes":[{"kind":"circle","cx":0,"cy":-28,"radius":4}]}
4. "cylinder" (horizontal/vertical shafts, threaded lead screws, handles, pins, bosses; axis="x"|"y"|"z"):
   {"name":"Lead Screw","kind":"cylinder","cx":0,"cy":24,"cz":26,"radius":6,"length":92,"axis":"y","threaded":true,"finish":"dark_oxide"}
   {"name":"Handle Grip","kind":"cylinder","cx":0,"cy":96,"cz":26,"radius":8,"length":44,"axis":"y","threaded":false,"finish":"dark_oxide"}

Available finishes: "dark_oxide", "cast_iron", "machined_steel", "aluminum", "brass", "anodized_blue".
Optional part role: "fixed" | "moving" | "shaft" | "actuator" | "fastener".

ASSEMBLY MATES SCHEMA for "mates_json" (compact JSON array string when generating 2+ part assemblies):
- [{"kind":"coincident","part_a":"Rear Nut Block","part_b":"Base Plate","axis":"z","description":"Rear Nut Block flush on Base Plate"},
   {"kind":"slide","part_a":"Movable V-Jaw","part_b":"Base Plate","axis":"y","travel_mm":28,"description":"Movable V-Jaw slides along Y"},
   {"kind":"screw","part_a":"Lead Screw","part_b":"Rear Nut Block","axis":"y","travel_mm":28,"pitch_mm":4,"description":"Lead Screw M16x4 drives Movable V-Jaw"},
   {"kind":"concentric","part_a":"Handle Grip","part_b":"Lead Screw","axis":"y","travel_mm":28,"pitch_mm":4,"description":"Handle concentric with Lead Screw"}]

CRITICAL 3D MECHANICAL ACCURACY RULES:
1. NEVER squash a multi-part mechanical assembly (like a Drill Press Vise, bracket, clamp, gearbox, flanged shaft, pillow block, arbor press) into a single flat extrusion! Use 4–12 properly stacked 3D parts in "parts_3d_json" with realistic Z elevations (e.g. base plate z_min=0..14, jaws/blocks sitting FLUSH on z_min=14..40, horizontal lead screw centered at cz=26 passing through the rear block and connecting to the movable jaw, handle extending cleanly behind the rear block).
2. Put mounting slots, center through-openings, and bolt holes INSIDE the plate's "holes" array so they render as true see-through cutouts (do NOT make holes into overlapping solid boxes!).
3. For a Drill Press Vise / Ragum Bor specifically: include (a) flanged base plate with left & right obround mounting slots and central rectangular through-opening, (b) recessed front/back bottom guide rails or stepped wings, (c) front jaw with diagonal V-groove / chamfered triangular cheek blocks using "prism" polygons, (d) stepped rear fixed nut block using stacked "box" features, (e) horizontal "threaded": true lead screw along Y axis ("axis":"y") spanning between front jaw and rear block, and (f) thicker cylindrical handle extending smoothly past the rear block.
4. Whenever generating a multi-part assembly (2+ parts), populate BOTH "parts_3d_json" (with accurate "role") AND "mates_json" so the user gets full SolidWorks Assembly Tree, Mates, BOM, Kinematic Motion Simulation, and .sldasm export.
5. Keep explanation concise (1-2 sentences) and lisp_code on one clean line matching the XY plan projection of the part.
6. Make sure hole radii are diameter / 2.
7. If target mode is "solidworks_3d" OR the user asks for 3D / .sldprt / .sldasm / assembly / extrude / model 3D, set action_type to "solidworks_3d", set part_name (snake_case), extrude_depth_mm, AND populate "parts_3d_json" + "mates_json".
8. Reply in the same language as the user's prompt (Indonesian or English).`;
}

function readBridgeFiles() {
  const bridgeDir = path.resolve(__dirname, 'bridge', 'solidworks');
  const readSafe = (file: string) => {
    const p = path.join(bridgeDir, file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  };
  return {
    sw_builder: readSafe('sw_builder.py'),
    dxf_to_sldprt: readSafe('dxf_to_sldprt.py'),
    requirements: readSafe('requirements.txt'),
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    const hasGeminiKey = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY',
    );
    res.json({
      ok: true,
      platform: process.platform,
      hasGeminiKey,
      bridgeReady: fs.existsSync(path.resolve(__dirname, 'bridge', 'solidworks', 'sw_builder.py')),
    });
  });

  app.get('/api/bridge/files', (_req, res) => {
    res.json(readBridgeFiles());
  });

  app.post('/api/ai/lmstudio/models', async (req, res) => {
    try {
      const lmUrl = String(req.body?.lmstudio_url || 'http://localhost:1234').replace(/\/+$/, '');
      const resp = await fetch(`${lmUrl}/v1/models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        return res.status(502).json({
          ok: false,
          models: [],
          error: `LM Studio merespons HTTP ${resp.status}. Pastikan Local Server di LM Studio sudah aktif.`,
        });
      }
      const data = (await resp.json()) as { data?: Array<{ id: string }> };
      const models = Array.isArray(data.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
      return res.json({ ok: true, models });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal terhubung ke LM Studio.';
      return res.status(502).json({
        ok: false,
        models: [],
        error: `Tidak dapat menghubungi LM Studio (${msg}). Pastikan "Start Server" aktif di port 1234.`,
      });
    }
  });

  app.post('/api/ai/design', async (req, res) => {
    try {
      const { prompt, mode = 'cad_2d', docSummary, config, imageBase64, imageMimeType } = req.body ?? {};
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: 'Prompt tidak boleh kosong.' });
      }
      if (prompt.length > 4000) {
        return res.status(400).json({ error: 'Prompt melebihi batas maksimal 4.000 karakter.' });
      }

      const hasImage =
        typeof imageBase64 === 'string' &&
        imageBase64.length > 32 &&
        typeof imageMimeType === 'string' &&
        imageMimeType.startsWith('image/');

      const provider =
        config?.provider === 'lmstudio'
          ? 'lmstudio'
          : config?.provider === 'ollama'
            ? 'ollama'
            : 'gemini';
      const exportDir = typeof config?.export_dir === 'string' && config.export_dir.trim()
        ? config.export_dir.trim()
        : 'C:\\Users\\Engineer\\Documents\\CADCraft';
      const defaultExtrudeMm =
        typeof config?.default_extrude_mm === 'number' && config.default_extrude_mm > 0.01
          ? config.default_extrude_mm
          : 12.0;

      const systemInstruction = buildSystemInstruction(mode, exportDir, defaultExtrudeMm);
      const userContext = `Active CAD Document Context:
${JSON.stringify(docSummary ?? {}, null, 2)}

User Design Request:
${prompt.trim()}`;

      if (provider === 'lmstudio') {
        const lmUrl = String(config?.lmstudio_url || 'http://localhost:1234').replace(/\/+$/, '');
        const lmModel = String(config?.model || 'local-model').trim() || 'local-model';
        const lmSystem = `${systemInstruction}

Return ONLY a valid JSON object matching this exact structure (no extra prose outside JSON):
{
  "explanation": "string",
  "action_type": "lisp" | "cmdline" | "solidworks_3d" | "none",
  "lisp_code": "string or null",
  "commands": ["string"] or null,
  "part_name": "string or null",
  "extrude_depth_mm": ${defaultExtrudeMm},
  "fillet_radius_mm": null,
  "parts_3d": [ { "name": "Base Plate", "kind": "plate", "cx": 0, "cy": 0, "width": 160, "depth": 140, "z_min": 0, "height": 14, "holes": [] } ]
}`;

        const lmRes = await fetch(`${lmUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(60000),
          body: JSON.stringify({
            model: lmModel,
            temperature: 0.15,
            max_tokens: 4096,
            messages: [
              { role: 'system', content: lmSystem },
              { role: 'user', content: userContext },
            ],
          }),
        });

        if (!lmRes.ok) {
          const text = await lmRes.text();
          return res.status(502).json({
            error: `LM Studio error (${lmRes.status}): ${text || 'Pastikan model sudah di-load dan Start Server aktif di LM Studio.'}`,
          });
        }

        const lmJson = (await lmRes.json()) as {
          model?: string;
          choices?: Array<{ message?: { content?: string } }>;
        };
        const rawContent = lmJson.choices?.[0]?.message?.content || '';
        const parsed = normalizeAiPayload(
          extractJsonFromLlmText(rawContent, mode),
          exportDir,
          defaultExtrudeMm,
          mode,
        );
        return res.json({
          payload: parsed,
          model: lmJson.model || lmModel,
          provider: 'lmstudio',
        });
      }

      if (provider === 'ollama') {
        const ollamaUrl = String(config?.ollama_url || 'http://localhost:11434').replace(/\/+$/, '');
        const ollamaModel = String(config?.model || 'qwen2.5-coder:7b');
        const ollamaRes = await fetch(`${ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(60000),
          body: JSON.stringify({
            model: ollamaModel,
            stream: false,
            format: 'json',
            messages: [
              { role: 'system', content: systemInstruction },
              { role: 'user', content: userContext },
            ],
          }),
        });
        if (!ollamaRes.ok) {
          const text = await ollamaRes.text();
          return res.status(502).json({
            error: `Ollama Local error (${ollamaRes.status}): ${text || 'Failed to reach Ollama endpoint.'}`,
          });
        }
        const ollamaJson = (await ollamaRes.json()) as { message?: { content?: string } };
        const parsed = normalizeAiPayload(
          extractJsonFromLlmText(ollamaJson.message?.content || '{}', mode),
          exportDir,
          defaultExtrudeMm,
          mode,
        );
        return res.json({ payload: parsed, model: ollamaModel, provider: 'ollama' });
      }

      const ai = getGeminiClient();
      const requestedModel = typeof config?.model === 'string' ? config.model : 'gemini-4-hydrogen';
      const primaryModel = ALLOWED_GEMINI_MODELS.has(requestedModel) ? requestedModel : 'gemini-4-hydrogen';
      const candidateModels =
        primaryModel === 'gemini-4-hydrogen'
          ? ['gemini-4-hydrogen', 'gemini-3.1-flash-lite']
          : [primaryModel];

      let parsedPayload: Record<string, unknown> | null = null;
      let usedModel = primaryModel;
      let lastErr: unknown = null;

      const geminiContents = hasImage
        ? [
            { text: `${userContext}\n\nAnalyze the attached mechanical reference image carefully and reproduce its true 3D proportions, stepped elevations, slots/cutouts, angled jaws, and cylindrical shafts/handles in parts_3d_json and lisp_code.` },
            { inlineData: { mimeType: imageMimeType, data: imageBase64 } },
          ]
        : userContext;

      for (const candidate of candidateModels) {
        try {
          const response = await ai.models.generateContent({
            model: candidate,
            contents: geminiContents,
            config: {
              abortSignal: AbortSignal.timeout(candidate === 'gemini-4-hydrogen' ? 28000 : 30000),
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema: AI_RESPONSE_SCHEMA,
              maxOutputTokens: 16384,
              thinkingConfig: {
                thinkingLevel:
                  candidate === 'gemini-3.1-flash-lite'
                    ? ThinkingLevel.MINIMAL
                    : ThinkingLevel.LOW,
              },
            },
          });
          const responseText = (response.text ?? '').trim();
          if (!responseText) {
            throw new Error(`Empty response from ${candidate}`);
          }
          const rawParsed = extractJsonFromLlmText(responseText, mode);
          parsedPayload = normalizeAiPayload(rawParsed, exportDir, defaultExtrudeMm, mode);
          usedModel = candidate;
          break;
        } catch (err) {
          lastErr = err;
          const errStr = err instanceof Error ? `${err.name} ${err.message}` : String(err);
          const isRecoverable =
            errStr.includes('503') ||
            errStr.includes('UNAVAILABLE') ||
            errStr.includes('429') ||
            errStr.includes('TimeoutError') ||
            errStr.includes('AbortError') ||
            errStr.includes('Empty response') ||
            errStr.includes('AiResponsePayload') ||
            errStr.toLowerCase().includes('aborted') ||
            errStr.toLowerCase().includes('timeout');
          if (!isRecoverable) {
            throw err;
          }
        }
      }

      if (!parsedPayload) {
        if (lastErr) throw lastErr;
        return res.status(502).json({ error: 'Gemini returned an empty response.' });
      }

      return res.json({ payload: parsedPayload, model: usedModel, provider: 'gemini' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to process AI design request.';
      console.error('[/api/ai/design]', msg);
      return res.status(500).json({ error: msg });
    }
  });

  app.post('/api/solidworks/ping', (req, res) => {
    const pythonBin = String(req.body?.python_bin || 'bridge/solidworks/.venv/Scripts/python.exe');
    const scriptPath = path.resolve(__dirname, 'bridge', 'solidworks', 'sw_builder.py');
    const checkedAt = new Date().toISOString();

    if (process.platform !== 'win32') {
      return res.json({
        status: 'offline',
        platform: process.platform,
        pythonFound: false,
        pywin32Ready: false,
        solidworksRunning: false,
        message: `Live COM dispatch (SldWorks.Application) requires Windows desktop with SolidWorks & pywin32. Current runtime: ${process.platform}. DXF & Python COM Bridge package export remains active.`,
        checkedAt,
      });
    }

    execFile(pythonBin, [scriptPath, '--ping'], { timeout: 6000 }, (err, stdout, stderr) => {
      if (err) {
        return res.json({
          status: 'offline',
          platform: process.platform,
          pythonFound: false,
          pywin32Ready: false,
          solidworksRunning: false,
          message: stderr?.trim() || err.message,
          checkedAt,
        });
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        return res.json({
          status: parsed.status === 'ready' ? 'ready' : 'offline',
          platform: process.platform,
          pythonFound: true,
          pywin32Ready: parsed.status === 'ready',
          solidworksRunning: parsed.status === 'ready',
          message: parsed.revision
            ? `SolidWorks COM Connected (Rev ${parsed.revision})`
            : parsed.error || 'SolidWorks offline',
          checkedAt,
        });
      } catch {
        return res.json({
          status: 'offline',
          platform: process.platform,
          pythonFound: true,
          pywin32Ready: false,
          solidworksRunning: false,
          message: stdout.trim() || 'Unexpected COM ping output.',
          checkedAt,
        });
      }
    });
  });

  app.post('/api/solidworks/export', (req, res) => {
    const { spec, dxfContent, config } = req.body ?? {};
    if (!spec || typeof spec.extrude_depth_mm !== 'number' || spec.extrude_depth_mm <= 0.01 || spec.extrude_depth_mm > 10000) {
      return res.status(400).json({ error: 'Ketebalan extrude harus > 0.01 mm dan <= 10000.0 mm.' });
    }
    if (typeof dxfContent !== 'string' || !dxfContent.includes('EOF')) {
      return res.status(400).json({ error: 'Payload DXF tidak valid.' });
    }

    const exportTmpDir = path.join(os.tmpdir(), 'cadcraft_exports');
    fs.mkdirSync(exportTmpDir, { recursive: true });

    const safeName = String(spec.part_name || 'cadcraft_part').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dxfFile = path.join(exportTmpDir, `${safeName}_sketch.dxf`);
    const specFile = path.join(exportTmpDir, `${safeName}_spec.json`);
    fs.writeFileSync(dxfFile, dxfContent, 'utf-8');
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf-8');

    const pythonBin = String(config?.python_bin || 'bridge/solidworks/.venv/Scripts/python.exe');
    const headlessFlag = config?.show_solidworks_window === false ? ['--headless'] : [];
    const scriptName = spec.source_mode === 'from_active_dxf' ? 'dxf_to_sldprt.py' : 'sw_builder.py';
    const scriptPath = path.resolve(__dirname, 'bridge', 'solidworks', scriptName);

    if (process.platform === 'win32') {
      const winSpec = { ...spec, dxf_temp_path: dxfFile };
      fs.writeFileSync(specFile, JSON.stringify(winSpec, null, 2), 'utf-8');
      return execFile(pythonBin, [scriptPath, specFile, ...headlessFlag], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          return res.status(500).json({
            error: `SolidWorks COM error: ${stderr?.trim() || err.message}`,
          });
        }
        return res.json({
          ok: true,
          mode: 'com_executed',
          message: `SolidWorks COM Bridge: Berhasil mengekstrusi sketch (${spec.extrude_depth_mm.toFixed(1)} mm) dan menyimpan ${spec.output_sldprt_path}`,
          spec: winSpec,
          comOutput: stdout.trim(),
          bridgeFiles: readBridgeFiles(),
        });
      });
    }

    return res.json({
      ok: true,
      mode: 'bridge_bundle_ready',
      message: `Sketch DXF dibersihkan (OVERKILL + JOIN) & spesifikasi SolidWorks (${spec.extrude_depth_mm.toFixed(1)} mm) siap untuk dieksekusi di Windows COM Bridge.`,
      spec,
      dxfPath: dxfFile,
      specPath: specFile,
      bridgeFiles: readBridgeFiles(),
    });
  });

  if (isProduction) {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CADCraft server running at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start CADCraft server:', err);
  process.exit(1);
});
