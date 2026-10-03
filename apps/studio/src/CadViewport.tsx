import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Grid, Html, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { isCooking, type NodeStatus } from "@patchcad/shared";
import { useStudio } from "./store.js";
import { API } from "./api";
import { fmtMm, measure, sectionOffset, sectionPlane, type Axis, type MeasurePoint, type Vec3 } from "./measure.js";

/**
 * The CAD preview pane: per-node GLB meshes (straight from the kernel's
 * content-addressed cache) placed by the assembly's world matrices from
 * scene.json. One node re-cooking swaps exactly one mesh; statuses tint —
 * dirty amber, error red, selection accent.
 */

interface SceneData {
  scene: { nodes: Record<string, { title: string; matrix?: number[]; matrices?: number[][]; version: number }>; problems: string[] };
  meshes: Record<string, { glb: string; status: string; printability?: { composite?: number } }>;
}

const loader = new GLTFLoader();

function statusTint(status: NodeStatus | undefined, selected: boolean): string | null {
  if (selected) return "var-accent";
  if (status === "dirty" || status === "repairing" || status === "cancelled") return "var-warn";
  if (status === "error_code" || status === "error_contract") return "var-danger";
  return null;
}

// three.js CANNOT read these from CSS: Color.setStyle has no oklch branch, and
// it does not throw on one — it warns "Unknown color model" and leaves the
// colour at its default WHITE. A getComputedStyle bridge therefore silently
// blanks every part in the viewport, which is exactly what it did until this
// was reverted to constants.
//
// So: literals, but the CORRECT literals, each copied verbatim from its token.
// The values are asserted against tokens.css in viewport-colors.test.ts, so a
// token edit fails there instead of quietly desaturating the 3D view.
const TINTS: Record<string, THREE.Color> = {
  "var-accent": new THREE.Color("#0070d7"), // --color-accent
  "var-warn": new THREE.Color("#8a5300"), //   --color-warn
  "var-danger": new THREE.Color("#b3261e"), // --color-danger
};
export const BASE = new THREE.Color("#898884"); //    --color-graphite
const GRID = "#c4c3bf"; //                     --color-grid       10mm cells
const GRID_MAJOR = "#9d9c97"; //               --color-grid-major 50mm lines
export const INK = "#37352f"; //                      --color-ink        measure line

/** GPU memory is not garbage-collected: every refetch used to leave the
 *  previous meshes' buffers behind. Clones share geometry and materials with
 *  the loaded original, so disposing the original frees them all. */
function dispose(root: THREE.Object3D) {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      for (const m of [child.material].flat() as THREE.Material[]) m.dispose();
    }
  });
}

/** glTF is meters and Y-up by spec (the exporter rotates Z-up CAD data -90°
 *  about X); assembly matrices are millimeter Z-up. Undo both. */
function placement(matrix?: number[]): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (matrix && matrix.length === 16) m.fromArray(matrix);
  m.multiply(new THREE.Matrix4().makeScale(1000, 1000, 1000));
  m.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  return m;
}

/**
 * One node's mesh, drawn at every pose the assembly gives it (four arms off
 * one plate). The GLB loads ONCE and the extra poses are clones sharing its
 * geometry and materials; each pose used to fetch and parse its own copy.
 */
