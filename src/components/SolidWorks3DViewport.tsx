import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Box, RotateCcw } from 'lucide-react';
import type { DocState, DocSummary } from '../types/cadcraft';
import { AI_THEME_TOKENS } from '../types/cadcraft';
import { mmToMeters } from '../cad/dxfExporter';

interface SolidWorks3DViewportProps {
  doc: DocState;
  summary: DocSummary;
  extrudeDepthMm: number;
  onChangeExtrudeDepth: (mm: number) => void;
  onExportSldprt: () => void;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const SolidWorks3DViewport: React.FC<SolidWorks3DViewportProps> = ({
  doc,
  summary,
  extrudeDepthMm,
  onChangeExtrudeDepth,
  onExportSldprt,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [yaw, setYaw] = useState(-0.62);
  const [pitch, setPitch] = useState(0.48);
  const [zoomScale, setZoomScale] = useState(1.0);
  const draggingRef = useRef(false);
  const lastRef = useRef({ x: 0, y: 0 });

  const project = useCallback(
    (p: Vec3, cx: number, cy: number, scale: number, width: number, height: number) => {
      // Translate relative to part center
      const dx = p.x - cx;
      const dy = p.y - cy;
      const dz = p.z - extrudeDepthMm / 2;

      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const x1 = dx * cosY - dy * sinY;
      const y1 = dx * sinY + dy * cosY;

      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      const y2 = y1 * cosP - dz * sinP;
      const z2 = y1 * sinP + dz * cosP;

      return {
        sx: width / 2 + x1 * scale,
        sy: height / 2 - z2 * scale,
        depth: y2,
      };
    },
    [yaw, pitch, extrudeDepthMm],
  );

  const draw3D = useCallback(() => {
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
    ctx.fillStyle = AI_THEME_TOKENS.cc_bg;
    ctx.fillRect(0, 0, width, height);

    if (doc.entities.length === 0 || !summary.extents) {
      ctx.restore();
      return;
    }

    const { minX, minY, maxX, maxY } = summary.extents;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const maxSpan = Math.max(maxX - minX, maxY - minY, extrudeDepthMm, 30);
    const scale = (Math.min(width, height) * 0.48 * zoomScale) / maxSpan;

    // Collect 3D faces for painter's algorithm sorting
    interface Face3D {
      pts: { sx: number; sy: number; depth: number }[];
      avgDepth: number;
      fill: string;
      stroke: string;
      lineWidth?: number;
    }

    const faces: Face3D[] = [];

    const addExtrudedPrism = (loop: { x: number; y: number }[], fillTop: string, fillSide: string, stroke: string) => {
      if (loop.length < 3) return;
      const botPts = loop.map((p) => project({ x: p.x, y: p.y, z: 0 }, centerX, centerY, scale, width, height));
      const topPts = loop.map((p) => project({ x: p.x, y: p.y, z: extrudeDepthMm }, centerX, centerY, scale, width, height));

      // Bottom face
      faces.push({
        pts: botPts,
        avgDepth: botPts.reduce((a, b) => a + b.depth, 0) / botPts.length,
        fill: '#171A20',
        stroke,
        lineWidth: 1,
      });

      // Side walls
      for (let i = 0; i < loop.length; i++) {
        const next = (i + 1) % loop.length;
        const quad = [botPts[i], botPts[next], topPts[next], topPts[i]];
        faces.push({
          pts: quad,
          avgDepth: quad.reduce((a, b) => a + b.depth, 0) / 4,
          fill: fillSide,
          stroke,
          lineWidth: 1.2,
        });
      }

      // Top face
      faces.push({
        pts: topPts,
        avgDepth: topPts.reduce((a, b) => a + b.depth, 0) / topPts.length,
        fill: fillTop,
        stroke,
        lineWidth: 1.5,
      });
    };

    for (const ent of doc.entities) {
      if (ent.kind === 'rectangle') {
        const loop = [
          { x: ent.x1, y: ent.y1 },
          { x: ent.x2, y: ent.y1 },
          { x: ent.x2, y: ent.y2 },
          { x: ent.x1, y: ent.y2 },
        ];
        addExtrudedPrism(loop, 'rgba(59, 130, 246, 0.24)', 'rgba(37, 99, 235, 0.16)', '#60A5FA');
      } else if (ent.kind === 'polyline' && ent.points.length >= 3) {
        addExtrudedPrism(ent.points, 'rgba(59, 130, 246, 0.24)', 'rgba(37, 99, 235, 0.16)', '#60A5FA');
      } else if (ent.kind === 'circle') {
        const segs = 24;
        const loop: { x: number; y: number }[] = [];
        for (let i = 0; i < segs; i++) {
          const ang = (i / segs) * Math.PI * 2;
          loop.push({
            x: ent.cx + Math.cos(ang) * ent.radius,
            y: ent.cy + Math.sin(ang) * ent.radius,
          });
        }
        addExtrudedPrism(loop, 'rgba(18, 20, 23, 0.85)', 'rgba(225, 29, 72, 0.25)', '#E11D48');
      } else if (ent.kind === 'line') {
        const p1 = project({ x: ent.x1, y: ent.y1, z: extrudeDepthMm }, centerX, centerY, scale, width, height);
        const p2 = project({ x: ent.x2, y: ent.y2, z: extrudeDepthMm }, centerX, centerY, scale, width, height);
        faces.push({
          pts: [p1, p2],
          avgDepth: (p1.depth + p2.depth) / 2,
          fill: 'transparent',
          stroke: '#94A3B8',
          lineWidth: 1.5,
        });
      }
    }

    // Painter's sort back-to-front (largest depth first, assuming camera looks toward -Y)
    faces.sort((a, b) => b.avgDepth - a.avgDepth);

    for (const f of faces) {
      ctx.beginPath();
      ctx.moveTo(f.pts[0].sx, f.pts[0].sy);
      for (let i = 1; i < f.pts.length; i++) {
        ctx.lineTo(f.pts[i].sx, f.pts[i].sy);
      }
      if (f.pts.length >= 3) {
        ctx.closePath();
        ctx.fillStyle = f.fill;
        ctx.fill();
      }
      ctx.strokeStyle = f.stroke;
      ctx.lineWidth = f.lineWidth ?? 1.25;
      ctx.stroke();
    }

    ctx.restore();
  }, [doc.entities, summary.extents, extrudeDepthMm, project, zoomScale]);

  useEffect(() => {
    const id = requestAnimationFrame(draw3D);
    return () => cancelAnimationFrame(id);
  }, [draw3D]);

  return (
    <div ref={containerRef} className="relative flex-1 overflow-hidden bg-[#121417] select-none">
      <canvas
        data-testid="cad-canvas-3d"
        ref={canvasRef}
        onPointerDown={(e) => {
          draggingRef.current = true;
          lastRef.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          const dx = e.clientX - lastRef.current.x;
          const dy = e.clientY - lastRef.current.y;
          lastRef.current = { x: e.clientX, y: e.clientY };
          setYaw((y) => y + dx * 0.01);
          setPitch((p) => Math.max(-1.4, Math.min(1.4, p + dy * 0.01)));
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        onWheel={(e) => {
          e.preventDefault();
          setZoomScale((z) => Math.max(0.4, Math.min(3.5, z * (e.deltaY < 0 ? 1.1 : 0.9))));
        }}
        className="block h-full w-full cursor-grab active:cursor-grabbing"
      />

      {/* Top-Left Camera Views & Extrude Depth Control */}
      <div className="absolute top-3 left-3 flex flex-wrap items-center gap-2 rounded-md border border-[#2E3440] bg-[#1B1E23]/95 p-1.5">
        <button
          type="button"
          onClick={() => {
            setYaw(-0.62);
            setPitch(0.48);
            setZoomScale(1.0);
          }}
          className="h-7 rounded px-2.5 text-xs font-medium text-[#F1F5F9] hover:bg-[#242830] whitespace-nowrap"
        >
          Isometric
        </button>
        <button
          type="button"
          onClick={() => {
            setYaw(0);
            setPitch(1.4);
          }}
          className="h-7 rounded px-2.5 text-xs font-medium text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9] whitespace-nowrap"
        >
          Top
        </button>
        <button
          type="button"
          onClick={() => {
            setYaw(0);
            setPitch(0.05);
          }}
          className="h-7 rounded px-2.5 text-xs font-medium text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9] whitespace-nowrap"
        >
          Front
        </button>
        <div className="h-4 w-px bg-[#2E3440]" aria-hidden="true" />
        <label className="flex items-center gap-2 px-1.5 text-xs text-[#94A3B8]">
          <span>Extrude Depth:</span>
          <input
            type="number"
            min={0.5}
            max={500}
            step={0.5}
            value={extrudeDepthMm}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) onChangeExtrudeDepth(v);
            }}
            className="w-16 rounded border border-[#2E3440] bg-[#121417] px-2 py-1 font-mono text-xs text-[#F1F5F9] tabular-nums focus:border-[#3B82F6] focus:outline-none"
          />
          <span className="font-mono text-[#94A3B8]">mm</span>
        </label>
      </div>

      {/* Top-Right Direct .sldprt CTA */}
      <div className="absolute top-3 right-3">
        <button
          type="button"
          onClick={onExportSldprt}
          disabled={doc.entities.length === 0}
          className="flex h-9 items-center gap-2 rounded-md bg-[#E11D48] px-3.5 text-xs font-semibold text-[#F1F5F9] transition-colors hover:bg-[#BE123C] disabled:opacity-40 whitespace-nowrap"
        >
          <Box className="h-3.5 w-3.5" />
          <span>Export .sldprt ({extrudeDepthMm.toFixed(1)} mm)</span>
        </button>
      </div>

      {doc.entities.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-lg border border-[#2E3440] bg-[#1B1E23]/90 px-5 py-4 text-center max-w-md">
            <p className="text-sm font-medium text-[#F1F5F9]">Belum Ada Geometri 3D</p>
            <p className="mt-1 text-xs text-[#94A3B8]">
              Buat sketsa 2D terlebih dahulu melalui AI Design Assistant atau Command Bar untuk melihat ekstrusi 3D SolidWorks.
            </p>
          </div>
        </div>
      )}

      {/* Bottom SolidWorks Unit Guard Telemetry */}
      <div className="pointer-events-none absolute bottom-2.5 left-3 right-3 flex items-center justify-between text-xs text-[#94A3B8]">
        <div className="flex items-center gap-2 rounded border border-[#2E3440] bg-[#121417]/85 px-2.5 py-1 font-mono tabular-nums">
          <RotateCcw className="h-3 w-3 text-[#E11D48]" />
          <span>Drag to orbit · Scroll to zoom</span>
        </div>
        <div className="flex items-center gap-3 rounded border border-[#2E3440] bg-[#121417]/85 px-2.5 py-1 font-mono tabular-nums">
          <span>FeatureExtrusion2</span>
          <span aria-hidden="true">·</span>
          <span>
            Depth: {extrudeDepthMm.toFixed(1)} mm ({mmToMeters(extrudeDepthMm).toFixed(4)} m)
          </span>
        </div>
      </div>
    </div>
  );
};
