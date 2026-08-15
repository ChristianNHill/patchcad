import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { NodeStatus } from "@patchcad/shared";
import { useStudio } from "./store.js";

const API = "http://localhost:4100";

/**
 * The CAD preview pane: per-node GLB meshes (straight from the kernel's
 * content-addressed cache) placed by the assembly's world matrices from
 * scene.json. One node re-cooking swaps exactly one mesh; statuses tint —
 * dirty amber, error red, selection accent.
 */

interface SceneData {
  scene: { nodes: Record<string, { title: string; matrix?: number[]; version: number }>; problems: string[] };
  meshes: Record<string, { glb: string; status: string; printability?: { composite?: number } }>;
}

const loader = new GLTFLoader();

function statusTint(status: NodeStatus | undefined, selected: boolean): string | null {
  if (selected) return "var-accent";
  if (status === "dirty" || status === "repairing") return "var-warn";
  if (status === "error_code" || status === "error_contract") return "var-danger";
  return null;
}

// Token hues resolved once — three.js needs literal colors, not CSS vars.
const TINTS: Record<string, THREE.Color> = {
  "var-accent": new THREE.Color("#6fd3e8"),
  "var-warn": new THREE.Color("#e8b551"),
  "var-danger": new THREE.Color("#e86f6f"),
};
const BASE = new THREE.Color("#9aa7b0");

function PartMesh({
  id,
  url,
  matrix,
  tint,
  offset,
  onCenter,
}: {
  id: string;
  url: string;
  matrix?: number[];
  tint: string | null;
  /** World-space displacement (mm) — the exploded-view slide. */
  offset?: [number, number, number];
  onCenter: (id: string, center: [number, number, number]) => void;
}) {
  const [object, setObject] = useState<THREE.Object3D | null>(null);

  useEffect(() => {
    let cancelled = false;
    loader.load(url, (gltf) => {
      if (cancelled) return;
      const cloned = gltf.scene;
      cloned.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.material = new THREE.MeshStandardMaterial({ color: BASE, metalness: 0.1, roughness: 0.6 });
        }
      });
      setObject(cloned);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    if (!object) return;
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const m = child.material as THREE.MeshStandardMaterial;
        m.color.copy(tint ? TINTS[tint]! : BASE);
        m.emissive.copy(tint ? TINTS[tint]!.clone().multiplyScalar(0.25) : new THREE.Color(0));
      }
    });
  }, [object, tint]);

  const m4 = useMemo(() => {
    const m = new THREE.Matrix4();
    if (matrix && matrix.length === 16) m.fromArray(matrix);
    // glTF is meters and Y-up by spec (the exporter rotates Z-up CAD data
    // -90° about X); assembly matrices are millimeter Z-up. Undo both.
    m.multiply(new THREE.Matrix4().makeScale(1000, 1000, 1000));
    m.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    return m;
  }, [matrix]);

  // Report the part's placed center — the parent derives each part's
  // exploded-view direction from these (away from the assembly centroid).
  useEffect(() => {
    if (!object) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()).applyMatrix4(m4);
    onCenter(id, [c.x, c.y, c.z]);
  }, [object, m4, id, onCenter]);

  const placed = useMemo(() => {
    if (!offset) return m4;
    return new THREE.Matrix4().makeTranslation(offset[0], offset[1], offset[2]).multiply(m4);
  }, [m4, offset]);

  if (!object) return null;
  return <primitive object={object} matrix={placed} matrixAutoUpdate={false} />;
}

/** WebGL isn't a given (hardware acceleration off, remote sessions) — a
 * viewport failure must degrade to a message, never a dead studio. */
class ViewportBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: Error) {
    return { error: err.message };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="inspector__hint">
          The 3D viewport could not start: {this.state.error}
          <br />
          <br />
          This usually means WebGL is unavailable — in Chrome, enable
          <code> Settings → System → Use graphics acceleration </code>
          and relaunch, then reload this page. The graph, inspector, and
          cooking all keep working meanwhile.
        </div>
      );
    }
    return this.props.children;
  }
}

export function CadViewport() {
  return (
    <ViewportBoundary>
      <CadViewportInner />
    </ViewportBoundary>
  );
}