function NodeParts({
  id,
  url,
  matrices,
  tint,
  offset,
  clip,
  onCenter,
  onError,
}: {
  id: string;
  url: string;
  matrices: (number[] | undefined)[];
  tint: string | null;
  /** World-space displacement (mm) — the exploded-view slide, shared by every
   *  pose of the node. */
  offset?: [number, number, number];
  /** Section planes, or null for none. */
  clip: THREE.Plane[] | null;
  /** The first pose's placed bounds: framing and explode directions. */
  onCenter: (id: string, min: [number, number, number], max: [number, number, number]) => void;
  onError: (id: string, message: string) => void;
}) {
  const [object, setObject] = useState<THREE.Object3D | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loaded: THREE.Object3D | null = null;
    loader.load(
      url,
      (gltf) => {
        if (cancelled) {
          dispose(gltf.scene);
          return;
        }
        gltf.scene.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            (child.material as THREE.Material).dispose();
            // Double-sided so a section cut shows the part's inside rather
            // than an empty shell.
            child.material = new THREE.MeshStandardMaterial({ color: BASE, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide });
            child.userData.nodeId = id;
          }
        });
        loaded = gltf.scene;
        setObject(loaded);
      },
      undefined,
      // A failed GLB used to be silent: the bar counted the part and the
      // viewport drew nothing.
      (err) => {
        if (!cancelled) onError(id, err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
      if (loaded) dispose(loaded);
    };
  }, [url, id, onError]);

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

  useEffect(() => {
    if (!object) return;
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const m = child.material as THREE.MeshStandardMaterial;
        m.clippingPlanes = clip;
        m.needsUpdate = true; // clipping on/off is a shader variant
      }
    });
  }, [object, clip]);

  const poseCount = matrices.length;
  const copies = useMemo(
    () => (object ? Array.from({ length: poseCount }, (_, i) => (i === 0 ? object : object.clone())) : []),
    [object, poseCount],
  );

  // Keyed by value: the parent builds a fresh one-pose array every render.
  const matricesKey = JSON.stringify(matrices);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const m4s = useMemo(() => matrices.map(placement), [matricesKey]);

  // Report the part's placed bounds — the parent frames the camera on the
  // assembly and derives each part's exploded-view direction from the centers.
  useEffect(() => {
    if (!object || !m4s[0]) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    box.applyMatrix4(m4s[0]);
    onCenter(id, [box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z]);
  }, [object, m4s, id, onCenter]);

  const placed = useMemo(
    () => (offset ? m4s.map((m) => new THREE.Matrix4().makeTranslation(offset[0], offset[1], offset[2]).multiply(m)) : m4s),
    [m4s, offset],
  );

  return (
    <>
      {copies.map((copy, i) => (
        <primitive key={i} object={copy} matrix={placed[i]} matrixAutoUpdate={false} />
      ))}
    </>
  );
}

/** Frames the camera on the assembly: imported models live wherever their
 * mesh coordinates put them (often nowhere near the origin), so a fixed
 * camera can open onto empty grid. Re-frames only when the part set changes,
 * never while the user is orbiting. */
