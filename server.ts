import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

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
    solidworks_spec: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        part_name: { type: Type.STRING },
        source_mode: { type: Type.STRING },
        dxf_temp_path: { type: Type.STRING, nullable: true },
        extrude_depth_mm: { type: Type.NUMBER },
        fillet_radius_mm: { type: Type.NUMBER, nullable: true },
        output_sldprt_path: { type: Type.STRING },
        entities: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              kind: { type: Type.STRING },
              width_mm: { type: Type.NUMBER, nullable: true },
              height_mm: { type: Type.NUMBER, nullable: true },
              cx_mm: { type: Type.NUMBER, nullable: true },
              cy_mm: { type: Type.NUMBER, nullable: true },
              radius_mm: { type: Type.NUMBER, nullable: true },
            },
            required: ['kind'],
          },
        },
      },
      required: ['part_name', 'source_mode', 'extrude_depth_mm', 'entities', 'output_sldprt_path'],
    },
  },
  required: ['explanation', 'action_type'],
};

function buildSystemInstruction(mode: string, exportDir: string, defaultExtrudeMm: number): string {
  return `You are CADCraft AI Design Assistant, a precision mechanical CAD and SolidWorks automation engineer.
You translate natural language mechanical design requests into deterministic AutoLISP scripts for CADCraft 2D and SolidWorksBuildSpec JSON for 3D .sldprt export.

Target mode: ${mode === 'solidworks_3d' ? '2D + 3D SolidWorks (.sldprt)' : '2D CADCraft'}.
Units: Always use millimeters (mm).
Default extrude depth: ${defaultExtrudeMm} mm.
Default export directory: ${exportDir}

Supported AutoLISP commands in CADCraft:
- (progn ...)
- (command "_RECTANG" '(x1 y1) '(x2 y2))
- (command "_CIRCLE" '(cx cy) radius)  [NOTE: pass RADIUS, not diameter!]
- (command "_LINE" '(x1 y1) '(x2 y2))
- (command "_PLINE" '(x1 y1) '(x2 y2) '(x3 y3) "C")
- (command "_ARC" '(cx cy) radius startDeg endDeg)
- (command "OVERKILL")  [deduplicate overlapping geometry]
- (command "JOIN")      [join contiguous line segments into closed polylines]
- (command "CLEAR")     [clear canvas]

Rules:
1. Always return strict JSON matching the schema.
2. When drawing a part (like a mounting plate, bracket, flange, or gear blank), use clear coordinates starting from (0,0) or centered symmetrically, and make sure hole radii are diameter / 2 (e.g. M6 clearance hole = radius 3 or 3.3, diameter 30mm bore = radius 15).
3. If the user asks to clean up the sketch (OVERKILL + JOIN), set action_type to "lisp" with "(progn (command \"OVERKILL\") (command \"JOIN\"))" or action_type "cmdline" with commands ["OVERKILL", "JOIN"].
4. If target mode is "solidworks_3d" OR the user asks to extrude / export to 3D / .sldprt, set action_type to "solidworks_3d", include lisp_code if new 2D geometry is requested (or null if extruding existing canvas), and provide a complete solidworks_spec with valid part_name, extrude_depth_mm, entities, source_mode ("parametric_primitives" or "from_active_dxf"), and output_sldprt_path.
5. Reply in the same language as the user's prompt (Indonesian or English), keeping explanations concise and technically accurate.`;
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
  app.use(express.json({ limit: '2mb' }));

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

  app.post('/api/ai/design', async (req, res) => {
    try {
      const { prompt, mode = 'cad_2d', docSummary, config } = req.body ?? {};
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: 'Prompt tidak boleh kosong.' });
      }
      if (prompt.length > 4000) {
        return res.status(400).json({ error: 'Prompt melebihi batas maksimal 4.000 karakter.' });
      }

      const provider = config?.provider === 'ollama' ? 'ollama' : 'gemini';
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

      if (provider === 'ollama') {
        const ollamaUrl = String(config?.ollama_url || 'http://localhost:11434').replace(/\/+$/, '');
        const ollamaModel = String(config?.model || 'qwen2.5-coder:7b');
        const ollamaRes = await fetch(`${ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
        const parsed = JSON.parse(ollamaJson.message?.content || '{}');
        return res.json({ payload: parsed, model: ollamaModel, provider: 'ollama' });
      }

      const ai = getGeminiClient();
      const requestedModel = typeof config?.model === 'string' ? config.model : 'gemini-4-hydrogen';
      const primaryModel = ALLOWED_GEMINI_MODELS.has(requestedModel) ? requestedModel : 'gemini-4-hydrogen';
      const candidateModels =
        primaryModel === 'gemini-4-hydrogen'
          ? ['gemini-4-hydrogen', 'gemini-3.1-flash-lite']
          : [primaryModel];

      let responseText = '';
      let usedModel = primaryModel;
      let lastErr: unknown = null;

      for (const candidate of candidateModels) {
        try {
          const response = await ai.models.generateContent({
            model: candidate,
            contents: userContext,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema: AI_RESPONSE_SCHEMA,
              thinkingConfig: {
                thinkingLevel:
                  candidate === 'gemini-3.1-flash-lite'
                    ? ThinkingLevel.MINIMAL
                    : ThinkingLevel.LOW,
              },
            },
          });
          responseText = (response.text ?? '').trim();
          usedModel = candidate;
          if (responseText) break;
        } catch (err) {
          lastErr = err;
          const errStr = err instanceof Error ? err.message : String(err);
          const isTransient = errStr.includes('503') || errStr.includes('UNAVAILABLE') || errStr.includes('429');
          if (!isTransient) {
            throw err;
          }
        }
      }

      if (!responseText) {
        if (lastErr) throw lastErr;
        return res.status(502).json({ error: 'Gemini returned an empty response.' });
      }

      const payload = JSON.parse(responseText);
      return res.json({ payload, model: usedModel, provider: 'gemini' });
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

    const exportTmpDir = path.resolve('/tmp', 'cadcraft_exports');
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
