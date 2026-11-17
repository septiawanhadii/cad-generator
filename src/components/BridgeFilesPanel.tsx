import React, { useEffect, useState } from 'react';
import { Check, Copy, Download, FileCode2 } from 'lucide-react';
import type { AiBridgeConfig, DocState, SolidWorksBuildSpec } from '../types/cadcraft';
import { buildSolidWorksSpecFromDoc, exportDocToDxf } from '../cad/dxfExporter';

interface BridgeFilesPanelProps {
  doc: DocState;
  config: AiBridgeConfig;
}

type BridgeTab = 'spec' | 'dxf' | 'sw_builder' | 'dxf_to_sldprt' | 'requirements';

function downloadTextFile(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const BridgeFilesPanel: React.FC<BridgeFilesPanelProps> = ({ doc, config }) => {
  const [activeTab, setActiveTab] = useState<BridgeTab>('spec');
  const [bridgeFiles, setBridgeFiles] = useState<{
    sw_builder: string;
    dxf_to_sldprt: string;
    requirements: string;
  }>({
    sw_builder: '',
    dxf_to_sldprt: '',
    requirements: 'pywin32>=306',
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/bridge/files')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setBridgeFiles(data);
      })
      .catch(() => {
        // Ignore network transient errors in file preview
      });
  }, []);

  const liveSpec: SolidWorksBuildSpec = buildSolidWorksSpecFromDoc(doc, config);
  const liveDxf = exportDocToDxf(doc);

  const getCurrentContent = (): { filename: string; content: string } => {
    switch (activeTab) {
      case 'spec':
        return {
          filename: `${liveSpec.part_name}_spec.json`,
          content: JSON.stringify(liveSpec, null, 2),
        };
      case 'dxf':
        return {
          filename: `${liveSpec.part_name}_sketch.dxf`,
          content: liveDxf,
        };
      case 'sw_builder':
        return {
          filename: 'sw_builder.py',
          content: bridgeFiles.sw_builder || '# Loading sw_builder.py...',
        };
      case 'dxf_to_sldprt':
        return {
          filename: 'dxf_to_sldprt.py',
          content: bridgeFiles.dxf_to_sldprt || '# Loading dxf_to_sldprt.py...',
        };
      case 'requirements':
        return {
          filename: 'requirements.txt',
          content: bridgeFiles.requirements || 'pywin32>=306',
        };
    }
  };

  const { filename, content } = getCurrentContent();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const tabs: { id: BridgeTab; label: string }[] = [
    { id: 'spec', label: 'SolidWorksBuildSpec JSON' },
    { id: 'dxf', label: 'Active DXF (R2000)' },
    { id: 'sw_builder', label: 'sw_builder.py' },
    { id: 'dxf_to_sldprt', label: 'dxf_to_sldprt.py' },
    { id: 'requirements', label: 'requirements.txt' },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-[#121417] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2E3440] pb-3">
        <div>
          <h2 className="text-[15px] font-semibold text-[#F1F5F9]">
            SolidWorks COM Bridge &amp; Export Artifacts
          </h2>
          <p className="mt-0.5 text-xs text-[#94A3B8]">
            Skrip Python pywin32 (mm / 1000.0 guard) dan payload DXF / JSON aktual dari kanvas CADCraft.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="flex h-8 items-center gap-1.5 rounded-md border border-[#2E3440] px-3 text-xs font-medium text-[#94A3B8] transition-colors hover:bg-[#242830] hover:text-[#F1F5F9] whitespace-nowrap"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-[#10B981]" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button
            type="button"
            onClick={() => downloadTextFile(filename, content)}
            className="flex h-8 items-center gap-1.5 rounded-md bg-[#3B82F6] px-3 text-xs font-medium text-[#F1F5F9] transition-colors hover:bg-[#2563EB] whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Download {filename}</span>
          </button>
        </div>
      </div>

      {/* Tab selector */}
      <div className="mt-3 flex flex-wrap items-center gap-1 border-b border-[#2E3440] pb-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              activeTab === tab.id
                ? 'bg-[#242830] text-[#F1F5F9] border border-[#2E3440]'
                : 'text-[#94A3B8] hover:bg-[#1B1E23] hover:text-[#F1F5F9]'
            }`}
          >
            <FileCode2 className="h-3.5 w-3.5" />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Code viewer */}
      <div className="mt-3 flex-1 overflow-auto rounded-lg border border-[#2E3440] bg-[#1B1E23] p-4">
        <pre className="font-mono text-xs leading-relaxed text-[#F1F5F9] whitespace-pre-wrap break-all">
          {content}
        </pre>
      </div>
    </div>
  );
};
