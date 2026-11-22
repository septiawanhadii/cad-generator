import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { CheckCircle2, Eye, EyeOff, PanelRightClose, PanelRightOpen } from 'lucide-react';
import {
  AssistantTargetMode,
  AiBridgeConfig,
  ChatMessage,
  DEFAULT_BRIDGE_CONFIG,
  DocState,
  SwBridgeStatus,
  SwPingResult,
} from './types/cadcraft';
import {
  beginUndoGroup,
  createInitialDocState,
  endUndoGroup,
  getDocSummary,
  redoDoc,
  runJoin,
  runOverkill,
  undoDoc,
} from './cad/docState';
import { evaluateAutoLisp, executeCmdlineList } from './cad/lispEvaluator';
import { buildSolidWorksSpecFromDoc, exportDocToDxf } from './cad/dxfExporter';
import { derive2dEntitiesFromParts3d } from './cad/cad3dModel';
import { CadCanvas2D } from './components/CadCanvas2D';
import { SolidWorks3DViewport } from './components/SolidWorks3DViewport';
import { BridgeFilesPanel } from './components/BridgeFilesPanel';
import { AiChatPanel, type PromptAttachment } from './components/AiChatPanel';
import { AiSettingsModal } from './components/AiSettingsModal';
import { CommandLineBar } from './components/CommandLineBar';

type WorkspaceView = 'canvas_2d' | 'solidworks_3d' | 'layers_lisp' | 'bridge_files';

const STORAGE_CONFIG_KEY = 'cadcraft_ai_bridge_config_v1';

const SEED_MESSAGES: ChatMessage[] = [
  {
    id: 'msg-001',
    created_at: '2026-11-17T08:00:00Z',
    role: 'User',
    content:
      'Buatkan mounting plate ukuran 120x80mm dengan lubang tengah diameter 30mm dan 4 lubang baut M6 di sudut.',
    lisp_payload: null,
    sldprt_output_path: null,
  },
  {
    id: 'msg-002',
    created_at: '2026-11-17T08:00:03Z',
    role: 'Assistant',
    content:
      'Pelat dasar 120x80mm beserta lubang tengah R15 dan 4 lubang sudut R3 telah digambar ke kanvas.',
    lisp_payload:
      '(progn (command "_RECTANG" \'(0 0) \'(120 80)) (command "_CIRCLE" \'(60 40) 15) (command "_CIRCLE" \'(10 10) 3) (command "_CIRCLE" \'(110 10) 3) (command "_CIRCLE" \'(10 70) 3) (command "_CIRCLE" \'(110 70) 3))',
    sldprt_output_path: null,
  },
  {
    id: 'msg-003',
    created_at: '2026-11-17T08:01:10Z',
    role: 'User',
    content: 'Jadikan 3D solid dengan ketebalan 12mm dan simpan sebagai mounting_plate.sldprt',
    lisp_payload: null,
    sldprt_output_path: null,
  },
  {
    id: 'msg-004',
    created_at: '2026-11-17T08:01:18Z',
    role: 'SystemTool',
    content:
      'SolidWorks COM Bridge: Berhasil mengekstrusi sketch (12.0 mm) dan menyimpan file asli SolidWorks.',
    lisp_payload: null,
    sldprt_output_path: 'C:\\Users\\Engineer\\Documents\\CADCraft\\mounting_plate.sldprt',
  },
];

function loadSavedConfig(): AiBridgeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_CONFIG_KEY);
    if (!raw) return DEFAULT_BRIDGE_CONFIG;
    return { ...DEFAULT_BRIDGE_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_BRIDGE_CONFIG;
  }
}

