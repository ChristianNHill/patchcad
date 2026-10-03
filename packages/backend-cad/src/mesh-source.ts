import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GraphDoc, NodeRecord } from "@patchcad/shared";
import { envelopeAabb, type CadContractPayload } from "./index.js";
import { resolveDim, resolvePose } from "./bindings.js";
import type { KernelClient } from "./kernel.js";

/** Ports a generated mesh can honestly carry: the faces it mates on and the
 *  joint features segmentation cuts into it (holes, pegs, sockets). A bore a
 *  bearing presses into or a boss a screw threads is a functional feature, and
 *  belongs to a parametric neighbour. */
export const MESH_PORT_TYPES = new Set(["FLAT_FACE", "CLEARANCE_HOLE", "SHAFT", "BORE"]);

/** Phase 6.3: `geometrySource: "mesh"` nodes. Without a mesh provider every
 *  mesh node is an error, so the architect re-plans it parametric instead of
 *  a cook failing on a node nothing can build. */
export function meshSourceLint(meshGenConfigured: boolean) {
  return {
    run(graph: GraphDoc): string[] {
      const problems: string[] = [];
      for (const n of Object.values(graph.nodes)) {
        const payload = n.contract.payload as CadContractPayload | undefined;
        if (payload?.geometrySource !== "mesh") continue;
        if (!meshGenConfigured) {
          problems.push(
            `${n.id}: geometrySource "mesh" but mesh generation not configured. Plan it "parametric" and model organic surfaces with loft, sweep and revolve.`,
          );
        } else if (graph.brief.refs.length === 0) {
          problems.push(
            `${n.id}: geometrySource "mesh" but the goal came with no reference image, and mesh generation works from images. Plan it "parametric" and model organic surfaces with loft, sweep and revolve.`,
          );
        }
        for (const p of payload.ports ?? []) {
          if (!MESH_PORT_TYPES.has(p.type)) {
            problems.push(
              `${n.id}: a mesh node may only carry FLAT_FACE or joint ports (${[...MESH_PORT_TYPES].join(", ")}); port "${p.name}" is ${p.type}. Move that feature onto a parametric neighbour and mate the mesh to it.`,
            );
          }
        }
      }
      return problems;
    },
  };
}

/** The architect's paragraph on geometrySource. A function of availability
 *  only, so the system prompt is stable for a given configuration. */
export function geometrySourceGuidance(meshAvailable: boolean): string[] {
  if (!meshAvailable) {
    return [
      'GEOMETRY SOURCE: payload.geometrySource is "parametric" (build123d code)',
      'or "mesh". Mesh generation is NOT AVAILABLE in this installation: every',
      'part must be "parametric" (or omit the field). Model organic or sculpted',
      "shapes with loft, sweep and revolve through a few cross-sections, split",
      "into a handful of parts if one would be too complex to build.",
    ];
  }
  return [
    'GEOMETRY SOURCE: payload.geometrySource is "parametric" (build123d code)',
    'or "mesh". Mesh generation IS AVAILABLE for organic or sculpted shapes (a',
    "figurine, a creature's body, a carved handle): an image-to-3D model makes",
    "the surface from the reference images and the part's visualRef, and the",
    "kernel scales it into the envelope. A mesh part may carry ONLY FLAT_FACE",
    `and joint ports (${[...MESH_PORT_TYPES].join(", ")}), each FLAT_FACE axis-aligned and on the`,
    "envelope's outer face, where it is cut flat. Anything functional — a",
    "bore, a boss, a screw seat, a hinge, a battery bay — goes on a",
    '"parametric" neighbour that the mesh mates to. Everything else is',
    '"parametric" (or omit the field).',
  ];
}

/** What makes a mesh-source node's surface. The server adapts its configured
 *  MeshGenProvider to this, so the backend never sees a vendor. */
export interface MeshSource {
  generate(
    req: { node: NodeRecord; graph: GraphDoc; projectDir: string },
    signal?: AbortSignal,
  ): Promise<{ glb: Buffer; usd?: number }>;
}

export const isMeshNode = (node: NodeRecord) =>
  (node.contract.payload as CadContractPayload | undefined)?.geometrySource === "mesh";

/** Mesh nodes load their fitted surface like an imported piece. */
export const meshNodeCode = (node: NodeRecord) => `def build(p):\n    return load_import("${node.id}.ply")\n`;

/** The node frame the kernel fits a generated mesh into: the union box of the
 *  envelope, and every FLAT_FACE port as a plane to cut a flat at. */
export function meshFitRequest(graph: GraphDoc, node: NodeRecord) {
  const payload = node.contract.payload as CadContractPayload;
  const boxes = payload.envelope.volumes.map((v) => envelopeAabb(graph, v));
  const min = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]!)));
  const max = [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]!)));
  const flats = payload.ports
    .filter((p) => p.type === "FLAT_FACE")
    .map((p) => {
      const pose = resolvePose(graph, p.pose);
      const size = p.params.size ?? p.params.faceSize ?? p.params.face_size ?? 0;
      return { name: p.name, origin: [...pose.origin], normal: [...pose.zAxis], size: resolveDim(graph, size as number | string) };
    });
  return {
    box: { center: min.map((v, i) => (v + max[i]!) / 2), dims: min.map((v, i) => max[i]! - v) },
    flats,
  };
}

