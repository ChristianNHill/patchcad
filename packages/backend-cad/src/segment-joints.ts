import type { NodeRecord } from "@patchcad/shared";
import type { CadContractPayload } from "./index.js";
import type { ImportInterface } from "./kernel.js";
import { CATALOG } from "./catalog.js";
import { FDM_FIT_CUT_MM, MACHINED_FIT_CUT_MM, majorDiameter } from "./grounding.js";
import { FDM_MIN_WALL_MM, selectJoint, type CadJoint, type JointInput, type JointProcess } from "./joints.js";
import { sourcingOf } from "./sourcing.js";

/**
 * Segmentation that joins its pieces with real hardware (Phase 4.6). The
 * kernel's `joints: "auto"` mode reports joint SITES on each cut (a disk of
 * material wide enough for any fastening rule, and how deep it runs into each
 * piece) and cuts nothing. Here each cut becomes one declared joint, the same
 * kind the architect declares, so the joint rules pick the hardware and
 * `expandJoints` mints it; the pieces' host features are then cut at execute
 * time by `importedNodeCode`, deterministically and with zero LLM calls.
 */

type CadPort = CadContractPayload["ports"][number];
type Vec = [number, number, number];

export interface ImportJointsOpts {
  idFor: (index: number) => string;
  /** How the pieces are made: the project's process, for the rules. */
  process: JointProcess;
  minWall?: number;
  thread: string;
  /** Joint ids already in the graph; new ones never collide with them. */
  taken: string[];
  /** The pieces' live scale, so the decision here is the one expansion makes. */
  scale?: number;
}

