import React, { useState } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, Loader2, WifiOff, X } from 'lucide-react';
import type { AiBridgeConfig, SwPingResult } from '../types/cadcraft';

interface AiSettingsModalProps {
  config: AiBridgeConfig;
  onSave: (next: AiBridgeConfig) => void;
  onClose: () => void;
  onTestSolidWorksCom: (pythonBin: string) => Promise<SwPingResult>;
}

export const AiSettingsModal: React.FC<AiSettingsModalProps> = ({
  config,
  onSave,
  onClose,
  onTestSolidWorksCom,
}) => {
  const [draft, setDraft] = useState<AiBridgeConfig>(config);
  const [extrudeInput, setExtrudeInput] = useState(String(config.default_extrude_mm));
  const [formError, setFormError] = useState<string | null>(null);
  const [testingCom, setTestingCom] = useState(false);
  const [pingResult, setPingResult] = useState<SwPingResult | null>(null);
  const [lmModels, setLmModels] = useState<string[]>([]);
  const [testingLm, setTestingLm] = useState(false);
  const [lmStatusMsg, setLmStatusMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const depth = Number(extrudeInput);
    if (!Number.isFinite(depth) || depth <= 0.01 || depth > 10000) {
      setFormError('Ketebalan extrude default harus angka positif antara 0.02 mm dan 10000.0 mm.');
      return;
    }
    if (!draft.python_bin.trim()) {
      setFormError('Path executable Python tidak boleh kosong.');
      return;
    }
    if (draft.provider === 'lmstudio' && !draft.lmstudio_url.trim()) {
      setFormError('URL server LM Studio wajib diisi (default: http://localhost:1234).');
      return;
    }
    if (draft.provider === 'ollama' && !draft.ollama_url.trim()) {
      setFormError('URL endpoint Ollama Local wajib diisi.');
      return;
    }
    setFormError(null);
    onSave({
      ...draft,
      default_extrude_mm: depth,
    });
  };

  const handlePing = async () => {
    setTestingCom(true);
    try {
      const res = await onTestSolidWorksCom(draft.python_bin);
      setPingResult(res);
    } finally {
      setTestingCom(false);
    }
  };

  const handleTestLmStudio = async () => {
    setTestingLm(true);
    setLmStatusMsg(null);
    try {
      const res = await fetch('/api/ai/lmstudio/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lmstudio_url: draft.lmstudio_url }),
      });
      const data = (await res.json()) as { ok: boolean; models?: string[]; error?: string };
      if (!res.ok || !data.ok) {
        setLmModels([]);
        setLmStatusMsg({ ok: false, text: data.error || 'LM Studio tidak merespons.' });
        return;
      }
      const list = data.models || [];
      setLmModels(list);
      if (list.length > 0) {
        setDraft((prev) => ({ ...prev, model: list[0] }));
        setLmStatusMsg({ ok: true, text: `Terhubung! ${list.length} model aktif terdeteksi.` });
      } else {
        setLmStatusMsg({
          ok: true,
          text: 'Server LM Studio aktif, tetapi belum ada model yang di-load di LM Studio.',
        });
      }
    } catch {
      setLmStatusMsg({ ok: false, text: 'Gagal memeriksa endpoint LM Studio.' });
    } finally {
      setTestingLm(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-settings-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#121417]/80 p-4"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.12 }}
        className="w-full max-w-[440px] max-h-[92vh] overflow-y-auto rounded-[10px] border border-[#2E3440] bg-[#1B1E23] shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[#2E3440] px-4 py-3">
          <h2 id="ai-settings-title" className="text-[15px] font-semibold text-[#F1F5F9]">
            AI &amp; SolidWorks Configuration
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Settings Modal"
            className="flex h-8 w-8 items-center justify-center rounded text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-4 p-4">
          {/* LLM Provider Config */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-[#94A3B8]">LLM Provider Configuration</h3>

            <div>
              <label htmlFor="cfg-provider" className="block text-xs font-medium text-[#F1F5F9]">
                AI Provider
              </label>
              <select
                id="cfg-provider"
                value={draft.provider}
                onChange={(e) => {
                  const val = e.target.value;
                  const p = val === 'lmstudio' ? 'lmstudio' : val === 'ollama' ? 'ollama' : 'gemini';
                  setFormError(null);
                  setLmStatusMsg(null);
                  setDraft({
                    ...draft,
                    provider: p,
                    model:
                      p === 'gemini'
                        ? 'gemini-4-hydrogen'
                        : p === 'lmstudio'
                          ? 'qwen2.5-coder-7b-instruct'
                          : 'qwen2.5-coder:7b',
                  });
                }}
                className="mt-1 w-full rounded-md border border-[#2E3440] bg-[#121417] px-3 py-2 text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
              >
                <option value="gemini">Google Gemini API (Server-Side Managed)</option>
                <option value="lmstudio">LM Studio (Local Server - port 1234)</option>
                <option value="ollama">Ollama Local (Offline Workstation)</option>
              </select>
            </div>

            {draft.provider === 'gemini' ? (
              <div>
                <label htmlFor="cfg-model" className="block text-xs font-medium text-[#F1F5F9]">
                  Model Gemini
                </label>
                <select
                  id="cfg-model"
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  className="mt-1 w-full rounded-md border border-[#2E3440] bg-[#121417] px-3 py-2 font-mono text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
                >
                  <option value="gemini-4-hydrogen">gemini-4-hydrogen (Recommended)</option>
                  <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (Fast)</option>
                </select>
              </div>
            ) : draft.provider === 'lmstudio' ? (
              <div className="space-y-2.5">
                <div>
                  <label htmlFor="cfg-lmstudio-url" className="block text-xs font-medium text-[#F1F5F9]">
                    LM Studio Server URL
                  </label>
                  <input
                    id="cfg-lmstudio-url"
                    type="text"
                    value={draft.lmstudio_url}
                    onChange={(e) => {
                      setDraft({ ...draft, lmstudio_url: e.target.value });
                      if (formError) setFormError(null);
                    }}
                    placeholder="http://localhost:1234"
                    className="mt-1 w-full rounded-md border border-[#2E3440] bg-[#121417] px-3 py-2 font-mono text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label htmlFor="cfg-lmstudio-model" className="block text-xs font-medium text-[#F1F5F9]">
                      LM Studio Model ID
                    </label>
                    <button
                      type="button"
                      onClick={handleTestLmStudio}
                      disabled={testingLm}
                      className="text-[11px] font-medium text-[#3B82F6] hover:underline disabled:opacity-50"
                    >
                      {testingLm ? 'Checking...' : 'Detect Loaded Models'}
                    </button>
                  </div>
                  {lmModels.length > 0 ? (
                    <select
                      id="cfg-lmstudio-model"
                      value={draft.model}
                      onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                      className="mt-1 w-full rounded-md border border-[#2E3440] bg-[#121417] px-3 py-2 font-mono text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
                    >
                      {lmModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="cfg-lmstudio-model"
                      type="text"
                      value={draft.model}
                      onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                      placeholder="local-model atau nama model di LM Studio"
                      className="mt-1 w-full rounded-md border border-[#2E3440] bg-[#121417] px-3 py-2 font-mono text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
                    />
                  )}
                  {lmStatusMsg && (
                    <p className={`mt-1 text-[11px] ${lmStatusMsg.ok ? 'text-[#10B981]' : 'text-[#F59E0B]'}`}>
                      {lmStatusMsg.text}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div>
                  <label htmlFor="cfg-ollama-url" className="block text-xs font-medium text-[#F1F5F9]">
                    Ollama Endpoint URL
                  </label>
                  <input
                    id="cfg-ollama-url"
                    type="text"
                    value={draft.ollama_url}
                    onChange={(e) => {
                      setDraft({ ...draft, ollama_url: e.target.value });
                      if (formError) setFormError(null);
                    }}
                    className="mt-1 w-full rounded-md border border-[#2E3440] bg-[#121417] px-3 py-2 font-mono text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="cfg-ollama-model" className="block text-xs font-medium text-[#F1F5F9]">
                    Ollama Model Tag
                  </label>
                  <input
                    id="cfg-ollama-model"
                    type="text"
                    value={draft.model}
                    onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                    className="mt-1 w-full rounded-md border border-[#2E3440] bg-[#121417] px-3 py-2 font-mono text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="h-px bg-[#2E3440]" />

          {/* SolidWorks Bridge Config */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-[#94A3B8]">SolidWorks COM Bridge</h3>

            <div>
              <label htmlFor="cfg-python-bin" className="block text-xs font-medium text-[#F1F5F9]">
                Python Bridge Executable Path
              </label>
              <input
                id="cfg-python-bin"
                type="text"
                value={draft.python_bin}
                onChange={(e) => {
                  setDraft({ ...draft, python_bin: e.target.value });
                  if (formError) setFormError(null);
                }}
                className="mt-1 w-full rounded-md border border-[#2E3440] bg-[#121417] px-3 py-2 font-mono text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="cfg-extrude" className="block text-xs font-medium text-[#F1F5F9]">
                  Default Extrude (mm)
                </label>
                <input
                  id="cfg-extrude"
                  type="number"
                  step="0.5"
                  value={extrudeInput}
                  onChange={(e) => {
                    setExtrudeInput(e.target.value);
                    if (formError) setFormError(null);
                  }}
                  className="mt-1 w-full rounded-md border border-[#2E3440] bg-[#121417] px-3 py-2 font-mono text-xs text-[#F1F5F9] tabular-nums focus:border-[#3B82F6] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="cfg-export-dir" className="block text-xs font-medium text-[#F1F5F9]">
                  Export Directory
                </label>
                <input
                  id="cfg-export-dir"
                  type="text"
                  value={draft.export_dir}
                  onChange={(e) => setDraft({ ...draft, export_dir: e.target.value })}
                  className="mt-1 w-full rounded-md border border-[#2E3440] bg-[#121417] px-3 py-2 font-mono text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
                />
              </div>
            </div>

            <label className="flex items-center gap-2.5 text-xs text-[#F1F5F9] cursor-pointer">
              <input
                type="checkbox"
                checked={draft.show_solidworks_window}
                onChange={(e) => setDraft({ ...draft, show_solidworks_window: e.target.checked })}
                className="h-4 w-4 rounded border-[#2E3440] bg-[#121417] accent-[#3B82F6]"
              />
              <span>Tampilkan jendela SolidWorks saat membangun .sldprt</span>
            </label>

            {/* Test COM Button & Result */}
            <div>
              <button
                type="button"
                onClick={handlePing}
                disabled={testingCom}
                className="flex h-8 items-center gap-2 rounded-md border border-[#2E3440] bg-[#242830] px-3 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] disabled:opacity-50"
              >
                {testingCom && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>Test SolidWorks COM</span>
              </button>

              {pingResult && (
                <div
                  className={`mt-2 rounded-md border p-2.5 text-xs ${
                    pingResult.status === 'ready'
                      ? 'border-[#10B981]/40 bg-[#10B981]/10 text-[#F1F5F9]'
                      : 'border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[#F1F5F9]'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    {pingResult.status === 'ready' ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-[#10B981]" />
                    ) : (
                      <WifiOff className="h-3.5 w-3.5 text-[#F59E0B]" />
                    )}
                    <span>{pingResult.status === 'ready' ? 'SolidWorks COM Ready' : 'COM Bridge Offline'}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[#94A3B8]">{pingResult.message}</p>
                </div>
              )}
            </div>
          </div>

          {formError && (
            <p className="text-xs text-[#EF4444]" role="alert">
              {formError}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-[#2E3440] pt-3">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-md border border-[#2E3440] px-4 text-xs font-medium text-[#94A3B8] transition-colors hover:bg-[#242830] hover:text-[#F1F5F9]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="h-9 rounded-md bg-[#3B82F6] px-4 text-xs font-semibold text-[#F1F5F9] transition-colors hover:bg-[#2563EB]"
            >
              Save Configuration
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
};
