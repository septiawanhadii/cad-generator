import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  Box,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Eye,
  EyeOff,
  FolderTree,
  Layers,
  Link2,
  Pause,
  Play,
  Table2,
  X,
} from 'lucide-react';
import type {
  CadAssemblyMate,
  CadPart3D,
  DocState,
  DocSummary,
} from '../types/cadcraft';
import { mmToMeters } from '../cad/dxfExporter';
import {
  computeAssemblyBom,
  computeExplodedOffset,
  computeParts3dBounds,
  deriveParts3dFrom2dDoc,
  inferAssemblyMates,
  solveAssemblyKinematics,
} from '../cad/cad3dModel';
import {
  applyPartVisualState,
  buildCadAssemblyGroup,
  disposeObject3D,
  type BuiltPartEntry,
  type CadShadingMode,
  type MaterialOverride,
  type PartHighlightState,
} from '../cad/threeSceneBuilder';

interface SolidWorks3DViewportProps {
  doc: DocState;
  summary: DocSummary;
  extrudeDepthMm: number;
  onChangeExtrudeDepth: (mm: number) => void;
  onExportSldprt: () => void;
}

type CameraPreset = 'iso' | 'top' | 'front' | 'right';
type AssemblyTab = 'parts' | 'mates' | 'bom';

const FINISH_OPTIONS: { id: MaterialOverride; label: string; swatch: string }[] = [
  { id: 'auto', label: 'Auto', swatch: '#64748B' },
  { id: 'dark_oxide', label: 'Dark Oxide', swatch: '#3B2D26' },
  { id: 'machined_steel', label: 'Steel', swatch: '#A4B0BE' },
  { id: 'cast_iron', label: 'Cast Iron', swatch: '#454A52' },
  { id: 'anodized_blue', label: 'CAD Blue', swatch: '#2F65B8' },
];

const ROLE_BADGE: Record<string, { code: string; title: string; color: string }> = {
  fixed: { code: '(f)', title: 'Fixed / Grounded component', color: 'text-[#10B981]' },
  moving: { code: '(-)', title: 'Moving / Sliding component', color: 'text-[#3B82F6]' },
  shaft: { code: '(o)', title: 'Rotating / Threaded shaft', color: 'text-[#06B6D4]' },
  actuator: { code: '(+)', title: 'Actuator / Handle', color: 'text-[#F59E0B]' },
  fastener: { code: '(*)', title: 'Fastener / Bolt', color: 'text-[#94A3B8]' },
};