/**
 * Make sure imports/<id>.ply holds this node's fitted mesh, before the cook
 * builds `meshNodeCode`. The generator's raw GLB is kept in meshgen/<id>.glb
 * and is paid for ONCE: a changed envelope or port re-fits it in the kernel
 * at no cost, and only a missing GLB calls the source. Returns what the call
 * cost, or null when nothing was generated.
 */
export async function prepareMeshNode(opts: {
  node: NodeRecord;
  graph: GraphDoc;
  projectDir: string;
  kernel: KernelClient;
  source?: MeshSource;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<{ usd: number } | null> {
  const { node, graph, projectDir, kernel } = opts;
  const rawPath = path.join(projectDir, "meshgen", `${node.id}.glb`);
  const fitPath = path.join(projectDir, "meshgen", `${node.id}.fit.json`);
  const plyPath = path.join(projectDir, "imports", `${node.id}.ply`);

  let glb: Buffer | null = await readFile(rawPath).catch(() => null);
  let cost: { usd: number } | null = null;
  if (!glb) {
    if (!opts.source) throw new Error(`${node.id}: geometrySource "mesh" but mesh generation is not configured`);
    opts.log?.("generating mesh (image-to-3D)");
    const out = await opts.source.generate({ node, graph, projectDir }, opts.signal);
    glb = out.glb;
    cost = { usd: out.usd ?? 0 };
    await mkdir(path.dirname(rawPath), { recursive: true });
    await writeFile(rawPath, out.glb);
  }

  const bytes = glb;
  const fit = meshFitRequest(graph, node);
  const key = createHash("sha256").update(bytes).update(JSON.stringify(fit)).digest("hex");
  const fitted = await readFile(fitPath, "utf8").then((s) => JSON.parse(s) as { key?: string }, () => null);
  const plyExists = await readFile(plyPath).then(() => true, () => false);
  if (fitted?.key === key && plyExists) return cost;

  const result = await kernel.meshFit(bytes.toString("base64"), fit);
  if (!result.ok) throw new Error(`${node.id}: mesh fit failed at ${result.stage}: ${result.error}`);
  if (!result.watertight) opts.log?.("fitted mesh is NOT watertight after repair; G2 will say so");
  for (const note of result.notes) opts.log?.(`mesh fit: ${note}`);
  // Bigger than the printer: the node still cooks whole, and the server then
  // splits it (segment, joints "auto") into pieces joined by real hardware —
  // graph surgery, so it waits for the cook wave to settle (oversizeMeshSplit).
  const extents = result.bbox.max.map((v, i) => v - result.bbox.min[i]!);
  const pieces = splitPiecesFor(extents, buildVolumeOf(node));
  if (pieces !== 1) opts.log?.(`fitted mesh ${extents.map((v) => v.toFixed(0)).join("×")}mm exceeds the build volume: ${pieces ? `splits into ${pieces} jointed pieces after this cook` : "too big to split into 8 slabs"}`);
  await mkdir(path.dirname(plyPath), { recursive: true });
  await copyFile(path.join(result.dir, result.file), plyPath);
  await writeFile(fitPath, JSON.stringify({ key, scale: result.scale, faces: result.faces, extents, pieces }), "utf8");
  return cost;
}

/** Bambu/Prusa-ish, when a part's process names none. */
export const DEFAULT_BUILD_VOLUME_MM: [number, number, number] = [250, 250, 250];

export const buildVolumeOf = (node: NodeRecord): number[] =>
  (node.contract.payload as CadContractPayload).process?.buildVolumeMm ?? DEFAULT_BUILD_VOLUME_MM;

/** How many equal slabs along the longest axis make every piece fit the build
 *  volume in some axis-aligned orientation: 1 = it already fits, null = not
 *  even 8 do (the most segmentation cuts), because another axis is too big. */
export function splitPiecesFor(extents: number[], volume: number[]): number | null {
  const fits = (e: number[]) => {
    const a = [...e].sort((x, y) => x - y);
    const b = [...volume].sort((x, y) => x - y);
    return a.every((v, i) => v <= b[i]!);
  };
  const axis = extents.indexOf(Math.max(...extents));
  for (let n = 1; n <= 8; n++) {
    if (fits(extents.map((v, i) => (i === axis ? v / n : v)))) return n;
  }
  return null;
}

/** A ready mesh node the last fit found too big for its printer: how many
 *  pieces it splits into. Read by the server once a cook wave settles. */
export async function oversizeMeshSplit(projectDir: string, node: NodeRecord): Promise<number | null> {
  if (!isMeshNode(node) || node.status !== "ready") return null;
  const fit = await readFile(path.join(projectDir, "meshgen", `${node.id}.fit.json`), "utf8").then(
    (s) => JSON.parse(s) as { pieces?: number | null },
    () => null,
  );
  return fit?.pieces && fit.pieces > 1 ? fit.pieces : null;
}
