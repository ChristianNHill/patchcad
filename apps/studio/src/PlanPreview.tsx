import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Edges, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { API } from "./api";
import { BusyButton } from "./BusyButton.js";
import { BASE, FitCamera, INK, ViewportBoundary } from "./CadViewport.js";

/**
 * The approval modal's look at the plan before anything is cooked: every
 * node's envelope, posed by the plan's mates (server-side solve, no model, no
 * kernel). Generated-mesh nodes draw in ink, parametric ones in graphite. A
 * mesh node can also fetch a paid low-poly draft from the mesh provider,
 * shown fitted into its envelope.
 */

interface Primitive {
  kind: "box" | "cylinder";
  size: [number, number, number];
  matrix: number[];
}
interface PreviewNode {
  id: string;
  title: string;
  geometrySource: "parametric" | "mesh";
  primitives: Primitive[];
}
interface Preview {
  nodes: PreviewNode[];
  problems: string[];
  meshGen: string | null;
}

const loader = new GLTFLoader();
const MESH = new THREE.Color(INK);

/** A unit box, or a unit cylinder turned from three's +y axis onto our +z. */
function primitiveMatrix(p: Primitive): THREE.Matrix4 {
  const m = new THREE.Matrix4().fromArray(p.matrix).multiply(new THREE.Matrix4().makeScale(...p.size));
  if (p.kind === "cylinder") m.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  return m;
}

function Envelope({ p, mesh, faint }: { p: Primitive; mesh: boolean; faint: boolean }) {
  const matrix = useMemo(() => primitiveMatrix(p), [p]);
  return (
    <mesh matrix={matrix} matrixAutoUpdate={false}>
      {p.kind === "box" ? <boxGeometry args={[1, 1, 1]} /> : <cylinderGeometry args={[0.5, 0.5, 1, 32]} />}
      <meshStandardMaterial color={mesh ? MESH : BASE} transparent opacity={faint ? 0.12 : mesh ? 0.55 : 0.8} />
      <Edges color={INK} />
    </mesh>
  );
}

/** A draft GLB (glTF: Y-up, arbitrary units) fitted the way the kernel fits
 *  the real one: Z-up, uniformly scaled into the envelope, centred in it. */
function DraftMesh({ scene, p }: { scene: THREE.Group; p: Primitive }) {
  const object = useMemo(() => {
    const inner = scene.clone();
    inner.rotation.x = Math.PI / 2;
    inner.updateMatrixWorld(true);
    inner.traverse((c) => {
      if (c instanceof THREE.Mesh) c.material = new THREE.MeshStandardMaterial({ color: MESH });
    });
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    const s = Math.min(p.size[0] / size.x, p.size[1] / size.y, p.size[2] / size.z);
    const fitted = new THREE.Group();
    fitted.add(inner);
    fitted.scale.setScalar(s);
    fitted.position.copy(box.getCenter(new THREE.Vector3()).multiplyScalar(-s));
    // Centred on the envelope primitive's origin, then posed with it.
    const root = new THREE.Group();
    root.add(fitted);
    root.matrix.fromArray(p.matrix);
    root.matrixAutoUpdate = false;
    return root;
  }, [scene, p]);
  return <primitive object={object} />;
}

function PlanPreviewInner({ planKey }: { planKey: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, THREE.Group>>({});
  const [spent, setSpent] = useState(0);
  /** A failed draft is one button's problem, not the whole preview's. */
  const [draftError, setDraftError] = useState<string | null>(null);
  const currentKey = useRef(planKey);
  currentKey.current = planKey;

  useEffect(() => {
    let live = true;
    setPreview(null);
    setError(null);
    setDrafts({});
    setDraftError(null);
    fetch(`${API}/api/project/plan/preview`, { method: "POST" })
      .then(async (res) => {
        const data = await res.json();
        if (!live) return;
        if (!res.ok) setError(data.error ?? `preview failed (${res.status})`);
        else setPreview(data as Preview);
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [planKey]);

  const box = useMemo(() => {
    const b = new THREE.Box3();
    for (const n of preview?.nodes ?? []) {
      for (const p of n.primitives) b.union(new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(primitiveMatrix(p)));
    }
    return b;
  }, [preview]);

  const generateDraft = async (id: string) => {
    const key = planKey;
    setDraftError(null);
    try {
      const res = await fetch(`${API}/api/project/plan/preview-mesh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: id }),
      });
      const data = await res.json();
      // A draft of a plan that has since been replaced belongs to nothing.
      if (currentKey.current !== key) return;
      if (!res.ok) return setDraftError(data.error ?? `draft failed (${res.status})`);
      const bytes = Uint8Array.from(atob(data.glbB64), (c) => c.charCodeAt(0));
      const gltf = await loader.parseAsync(bytes.buffer, "");
      if (currentKey.current !== key) return;
      setDrafts((d) => ({ ...d, [id]: gltf.scene }));
      setSpent((s) => s + (data.usd ?? 0));
    } catch (err) {
      if (currentKey.current === key) setDraftError((err as Error).message);
    }
  };

  if (error) return <div className="plan-preview__note">preview unavailable: {error}</div>;
  if (!preview) return <div className="plan-preview plan-preview--loading" aria-busy="true" />;
  const meshNodes = preview.nodes.filter((n) => n.geometrySource === "mesh");

  return (
    <>
      <div className="plan-preview" aria-label="plan envelopes, posed">
        <Canvas camera={{ position: [90, -90, 80], up: [0, 0, 1], fov: 40, near: 0.1, far: 5000 }}>
          <ambientLight intensity={0.7} />
          <directionalLight position={[100, -60, 140]} intensity={1.2} />
          {preview.nodes.flatMap((n) =>
            n.primitives.map((p, i) => (
              <Envelope key={`${n.id}-${i}`} p={p} mesh={n.geometrySource === "mesh"} faint={drafts[n.id] != null} />
            )),
          )}
          {preview.nodes.flatMap((n) => {
            const draft = drafts[n.id];
            return draft && n.primitives[0] ? [<DraftMesh key={`${n.id}-draft`} scene={draft} p={n.primitives[0]} />] : [];
          })}
          <FitCamera box={box} partsKey={planKey} />
          <OrbitControls makeDefault />
        </Canvas>
      </div>
      <div className="plan-preview__note">
        envelopes only, posed by the plan's mates
        {meshNodes.length > 0 && " · dark = generated mesh"}
        {preview.problems.length > 0 && ` · ${preview.problems.length} assembly problem${preview.problems.length > 1 ? "s" : ""}`}
      </div>
      {meshNodes.length > 0 && preview.meshGen && (
        <div className="plan-preview__drafts">
          {meshNodes.map((n) => (
            <BusyButton key={n.id} onClick={() => generateDraft(n.id)} busyLabel={`generating ${n.title}…`} disabled={drafts[n.id] != null}>
              generate preview mesh: {n.title} (paid {preview.meshGen} call)
            </BusyButton>
          ))}
          {spent > 0 && <span className="plan-preview__note">preview meshes ≈ ${spent.toFixed(2)}</span>}
          {draftError && <span className="plan-preview__note">draft failed: {draftError}</span>}
        </div>
      )}
    </>
  );
}

export function PlanPreview({ planKey }: { planKey: string }) {
  return (
    <ViewportBoundary>
      <PlanPreviewInner planKey={planKey} />
    </ViewportBoundary>
  );
}