function detectSoftwareWebGL(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export const SolidWorks3DViewport: React.FC<SolidWorks3DViewportProps> = ({
  doc,
  extrudeDepthMm,
  onChangeExtrudeDepth,
  onExportSldprt,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);

  const [shadingMode, setShadingMode] = useState<CadShadingMode>('shaded_edges');
  const [materialOverride, setMaterialOverride] = useState<MaterialOverride>('auto');
  const [explodePercent, setExplodePercent] = useState(0);
  const [motionPercent, setMotionPercent] = useState(0);
  const [isMotionPlaying, setIsMotionPlaying] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [activePreset, setActivePreset] = useState<CameraPreset>('iso');

  // SolidWorks FeatureManager Assembly Tree state
  const [isTreeOpen, setIsTreeOpen] = useState(true);
  const [treeTab, setTreeTab] = useState<AssemblyTab>('parts');
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [selectedMateId, setSelectedMateId] = useState<string | null>(null);
  const [hiddenPartIds, setHiddenPartIds] = useState<Record<string, boolean>>({});

  const resolvedParts: CadPart3D[] = useMemo(() => {
    if (doc.parts3d && doc.parts3d.length > 0) return doc.parts3d;
    return deriveParts3dFrom2dDoc(doc);
  }, [doc]);

  const isAssembly = resolvedParts.length > 1;

  const resolvedMates: CadAssemblyMate[] = useMemo(() => {
    if (!isAssembly) return [];
    if (doc.mates && doc.mates.length > 0) return doc.mates;
    return inferAssemblyMates(resolvedParts);
  }, [doc.mates, isAssembly, resolvedParts]);

  const kinematics = useMemo(
    () => solveAssemblyKinematics(resolvedParts, resolvedMates, motionPercent / 100),
    [resolvedParts, resolvedMates, motionPercent],
  );
  const hasKinematicMotion = kinematics.mechanismType !== 'static';

  const bom = useMemo(() => computeAssemblyBom(resolvedParts, resolvedMates), [resolvedParts, resolvedMates]);
  const bounds = useMemo(() => computeParts3dBounds(resolvedParts), [resolvedParts]);

  // Reset per-assembly selection/visibility whenever a brand-new parts list loads
  useEffect(() => {
    setSelectedPartId(null);
    setSelectedMateId(null);
    setHiddenPartIds({});
    setMotionPercent(0);
    setIsMotionPlaying(false);
  }, [resolvedParts]);

  // Refs for stable Three.js lifecycle without tearing down WebGL on React state changes
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelRootRef = useRef<THREE.Group | null>(null);
  const partEntriesRef = useRef<BuiltPartEntry[]>([]);
  const requestRenderRef = useRef<() => void>(() => {});
  const cameraGoalRef = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const isSoftwareGlRef = useRef(true);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  // Initialize Three.js WebGLRenderer, studio RoomEnvironment, 3-point lighting, and Raycaster once
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareWebGL();
    isSoftwareGlRef.current = isSoftwareGl;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x161a20);
    scene.fog = new THREE.Fog(0x161a20, 480, 1400);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(38, width / height, 0.5, 2500);
    camera.position.set(170, 145, 195);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.dataset.testid = 'cad-canvas-3d';
    renderer.domElement.className = 'block h-full w-full outline-none cursor-grab active:cursor-grabbing';
    container.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    pmrem.dispose();

    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e242c, 0.85);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff5e4, 1.85);
    keyLight.position.set(180, 260, 190);
    if (!isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.width = 1024;
      keyLight.shadow.mapSize.height = 1024;
      keyLight.shadow.camera.near = 20;
      keyLight.shadow.camera.far = 900;
      const d = 180;
      keyLight.shadow.camera.left = -d;
      keyLight.shadow.camera.right = d;
      keyLight.shadow.camera.top = d;
      keyLight.shadow.camera.bottom = -d;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.04;
    }
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x93c5fd, 0.75);
    rimLight.position.set(-180, 120, -160);
    scene.add(rimLight);

    const floorGeo = new THREE.PlaneGeometry(1200, 1200);
    const floorMat = new THREE.ShadowMaterial({ opacity: 0.34 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.15;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(360, 36, 0x334155, 0x222730);
    grid.position.y = -0.1;
    scene.add(grid);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.08;
    controls.minDistance = 20;
    controls.maxDistance = 1200;
    controls.target.set(0, 12, 0);
    controlsRef.current = controls;

    // 3D Part picking via Raycaster (only triggers on click without orbit drag)
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    let pointerDownPos: { x: number; y: number } | null = null;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pointerDownPos = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!pointerDownPos) return;
      const distMoved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      pointerDownPos = null;
      if (distMoved > 5) return; // User was orbiting, not picking

      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);

      const visibleMeshes = partEntriesRef.current
        .filter((entry) => entry.wrapper.visible)
        .map((entry) => entry.mesh);
      const hits = raycaster.intersectObjects(visibleMeshes, false);
      if (hits.length > 0) {
        const hitId = hits[0].object.userData?.partId as string | undefined;
        if (hitId) {
          setSelectedMateId(null);
          setSelectedPartId((prev) => (prev === hitId ? null : hitId));
        }
      } else {
        setSelectedPartId(null);
        setSelectedMateId(null);
      }
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    // On-demand coalesced rendering with software-WebGL fence pacing
    let frameId = 0;
    let disposed = false;
    let renderBusy = false;
    let renderDirty = false;
    let lastTime = performance.now();

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (!gl || typeof gl.fenceSync !== 'function') {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) return;
        const state = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function requestRender() {
      if (disposed) return;
      if (renderBusy) {
        renderDirty = true;
        return;
      }
      renderBusy = true;
      frameId = requestAnimationFrame(() => {
        if (disposed) return;
        renderDirty = false;
        const now = performance.now();
        const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
        lastTime = now;

        let keepAnimating = false;
        const goal = cameraGoalRef.current;
        if (goal) {
          if (isSoftwareGl) {
            camera.position.copy(goal.pos);
            controls.target.copy(goal.target);
            cameraGoalRef.current = null;
          } else {
            const lambda = 9;
            camera.position.x = THREE.MathUtils.damp(camera.position.x, goal.pos.x, lambda, dt);
            camera.position.y = THREE.MathUtils.damp(camera.position.y, goal.pos.y, lambda, dt);
            camera.position.z = THREE.MathUtils.damp(camera.position.z, goal.pos.z, lambda, dt);
            controls.target.x = THREE.MathUtils.damp(controls.target.x, goal.target.x, lambda, dt);
            controls.target.y = THREE.MathUtils.damp(controls.target.y, goal.target.y, lambda, dt);
            controls.target.z = THREE.MathUtils.damp(controls.target.z, goal.target.z, lambda, dt);
            if (
              camera.position.distanceTo(goal.pos) < 0.35 &&
              controls.target.distanceTo(goal.target) < 0.25
            ) {
              camera.position.copy(goal.pos);
              controls.target.copy(goal.target);
              cameraGoalRef.current = null;
            } else {
              keepAnimating = true;
            }
          }
        }

        const damped = controls.update();
        if (damped && !isSoftwareGl) keepAnimating = true;

        renderer.render(scene, camera);

        const done = () => {
          renderBusy = false;
          if (!disposed && (renderDirty || keepAnimating)) {
            requestRender();
          }
        };
        if (isSoftwareGl) afterDraw(done);
        else done();
      });
    }

    requestRenderRef.current = requestRender;

    controls.addEventListener('start', () => {
      cameraGoalRef.current = null;
    });
    controls.addEventListener('change', requestRender);

    const onResize = () => {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      requestRender();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    requestRender();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      if (modelRootRef.current) {
        disposeObject3D(modelRootRef.current);
        modelRootRef.current = null;
      }
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      floorGeo.dispose();
      floorMat.dispose();
      envTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Live Motion Simulation stepper (ping-pongs 0% -> 100% -> 0% when playing)
  useEffect(() => {
    if (!isMotionPlaying || !hasKinematicMotion) return;
    let direction = 1;
    const stepMs = isSoftwareGlRef.current ? 120 : 32;
    const stepDelta = isSoftwareGlRef.current ? 4 : 1.2;
    const timer = window.setInterval(() => {
      setMotionPercent((prev) => {
        let next = prev + direction * stepDelta;
        if (next >= 100) {
          next = 100;
          direction = -1;
        } else if (next <= 0) {
          next = 0;
          direction = 1;
        }
        return Math.round(next * 10) / 10;
      });
    }, stepMs);
    return () => window.clearInterval(timer);
  }, [isMotionPlaying, hasKinematicMotion]);

  // Helper to aim camera cleanly at current model bounds (offset slightly right if Assembly Tree is open)
  const moveCameraToPreset = (preset: CameraPreset, instant = false) => {
    setActivePreset(preset);
    const b = boundsRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const span = b ? Math.max(b.width, b.depth, b.height, 45) : 140;
    const dist = span * 1.65;
    const targetY = b ? Math.max(0, b.height * 0.24) : 6;
    const target = new THREE.Vector3(0, targetY, 0);

    let pos: THREE.Vector3;
    if (preset === 'top') {
      pos = new THREE.Vector3(0, dist * 1.25, 0.01);
    } else if (preset === 'front') {
      pos = new THREE.Vector3(0, targetY + dist * 0.14, dist * 1.18);
    } else if (preset === 'right') {
      pos = new THREE.Vector3(dist * 1.18, targetY + dist * 0.14, 0);
    } else {
      pos = new THREE.Vector3(dist * 0.78, dist * 0.74, dist * 0.88);
    }

    if (instant) {
      cameraGoalRef.current = null;
      camera.position.copy(pos);
      controls.target.copy(target);
      controls.update();
    } else {
      cameraGoalRef.current = { pos, target };
    }
    requestRenderRef.current();
  };

  // Rebuild 3D geometry whenever parts, shading, or material finish change
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (modelRootRef.current) {
      scene.remove(modelRootRef.current);
      disposeObject3D(modelRootRef.current);
      modelRootRef.current = null;
      partEntriesRef.current = [];
    }

    if (resolvedParts.length === 0 || !bounds) {
      requestRenderRef.current();
      return;
    }

    const { group, entries } = buildCadAssemblyGroup(
      resolvedParts,
      bounds,
      shadingMode,
      materialOverride,
      explodePercent / 100,
    );
    scene.add(group);
    modelRootRef.current = group;
    partEntriesRef.current = entries;

    moveCameraToPreset(activePreset, true);
    requestRenderRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedParts, bounds, shadingMode, materialOverride]);

  // Fast update for Exploded View + Coupled Rigid-Body Kinematics without rebuilding geometries
  useEffect(() => {
    if (!bounds || partEntriesRef.current.length === 0) return;
    const explodeFactor = explodePercent / 100;
    for (const entry of partEntriesRef.current) {
      const off = computeExplodedOffset(entry.part, bounds, explodeFactor);
      const kin = kinematics.deltas[entry.part.id] ?? { dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0 };
      entry.wrapper.position.set(
        entry.pivotCenter.x + off.dx + kin.dx,
        entry.pivotCenter.y + off.dz + kin.dz,
        entry.pivotCenter.z - off.dy - kin.dy,
      );
      // CAD -> Three.js axis rotation: CAD X -> +X, CAD Y -> -Z, CAD Z -> +Y
      entry.pivotGroup.rotation.set(kin.rx, kin.rz, -kin.ry);
    }
    requestRenderRef.current();
  }, [explodePercent, kinematics, bounds]);

  // Fast update for Selection, Mate Highlighting, and Show/Hide visibility
  useEffect(() => {
    if (partEntriesRef.current.length === 0) return;
    const activeMate = selectedMateId
      ? resolvedMates.find((m) => m.id === selectedMateId) ?? null
      : null;

    for (const entry of partEntriesRef.current) {
      const isVisible = !hiddenPartIds[entry.part.id];
      let state: PartHighlightState = 'none';
      if (activeMate) {
        if (entry.part.id === activeMate.part_a) state = 'selected';
        else if (entry.part.id === activeMate.part_b) state = 'mated';
      } else if (selectedPartId && entry.part.id === selectedPartId) {
        state = 'selected';
      }
      applyPartVisualState(entry, state, isVisible);
    }
    requestRenderRef.current();
  }, [selectedPartId, selectedMateId, hiddenPartIds, resolvedMates, shadingMode, materialOverride]);

  const togglePartVisibility = (partId: string) => {
    setHiddenPartIds((prev) => ({ ...prev, [partId]: !prev[partId] }));
  };

  const isolatePart = (partId: string) => {
    const next: Record<string, boolean> = {};
    for (const p of resolvedParts) {
      if (p.id !== partId) next[p.id] = true;
    }
    setHiddenPartIds(next);
    setSelectedMateId(null);
    setSelectedPartId(partId);
  };

  const hiddenCount = Object.values(hiddenPartIds).filter(Boolean).length;
  const hasGeometry = resolvedParts.length > 0;
  const partName = doc.lastPartName || 'cadcraft_part';

  return (
    <div className="relative flex-1 overflow-hidden bg-[#161A20] select-none">
      {/* Dedicated WebGL Mount Container */}
      <div ref={mountRef} className="h-full w-full" />

      {/* Top Bar: Assembly/Part Spec + Tree Toggle (Left) | Export CTA (Right) */}
      <div className="pointer-events-none absolute top-3 right-3 left-3 flex flex-wrap items-center justify-between gap-2">
        <div className="pointer-events-auto flex items-center gap-2">
          {isAssembly && (
            <button
              type="button"
              onClick={() => setIsTreeOpen((v) => !v)}
              aria-label="Toggle Assembly FeatureManager Tree"
              className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors whitespace-nowrap ${
                isTreeOpen
                  ? 'border-[#3B82F6] bg-[#242830] text-[#F1F5F9]'
                  : 'border-[#2E3440] bg-[#1B1E23]/95 text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              <FolderTree className="h-3.5 w-3.5 text-[#3B82F6]" />
              <span>Assembly Tree</span>
            </button>
          )}

          <div className="flex items-center gap-2.5 rounded-md border border-[#2E3440] bg-[#1B1E23]/95 px-3 py-1.5 text-xs">
            <Layers className="h-3.5 w-3.5 text-[#3B82F6]" />
            <span className="font-mono font-medium text-[#F1F5F9]">
              {partName}.{isAssembly ? 'sldasm' : 'sldprt'}
            </span>
            {bounds && (
              <>
                <span className="text-[#2E3440]" aria-hidden="true">
                  |
                </span>
                <span className="font-mono text-[#94A3B8] tabular-nums">
                  {bounds.width}×{bounds.depth}×{bounds.height} mm · {resolvedParts.length}{' '}
                  {isAssembly ? `Parts · ${resolvedMates.length} Mates` : 'Body'}
                </span>
              </>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={onExportSldprt}
          disabled={!hasGeometry}
          className="pointer-events-auto flex h-9 items-center gap-2 rounded-md bg-[#E11D48] px-3.5 text-xs font-semibold text-[#F1F5F9] transition-colors hover:bg-[#BE123C] disabled:opacity-40 whitespace-nowrap"
        >
          <Box className="h-3.5 w-3.5" />
          <span>
            {isAssembly
              ? `Export .sldasm (${resolvedParts.length} Parts)`
              : `Export .sldprt (${extrudeDepthMm.toFixed(1)} mm)`}
          </span>
        </button>
      </div>

      {/* Collapsible SolidWorks-Style FeatureManager Assembly Tree (Left Rail) */}
      {isAssembly && isTreeOpen && (
        <aside
          aria-label="Assembly FeatureManager Tree"
          className="pointer-events-auto absolute top-14 bottom-28 left-3 z-20 flex w-[272px] flex-col overflow-hidden rounded-lg border border-[#2E3440] bg-[#1B1E23]/95 shadow-xl max-md:w-60"
        >
          {/* Drawer Header & Tabs */}
          <div className="flex items-center justify-between gap-1 border-b border-[#2E3440] px-2 py-2">
            <div className="flex items-center gap-1" role="tablist" aria-label="Assembly Inspector Tabs">
              <button
                type="button"
                role="tab"
                aria-selected={treeTab === 'parts'}
                onClick={() => setTreeTab('parts')}
                className={`flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                  treeTab === 'parts'
                    ? 'bg-[#3B82F6] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9]'
                }`}
              >
                <FolderTree className="h-3 w-3 shrink-0" />
                <span>Parts ({resolvedParts.length})</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={treeTab === 'mates'}
                onClick={() => setTreeTab('mates')}
                className={`flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                  treeTab === 'mates'
                    ? 'bg-[#3B82F6] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9]'
                }`}
              >
                <Link2 className="h-3 w-3 shrink-0" />
                <span>Mates ({resolvedMates.length})</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={treeTab === 'bom'}
                onClick={() => setTreeTab('bom')}
                className={`flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                  treeTab === 'bom'
                    ? 'bg-[#3B82F6] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9]'
                }`}
              >
                <Table2 className="h-3 w-3 shrink-0" />
                <span>BOM</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setIsTreeOpen(false)}
              aria-label="Close Assembly Tree"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Tab 1: Parts Tree */}
          {treeTab === 'parts' && (
            <div className="flex flex-1 flex-col overflow-hidden">
              {hiddenCount > 0 && (
                <div className="flex items-center justify-between border-b border-[#2E3440] bg-[#121417] px-2.5 py-1 text-[11px] text-[#94A3B8]">
                  <span>{hiddenCount} part disembunyikan</span>
                  <button
                    type="button"
                    onClick={() => setHiddenPartIds({})}
                    className="font-medium text-[#3B82F6] hover:underline"
                  >
                    Show All
                  </button>
                </div>
              )}

              <div className="flex-1 divide-y divide-[#2E3440]/60 overflow-y-auto">
                {bom.rows.map((row) => {
                  const isSelected = selectedPartId === row.id;
                  const isHidden = Boolean(hiddenPartIds[row.id]);
                  const badge = ROLE_BADGE[row.role] ?? ROLE_BADGE.fixed;
                  return (
                    <div
                      key={row.id}
                      className={`group flex items-center justify-between gap-1.5 px-2.5 py-1.5 text-xs transition-colors ${
                        isSelected
                          ? 'bg-[#3B82F6]/20 text-[#F1F5F9]'
                          : 'text-[#F1F5F9] hover:bg-[#242830]/70'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedMateId(null);
                          setSelectedPartId((prev) => (prev === row.id ? null : row.id));
                        }}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      >
                        <span
                          title={badge.title}
                          className={`shrink-0 font-mono text-[10px] font-semibold ${badge.color}`}
                        >
                          {badge.code}
                        </span>
                        <span
                          className={`truncate text-[11.5px] font-medium ${
                            isHidden ? 'text-[#94A3B8]/50 line-through' : ''
                          }`}
                        >
                          {row.name}
                        </span>
                      </button>

                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => isolatePart(row.id)}
                          title={`Isolate ${row.name}`}
                          aria-label={`Isolate ${row.name}`}
                          className="flex h-6 w-6 items-center justify-center rounded text-[#94A3B8] opacity-70 hover:bg-[#121417] hover:text-[#06B6D4] hover:opacity-100"
                        >
                          <Crosshair className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => togglePartVisibility(row.id)}
                          title={isHidden ? `Show ${row.name}` : `Hide ${row.name}`}
                          aria-label={isHidden ? `Show ${row.name}` : `Hide ${row.name}`}
                          className="flex h-6 w-6 items-center justify-center rounded text-[#94A3B8] hover:bg-[#121417] hover:text-[#F1F5F9]"
                        >
                          {isHidden ? (
                            <EyeOff className="h-3 w-3 text-[#94A3B8]/60" />
                          ) : (
                            <Eye className="h-3 w-3 text-[#10B981]" />
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-[#2E3440] bg-[#121417] px-2.5 py-1.5 text-[10.5px] text-[#94A3B8]">
                Klik komponen di daftar atau langsung di 3D untuk memilih &amp; sorot.
              </div>
            </div>
          )}

          {/* Tab 2: Mates List */}
          {treeTab === 'mates' && (
            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex-1 divide-y divide-[#2E3440]/60 overflow-y-auto">
                {resolvedMates.map((mate) => {
                  const isActive = selectedMateId === mate.id;
                  return (
                    <button
                      key={mate.id}
                      type="button"
                      onClick={() => {
                        setSelectedPartId(null);
                        setSelectedMateId((prev) => (prev === mate.id ? null : mate.id));
                      }}
                      className={`flex w-full flex-col gap-0.5 px-2.5 py-2 text-left transition-colors ${
                        isActive
                          ? 'bg-[#06B6D4]/15 text-[#F1F5F9]'
                          : 'text-[#F1F5F9] hover:bg-[#242830]/70'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wide text-[#06B6D4]">
                          {mate.kind}
                          {mate.axis ? ` · ${mate.axis.toUpperCase()}` : ''}
                        </span>
                        {mate.travel_mm && (
                          <span className="font-mono text-[10px] text-[#94A3B8] tabular-nums">
                            {mate.travel_mm} mm
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] leading-snug text-[#94A3B8]">{mate.description}</p>
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-[#2E3440] bg-[#121417] px-2.5 py-1.5 text-[10.5px] text-[#94A3B8]">
                Klik mate untuk menyorot kedua komponen yang terhubung.
              </div>
            </div>
          )}

          {/* Tab 3: Engineering BOM & Mass Properties */}
          {treeTab === 'bom' && (
            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex-1 divide-y divide-[#2E3440]/60 overflow-y-auto">
                {bom.rows.map((row, idx) => (
                  <div key={row.id} className="px-2.5 py-1.5 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-[#F1F5F9]">
                        {idx + 1}. {row.name}
                      </span>
                      <span className="shrink-0 font-mono text-[#10B981] tabular-nums">
                        {row.massGrams} g
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[10px] text-[#94A3B8]">
                      <span className="truncate">{row.material}</span>
                      <span className="shrink-0 tabular-nums">{row.dimensionsMm}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between border-t border-[#2E3440] bg-[#121417] px-2.5 py-2 text-[11px] font-mono tabular-nums">
                <span className="text-[#94A3B8]">Total Est. Mass:</span>
                <span className="font-semibold text-[#F1F5F9]">
                  {bom.totalMassGrams >= 1000
                    ? `${(bom.totalMassGrams / 1000).toFixed(2)} kg`
                    : `${bom.totalMassGrams} g`}{' '}
                  ({bom.totalVolumeCm3} cm³)
                </span>
              </div>
            </div>
          )}
        </aside>
      )}

      {/* Empty State */}
      {!hasGeometry && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="max-w-md rounded-lg border border-[#2E3440] bg-[#1B1E23]/95 px-5 py-4 text-center">
            <p className="text-sm font-semibold text-[#F1F5F9]">Belum Ada Geometri 3D</p>
            <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
              Deskripsikan komponen atau assembly mekanik di panel AI Design Assistant sebelah kanan (atau lampirkan gambar referensi) untuk menghasilkan rakitan 3D SolidWorks lengkap dengan Mates &amp; BOM.
            </p>
          </div>
        </div>
      )}

      {/* Unified Collapsible Bottom Control Dock (Zero Center Occlusion) */}
      <div className="pointer-events-none absolute right-3 bottom-3 left-3 flex flex-col items-center">
        <button
          type="button"
          onClick={() => setDockCollapsed((v) => !v)}
          className="pointer-events-auto mb-1 flex items-center gap-1 rounded-t-md border border-b-0 border-[#2E3440] bg-[#1B1E23] px-2.5 py-0.5 text-[11px] font-medium text-[#94A3B8] hover:text-[#F1F5F9]"
        >
          {dockCollapsed ? (
            <>
              <ChevronUp className="h-3 w-3" />
              <span>Show 3D Controls</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              <span>Hide Controls</span>
            </>
          )}
        </button>

        {!dockCollapsed && (
          <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-lg border border-[#2E3440] bg-[#1B1E23]/95 px-3 py-2 text-xs">
            {/* Camera Presets */}
            <div className="flex items-center gap-1" role="group" aria-label="3D Camera Views">
              {(
                [
                  { id: 'iso', label: 'Isometric' },
                  { id: 'top', label: 'Top' },
                  { id: 'front', label: 'Front' },
                  { id: 'right', label: 'Right' },
                ] as const
              ).map((cam) => (
                <button
                  key={cam.id}
                  type="button"
                  onClick={() => moveCameraToPreset(cam.id)}
                  className={`h-7 rounded px-2 font-medium transition-colors whitespace-nowrap ${
                    activePreset === cam.id
                      ? 'bg-[#3B82F6] text-[#F1F5F9]'
                      : 'text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9]'
                  }`}
                >
                  {cam.label}
                </button>
              ))}
            </div>

            <div className="h-4 w-px bg-[#2E3440]" aria-hidden="true" />

            {/* Shading Mode */}
            <div className="flex items-center gap-1" role="group" aria-label="3D Shading Mode">
              {(
                [
                  { id: 'shaded_edges', label: 'Shaded+Edges' },
                  { id: 'shaded', label: 'Shaded' },
                  { id: 'wireframe', label: 'Wireframe' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setShadingMode(m.id)}
                  className={`h-7 rounded px-2 font-medium transition-colors whitespace-nowrap ${
                    shadingMode === m.id
                      ? 'border border-[#3B82F6]/60 bg-[#242830] text-[#F1F5F9]'
                      : 'text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9]'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="h-4 w-px bg-[#2E3440]" aria-hidden="true" />

            {/* Material Finish Swatches */}
            <div className="flex items-center gap-1" role="group" aria-label="Material Finish">
              {FINISH_OPTIONS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setMaterialOverride(f.id)}
                  title={f.label}
                  className={`flex h-7 items-center gap-1.5 rounded border px-2 text-[11px] font-medium transition-colors whitespace-nowrap ${
                    materialOverride === f.id
                      ? 'border-[#3B82F6] bg-[#242830] text-[#F1F5F9]'
                      : 'border-transparent text-[#94A3B8] hover:bg-[#242830] hover:text-[#F1F5F9]'
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-sm border border-[#2E3440]"
                    style={{ backgroundColor: f.swatch }}
                    aria-hidden="true"
                  />
                  <span className="hidden xl:inline">{f.label}</span>
                </button>
              ))}
            </div>

            {isAssembly && (
              <>
                <div className="h-4 w-px bg-[#2E3440]" aria-hidden="true" />
                <label className="flex items-center gap-1.5 text-[#94A3B8]">
                  <span className="whitespace-nowrap">Explode:</span>
                  <input
                    type="range"
                    aria-label="Exploded View Percentage"
                    min={0}
                    max={100}
                    value={explodePercent}
                    onChange={(e) => setExplodePercent(Number(e.target.value))}
                    className="w-16 accent-[#3B82F6]"
                  />
                  <span className="w-7 font-mono text-[11px] text-[#F1F5F9] tabular-nums">
                    {explodePercent}%
                  </span>
                </label>
              </>
            )}

            {hasKinematicMotion && (
              <>
                <div className="h-4 w-px bg-[#2E3440]" aria-hidden="true" />
                <div className="flex items-center gap-1.5 text-[#94A3B8]">
                  <button
                    type="button"
                    onClick={() => setIsMotionPlaying((p) => !p)}
                    aria-label={isMotionPlaying ? 'Pause Assembly Motion' : 'Play Assembly Motion'}
                    title={isMotionPlaying ? 'Pause Motion' : 'Simulate Kinematic Motion'}
                    className={`flex h-7 w-7 items-center justify-center rounded border transition-colors ${
                      isMotionPlaying
                        ? 'border-[#06B6D4] bg-[#06B6D4]/20 text-[#06B6D4]'
                        : 'border-[#2E3440] bg-[#121417] text-[#F1F5F9] hover:border-[#3B82F6]'
                    }`}
                  >
                    {isMotionPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                  </button>
                  <label className="flex items-center gap-1.5">
                    <span className="whitespace-nowrap">{kinematics.label}:</span>
                    <input
                      type="range"
                      aria-label="Assembly Motion Simulation"
                      min={0}
                      max={100}
                      value={Math.round(motionPercent)}
                      onChange={(e) => {
                        setIsMotionPlaying(false);
                        setMotionPercent(Number(e.target.value));
                      }}
                      className="w-16 accent-[#06B6D4]"
                    />
                    <span className="font-mono text-[11px] text-[#06B6D4] tabular-nums whitespace-nowrap">
                      {kinematics.mechanismType === 'rotary'
                        ? `${kinematics.angleDeg}°`
                        : kinematics.revolutions > 0
                          ? `${kinematics.strokeMm.toFixed(1)}mm · ${kinematics.revolutions.toFixed(1)}rev`
                          : `${kinematics.strokeMm.toFixed(1)}mm`}
                    </span>
                  </label>
                </div>
              </>
            )}

            {!isAssembly && (
              <>
                <div className="h-4 w-px bg-[#2E3440]" aria-hidden="true" />
                <label className="flex items-center gap-1.5 text-[#94A3B8]">
                  <span>Depth:</span>
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
                    className="w-14 rounded border border-[#2E3440] bg-[#121417] px-1.5 py-0.5 font-mono text-xs text-[#F1F5F9] tabular-nums focus:border-[#3B82F6] focus:outline-none"
                  />
                  <span className="font-mono text-[11px] text-[#94A3B8]">
                    mm ({mmToMeters(extrudeDepthMm).toFixed(4)}m)
                  </span>
                </label>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