export function FitCamera({ box, partsKey }: { box: THREE.Box3 | null; partsKey: string }) {
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
export class ViewportBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
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

const AXES = ["x", "y", "z"] as const;
const vec = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

function CadViewportInner() {
  const graph = useStudio((s) => s.graph);
  const statuses = useStudio((s) => s.statuses);
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const kernel = useStudio((s) => s.status?.kernel);
  const [data, setData] = useState<SceneData | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [sceneLoading, setSceneLoading] = useState(false);
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [explode, setExplode] = useState(0);
  const [bounds, setBounds] = useState<Record<string, { min: [number, number, number]; max: [number, number, number] }>>({});
  const [measuring, setMeasuring] = useState(false);
  const [picks, setPicks] = useState<MeasurePoint[]>([]);
  const [section, setSection] = useState<{ on: boolean; axis: Axis; t: number }>({ on: false, axis: 2, t: 0.5 });

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

  const onLoadError = useCallback((id: string, message: string) => {
    setLoadErrors((prev) => ({ ...prev, [id]: message }));
  }, []);

  // Scene refetches ride the store's cook/param signals.
  const sceneRev = useStudio((s) => s.cadSceneRev);
  useEffect(() => {
    let cancelled = false;
    setSceneLoading(true);
    void fetch(`${API}/api/project/cad-scene`)
      .then(async (r) => {
        if (r.ok) return (await r.json()) as SceneData;
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `the scene did not load (${r.status})`);
      })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setSceneError(null);
        setLoadErrors({});
        const scores: Record<string, never> = {};
        for (const [id, m] of Object.entries(d.meshes)) {
          if (m.printability) scores[id] = m.printability as never;
        }
        useStudio.getState().setPrintability(scores);
      })
      .catch((err: Error) => {
        if (!cancelled) setSceneError(err.message);
      })
      .finally(() => {
        if (cancelled) return;
        setSceneLoading(false);
        // The kernel answered (or failed): let the warm-up banner settle.
        void useStudio.getState().loadStatus();
      });
    return () => {
      cancelled = true;
    };
  }, [graph?.rev, sceneRev, reloadKey]);

  // A scene fetch waits on the kernel, and its first boot pays the OCP import —
  // a minute of empty grid. Ask the server whether that is what is happening.
  useEffect(() => {
    if (!sceneLoading) return;
    const loadStatus = useStudio.getState().loadStatus;
    void loadStatus();
    const timer = setInterval(() => void loadStatus(), 2000);
    return () => clearInterval(timer);
  }, [sceneLoading]);

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

  // One plane object for the life of the viewport: materials hold a reference,
  // so moving the slider updates it in place without recompiling a shader.
  const clipPlane = useMemo(() => new THREE.Plane(), []);
  const clip = useMemo(() => (section.on ? [clipPlane] : null), [section.on, clipPlane]);
  useEffect(() => {
    if (!unionBox) return;
    // A hair past the bounds, so both slider ends show the whole part or none.
    const min = vec(unionBox.min.clone().subScalar(0.5));
    const max = vec(unionBox.max.clone().addScalar(0.5));
    const { normal, constant } = sectionPlane(section.axis, sectionOffset(min, max, section.axis, section.t));
    clipPlane.set(new THREE.Vector3(...normal), constant);
  }, [clipPlane, unionBox, section.axis, section.t]);

  /** Click a part to select its node (the canvas and inspector follow), or,
   *  while measuring, to drop a measure point on its surface. */
  const onPick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      // An orbit drag ends in a click too; only a still click picks.
      if (e.delta > 4) return;
      e.stopPropagation();
      // Raycasts ignore clipping, so skip hits on the cut-away side.
      const hit = e.intersections.find((h) => !clip || clipPlane.distanceToPoint(h.point) >= 0);
      if (!hit) return;
      if (measuring) {
        const normal = hit.face ? vec(hit.face.normal.clone().transformDirection(hit.object.matrixWorld)) : null;
        const p: MeasurePoint = { point: vec(hit.point), normal };
        setPicks((prev) => (prev.length >= 2 ? [p] : [...prev, p]));
        return;
      }
      const nodeId = hit.object.userData.nodeId as string | undefined;
      if (nodeId && nodeId !== useStudio.getState().selectedNodeId) void useStudio.getState().selectNode(nodeId);
    },
    [measuring, clip, clipPlane],
  );

  const reading = picks.length === 2 ? measure(picks[0]!, picks[1]!) : null;

  if (!graph) return null;
  const parts = Object.entries(data?.meshes ?? {});
  // Never let an exclusion be silent: a short export is otherwise indistinguishable
  // from a broken one.
  const hiddenCount = Object.values(graph.nodes).filter((n) => n.hidden).length;
  const failedLoads = Object.entries(loadErrors);
  const warming = sceneLoading && kernel != null && !kernel.ok;
  const cooking = Object.values(statuses).some(isCooking);

  return (
    <div className="cad-viewport" data-tool={measuring ? "measure" : undefined}>
      {warming && (
        <div className="banner cad-viewport__banner" role="status">
          Starting the geometry kernel. Its first boot loads OpenCascade and can take a minute;
          {cooking ? " the cook continues once it is up." : " parts appear once it is up."}
        </div>
      )}
      <Canvas
        camera={{ position: [90, -90, 80], up: [0, 0, 1], fov: 40, near: 0.1, far: 5000 }}
        onCreated={({ gl }) => {
          gl.localClippingEnabled = true;
        }}
      >
        <ambientLight intensity={0.6} />
        <directionalLight position={[100, -60, 140]} intensity={1.4} />
        <directionalLight position={[-80, 90, 40]} intensity={0.4} />
        {/* Ground plane, drawn the way a CAD viewport draws one: 10mm cells for
            texture, 50mm lines for measuring, fading out with distance so the
            plane reads as unbounded instead of as a square rug. drei's Grid is
            a shader — one draw call, and the fade is what a GridHelper cannot do. */}
        <Grid
          cellSize={10}
          cellThickness={0.6}
          cellColor={GRID}
          sectionSize={50}
          sectionThickness={1.1}
          sectionColor={GRID_MAJOR}
          infiniteGrid
          fadeFrom={0}
          fadeDistance={900}
          fadeStrength={0.6}
          rotation={[Math.PI / 2, 0, 0]} // XZ default → our XY ground (z-up)
          side={THREE.DoubleSide}
        />
        <FitCamera box={unionBox} partsKey={liveIds.join("|")} />
        <group onClick={onPick}>
          {parts.map(([id, mesh]) => {
            const n = data?.scene.nodes[id];
            return (
              <NodeParts
                key={`${id}:${mesh.glb}`}
                id={id}
                url={mesh.glb}
                matrices={n?.matrices?.length ? n.matrices : [n?.matrix]}
                tint={statusTint(statuses[id], selectedNodeId === id)}
                offset={offsets[id]}
                clip={clip}
                onCenter={onCenter}
                onError={onLoadError}
              />
            );
          })}
        </group>
        {measuring &&
          picks.map((p, i) => (
            <Html key={i} position={p.point} center>
              <span className="cad-viewport__measure-dot" />
            </Html>
          ))}
        {reading && (
          <>
            <Line points={[picks[0]!.point, picks[1]!.point]} color={INK} lineWidth={1.5} depthTest={false} />
            <Html position={reading.mid} center>
              <span className="cad-viewport__measure-label">
                {fmtMm(reading.distance)}
                {reading.faceGap !== null && ` · faces ${fmtMm(reading.faceGap)}`}
              </span>
            </Html>
          </>
        )}
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
              disabled={measuring}
              onChange={(e) => setExplode(Number(e.target.value))}
            />
          </label>
        )}
        <button
          className="btn btn--quiet btn--tiny"
          aria-pressed={measuring}
          title="click two points on the model for the distance between them; two parallel faces also give the gap between their planes"
          onClick={() => {
            // An exploded measurement is a distance between parts that are
            // not where the assembly puts them.
            if (!measuring) setExplode(0);
            setMeasuring(!measuring);
            setPicks([]);
          }}
        >
          measure
        </button>
        <button
          className="btn btn--quiet btn--tiny"
          aria-pressed={section.on}
          title="cut the model with a plane to see inside it"
          onClick={() => setSection((s) => ({ ...s, on: !s.on }))}
        >
          section
        </button>
        {section.on && (
          <span className="cad-viewport__section">
            <select
              className="input"
              value={section.axis}
              onChange={(e) => setSection((s) => ({ ...s, axis: Number(e.target.value) as Axis }))}
              aria-label="section axis"
            >
              {AXES.map((a, i) => (
                <option key={a} value={i}>
                  {a}
                </option>
              ))}
            </select>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={section.t}
              onChange={(e) => setSection((s) => ({ ...s, t: Number(e.target.value) }))}
              aria-label="section offset"
            />
          </span>
        )}
        {measuring && !reading && <span>{picks.length === 0 ? "click a point" : "click a second point"}</span>}
        {selectedNodeId && data?.meshes[selectedNodeId]?.printability?.composite !== undefined && (
          <span title="DfAM printability (min-wall + overhang, CADClamp method): 1.0 prints clean, low values will fail on an FDM printer">
            printability {data.meshes[selectedNodeId]!.printability!.composite!.toFixed(2)}
          </span>
        )}
        {sceneError && <span className="cad-viewport__problem">{sceneError}</span>}
        {failedLoads.length > 0 && (
          <span className="cad-viewport__problem" title={failedLoads.map(([id, msg]) => `${id}: ${msg}`).join("\n")}>
            {failedLoads.length} part{failedLoads.length === 1 ? "" : "s"} failed to load
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
 * With nothing selected it writes the posed assembly: one STEP child or 3MF
 * object per placed part, one combined mesh for stl/obj.
 *
 * The server streams the kernel's file; the browser saves it. Nothing is
 * written into the project, so exporting can never disturb a graph.
 */
function ExportButton({ nodeId, partCount }: { nodeId: string | null; partCount: number }) {
  const [format, setFormat] = useState<string>("stl");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams(nodeId ? { node: nodeId } : {});
      const res = await fetch(`${API}/api/project/export/${format}?${q}`);
      if (!res.ok) {
        const body = (await res.json()) as { error?: string; hint?: string };
        setError(body.hint ? `${body.error} — ${body.hint}` : (body.error ?? "export failed"));
        return;
      }
      // A blob URL is same-origin, so the browser honours `download` — it
      // ignored the name on the old cross-origin link to the kernel.
      const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = filename ?? `patchcad.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      // e.g. imported mesh parts a STEP export had to leave out
      const warning = res.headers.get("x-patchcad-warning");
      if (warning) setError(warning);
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
        title="stl / 3mf / obj write a mesh for a slicer; step writes B-rep for another CAD tool, the whole assembly when nothing is selected"
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
