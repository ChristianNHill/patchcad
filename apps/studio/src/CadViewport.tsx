import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { NodeStatus } from "@patchcad/shared";
import { useStudio } from "./store.js";
import { API } from "./api";

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
  if (status === "dirty" || status === "repairing" || status === "cancelled") return "var-warn";
  if (status === "error_code" || status === "error_contract") return "var-danger";
  return null;
}

// three.js needs literal colours, so these are READ FROM the tokens at first
// use rather than hand-copied. The hand-copied set had drifted: the "accent"
// literal was 25% lower chroma than --color-accent, "warn" was 7° off hue, and
// the part base and grid were invented values on a hue the palette never uses.
let tokenCache: Record<string, THREE.Color> | null = null;

function tokens(): Record<string, THREE.Color> {
  if (tokenCache) return tokenCache;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => {
    const raw = style.getPropertyValue(name).trim();
    try {
      return new THREE.Color(raw || fallback);
    } catch {
      // A browser that cannot parse oklch() in a Color still gets the palette.
      return new THREE.Color(fallback);
    }
  };
  tokenCache = {
    "var-accent": read("--color-accent", "#2ccceb"),
    "var-warn": read("--color-warn", "#e8aa4e"),
    "var-danger": read("--color-danger", "#e8605b"),
    base: read("--color-ink-2", "#a6b0b3"),
    grid: read("--color-rule", "#263033"),
    "grid-2": read("--color-rule-2", "#2c3437"),
  };
  return tokenCache;
}

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
  onCenter: (id: string, min: [number, number, number], max: [number, number, number]) => void;
}) {
  const [object, setObject] = useState<THREE.Object3D | null>(null);

  useEffect(() => {
    let cancelled = false;
    loader.load(url, (gltf) => {
      if (cancelled) return;
      const cloned = gltf.scene;
      cloned.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.material = new THREE.MeshStandardMaterial({ color: tokens().base, metalness: 0.1, roughness: 0.6 });
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
        const t = tokens();
        m.color.copy(tint ? t[tint]! : t.base!);
        m.emissive.copy(tint ? t[tint]!.clone().multiplyScalar(0.25) : new THREE.Color(0));
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

  // Report the part's placed bounds — the parent frames the camera on the
  // assembly and derives each part's exploded-view direction from the centers.
  useEffect(() => {
    if (!object) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    box.applyMatrix4(m4);
    onCenter(id, [box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z]);
  }, [object, m4, id, onCenter]);

  const placed = useMemo(() => {
    if (!offset) return m4;
    return new THREE.Matrix4().makeTranslation(offset[0], offset[1], offset[2]).multiply(m4);
  }, [m4, offset]);

  if (!object) return null;
  return <primitive object={object} matrix={placed} matrixAutoUpdate={false} />;
}

/** Frames the camera on the assembly: imported models live wherever their
 * mesh coordinates put them (often nowhere near the origin), so a fixed
 * camera can open onto empty grid. Re-frames only when the part set changes,
 * never while the user is orbiting. */
function FitCamera({ box, partsKey }: { box: THREE.Box3 | null; partsKey: string }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3; update: () => void } | null;
  // Framed part sets, not a one-shot effect: box, controls and partsKey settle
  // in whatever order the GLB loads and OrbitControls mount happen to finish.
  // Keying the effect on partsKey alone meant a box arriving last never framed
  // anything — the camera stayed at its initial pose and the pane looked empty
  // until something forced a remount.
  const framed = useRef<string>("");
  useEffect(() => {
    if (!box || box.isEmpty() || !controls) return;
    if (framed.current === partsKey) return; // already framed this set; don't fight an orbit
    framed.current = partsKey;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 10);
    // distance from the NARROWER field of view — the pane is a tall column,
    // so the horizontal fov usually binds
    const persp = camera as THREE.PerspectiveCamera;
    const vHalf = (persp.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * persp.aspect);
    const dist = (radius * 1.15) / Math.tan(Math.min(vHalf, hHalf));
    const dir = new THREE.Vector3(0.55, -0.55, 0.5).normalize();
    camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
    controls.target.copy(center);
    controls.update();
  }, [partsKey, controls, box]);
  return null;
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
  const [bounds, setBounds] = useState<Record<string, { min: [number, number, number]; max: [number, number, number] }>>({});

  const onCenter = useCallback((id: string, min: [number, number, number], max: [number, number, number]) => {
    setBounds((prev) => {
      const old = prev[id];
      if (
        old &&
        Math.hypot(old.min[0] - min[0], old.min[1] - min[1], old.min[2] - min[2]) < 1e-4 &&
        Math.hypot(old.max[0] - max[0], old.max[1] - max[1], old.max[2] - max[2]) < 1e-4
      )
        return prev;
      return { ...prev, [id]: { min, max } };
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
    const t = tokens();
    const g = new THREE.GridHelper(400, 40, t.grid, t["grid-2"]);
    g.rotation.x = Math.PI / 2; // XZ default → our XY ground (z-up)
    return g;
  }, []);

  // Exploded view: each part slides away from the assembly centroid along its
  // own center direction — mates and joints (pegs, sockets) become inspectable
  // without touching the graph. Purely visual, purely client-side.
  const centers = useMemo(() => {
    const out: Record<string, [number, number, number]> = {};
    for (const [id, b] of Object.entries(bounds)) {
      out[id] = [0, 1, 2].map((i) => (b.min[i]! + b.max[i]!) / 2) as [number, number, number];
    }
    return out;
  }, [bounds]);

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

  const liveIds = Object.keys(bounds)
    .filter((id) => data?.meshes[id])
    .sort();
  const unionBox = useMemo(() => {
    if (liveIds.length === 0) return null;
    const box = new THREE.Box3();
    for (const id of liveIds) {
      const b = bounds[id]!;
      box.expandByPoint(new THREE.Vector3(...b.min));
      box.expandByPoint(new THREE.Vector3(...b.max));
    }
    return box;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, liveIds.join("|")]);

  if (!graph) return null;
  const parts = Object.entries(data?.meshes ?? {});
  // Never let an exclusion be silent: a short export is otherwise indistinguishable
  // from a broken one.
  const hiddenCount = Object.values(graph.nodes).filter((n) => n.hidden).length;

  return (
    <div className="cad-viewport">
      <Canvas camera={{ position: [90, -90, 80], up: [0, 0, 1], fov: 40, near: 0.1, far: 5000 }}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[100, -60, 140]} intensity={1.4} />
        <directionalLight position={[-80, 90, 40]} intensity={0.4} />
        <primitive object={grid} />
        <FitCamera box={unionBox} partsKey={liveIds.join("|")} />
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
        <span>
          {parts.length} part{parts.length === 1 ? "" : "s"}
          {hiddenCount > 0 && (
            <span className="cad-viewport__hidden" title="Hidden parts stay in the model and out of the export">
              {" "}· {hiddenCount} hidden
            </span>
          )}
        </span>
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
        <ExportButton nodeId={selectedNodeId} partCount={parts.length} />
        <button className="btn btn--quiet btn--tiny" onClick={() => setReloadKey((k) => k + 1)}>
          refresh
        </button>
      </div>
    </div>
  );
}

/**
 * Geometry out. Exports the SELECTED part in its own frame when there is one,
 * because that is what you slice — parts print flat and separately, not posed.
 * With nothing selected it writes the whole assembly as one mesh.
 *
 * The kernel serves the file; the browser saves it. Nothing is written into
 * the project, so exporting can never disturb a graph.
 */
function ExportButton({ nodeId, partCount }: { nodeId: string | null; partCount: number }) {
  const [format, setFormat] = useState<string>("stl");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams({ format, ...(nodeId ? { node: nodeId } : {}) });
      const res = await fetch(`${API}/api/project/export?${q}`);
      const body = (await res.json()) as { url?: string; filename?: string; error?: string; hint?: string };
      if (!res.ok || !body.url) {
        setError(body.hint ? `${body.error} — ${body.hint}` : (body.error ?? "export failed"));
        return;
      }
      const a = document.createElement("a");
      a.href = body.url;
      a.download = body.filename ?? `patchcad.${format}`;
      a.click();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="cad-viewport__export">
      <select
        className="input"
        value={format}
        onChange={(e) => setFormat(e.target.value)}
        aria-label="export format"
        title="stl / 3mf / obj write a mesh for a slicer; step writes B-rep for another CAD tool, one part at a time"
      >
        {["stl", "3mf", "obj", "step"].map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <button
        className="btn btn--quiet btn--tiny"
        onClick={() => void run()}
        disabled={busy || partCount === 0}
        data-state={busy ? "loading" : undefined}
        title={nodeId ? "export the selected part in its own frame" : "export the whole assembly, posed"}
      >
        {busy ? "exporting…" : nodeId ? "export part" : "export all"}
      </button>
      {error && <span className="cad-viewport__problem">{error}</span>}
    </span>
  );
}
