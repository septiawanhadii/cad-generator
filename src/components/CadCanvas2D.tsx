import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { CadEntity, DocState, DocSummary } from '../types/cadcraft';
import { AI_THEME_TOKENS } from '../types/cadcraft';

interface CadCanvas2DProps {
  doc: DocState;
  summary: DocSummary;
  onUndo: () => void;
  onRedo: () => void;
  onCleanupSketch: () => void;
  onClearCanvas: () => void;
}

export const CadCanvas2D: React.FC<CadCanvas2DProps> = ({
  doc,
  summary,
  onUndo,
  onRedo,
  onCleanupSketch,
  onClearCanvas,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [zoom, setZoom] = useState(3.2); // px per mm
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cursorMm, setCursorMm] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const lastPointerRef = useRef({ x: 0, y: 0 });

  const fitToExtents = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    if (!summary.extents) {
      setZoom(3.2);
      setPan({ x: rect.width * 0.32, y: rect.height * 0.68 });
      return;
    }

    const { minX, minY, maxX, maxY } = summary.extents;
    const w = Math.max(maxX - minX, 20);
    const h = Math.max(maxY - minY, 20);
    const padFactor = 0.65;
    const nextZoom = Math.min(
      Math.max(Math.min((rect.width * padFactor) / w, (rect.height * padFactor) / h), 0.35),
      18,
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setZoom(nextZoom);
    setPan({
      x: rect.width / 2 - cx * nextZoom,
      y: rect.height / 2 + cy * nextZoom,
    });
  }, [summary.extents]);

  // Initial fit and auto-fit when entity count changes from 0 -> N
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (prevCountRef.current === 0 && doc.entities.length > 0) {
      fitToExtents();
    } else if (prevCountRef.current === 0 && pan.x === 0 && pan.y === 0) {
      fitToExtents();
    }
    prevCountRef.current = doc.entities.length;
  }, [doc.entities.length, fitToExtents, pan.x, pan.y]);

  useEffect(() => {
    const handleResize = () => fitToExtents();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [fitToExtents]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width <= 0 || height <= 0) return;

    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = AI_THEME_TOKENS.cc_bg;
    ctx.fillRect(0, 0, width, height);

    const worldToScreenX = (wx: number) => pan.x + wx * zoom;
    const worldToScreenY = (wy: number) => pan.y - wy * zoom;

    // Adaptive grid step in mm
    let minorStep = 10;
    if (zoom < 1.0) minorStep = 50;
    else if (zoom < 2.2) minorStep = 20;
    else if (zoom > 8) minorStep = 5;
    const majorStep = minorStep * 5;

    const minWorldX = Math.floor(-pan.x / zoom / minorStep) * minorStep;
    const maxWorldX = Math.ceil((width - pan.x) / zoom / minorStep) * minorStep;
    const minWorldY = Math.floor((pan.y - height) / zoom / minorStep) * minorStep;
    const maxWorldY = Math.ceil(pan.y / zoom / minorStep) * minorStep;

    // Minor grid
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#1B1E23';
    ctx.beginPath();
    for (let x = minWorldX; x <= maxWorldX; x += minorStep) {
      const sx = Math.round(worldToScreenX(x)) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
    }
    for (let y = minWorldY; y <= maxWorldY; y += minorStep) {
      const sy = Math.round(worldToScreenY(y)) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(width, sy);
    }
    ctx.stroke();

    // Major grid
    ctx.strokeStyle = '#242830';
    ctx.beginPath();
    for (let x = Math.floor(minWorldX / majorStep) * majorStep; x <= maxWorldX; x += majorStep) {
      const sx = Math.round(worldToScreenX(x)) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
    }
    for (let y = Math.floor(minWorldY / majorStep) * majorStep; y <= maxWorldY; y += majorStep) {
      const sy = Math.round(worldToScreenY(y)) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(width, sy);
    }
    ctx.stroke();

    // Origin Axes (X, Y)
    const ox = worldToScreenX(0);
    const oy = worldToScreenY(0);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.45)';
    ctx.beginPath();
    ctx.moveTo(0, oy);
    ctx.lineTo(width, oy);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(16, 185, 129, 0.45)';
    ctx.beginPath();
    ctx.moveTo(ox, 0);
    ctx.lineTo(ox, height);
    ctx.stroke();

    // Origin badge marker
    ctx.fillStyle = AI_THEME_TOKENS.cc_text_muted;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillText('0,0', ox + 6, oy - 6);

    const layerMap = new Map(doc.layers.map((l) => [l.name, l]));

    // Draw CAD entities
    for (const ent of doc.entities) {
      const layer = layerMap.get(ent.layer);
      if (layer && !layer.visible) continue;

      ctx.strokeStyle = layer?.color || AI_THEME_TOKENS.cc_text;
      ctx.lineWidth = 1.75;
      drawEntity(ctx, ent, worldToScreenX, worldToScreenY, zoom);
    }

    // Dimension extents overlay
    if (summary.extents) {
      const { minX, minY, maxX, maxY, width: extW, height: extH } = summary.extents;
      const sx1 = worldToScreenX(minX);
      const sx2 = worldToScreenX(maxX);
      const syTop = worldToScreenY(maxY);
      const syBot = worldToScreenY(minY);

      ctx.save();
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.45)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;

      // Width dimension above part
      const dimY = syTop - 22;
      ctx.beginPath();
      ctx.moveTo(sx1, syTop - 4);
      ctx.lineTo(sx1, dimY - 4);
      ctx.moveTo(sx2, syTop - 4);
      ctx.lineTo(sx2, dimY - 4);
      ctx.moveTo(sx1, dimY);
      ctx.lineTo(sx2, dimY);
      ctx.stroke();

      // Height dimension right of part
      const dimX = sx2 + 22;
      ctx.beginPath();
      ctx.moveTo(sx2 + 4, syTop);
      ctx.lineTo(dimX + 4, syTop);
      ctx.moveTo(sx2 + 4, syBot);
      ctx.lineTo(dimX + 4, syBot);
      ctx.moveTo(dimX, syTop);
      ctx.lineTo(dimX, syBot);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = AI_THEME_TOKENS.cc_accent;
      ctx.font = '500 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${extW.toFixed(1)} mm`, (sx1 + sx2) / 2, dimY - 6);

      ctx.save();
      ctx.translate(dimX + 14, (syTop + syBot) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`${extH.toFixed(1)} mm`, 0, 0);
      ctx.restore();
      ctx.restore();
    }

    ctx.restore();
  }, [doc.entities, doc.layers, pan, zoom, summary.extents]);

  useEffect(() => {
    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [draw]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = true;
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wx = (sx - pan.x) / zoom;
    const wy = (pan.y - sy) / zoom;
    setCursorMm({ x: wx, y: wy });

    if (isDraggingRef.current) {
      const dx = e.clientX - lastPointerRef.current.x;
      const dy = e.clientY - lastPointerRef.current.y;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const nextZoom = Math.min(Math.max(zoom * factor, 0.25), 25);
    const wx = (sx - pan.x) / zoom;
    const wy = (pan.y - sy) / zoom;
    setZoom(nextZoom);
    setPan({
      x: sx - wx * nextZoom,
      y: sy + wy * nextZoom,
    });
  };

  return (
    <div ref={containerRef} className="relative flex-1 overflow-hidden bg-[#121417] select-none">
      <canvas
        ref={canvasRef}
        data-testid="cad-canvas-2d"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        className="block h-full w-full cursor-crosshair"
      />

      {/* Top Canvas Action & Zoom Toolbars (responsive flex-wrap prevents overlap on narrow viewports) */}
      <div className="pointer-events-none absolute top-3 right-3 left-3 flex flex-wrap items-center justify-between gap-2">
        <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-[#2E3440] bg-[#1B1E23]/95 p-1">
          <button
            type="button"
            onClick={onUndo}
            disabled={doc.undoStack.length === 0}
            title="Undo AI / Command Batch (Ctrl+Z)"
            aria-label="Undo last action"
            className="flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium text-[#F1F5F9] transition-colors hover:bg-[#242830] disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap shrink-0"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Undo</span>
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={doc.redoStack.length === 0}
            title="Redo (Ctrl+Y)"
            aria-label="Redo last action"
            className="flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium text-[#F1F5F9] transition-colors hover:bg-[#242830] disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap shrink-0"
          >
            <RotateCw className="h-3.5 w-3.5" />
            <span>Redo</span>
          </button>
          <div className="mx-0.5 h-4 w-px bg-[#2E3440]" aria-hidden="true" />
          <button
            type="button"
            onClick={onCleanupSketch}
            disabled={doc.entities.length === 0}
            title="Jalankan OVERKILL + JOIN pada kanvas"
            aria-label="Clean Sketch with OVERKILL and JOIN"
            className="flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium text-[#06B6D4] transition-colors hover:bg-[#242830] disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap shrink-0"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span className="max-sm:hidden">OVERKILL + JOIN</span>
            <span className="sm:hidden">Clean</span>
          </button>
          <button
            type="button"
            onClick={onClearCanvas}
            disabled={doc.entities.length === 0}
            title="Hapus semua entitas di kanvas"
            aria-label="Clear canvas"
            className="flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium text-[#94A3B8] transition-colors hover:bg-[#242830] hover:text-[#EF4444] disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap shrink-0"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="max-sm:hidden">Clear</span>
          </button>
        </div>

        <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-[#2E3440] bg-[#1B1E23]/95 p-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(z * 0.8, 0.25))}
            aria-label="Zoom out"
            className="flex h-8 w-8 items-center justify-center rounded text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9]"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[48px] text-center font-mono text-xs text-[#94A3B8] tabular-nums">
            {Math.round((zoom / 3.2) * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(z * 1.25, 25))}
            aria-label="Zoom in"
            className="flex h-8 w-8 items-center justify-center rounded text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9]"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <div className="mx-0.5 h-4 w-px bg-[#2E3440]" aria-hidden="true" />
          <button
            type="button"
            onClick={fitToExtents}
            aria-label="Zoom extents fit view"
            title="Fit View to Geometry"
            className="flex h-8 items-center gap-1 rounded px-2 text-xs font-medium text-[#F1F5F9] hover:bg-[#242830] whitespace-nowrap shrink-0"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span>Fit</span>
          </button>
        </div>
      </div>

      {/* Empty Canvas Guide Overlay */}
      {doc.entities.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4">
          <div className="rounded-lg border border-[#2E3440] bg-[#1B1E23]/90 px-5 py-4 text-center max-w-md">
            <p className="text-sm font-medium text-[#F1F5F9]">Kanvas 2D CADCraft Siap</p>
            <p className="mt-1 text-xs text-[#94A3B8]">
              Pilih Quick Prompt di panel AI Design Assistant sebelah kanan atau ketik perintah AutoLISP di Command Bar bawah.
            </p>
          </div>
        </div>
      )}

      {/* Bottom Coordinate & Document Telemetry Readout (clean unboxed text) */}
      <div className="pointer-events-none absolute bottom-2.5 left-3 right-3 flex items-center justify-between gap-2 text-xs text-[#94A3B8]">
        <div className="hidden sm:flex items-center gap-3 font-mono tabular-nums bg-[#121417]/85 px-2.5 py-1 rounded border border-[#2E3440] whitespace-nowrap">
          <span>X: {cursorMm.x.toFixed(1)} mm</span>
          <span aria-hidden="true">·</span>
          <span>Y: {cursorMm.y.toFixed(1)} mm</span>
        </div>
        <div className="flex items-center gap-2.5 font-mono tabular-nums bg-[#121417]/85 px-2.5 py-1 rounded border border-[#2E3440] whitespace-nowrap ml-auto">
          <span>Layer: {summary.activeLayer}</span>
          <span aria-hidden="true">·</span>
          <span>{summary.entityCount} Entities</span>
          <span aria-hidden="true">·</span>
          <span>Unit: mm</span>
        </div>
      </div>
    </div>
  );
};

function drawEntity(
  ctx: CanvasRenderingContext2D,
  ent: CadEntity,
  sx: (x: number) => number,
  sy: (y: number) => number,
  zoom: number,
) {
  switch (ent.kind) {
    case 'rectangle': {
      const x1 = sx(ent.x1);
      const y1 = sy(ent.y1);
      const x2 = sx(ent.x2);
      const y2 = sy(ent.y2);
      ctx.fillStyle = 'rgba(59, 130, 246, 0.05)';
      ctx.beginPath();
      ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'circle': {
      const cx = sx(ent.cx);
      const cy = sy(ent.cy);
      const r = ent.radius * zoom;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      // Subtle center mark crosshair
      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
      ctx.lineWidth = 1;
      const mark = Math.min(6, Math.max(3, r * 0.3));
      ctx.beginPath();
      ctx.moveTo(cx - mark, cy);
      ctx.lineTo(cx + mark, cy);
      ctx.moveTo(cx, cy - mark);
      ctx.lineTo(cx, cy + mark);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'line': {
      ctx.beginPath();
      ctx.moveTo(sx(ent.x1), sy(ent.y1));
      ctx.lineTo(sx(ent.x2), sy(ent.y2));
      ctx.stroke();
      break;
    }
    case 'polyline': {
      if (ent.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(sx(ent.points[0].x), sy(ent.points[0].y));
      for (let i = 1; i < ent.points.length; i++) {
        ctx.lineTo(sx(ent.points[i].x), sy(ent.points[i].y));
      }
      if (ent.closed) ctx.closePath();
      ctx.stroke();
      break;
    }
    case 'arc': {
      const cx = sx(ent.cx);
      const cy = sy(ent.cy);
      const r = ent.radius * zoom;
      const start = (-ent.endAngleDeg * Math.PI) / 180;
      const end = (-ent.startAngleDeg * Math.PI) / 180;
      ctx.beginPath();
      ctx.arc(cx, cy, r, start, end);
      ctx.stroke();
      break;
    }
  }
}
