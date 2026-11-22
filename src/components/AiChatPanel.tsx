import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  Box,
  CheckCircle2,
  Copy,
  Download,
  ImagePlus,
  Loader2,
  Play,
  RefreshCw,
  Send,
  Settings,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  AssistantTargetMode,
  ChatMessage,
  DocSummary,
  SwBridgeStatus,
} from '../types/cadcraft';

export interface PromptAttachment {
  base64: string;
  mimeType: string;
  previewUrl: string;
  name?: string;
}

interface AiChatPanelProps {
  messages: ChatMessage[];
  mode: AssistantTargetMode;
  onChangeMode: (mode: AssistantTargetMode) => void;
  docSummary: DocSummary;
  swStatus: SwBridgeStatus;
  isLoading: boolean;
  errorMessage: string | null;
  widthPx: number;
  onResizeWidth: (nextWidth: number) => void;
  onSendPrompt: (prompt: string, attachment?: PromptAttachment) => void;
  onRetryLast: () => void;
  onExportSldprt: () => void;
  onRunLisp: (lispCode: string) => void;
  onLoadSeedSession: () => void;
  onOpenSettings: () => void;
  onClearChat: () => void;
  composerInputRef: React.RefObject<HTMLTextAreaElement | null>;
}

const QUICK_PROMPTS = [
  {
    label: 'Buat Pelat Bracket 4 Lubang',
    prompt:
      'Buatkan mounting plate ukuran 120x80mm dengan lubang tengah diameter 30mm dan 4 lubang baut M6 (radius 3mm) di sudut (10,10), (110,10), (10,70), (110,70).',
  },
  {
    label: 'Bersihkan Sketch (OVERKILL + JOIN)',
    prompt: 'Bersihkan sketch aktif di kanvas menggunakan OVERKILL dan JOIN agar siap diekstrusi.',
  },
  {
    label: 'Ekspor Kanvas ke .sldprt (Extrude 15mm)',
    prompt: 'Ekspor kanvas aktif menjadi model 3D SolidWorks dengan ketebalan extrude 15mm.',
  },
];

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const AiChatPanel: React.FC<AiChatPanelProps> = ({
  messages,
  mode,
  onChangeMode,
  docSummary,
  swStatus,
  isLoading,
  errorMessage,
  widthPx,
  onResizeWidth,
  onSendPrompt,
  onRetryLast,
  onExportSldprt,
  onRunLisp,
  onLoadSeedSession,
  onOpenSettings,
  onClearChat,
  composerInputRef,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [attachment, setAttachment] = useState<PromptAttachment | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resizingRef = useRef(false);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isLoading]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const next = Math.min(520, Math.max(280, window.innerWidth - e.clientX));
      onResizeWidth(next);
    };
    const onUp = () => {
      resizingRef.current = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onResizeWidth]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setValidationError('Hanya file gambar (PNG, JPG, WebP) yang didukung sebagai referensi.');
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      setValidationError('Ukuran gambar referensi maksimal 6 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = dataUrl.indexOf(',');
      if (commaIdx === -1) return;
      const base64 = dataUrl.slice(commaIdx + 1);
      setAttachment({
        base64,
        mimeType: file.type || 'image/png',
        previewUrl: dataUrl,
        name: file.name,
      });
      setValidationError(null);
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = () => {
    const trimmed = inputValue.trim();
    if (!trimmed && !attachment) {
      setValidationError('Masukkan deskripsi desain atau lampirkan gambar referensi terlebih dahulu.');
      return;
    }
    if (trimmed.length > 4000) {
      setValidationError('Prompt melebihi batas maksimal 4.000 karakter.');
      return;
    }
    const finalPrompt =
      trimmed ||
      'Analisis gambar referensi ini dan buatkan model 3D mekanik multi-komponen yang akurat sesuai proporsi gambar.';
    const currentAttachment = attachment ?? undefined;
    setValidationError(null);
    setInputValue('');
    setAttachment(null);
    onSendPrompt(finalPrompt, currentAttachment);
  };

  const handleCopy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <motion.aside
      initial={{ opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      style={{ width: `${widthPx}px` }}
      aria-label="AI Design Assistant Panel"
      className="relative flex h-full shrink-0 flex-col border-l border-[#2E3440] bg-[#121417] max-md:fixed max-md:top-13 max-md:right-0 max-md:bottom-0 max-md:z-30 max-md:!w-[92vw] max-md:max-w-[380px] max-md:shadow-2xl"
    >
      {/* Drag Resize Handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize AI Assistant Panel"
        onMouseDown={() => {
          resizingRef.current = true;
        }}
        className="absolute top-0 bottom-0 left-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-[#3B82F6]/60"
      />

      {/* Panel Header */}
      <div className="flex items-center justify-between gap-2 border-b border-[#2E3440] px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold tracking-[0.01em] text-[#F1F5F9]">
            AI Design Assistant
          </h2>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
            {swStatus === 'ready' ? (
              <span className="flex items-center gap-1 text-[#10B981]">
                <CheckCircle2 className="h-3 w-3" />
                <span>SW Ready</span>
              </span>
            ) : swStatus === 'checking' ? (
              <span className="flex items-center gap-1 text-[#06B6D4]">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Checking COM</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[#F59E0B]">
                <WifiOff className="h-3 w-3" />
                <span>SW Offline (Bridge Mode)</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onOpenSettings}
            title="AI & SolidWorks Configuration"
            aria-label="Open AI and SolidWorks Settings"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-[#2E3440] text-[#94A3B8] transition-colors hover:bg-[#242830] hover:text-[#F1F5F9]"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onClearChat}
            title="Clear Chat History"
            aria-label="Clear Chat History"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-[#2E3440] text-[#94A3B8] transition-colors hover:bg-[#242830] hover:text-[#EF4444]"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Context & Mode Bar */}
      <div className="border-b border-[#2E3440] bg-[#1B1E23]/60 px-3 py-2.5">
        <div className="flex items-center justify-between text-xs text-[#94A3B8] font-mono tabular-nums">
          <span className="truncate">
            Layer: {docSummary.activeLayer} · {docSummary.entityCount} 2D
            {(docSummary.parts3dCount ?? 0) > 0 ? ` · ${docSummary.parts3dCount} 3D Parts` : ''} ·{' '}
            {docSummary.unit}
          </span>
          {docSummary.extents && (
            <span className="shrink-0 text-[#06B6D4]">
              {docSummary.extents.width}×{docSummary.extents.height}
            </span>
          )}
        </div>

        {/* Target Mode Segmented Selector */}
        <div
          role="group"
          aria-label="Target Design Mode"
          className="mt-2 grid grid-cols-2 gap-1 rounded-md border border-[#2E3440] bg-[#121417] p-1"
        >
          <button
            type="button"
            onClick={() => onChangeMode('cad_2d')}
            className={`rounded px-2 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              mode === 'cad_2d'
                ? 'bg-[#3B82F6] text-[#F1F5F9]'
                : 'text-[#94A3B8] hover:text-[#F1F5F9]'
            }`}
          >
            2D CADCraft
          </button>
          <button
            type="button"
            onClick={() => onChangeMode('solidworks_3d')}
            className={`rounded px-2 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              mode === 'solidworks_3d'
                ? 'bg-[#E11D48] text-[#F1F5F9]'
                : 'text-[#94A3B8] hover:text-[#F1F5F9]'
            }`}
          >
            2D + 3D (.sldprt)
          </button>
        </div>
      </div>

      {/* Chat Transcript ScrollArea */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col justify-center py-4">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg border border-[#2E3440] bg-[#1B1E23]">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                className="text-[#3B82F6]"
              >
                <rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
                <circle cx="12" cy="12" r="3" stroke="#E11D48" strokeWidth="1.6" />
                <circle cx="6.5" cy="8.5" r="1" fill="currentColor" />
                <circle cx="17.5" cy="8.5" r="1" fill="currentColor" />
                <circle cx="6.5" cy="15.5" r="1" fill="currentColor" />
                <circle cx="17.5" cy="15.5" r="1" fill="currentColor" />
              </svg>
            </div>
            <p className="mt-3 text-center text-sm font-semibold text-[#F1F5F9]">
              Asisten Desain CAD &amp; SolidWorks
            </p>
            <p className="mt-1 text-center text-xs leading-relaxed text-[#94A3B8]">
              Deskripsikan komponen mekanik dalam milimeter (mm). AI akan menyusun skrip AutoLISP, menggambar ke kanvas, dan menyiapkan paket ekspor <span className="font-mono text-[#F1F5F9]">.sldprt</span>.
            </p>

            <div className="mt-4 space-y-1.5">
              {QUICK_PROMPTS.map((chip, idx) => (
                <motion.button
                  key={chip.label}
                  type="button"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.14, delay: idx * 0.03 }}
                  onClick={() => onSendPrompt(chip.prompt)}
                  disabled={isLoading}
                  className="w-full rounded-md border border-[#2E3440] bg-[#1B1E23] px-3 py-2 text-left text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6]/60 hover:bg-[#242830] disabled:opacity-50"
                >
                  {chip.label}
                </motion.button>
              ))}
            </div>

            <button
              type="button"
              onClick={onLoadSeedSession}
              className="mt-3 w-full rounded-md border border-[#2E3440] bg-transparent px-3 py-1.5 text-xs font-medium text-[#94A3B8] transition-colors hover:bg-[#242830] hover:text-[#F1F5F9]"
            >
              Muat Contoh Sesi Mounting Plate (PRD Seed)
            </button>
          </div>
        ) : (
          messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              className={`flex flex-col ${msg.role === 'User' ? 'items-end' : 'items-start'}`}
            >
              {msg.role === 'User' && (
                <div className="max-w-[90%] space-y-2 rounded-[10px] border border-[#3B82F6]/35 bg-[#2563EB]/15 px-3 py-2 text-[13px] leading-[1.45] text-[#F1F5F9]">
                  {msg.image_preview_url && (
                    <img
                      src={msg.image_preview_url}
                      alt="Referensi komponen mekanik"
                      className="max-h-36 w-full rounded border border-[#2E3440] bg-[#121417] object-contain"
                    />
                  )}
                  <p>{msg.content}</p>
                </div>
              )}

              {msg.role === 'Assistant' && (
                <div className="w-full rounded-[10px] border border-[#2E3440] bg-[#1B1E23] p-3 text-[13px] leading-[1.45] text-[#F1F5F9]">
                  <p>{msg.content}</p>
                  {msg.lisp_payload && (
                    <div className="mt-2.5 rounded-md border border-[#2E3440] bg-[#121417] p-2">
                      <div className="flex items-center justify-between border-b border-[#2E3440] pb-1.5 text-[11px] text-[#94A3B8]">
                        <span className="font-mono">AutoLISP Executed</span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleCopy(msg.id, msg.lisp_payload || '')}
                            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9]"
                          >
                            <Copy className="h-3 w-3" />
                            <span>{copiedId === msg.id ? 'Copied' : 'Copy'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onRunLisp(msg.lisp_payload || '')}
                            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[#3B82F6] hover:bg-[#242830]"
                          >
                            <Play className="h-3 w-3" />
                            <span>Re-run</span>
                          </button>
                        </div>
                      </div>
                      <pre className="mt-1.5 max-h-36 overflow-auto font-mono text-[11.5px] leading-[1.4] text-[#06B6D4] whitespace-pre-wrap break-all">
                        {msg.lisp_payload}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {msg.role === 'SystemTool' && (
                <div
                  className={`w-full rounded-[10px] border p-3 text-xs leading-relaxed ${
                    msg.is_error
                      ? 'border-[#EF4444]/50 bg-[#EF4444]/10 text-[#F1F5F9]'
                      : 'border-[#10B981]/40 bg-[#1B1E23] text-[#F1F5F9]'
                  }`}
                >
                  <p className="font-medium">{msg.content}</p>

                  {msg.sldprt_output_path && (
                    <div className="mt-2 rounded border border-[#2E3440] bg-[#121417] px-2.5 py-1.5 font-mono text-[11.5px] text-[#10B981] break-all">
                      {msg.sldprt_output_path}
                    </div>
                  )}

                  {(msg.dxf_content || msg.solidworks_spec) && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {msg.dxf_content && (
                        <button
                          type="button"
                          onClick={() =>
                            downloadBlob(
                              `${msg.solidworks_spec?.part_name || 'cadcraft_part'}_sketch.dxf`,
                              msg.dxf_content || '',
                            )
                          }
                          className="flex items-center gap-1 rounded border border-[#2E3440] bg-[#242830] px-2 py-1 text-[11px] font-medium text-[#F1F5F9] hover:border-[#3B82F6]"
                        >
                          <Download className="h-3 w-3" />
                          <span>Download .dxf</span>
                        </button>
                      )}
                      {msg.solidworks_spec && (
                        <button
                          type="button"
                          onClick={() =>
                            downloadBlob(
                              `${msg.solidworks_spec?.part_name || 'cadcraft_part'}_spec.json`,
                              JSON.stringify(msg.solidworks_spec, null, 2),
                            )
                          }
                          className="flex items-center gap-1 rounded border border-[#2E3440] bg-[#242830] px-2 py-1 text-[11px] font-medium text-[#F1F5F9] hover:border-[#E11D48]"
                        >
                          <Download className="h-3 w-3" />
                          <span>Download Spec JSON</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          ))
        )}

        {isLoading && (
          <div className="flex items-center gap-2 rounded-[10px] border border-[#2E3440] bg-[#1B1E23] px-3 py-2.5 text-xs text-[#94A3B8]">
            <Loader2 className="h-4 w-4 animate-spin text-[#3B82F6]" />
            <span>Menyusun geometri CAD...</span>
          </div>
        )}

        {errorMessage && (
          <div
            role="alert"
            className="rounded-[10px] border border-[#EF4444]/60 bg-[#EF4444]/10 p-3 text-xs text-[#F1F5F9]"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#EF4444]" />
              <div className="flex-1">
                <p className="font-medium text-[#EF4444]">Eksekusi AI / CAD Gagal</p>
                <p className="mt-0.5 text-[#F1F5F9]">{errorMessage}</p>
                <button
                  type="button"
                  onClick={onRetryLast}
                  className="mt-2 inline-flex items-center gap-1 rounded border border-[#EF4444]/40 bg-[#1B1E23] px-2.5 py-1 text-[11px] font-medium text-[#F1F5F9] hover:bg-[#242830]"
                >
                  <RefreshCw className="h-3 w-3" />
                  <span>Retry</span>
                </button>
              </div>
            </div>
          </div>
        )}

        <div ref={scrollEndRef} />
      </div>

      {/* Prompt Composer Footer */}
      <div className="border-t border-[#2E3440] bg-[#1B1E23]/80 p-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          aria-label="Lampirkan gambar referensi 3D"
          onChange={handleFileChange}
          className="hidden"
        />

        {attachment && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-[#2E3440] bg-[#121417] px-2 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <img
                src={attachment.previewUrl}
                alt="Preview lampiran referensi"
                className="h-9 w-9 shrink-0 rounded border border-[#2E3440] object-cover"
              />
              <span className="truncate text-[11px] font-mono text-[#F1F5F9]">
                {attachment.name || 'reference-image.png'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setAttachment(null)}
              aria-label="Hapus gambar referensi"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#94A3B8] hover:bg-[#242830] hover:text-[#EF4444]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <label htmlFor="ai-prompt-composer" className="sr-only">
          CAD Design Prompt
        </label>
        <textarea
          ref={composerInputRef}
          id="ai-prompt-composer"
          rows={3}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            if (validationError) setValidationError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!isLoading) handleSubmit();
            }
          }}
          placeholder="Deskripsikan geometri CAD (mm) atau lampirkan gambar referensi..."
          className="w-full resize-none rounded-md border border-[#2E3440] bg-[#121417] px-3 py-2 text-[13px] text-[#F1F5F9] placeholder-[#94A3B8]/60 focus:border-[#3B82F6] focus:outline-none"
        />

        {validationError && (
          <p className="mt-1 text-[11px] text-[#EF4444]" role="alert">
            {validationError}
          </p>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            title="Lampirkan gambar referensi mekanik (PNG/JPG)"
            aria-label="Lampirkan gambar referensi"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#2E3440] bg-[#121417] text-[#94A3B8] transition-colors hover:border-[#3B82F6] hover:text-[#F1F5F9] disabled:opacity-40"
          >
            <ImagePlus className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={onExportSldprt}
            disabled={isLoading || (docSummary.entityCount === 0 && (docSummary.parts3dCount ?? 0) === 0)}
            className="flex h-9 items-center gap-1.5 rounded-md bg-[#E11D48] px-3 text-xs font-semibold text-[#F1F5F9] transition-colors hover:bg-[#BE123C] disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <Box className="h-3.5 w-3.5" />
            <span>{(docSummary.parts3dCount ?? 0) > 1 ? 'Export .sldasm' : 'Export .sldprt'}</span>
          </button>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={isLoading}
            className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-[#3B82F6] px-3.5 text-xs font-semibold text-[#F1F5F9] transition-colors hover:bg-[#2563EB] disabled:opacity-50 whitespace-nowrap"
          >
            <Send className="h-3.5 w-3.5" />
            <span>Generate</span>
          </button>
        </div>
      </div>
    </motion.aside>
  );
};