function CadViewportInner() {
  const graph = useStudio((s) => s.graph);
  const statuses = useStudio((s) => s.statuses);
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const [data, setData] = useState<SceneData | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [explode, setExplode] = useState(0);
  const [centers, setCenters] = useState<Record<string, [number, number, number]>>({});

  const onCenter = useCallback((id: string, c: [number, number, number]) => {
    setCenters((prev) => {
      const old = prev[id];
      if (old && Math.hypot(old[0] - c[0], old[1] - c[1], old[2] - c[2]) < 1e-4) return prev;
      return { ...prev, [id]: c };
    });
  }, []);

  // Scene refetches ride the store's cook/param signals.
  const sceneRev = useStudio((s) => s.cadSceneRev);
  useEffect(() => {
    let cancelled = false;
    void fetch(`${API}/api/project/cad-scene`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SceneData | null) => {
        if (cancelled || !d) return;
        setData(d);
        const scores: Record<string, never> = {};
        for (const [id, m] of Object.entries(d.meshes)) {
          if (m.printability) scores[id] = m.printability as never;
        }
        useStudio.getState().setPrintability(scores);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [graph?.rev, sceneRev, reloadKey]);

  const grid = useMemo(() => {
    const g = new THREE.GridHelper(400, 40, "#3a4f5c", "#2a3a44");
    g.rotation.x = Math.PI / 2; // XZ default → our XY ground (z-up)
    return g;
  }, []);

  // Exploded view: each part slides away from the assembly centroid along its
  // own center direction — mates and joints (pegs, sockets) become inspectable
  // without touching the graph. Purely visual, purely client-side.
  const offsets = useMemo(() => {
    const ids = Object.keys(centers).filter((id) => data?.meshes[id]);
    if (ids.length < 2 || explode === 0) return {};
    const mean: [number, number, number] = [0, 0, 0];
    for (const id of ids) for (let i = 0; i < 3; i++) mean[i] = mean[i]! + centers[id]![i]! / ids.length;
    const out: Record<string, [number, number, number]> = {};
    for (const id of ids) {
      out[id] = [0, 1, 2].map((i) => (centers[id]![i]! - mean[i]!) * explode * 1.4) as [number, number, number];
    }
    return out;
  }, [centers, explode, data]);

  if (!graph) return null;
  const parts = Object.entries(data?.meshes ?? {});

  return (
    <div className="cad-viewport">
      <Canvas camera={{ position: [90, -90, 80], up: [0, 0, 1], fov: 40, near: 0.1, far: 5000 }}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[100, -60, 140]} intensity={1.4} />
        <directionalLight position={[-80, 90, 40]} intensity={0.4} />
        <primitive object={grid} />
        {parts.map(([id, mesh]) => (
          <PartMesh
            key={`${id}:${mesh.glb}`}
            id={id}
            url={mesh.glb}
            matrix={data?.scene.nodes[id]?.matrix}
            tint={statusTint(statuses[id], selectedNodeId === id)}
            offset={offsets[id]}
            onCenter={onCenter}
          />
        ))}
        <OrbitControls makeDefault />
      </Canvas>
      <div className="cad-viewport__bar">
        <span>{parts.length} part{parts.length === 1 ? "" : "s"}</span>
        {parts.length > 1 && (
          <label className="cad-viewport__explode" title="slide parts apart along their assembly directions — joints and pegs stay visible, nothing changes in the graph">
            explode
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={explode}
              onChange={(e) => setExplode(Number(e.target.value))}
            />
          </label>
        )}
        {selectedNodeId && data?.meshes[selectedNodeId]?.printability?.composite !== undefined && (
          <span title="DfAM printability (min-wall + overhang, CADClamp method): 1.0 prints clean, low values will fail on an FDM printer">
            printability {data.meshes[selectedNodeId]!.printability!.composite!.toFixed(2)}
          </span>
        )}
        {(data?.scene.problems.length ?? 0) > 0 && (
          <span className="cad-viewport__problem">{data!.scene.problems[0]}</span>
        )}
        <button className="btn btn--quiet btn--tiny" onClick={() => setReloadKey((k) => k + 1)}>
          refresh
        </button>
      </div>
    </div>
  );
}