export interface ImportJoints {
  joints: CadJoint[];
  /** The face port each joint end names, per piece. */
  ports: Record<string, CadPort[]>;
  /** Points a piece's envelope must reach (a printed peg's tip), unscaled. */
  reach: Record<string, Vec[]>;
  /** Cuts that got no joint, and why. */
  notes: string[];
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** The deepest a joint's head or nut sits from the cut, in thread diameters. */
export const CLAMP_DIAMETERS = 4;

/** One joint per cut: a removable, light, both-sides fastener at the kernel's
 *  sites (two sites = one joint with count 2, so one screw node placed twice).
 *  When no fastening rule fits, an alignment dowel or printed peg, with the
 *  shortfall kept on the joint's `note`; when nothing fits, no joint. */
export function importJoints(interfaces: ImportInterface[], opts: ImportJointsOpts): ImportJoints {
  const out: ImportJoints = { joints: [], ports: {}, reach: {}, notes: [] };
  const taken = new Set(opts.taken);
  let next = 1;
  const minWall = opts.minWall ?? FDM_MIN_WALL_MM;
  const scale = opts.scale ?? 1;
  for (const itf of interfaces) {
    const sites = itf.candidates ?? [];
    const A = opts.idFor(itf.piece_a);
    const B = opts.idFor(itf.piece_b);
    if (sites.length === 0) {
      if (itf.candidates) out.notes.push(`${A}↔${B}: no site on the cut has room for a joint; the pieces only mate by the face`);
      continue;
    }
    while (taken.has(`j${next}`)) next++;
    const id = `j${next}`;
    taken.add(id);

    const centers = sites.map((s) => s.center as Vec);
    const mid = [0, 1, 2].map((i) => centers.reduce((t, c) => t + c[i]!, 0) / centers.length) as Vec;
    const normal = itf.normal as Vec;
    let xAxis: Vec = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let pitch: number | undefined;
    if (centers.length === 2) {
      const d = [0, 1, 2].map((i) => centers[1]![i]! - centers[0]![i]!) as Vec;
      pitch = round(Math.hypot(...d));
      xAxis = d.map((c) => round(c / pitch!)) as Vec;
    }
    // A thick piece does not take a screw as long as the piece: the head (or
    // nut) sits CLAMP_DIAMETERS·d in, down an access bore cut_joints opens to
    // the surface, so the stocked lengths always reach.
    const cap = CLAMP_DIAMETERS * majorDiameter(opts.thread);
    const wallA = Math.min(cap, ...sites.map((s) => s.wallA));
    const wallB = Math.min(cap, ...sites.map((s) => s.wallB));
    const scaled = (v: number, node: string): number | string => (v === 0 ? 0 : `expr: ${round(v)} * param(${node}.scale)`);
    const face = `face_${id}`;
    const port = (node: string, zAxis: Vec): CadPort => ({
      name: face,
      type: "FLAT_FACE",
      pose: { origin: mid.map((v) => scaled(v, node)) as Vec, zAxis, xAxis },
      // The expansion rings this face around the joint's features.
      params: { size: 0.6 },
    });

    const joint: CadJoint = {
      id,
      a: { node: A, port: face },
      b: { node: B, port: face },
      intent: "removable",
      motion: "fixed",
      duty: "occasional",
      load: "light",
      access: "both_sides",
      count: centers.length,
      ...(pitch ? { pitch } : {}),
      wallA: scaled(wallA, A),
      wallB: scaled(wallB, B),
      threadHint: opts.thread,
    };
    const input: JointInput = {
      id, intent: joint.intent, motion: "fixed", load: joint.load, access: joint.access,
      wallA: wallA * scale, wallB: wallB * scale, processA: opts.process, processB: opts.process,
      minWall, count: joint.count, threadHint: opts.thread,
    };
    let decision = selectJoint(input);
    if ("error" in decision) {
      const why = decision.error;
      joint.intent = "alignment";
      joint.note = `no fastener fits (${why}); alignment only`;
      decision = selectJoint({ ...input, intent: "alignment" });
      if ("error" in decision) {
        out.notes.push(`${A}↔${B}: no joint fits — ${why}; ${decision.error}`);
        continue;
      }
    }
    if (decision.recipe === "peg") {
      const tip = (c: Vec) => c.map((v, i) => round(v + normal[i]! * decision.dims.length!)) as Vec;
      (out.reach[A] ??= []).push(...centers.map(tip));
    }
    out.joints.push(joint);
    (out.ports[A] ??= []).push(port(A, normal));
    (out.ports[B] ??= []).push(port(B, normal.map((v) => -v || 0) as Vec));
  }
  return out;
}

// ---------- Deterministic host features ----------

/** A T1 dimension as Python over the node's own params, or null when it reads
 *  another node (the cut cannot follow it from inside build(p)). */
function py(v: unknown, id: string): string | null {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const body = v.startsWith("expr:") ? v.slice(5).trim() : v;
  let foreign = false;
  const out = body.replace(/param\(\s*([\w.-]+)\.(\w+)\s*\)/g, (_m, node: string, name: string) => {
    if (node !== id) foreign = true;
    return `p.${name}`;
  });
  if (foreign || !/^[\w\s.+\-*/()]+$/.test(out)) return null;
  return `(${out})`;
}

/** Ports whose feature the kernel already cut at segmentation (holes/pegs
 *  modes) or that are faces, not features. */
const preCut = (port: CadPort) => port.name.startsWith("joint_");

/** A head or a washer sits on these, so they get a spot face out to the
 *  surface: twice the clearance clears every stocked button head. */
const seated = (port: CadPort) => /_(head|back)(_\d+)?$/.test(port.name);

/** The cut list `cut_joints` takes, one Python dict per joint feature, each
 *  sized to the cut target (nominal + the process's fit offset, grounding.ts)
 *  so the G3 probe lands mid-band. */
export function jointCuts(node: NodeRecord): string[] {
  const payload = node.contract.payload as CadContractPayload | undefined;
  const s = sourcingOf(node);
  const fit = s.process === "cnc" || s.process === "sheet_metal" || s.process === "laser_cut" ? MACHINED_FIT_CUT_MM : FDM_FIT_CUT_MM;
  const cuts: string[] = [];
  for (const port of payload?.ports ?? []) {
    if (preCut(port)) continue;
    const q = (v: unknown) => py(v, node.id);
    const prm = (k: string) => q(port.params[k]);
    const plus = (e: string | null, k: number) => (e === null ? null : `${e} + ${k}`);
    let cut: Record<string, string | null> | null = null;
    switch (port.type) {
      case "CLEARANCE_HOLE": {
        const d = prm("diameter");
        cut = { kind: '"round"', d, depth: "None", access: seated(port) ? d && `2 * ${d} + 1.5` : "0" };
        break;
      }
      case "COUNTERBORE":
        cut = { kind: '"round"', d: prm("diameter"), depth: prm("depth"), through: prm("through_diameter"), access: prm("diameter") };
        break;
      case "INSERT_POCKET":
        cut = { kind: '"round"', d: prm("diameter"), depth: plus(prm("depth"), 0.5) };
        break;
      case "NUT_TRAP": {
        // Axial traps only: a side-entry channel is not cut here, so G3 says so.
        if (port.params.entry === "side") break;
        const af = plus(prm("af"), fit.nutTrapAf);
        cut = { kind: '"hex"', d: af, depth: plus(prm("depth"), 0.2), access: af && `(${af}) * 1.155 + 0.4` };
        break;
      }
      case "DOWEL_HOLE":
        cut = { kind: '"round"', d: plus(prm("diameter"), port.params.fit === "slip" ? fit.slip : fit.press), depth: plus(prm("depth"), 0.3) };
        break;
      case "BORE":
        cut = { kind: '"round"', d: prm("diameter"), depth: port.params.depth === undefined ? "None" : prm("depth") };
        break;
      case "SHAFT":
        cut = { kind: '"peg"', d: prm("diameter"), depth: prm("length") };
        break;
      case "THREADED_HOLE": {
        const tap = CATALOG.threads[String(port.params.thread)]?.tapDrill;
        cut = { kind: '"round"', d: tap === undefined ? null : String(tap), depth: plus(prm("depth"), 0.5) };
        break;
      }
    }
    if (!cut) continue;
    const frame = { o: port.pose.origin, z: port.pose.zAxis, x: port.pose.xAxis };
    const vecs = Object.entries(frame).map(([k, v]) => [k, v.map(q)] as const);
    if (Object.values(cut).some((e) => e === null) || vecs.some(([, v]) => v.some((e) => e === null))) continue;
    const fields = [...vecs.map(([k, v]) => `"${k}": [${v.join(", ")}]`), ...Object.entries(cut).map(([k, e]) => `"${k}": ${e}`)];
    cuts.push(`{${fields.join(", ")}}`);
  }
  return cuts;
}

/** What an imported piece's build(p) returns: its mesh at scale, minus (or
 *  plus, for a printed peg) the host features of every joint it takes part in. */
export function importedPartExpr(node: NodeRecord): string {
  const load = `load_import("${node.id}.ply", scale=p.scale)`;
  const cuts = jointCuts(node);
  if (cuts.length === 0) return load;
  return `cut_joints(${load}, [\n${cuts.map((c) => `        ${c},`).join("\n")}\n    ])`;
}

export const importedNodeCode = (node: NodeRecord) => `def build(p):\n    return ${importedPartExpr(node)}\n`;
