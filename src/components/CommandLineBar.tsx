import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';

interface CommandLineBarProps {
  logs: string[];
  onExecuteCommand: (raw: string) => void;
}

export const CommandLineBar: React.FC<CommandLineBarProps> = ({ logs, onExecuteCommand }) => {
  const [cmd, setCmd] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = cmd.trim();
    if (!trimmed) return;
    onExecuteCommand(trimmed);
    setCmd('');
  };

  const latestLog = logs.length > 0 ? logs[logs.length - 1] : 'Ready. Contoh: RECTANG 0,0 120,80 | OVERKILL | JOIN | (command "_CIRCLE" \'(60 40) 15)';

  return (
    <div className="border-t border-[#2E3440] bg-[#1B1E23] px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-mono text-[#94A3B8]">
        <span className="truncate">{latestLog}</span>
      </div>
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <label htmlFor="cad-cmdline-input" className="flex items-center gap-1 font-mono text-xs font-medium text-[#3B82F6] shrink-0">
          <ChevronRight className="h-3.5 w-3.5" />
          <span>Command:</span>
        </label>
        <input
          id="cad-cmdline-input"
          type="text"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder='(command "_CIRCLE" (list 60 40) 15) atau OVERKILL / JOIN / UNDO'
          className="flex-1 rounded border border-[#2E3440] bg-[#121417] px-2.5 py-1 font-mono text-xs text-[#F1F5F9] placeholder-[#94A3B8]/50 focus:border-[#3B82F6] focus:outline-none"
        />
        <button
          type="submit"
          className="h-7 rounded border border-[#2E3440] bg-[#242830] px-2.5 text-xs font-medium text-[#F1F5F9] hover:border-[#3B82F6] whitespace-nowrap shrink-0"
        >
          Run
        </button>
      </form>
    </div>
  );
};