export default function App() {
  const [activeView, setActiveView] = useState<WorkspaceView>('canvas_2d');
  const [doc, setDoc] = useState<DocState>(() => createInitialDocState());
  const [config, setConfig] = useState<AiBridgeConfig>(() => loadSavedConfig());
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(true);
  const [aiPanelWidth, setAiPanelWidth] = useState(360);
  const [mode, setMode] = useState<AssistantTargetMode>('cad_2d');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [lastAttachment, setLastAttachment] = useState<PromptAttachment | undefined>(undefined);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [swStatus, setSwStatus] = useState<SwBridgeStatus>('offline');
  const [cliLogs, setCliLogs] = useState<string[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const activeRequestAbortRef = useRef<AbortController | null>(null);
  const docSummary = useMemo(() => getDocSummary(doc), [doc]);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 4500);
  }, []);

  const pingSolidWorks = useCallback(async (pythonBin: string): Promise<SwPingResult> => {
    setSwStatus('checking');
    try {
      const res = await fetch('/api/solidworks/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ python_bin: pythonBin }),
      });
      const data = (await res.json()) as SwPingResult;
      setSwStatus(data.status === 'ready' ? 'ready' : 'offline');
      return data;
    } catch {
      const fallback: SwPingResult = {
        status: 'offline',
        platform: 'unknown',
        pythonFound: false,
        pywin32Ready: false,
        solidworksRunning: false,
        message: 'Tidak dapat menghubungi backend bridge.',
        checkedAt: new Date().toISOString(),
      };
      setSwStatus('offline');
      return fallback;
    }
  }, []);

  useEffect(() => {
    pingSolidWorks(config.python_bin);
  }, [config.python_bin, pingSolidWorks]);

  const handleUndo = useCallback(() => {
    setDoc((prev) => undoDoc(prev));
    setCliLogs((prev) => [...prev, 'UNDO: Mengembalikan grup perubahan terakhir.']);
  }, []);

  const handleRedo = useCallback(() => {
    setDoc((prev) => redoDoc(prev));
    setCliLogs((prev) => [...prev, 'REDO: Menerapkan ulang perubahan.']);
  }, []);

  // Global keyboard shortcuts: Ctrl+Shift+I (toggle AI panel), Ctrl+Z / Ctrl+Y
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toUpperCase() === 'I') {
        e.preventDefault();
        setIsAiPanelOpen((open) => {
          const next = !open;
          if (next) {
            setTimeout(() => composerInputRef.current?.focus(), 60);
          }
          return next;
        });
      }
      const target = e.target as HTMLElement | null;
      const isEditingText =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (!isEditingText && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      }
      if (!isEditingText && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, handleRedo]);

  const handleCleanupSketch = useCallback(() => {
    setDoc((prev) => {
      let next = beginUndoGroup(prev);
      const over = runOverkill(next);
      next = over.doc;
      const joined = runJoin(next);
      next = endUndoGroup(joined.doc);
      setCliLogs((l) => [
        ...l,
        `OVERKILL (${over.removedCount} duplikat dihapus) + JOIN (${joined.joinedChains} rantai digabung).`,
      ]);
      return next;
    });
  }, []);

  const handleClearCanvas = useCallback(() => {
    setDoc((prev) => {
      const grouped = beginUndoGroup(prev);
      const cleared = { ...grouped, entities: [], parts3d: [], mates: [] };
      return endUndoGroup(cleared);
    });
    setCliLogs((l) => [...l, 'CLEAR: Kanvas 2D & rakitan 3D dibersihkan (dapat dibatalkan via Undo).']);
  }, []);

  const executeSolidWorksExport = useCallback(
    async (
      currentDoc: DocState,
      specOverrides?: { partName?: string; extrudeDepthMm?: number; filletRadiusMm?: number | null },
    ) => {
      // Atomic cleanup before DXF export per PRD Section 5.1
      let cleanedDoc = beginUndoGroup(currentDoc);
      const over = runOverkill(cleanedDoc);
      cleanedDoc = over.doc;
      const joined = runJoin(cleanedDoc);
      cleanedDoc = endUndoGroup(joined.doc);
      setDoc(cleanedDoc);

      const dxfContent = exportDocToDxf(cleanedDoc);
      const spec = buildSolidWorksSpecFromDoc(cleanedDoc, config, specOverrides);

      const res = await fetch('/api/solidworks/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec, dxfContent, config }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Gagal mengekspor ke SolidWorks COM Bridge.');
      }

      const isAsm = spec.output_mode === 'assembly' && Boolean(spec.output_sldasm_path);
      const primaryOutputPath = isAsm
        ? spec.output_sldasm_path!
        : spec.output_sldprt_path;

      const sysMsg: ChatMessage = {
        id: `sys-${Date.now()}`,
        created_at: new Date().toISOString(),
        role: 'SystemTool',
        content: data.message,
        lisp_payload: null,
        sldprt_output_path: primaryOutputPath,
        dxf_content: dxfContent,
        solidworks_spec: spec,
      };
      setMessages((prev) => [...prev, sysMsg]);
      showToast(
        isAsm
          ? `Assembly SolidWorks siap: ${spec.part_name}.sldasm (${spec.parts_3d?.length ?? 0} Parts)`
          : `Ekspor SolidWorks siap: ${spec.part_name}.sldprt (${spec.extrude_depth_mm.toFixed(1)} mm)`,
      );
    },
    [config, showToast],
  );

  const handleExportSldprt = useCallback(async () => {
    if (doc.entities.length === 0 && doc.parts3d.length === 0) {
      setErrorMessage(
        'Kanvas masih kosong. Gambar geometri 2D atau generate model 3D terlebih dahulu sebelum mengekspor .sldprt.',
      );
      return;
    }
    setErrorMessage(null);
    setIsLoading(true);
    try {
      await executeSolidWorksExport(doc);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Gagal mengekspor .sldprt.');
    } finally {
      setIsLoading(false);
    }
  }, [doc, executeSolidWorksExport]);

  const handleSendPrompt = useCallback(
    async (promptText: string, attachment?: PromptAttachment) => {
      setErrorMessage(null);
      setLastPrompt(promptText);
      setLastAttachment(attachment);
      const userMsg: ChatMessage = {
        id: `usr-${Date.now()}`,
        created_at: new Date().toISOString(),
        role: 'User',
        content: promptText,
        lisp_payload: null,
        sldprt_output_path: null,
        image_preview_url: attachment?.previewUrl ?? null,
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      activeRequestAbortRef.current?.abort();
      const abortController = new AbortController();
      activeRequestAbortRef.current = abortController;

      try {
        const res = await fetch('/api/ai/design', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          body: JSON.stringify({
            prompt: promptText,
            mode,
            docSummary,
            config,
            imageBase64: attachment?.base64,
            imageMimeType: attachment?.mimeType,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Gagal memanggil AI Design Assistant.');
        }

        const payload = data.payload;
        let workingDoc = doc;
        let updated2d = false;

        const hasParts3d = Array.isArray(payload.parts_3d) && payload.parts_3d.length > 0;

        if (payload.lisp_code) {
          const evalRes = evaluateAutoLisp(payload.lisp_code, workingDoc);
          if (evalRes.ok) {
            workingDoc = evalRes.doc;
            updated2d = true;
            setCliLogs((l) => [...l, ...evalRes.logs]);
          } else if (!hasParts3d) {
            throw new Error(`Sintaks AutoLISP ditolak engine: ${evalRes.error}`);
          } else {
            setCliLogs((l) => [
              ...l,
              `INFO: Proyeksi 2D diturunkan otomatis dari 3D Assembly (${evalRes.error}).`,
            ]);
          }
        } else if (Array.isArray(payload.commands) && payload.commands.length > 0) {
          const cmdRes = executeCmdlineList(payload.commands, workingDoc);
          if (cmdRes.ok) {
            workingDoc = cmdRes.doc;
            updated2d = true;
            setCliLogs((l) => [...l, ...cmdRes.logs]);
          } else if (!hasParts3d) {
            throw new Error(`Perintah CAD ditolak engine: ${cmdRes.error}`);
          }
        }

        const resolvedMates = Array.isArray(payload.mates) ? payload.mates : [];
        if (hasParts3d) {
          const syncedEntities =
            updated2d || workingDoc.entities.length > 0
              ? workingDoc.entities
              : derive2dEntitiesFromParts3d(payload.parts_3d, workingDoc.activeLayer);
          workingDoc = {
            ...workingDoc,
            entities: syncedEntities,
            parts3d: payload.parts_3d,
            mates: resolvedMates,
          };
          setCliLogs((l) => [
            ...l,
            `3D ASSEMBLY: ${payload.parts_3d.length} komponen solid & ${resolvedMates.length} mates dimuat ke 3D SolidView.`,
          ]);
        } else if (updated2d) {
          workingDoc = {
            ...workingDoc,
            parts3d: [],
            mates: [],
          };
        }

        if (payload.solidworks_spec) {
          workingDoc = {
            ...workingDoc,
            extrudeDepthMm: payload.solidworks_spec.extrude_depth_mm || workingDoc.extrudeDepthMm,
            filletRadiusMm: payload.solidworks_spec.fillet_radius_mm ?? workingDoc.filletRadiusMm,
            lastPartName: payload.solidworks_spec.part_name || workingDoc.lastPartName,
          };
        }

        setDoc(workingDoc);

        const assistantMsg: ChatMessage = {
          id: `ast-${Date.now()}`,
          created_at: new Date().toISOString(),
          role: 'Assistant',
          content: payload.explanation || 'Perintah desain berhasil dieksekusi.',
          lisp_payload: payload.lisp_code || null,
          sldprt_output_path: null,
        };
        setMessages((prev) => [...prev, assistantMsg]);

        const hasGeometry = workingDoc.entities.length > 0 || workingDoc.parts3d.length > 0;
        if ((payload.action_type === 'solidworks_3d' || hasParts3d) && hasGeometry) {
          setActiveView('solidworks_3d');
        }

        if (payload.action_type === 'solidworks_3d' && hasGeometry) {
          await executeSolidWorksExport(workingDoc, {
            partName: payload.solidworks_spec?.part_name,
            extrudeDepthMm: payload.solidworks_spec?.extrude_depth_mm,
            filletRadiusMm: payload.solidworks_spec?.fillet_radius_mm ?? null,
          });
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          setCliLogs((l) => [...l, 'AI REQUEST: Dibatalkan oleh pengguna.']);
        } else {
          setErrorMessage(err instanceof Error ? err.message : 'Terjadi kesalahan saat memproses prompt.');
        }
      } finally {
        if (activeRequestAbortRef.current === abortController) {
          activeRequestAbortRef.current = null;
        }
        setIsLoading(false);
      }
    },
    [mode, docSummary, config, doc, executeSolidWorksExport],
  );

  const handleCancelAiRequest = useCallback(() => {
    activeRequestAbortRef.current?.abort();
  }, []);

  const handleRunLisp = useCallback((lispCode: string) => {
    setErrorMessage(null);
    setDoc((prev) => {
      const evalRes = evaluateAutoLisp(lispCode, prev);
      if (!evalRes.ok) {
        setErrorMessage(`Sintaks AutoLISP ditolak engine: ${evalRes.error}`);
        return prev;
      }
      setCliLogs((l) => [...l, ...evalRes.logs]);
      return { ...evalRes.doc, parts3d: [], mates: [] };
    });
  }, []);

  const handleLoadSeedSession = useCallback(() => {
    const seedLisp = SEED_MESSAGES[1].lisp_payload!;
    const evalRes = evaluateAutoLisp(seedLisp, createInitialDocState());
    if (evalRes.ok) {
      const nextDoc: DocState = {
        ...evalRes.doc,
        extrudeDepthMm: 12.0,
        lastPartName: 'mounting_plate',
      };
      setDoc(nextDoc);
      const dxf = exportDocToDxf(nextDoc);
      const spec = buildSolidWorksSpecFromDoc(nextDoc, config, {
        partName: 'mounting_plate',
        extrudeDepthMm: 12.0,
      });
      setMessages(
        SEED_MESSAGES.map((m) =>
          m.id === 'msg-004' ? { ...m, dxf_content: dxf, solidworks_spec: spec } : m,
        ),
      );
      setCliLogs(['Seed session mounting_plate.sldprt (120×80×12 mm) dimuat ke kanvas.']);
      setMode('solidworks_3d');
    }
  }, [config]);

  const handleExecuteCli = useCallback(
    (raw: string) => {
      const upper = raw.trim().toUpperCase();
      if (upper === 'UNDO') {
        handleUndo();
        return;
      }
      if (upper === 'REDO') {
        handleRedo();
        return;
      }
      setDoc((prev) => {
        const res = executeCmdlineList([raw], prev);
        if (!res.ok) {
          setCliLogs((l) => [...l, `ERROR: ${res.error}`]);
          return prev;
        }
        setCliLogs((l) => [...l, ...(res.logs.length > 0 ? res.logs : [`OK: ${raw}`])]);
        return res.doc;
      });
    },
    [handleUndo, handleRedo],
  );

  const handleSaveSettings = (next: AiBridgeConfig) => {
    setConfig(next);
    setDoc((prev) => ({ ...prev, extrudeDepthMm: next.default_extrude_mm }));
    try {
      localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage quota errors
    }
    setIsSettingsOpen(false);
    showToast('Konfigurasi AI & SolidWorks Bridge disimpan.');
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#121417] text-[#F1F5F9]">
        {/* Top Bar (3-zone contract: Wordmark | Single-line Views | 1 Primary Toggle) */}
        <header className="flex h-13 shrink-0 items-center justify-between gap-8 border-b border-[#2E3440] bg-[#1B1E23] px-4">
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('canvas_2d');
            }}
            className="text-base font-bold tracking-tight text-[#F1F5F9] whitespace-nowrap shrink-0"
          >
            CADCraft
          </a>

          <nav aria-label="Workspace Views" className="flex items-center gap-6 overflow-x-auto">
            {(
              [
                { id: 'canvas_2d', label: 'Canvas 2D' },
                { id: 'solidworks_3d', label: '3D SolidView' },
                { id: 'layers_lisp', label: 'Layers & Entities' },
                { id: 'bridge_files', label: 'Bridge Files' },
              ] as { id: WorkspaceView; label: string }[]
            ).map((navItem) => (
              <button
                key={navItem.id}
                type="button"
                onClick={() => setActiveView(navItem.id)}
                className={`border-b-2 py-3.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeView === navItem.id
                    ? 'border-[#3B82F6] text-[#F1F5F9]'
                    : 'border-transparent text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                {navItem.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => setIsAiPanelOpen((v) => !v)}
              title="Toggle AI Design Assistant (Ctrl+Shift+I)"
              className="flex h-8 items-center gap-2 rounded-md border border-[#2E3440] bg-[#242830] px-3 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] whitespace-nowrap shrink-0"
            >
              {isAiPanelOpen ? (
                <PanelRightClose className="h-3.5 w-3.5 text-[#3B82F6]" />
              ) : (
                <PanelRightOpen className="h-3.5 w-3.5 text-[#3B82F6]" />
              )}
              <span>AI Assistant</span>
            </button>
          </div>
        </header>

        {/* Main Workspace Split: Left/Center CAD Viewport + Right AI Docking Panel */}
        <main className="flex flex-1 overflow-hidden">
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {activeView === 'canvas_2d' && (
              <CadCanvas2D
                doc={doc}
                summary={docSummary}
                onUndo={handleUndo}
                onRedo={handleRedo}
                onCleanupSketch={handleCleanupSketch}
                onClearCanvas={handleClearCanvas}
              />
            )}

            {activeView === 'solidworks_3d' && (
              <SolidWorks3DViewport
                doc={doc}
                summary={docSummary}
                extrudeDepthMm={doc.extrudeDepthMm}
                onChangeExtrudeDepth={(mm) =>
                  setDoc((prev) => ({ ...prev, extrudeDepthMm: mm }))
                }
                onExportSldprt={handleExportSldprt}
              />
            )}

            {activeView === 'layers_lisp' && (
              <div className="flex-1 overflow-y-auto bg-[#121417] p-5">
                <div className="mx-auto max-w-4xl space-y-6">
                  <div>
                    <h2 className="text-[15px] font-semibold text-[#F1F5F9]">Layers</h2>
                    <div className="mt-2 overflow-hidden rounded-lg border border-[#2E3440] bg-[#1B1E23]">
                      <table className="w-full text-left text-xs">
                        <thead className="border-b border-[#2E3440] text-[#94A3B8]">
                          <tr>
                            <th className="px-4 py-2.5 font-medium">Layer Name</th>
                            <th className="px-4 py-2.5 font-medium">Color</th>
                            <th className="px-4 py-2.5 font-medium text-right">Entities</th>
                            <th className="px-4 py-2.5 font-medium text-right">Visibility</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#2E3440]">
                          {doc.layers.map((layer) => {
                            const count = doc.entities.filter((e) => e.layer === layer.name).length;
                            return (
                              <tr key={layer.name} className="hover:bg-[#242830]/60">
                                <td className="px-4 py-2.5 font-mono font-medium text-[#F1F5F9]">
                                  {layer.name}
                                </td>
                                <td className="px-4 py-2.5 font-mono text-[#94A3B8]">{layer.color}</td>
                                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#F1F5F9]">
                                  {count}
                                </td>
                                <td className="px-4 py-2.5 text-right">
                                  <button
                                    type="button"
                                    aria-label={`Toggle visibility for layer ${layer.name}`}
                                    onClick={() =>
                                      setDoc((prev) => ({
                                        ...prev,
                                        layers: prev.layers.map((l) =>
                                          l.name === layer.name ? { ...l, visible: !l.visible } : l,
                                        ),
                                      }))
                                    }
                                    className="inline-flex h-7 items-center gap-1 rounded border border-[#2E3440] px-2 text-xs text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9]"
                                  >
                                    {layer.visible ? (
                                      <>
                                        <Eye className="h-3.5 w-3.5 text-[#10B981]" />
                                        <span>Visible</span>
                                      </>
                                    ) : (
                                      <>
                                        <EyeOff className="h-3.5 w-3.5" />
                                        <span>Hidden</span>
                                      </>
                                    )}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div>
                    <h2 className="text-[15px] font-semibold text-[#F1F5F9]">
                      Active Entities ({doc.entities.length})
                    </h2>
                    {doc.entities.length === 0 ? (
                      <p className="mt-2 text-xs text-[#94A3B8]">
                        Belum ada entitas geometri di dokumen aktif.
                      </p>
                    ) : (
                      <div className="mt-2 overflow-hidden rounded-lg border border-[#2E3440] bg-[#1B1E23]">
                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-[#2E3440] text-[#94A3B8]">
                            <tr>
                              <th className="px-4 py-2.5 font-medium">ID</th>
                              <th className="px-4 py-2.5 font-medium">Type</th>
                              <th className="px-4 py-2.5 font-medium">Layer</th>
                              <th className="px-4 py-2.5 font-medium">Geometry (mm)</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#2E3440] font-mono tabular-nums">
                            {doc.entities.map((ent) => (
                              <tr key={ent.id} className="hover:bg-[#242830]/60">
                                <td className="px-4 py-2 text-[#94A3B8]">{ent.id}</td>
                                <td className="px-4 py-2 text-[#3B82F6]">{ent.kind}</td>
                                <td className="px-4 py-2 text-[#F1F5F9]">{ent.layer}</td>
                                <td className="px-4 py-2 text-[#F1F5F9]">
                                  {ent.kind === 'rectangle' &&
                                    `(${ent.x1}, ${ent.y1}) -> (${ent.x2}, ${ent.y2})`}
                                  {ent.kind === 'circle' &&
                                    `center=(${ent.cx}, ${ent.cy}) R=${ent.radius}`}
                                  {ent.kind === 'line' &&
                                    `(${ent.x1}, ${ent.y1}) -> (${ent.x2}, ${ent.y2})`}
                                  {ent.kind === 'polyline' &&
                                    `${ent.points.length} vertices (${ent.closed ? 'closed' : 'open'})`}
                                  {ent.kind === 'arc' &&
                                    `center=(${ent.cx}, ${ent.cy}) R=${ent.radius} [${ent.startAngleDeg}°, ${ent.endAngleDeg}°]`}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {doc.parts3d.length > 0 && (
                    <div>
                      <h2 className="text-[15px] font-semibold text-[#F1F5F9]">
                        3D Feature Tree ({doc.parts3d.length} Parts)
                      </h2>
                      <div className="mt-2 overflow-hidden rounded-lg border border-[#2E3440] bg-[#1B1E23]">
                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-[#2E3440] text-[#94A3B8]">
                            <tr>
                              <th className="px-4 py-2.5 font-medium">Part Name</th>
                              <th className="px-4 py-2.5 font-medium">Type</th>
                              <th className="px-4 py-2.5 font-medium">Finish</th>
                              <th className="px-4 py-2.5 font-medium">Dimensions / Placement (mm)</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#2E3440] font-mono tabular-nums">
                            {doc.parts3d.map((part) => (
                              <tr key={part.id} className="hover:bg-[#242830]/60">
                                <td className="px-4 py-2 text-[#F1F5F9]">{part.name}</td>
                                <td className="px-4 py-2 text-[#E11D48]">{part.kind}</td>
                                <td className="px-4 py-2 text-[#94A3B8]">{part.finish ?? 'default'}</td>
                                <td className="px-4 py-2 text-[#F1F5F9]">
                                  {part.kind === 'plate' &&
                                    `${part.width}×${part.depth}×${part.height} @ Z=${part.z_min}${part.holes?.length ? ` (${part.holes.length} holes)` : ''}`}
                                  {part.kind === 'box' &&
                                    `${part.width}×${part.depth}×${part.height} @ (${part.cx}, ${part.cy}, Z=${part.z_min})`}
                                  {part.kind === 'prism' &&
                                    `${part.points.length} pts, H=${part.height} @ Z=${part.z_min}${part.holes?.length ? ` (${part.holes.length} holes)` : ''}`}
                                  {part.kind === 'cylinder' &&
                                    `Ø${(part.radius * 2).toFixed(1)}×L${part.length} axis=${part.axis.toUpperCase()} @ (${part.cx}, ${part.cy}, ${part.cz})${part.threaded ? ' [threaded]' : ''}`}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeView === 'bridge_files' && <BridgeFilesPanel doc={doc} config={config} />}

            <CommandLineBar logs={cliLogs} onExecuteCommand={handleExecuteCli} />
          </section>

          <AnimatePresence>
            {isAiPanelOpen && (
              <AiChatPanel
                messages={messages}
                mode={mode}
                onChangeMode={setMode}
                docSummary={docSummary}
                swStatus={swStatus}
                isLoading={isLoading}
                activeProvider={config.provider}
                onCancelRequest={handleCancelAiRequest}
                errorMessage={errorMessage}
                widthPx={aiPanelWidth}
                onResizeWidth={setAiPanelWidth}
                onSendPrompt={handleSendPrompt}
                onRetryLast={() => {
                  if (lastPrompt) handleSendPrompt(lastPrompt, lastAttachment);
                }}
                onExportSldprt={handleExportSldprt}
                onRunLisp={handleRunLisp}
                onLoadSeedSession={handleLoadSeedSession}
                onOpenSettings={() => setIsSettingsOpen(true)}
                onClearChat={() => {
                  setMessages([]);
                  setErrorMessage(null);
                }}
                composerInputRef={composerInputRef}
              />
            )}
          </AnimatePresence>
        </main>

        {/* Settings Modal */}
        {isSettingsOpen && (
          <AiSettingsModal
            config={config}
            onSave={handleSaveSettings}
            onClose={() => setIsSettingsOpen(false)}
            onTestSolidWorksCom={pingSolidWorks}
          />
        )}

        {/* Toast Notification (top-center, clear of 3D bottom control dock) */}
        <AnimatePresence>
          {toastMessage && (
            <motion.div
              role="status"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="fixed top-28 right-[380px] z-40 flex items-center gap-2 rounded-md border border-[#10B981]/50 bg-[#1B1E23] px-3.5 py-2 text-xs font-medium text-[#F1F5F9] shadow-lg max-md:right-4"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 text-[#10B981]" />
              <span>{toastMessage}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
