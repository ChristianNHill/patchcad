import { z } from "zod";
import type { GraphDoc, NodeRecord, ParamValue } from "@patchcad/shared";

export * from "./kernel.js";
export * from "./registry.js";
export * from "./assembly.js";
export * from "./bindings.js";
export { normalizeCadCode } from "./prompts.js";
import type {
  CheckResult,
  LlmImage,
  DomainBackend,
  ExecuteResult,
  FailureClass,
  GenerateCtx,
  PromptSpec,
  RepairCtx,
  VerifyResult,
  Workspace,
} from "@patchcad/engine";

/**
 * CAD backend — interface-proving stub (CAD-M1+ makes it real).
 * The payload schema is the real design: typed ports as declarations in
 * SE(3) plus a claimed envelope. Compiling this package against
 * DomainBackend keeps the engine from growing web-code assumptions.
 */

/** Pose/envelope components may be numbers or T1 expressions
 * ("param(base-plate.thickness) / 2") — resolved against live params before
 * probing or assembly, so geometry declarations track their parameters. */
export const Dim = z.union([z.number(), z.string()]);

export const Pose = z.object({
  origin: z.tuple([Dim, Dim, Dim]),
  zAxis: z.tuple([Dim, Dim, Dim]),
  xAxis: z.tuple([Dim, Dim, Dim]),
});
export type Pose = z.infer<typeof Pose>;

export const CadPortType = z.enum([
  "FLAT_FACE",
  "SCREW_BOSS",
  "CLEARANCE_HOLE",
  "SCREW_SEAT",
  "BORE",
  "SHAFT",
  "SLOT",
  "SNAP_HOOK",
  "SNAP_RECESS",
  "LIP",
  "GROOVE",
  "HOLE_PATTERN",
  "BOSS_PATTERN",
]);

export const CadPort = z.object({
  name: z.string(),
  type: CadPortType,
  pose: Pose,
  params: z.record(z.union([z.number(), z.string()])).default({}),
});

export const EnvelopePrimitive = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("box"),
    pose: Pose,
    dims: z.tuple([Dim, Dim, Dim]),
  }),
  z.object({
    kind: z.literal("cylinder"),
    pose: Pose,
    d: Dim,
    h: Dim,
  }),
]);

export const CadContractPayload = z.object({
  units: z.literal("mm"),
  process: z.object({
    kind: z.literal("FDM"),
    minWall: z.number().default(1.2),
    nozzle: z.number().default(0.4),
  }),
  ports: z.array(CadPort),
  envelope: z.object({
    volumes: z.array(EnvelopePrimitive).min(1).max(4),
    clearance: z.number().default(0.4),
  }),
  /** Symbolic bindings resolved by the kernel from upstream contracts (T1). */
  paramBindings: z.record(z.string()).default({}),
});
export type CadContractPayload = z.infer<typeof CadContractPayload>;

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { KernelClient, type ExportResult, type KernelResult } from "./kernel.js";
import { generatePrompt, repairPrompt } from "./prompts.js";
import { FASTENING_HARDWARE, REGISTRY_HARDWARE, resolveDeterministic } from "./registry.js";
import { solveAssembly, type AssemblyMate, type AssemblyNode } from "./assembly.js";
import { resolveDim, resolvePose } from "./bindings.js";

/**
 * One name per port, everywhere: contract provides/requires keys, payload
 * geometric ports, and edge endpoints must agree exactly — the assembly
 * solver and the G3 probes both key on payload port names. Runs at plan time
 * so a mismatch becomes an architect repair round, never a hand fix.
 * Fasteners are exempt (registry geometry, no probed ports by convention).
 */
export const cadPortConsistencyLint = {
  id: "cad-port-consistency",
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    const payloadNames = new Map<string, Set<string>>();
    for (const n of Object.values(graph.nodes)) {
      const payload = n.contract.payload as CadContractPayload;
      const names = new Set((payload.ports ?? []).map((p) => p.name));
      payloadNames.set(n.id, names);
      // Hardware declares no geometric ports; probes do not apply to it.
      if (REGISTRY_HARDWARE.has(n.kind)) continue;
      for (const port of [...n.contract.provides, ...n.contract.requires]) {
        if (!names.has(port.key)) {
          problems.push(
            `${n.id}: contract port "${port.key}" has no payload.ports entry of the same name — port names must match EXACTLY across contract, payload, and edges`,
          );
        }
      }
    }
    for (const e of graph.edges) {
      const from = graph.nodes[e.from];
      const to = graph.nodes[e.to];
      if (from && !REGISTRY_HARDWARE.has(from.kind) && !payloadNames.get(e.from)?.has(e.fromPort)) {
        problems.push(`edge ${e.from}.${e.fromPort} → ${e.to}: "${e.fromPort}" is not a payload port name of ${e.from}`);
      }
      // HARDWARE IS NOT EXEMPT FROM THE EDGE CHECK, only from the
      // contract-vs-payload one above. examples/cad-clamp's m4-screw declares a
      // real `head_seat` payload port and its edge names it, so hardware does
      // carry ports and an edge naming one that is absent is simply wrong.
      //
      // This exemption let plate-a.screw_hole → screw-m4.hole through a whole
      // cook against a screw declaring NO ports, and the assembly reported
      // "missing port" with both fasteners left at the origin.
      //
      // My first attempt at this rejected every edge to hardware instead, which
      // deadlocked against cad-fastener-justified: that lint requires a fastener
      // to be wired to something, so a fastener could be neither wired nor
      // unwired and no plan containing one was possible. The architect burned
      // three repair rounds and planning failed outright. Requiring the NAME to
      // exist leaves both lints satisfiable together, which is the whole point.
      if (to && !payloadNames.get(e.to)?.has(e.toPort)) {
        problems.push(
          `edge ${e.from} → ${e.to}.${e.toPort}: "${e.toPort}" is not a payload port name of ${e.to}` +
            (REGISTRY_HARDWARE.has(to.kind)
              ? `. ${e.to} is ${to.kind}: give it the seat port the edge names (examples/cad-clamp's screw declares head_seat), or wire to a different node.`
              : ""),
        );
      }
    }
    return problems;
  },
};

/** The hole-like ports a screw actually fastens into. */
const FASTENED_PORT_TYPES = new Set(["CLEARANCE_HOLE", "SCREW_SEAT", "SCREW_BOSS", "BORE"]);

/**
 * Hardware has to fasten something. The vocabulary handed to the architect is
 * screw-heavy by construction — hardware is most of the node taxonomy and most
 * of the paramBindings examples are threads and lengths — so weaker plans
 * sprout decorative screws that no part has a hole for. Runs at plan time, so
 * unjustified hardware becomes an architect repair round rather than a node
 * the user has to notice and delete. Nuts and inserts earn the same check: one
 * wired to nothing is exactly as decorative as a floating screw.
 */
export const cadFastenerJustifiedLint = {
  id: "cad-fastener-justified",
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    const holePorts = (id: string) =>
      ((graph.nodes[id]?.contract.payload as CadContractPayload | undefined)?.ports ?? []).filter((p) =>
        FASTENED_PORT_TYPES.has(p.type),
      );
    for (const n of Object.values(graph.nodes)) {
      if (!FASTENING_HARDWARE.has(n.kind)) continue;
      const neighbors = graph.edges
        .filter((e) => e.from === n.id || e.to === n.id)
        .map((e) => (e.from === n.id ? e.to : e.from));
      if (neighbors.length === 0) {
        problems.push(
          `${n.id}: ${n.kind} is wired to nothing. Hardware is optional — join the parts it belongs to through their hole ports, or drop the node (a one-piece, press-fit, or snap-fit design needs none).`,
        );
        continue;
      }
      if (!neighbors.some((id) => holePorts(id).length > 0)) {
        problems.push(
          `${n.id}: ${n.kind} connects only to ${neighbors.join(", ")}, none of which declare a CLEARANCE_HOLE / SCREW_SEAT / SCREW_BOSS / BORE port for it to fasten into. Add the hole ports to the parts being joined, or drop the ${n.kind}.`,
        );
      }
    }
    return problems;
  },
};

/**
 * The envelope is the only thing standing between the architect's imagination
 * and a part the generator cannot possibly build, and G4 grades the part
 * against it on every single attempt. Two ways it goes wrong, both of which
 * cost a whole repair budget and neither of which the generator can see:
 *
 *  - Drawn in disconnected pieces. A union with a gap asks for a part that
 *    spans empty space. Seen live: cylinders over z [-8, 0] and [3.25, 4.75].
 *  - Drawn somewhere the part's own ports aren't, which is self-contradictory.
 *
 * Runs at plan time, so either becomes an architect repair round instead of
 * five generator rounds that cannot succeed.
 */
const ENVELOPE_LINT_MARGIN = 0.5;

interface Aabb {
  min: [number, number, number];
  max: [number, number, number];
}

function envelopeAabb(graph: GraphDoc, vol: z.infer<typeof EnvelopePrimitive>): Aabb {
  const o = resolvePose(graph, vol.pose).origin;
  const half: [number, number, number] =
    vol.kind === "box"
      ? [resolveDim(graph, vol.dims[0]) / 2, resolveDim(graph, vol.dims[1]) / 2, resolveDim(graph, vol.dims[2]) / 2]
      : [resolveDim(graph, vol.d) / 2, resolveDim(graph, vol.d) / 2, resolveDim(graph, vol.h) / 2];
  return {
    min: [o[0] - half[0], o[1] - half[1], o[2] - half[2]],
    max: [o[0] + half[0], o[1] + half[1], o[2] + half[2]],
  };
}

const overlaps = (a: Aabb, b: Aabb, slack: number) =>
  [0, 1, 2].every((i) => a.min[i]! - slack <= b.max[i]! && b.min[i]! - slack <= a.max[i]!);

export const cadEnvelopeCoherentLint = {
  id: "cad-envelope-coherent",
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    for (const n of Object.values(graph.nodes)) {
      // Registry hardware skips G4 entirely, so its envelope grades nothing.
      if (REGISTRY_HARDWARE.has(n.kind)) continue;
      const volumes = (n.contract.payload as CadContractPayload | undefined)?.envelope?.volumes ?? [];
      if (volumes.length === 0) continue;

      let boxes: Aabb[];
      try {
        boxes = volumes.map((v) => envelopeAabb(graph, v));
      } catch {
        continue; // unresolvable expression — not this lint's business
      }

      // Every declared port is a feature ON this part, so it cannot sit
      // outside the volume the part is promised to fit in. (Note there is
      // deliberately NO "envelope must contain the origin" check: parts are
      // legitimately modelled base-at-origin, and imported pieces keep their
      // source model's frame, so origin placement carries no signal.)
      for (const port of (n.contract.payload as CadContractPayload).ports ?? []) {
        let o: [number, number, number];
        try {
          o = resolvePose(graph, port.pose).origin;
        } catch {
          continue;
        }
        const inside = boxes.some((b) =>
          [0, 1, 2].every(
            (i) => o[i]! >= b.min[i]! - ENVELOPE_LINT_MARGIN && o[i]! <= b.max[i]! + ENVELOPE_LINT_MARGIN,
          ),
        );
        if (!inside) {
          problems.push(
            `${n.id}: port "${port.name}" sits at [${o.map((v) => v.toFixed(1)).join(", ")}], outside this node's own envelope. A port is a feature of the part, so either the pose or the envelope is wrong.`,
          );
        }
      }

      // Union must be one connected region: a gap asks for a part spanning air.
      if (boxes.length > 1) {
        const seen = new Set<number>([0]);
        const queue = [0];
        while (queue.length) {
          const i = queue.pop()!;
          boxes.forEach((b, j) => {
            if (!seen.has(j) && overlaps(boxes[i]!, b, ENVELOPE_LINT_MARGIN)) {
              seen.add(j);
              queue.push(j);
            }
          });
        }
        if (seen.size < boxes.length) {
          problems.push(
            `${n.id}: envelope volumes are disjoint — ${boxes
              .map((b) => `z [${b.min[2]!.toFixed(1)}, ${b.max[2]!.toFixed(1)}]`)
              .join(" and ")} do not meet. A part cannot span the gap between them; overlap the volumes or use one that covers the whole part.`,
          );
        }
      }
    }
    return problems;
  },
};

/**
 * Every probed port type needs the one param its probe measures against.
 * A hole without a diameter and a flat face without a size are the same
 * mistake, and both are silent until a cook is already burning rounds: the
 * gate can only say the declaration is unusable, never what the part should
 * have been. Catching it at plan time turns it into an architect repair.
 */
const HOLE_PORT_TYPES = new Set(["CLEARANCE_HOLE", "SCREW_SEAT", "BORE", "HOLE_PATTERN"]);
const DIAMETER_KEYS = ["diameter", "dia", "holeDia", "hole_diameter", "d", "boreDia"];
const FACE_SIZE_KEYS = ["size", "faceSize", "face_size", "width", "flatWidth", "flat_width"];
const CHANNEL_PORT_TYPES = new Set(["GROOVE", "SLOT"]);
// Mirrors gates.py's OUTER_D_KEYS across the language boundary, with no import
// path between them. The drift is asymmetric: a lint list WIDER than the probe's
// only lets a port through to fail at G3, while a lint list NARROWER than the
// probe's blocks a plan the probe could have measured. So if these ever diverge,
// widen this one. Bare "diameter" is deliberately absent from both, and dropping
// it from one alone would have created exactly the narrower case.
export const OUTER_DIAMETER_KEYS = ["outer_diameter", "outerDiameter", "od", "boss_diameter", "bossDiameter"];
const CHANNEL_WIDTH_KEYS = ["width", "slotWidth", "slot_width", "grooveWidth", "groove_width", "channelWidth"];

export const cadFlatFaceSizeLint = {
  id: "cad-port-params",
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    for (const n of Object.values(graph.nodes)) {
      if (REGISTRY_HARDWARE.has(n.kind)) continue;
      for (const p of (n.contract.payload as CadContractPayload | undefined)?.ports ?? []) {
        const keys = Object.keys(p.params ?? {});
        if (p.type === "FLAT_FACE") {
          if (!keys.some((k) => FACE_SIZE_KEYS.includes(k)) && !keys.includes("ring_diameter")) {
            problems.push(
              `${n.id}: FLAT_FACE port "${p.name}" declares no face size (params: ${JSON.stringify(keys)}). Add params.size — the width in mm of the flat the mating part sits on — or params.ring_diameter for an annular seat.`,
            );
          }
        } else if (HOLE_PORT_TYPES.has(p.type)) {
          if (!keys.some((k) => DIAMETER_KEYS.includes(k))) {
            problems.push(
              `${n.id}: ${p.type} port "${p.name}" declares no diameter (params: ${JSON.stringify(keys)}). Add params.diameter in mm — probes measure the hole against it.`,
            );
          }
        } else if (p.type === "SCREW_BOSS") {
          // The last probed type with no branch here, found by auditing the
          // probed set against this lint rather than by anything failing. Worse
          // than the SHAFT gap was: _probe_boss indexed params["outer_diameter"]
          // raw, so a missing key raised KeyError and reached the model as a
          // stage-G1 surprise instead of a repairable G3. The probe reads through
          // the alias helper now, and this stops it at plan time.
          if (!keys.some((k) => OUTER_DIAMETER_KEYS.includes(k))) {
            problems.push(
              `${n.id}: SCREW_BOSS port "${p.name}" declares no outer diameter (params: ${JSON.stringify(keys)}). Add params.outer_diameter in mm — the boss wall diameter the probe measures.`,
            );
          }
        } else if (p.type === "SHAFT") {
          // The emitter is the IMPORT path (main.ts), which never runs a lint,
          // and imported nodes resolve deterministically with no repair round.
          // So a SHAFT missing its diameter would sail through plan time and die
          // at G3 as an unrecoverable error_code. Live SHAFT ports all carry a
          // diameter today; this is the guard for the first one that does not.
          if (!keys.some((k) => DIAMETER_KEYS.includes(k))) {
            problems.push(
              `${n.id}: SHAFT port "${p.name}" declares no diameter (params: ${JSON.stringify(keys)}). Add params.diameter in mm — the peg diameter at its base, which the probe measures against.`,
            );
          }
        } else if (CHANNEL_PORT_TYPES.has(p.type)) {
          if (!keys.some((k) => CHANNEL_WIDTH_KEYS.includes(k))) {
            problems.push(
              `${n.id}: ${p.type} port "${p.name}" declares no width (params: ${JSON.stringify(keys)}). Add params.width in mm — the gap a mating tongue sits in, which the probe measures against.`,
            );
          }
        }
      }
    }
    return problems;
  },
};

/** The port types the kernel can actually MEASURE (gates.py: HOLE_LIKE, plus the
 * FLAT_FACE and SCREW_BOSS branches of g3_ports). Everything else in CadPortType
 * falls through g3_ports' else-branch and is recorded "skipped" — the job still
 * passes. A contract built from unprobed ports is verified by nothing: a solid
 * brick satisfies it, which is exactly how a 75x75x95 block once passed as a pen
 * cup holder with hexagonal cutouts.
 *
 * So the taxonomy is narrowed to what the gates can defend. Widen this set in
 * the same commit that adds a probe, NEVER before it — a type listed here with
 * nothing behind it re-opens the hole silently. */
const PROBED_PORT_TYPES = new Set([
  "CLEARANCE_HOLE",
  "BORE",
  "SCREW_SEAT",
  "SCREW_BOSS",
  "FLAT_FACE",
  // Channel types, measured by _probe_channel: void at the pose, walls found by
  // marching out to each side, width compared against the declaration. Added
  // here in the same change that added the probe — this set is a claim about
  // what the kernel can defend, so it must never run ahead of gates.py.
  "GROOVE",
  "SLOT",
  // A peg standing out of a mating face, measured by _probe_shaft: diameter as
  // the median over 8 outward rays at the peg's true mid-height, plus the tip.
  // Added because --score-projects found 14 SHAFT ports live on disk, all
  // reporting "no probe for this type yet". They got there without the
  // architect: main.ts emits SHAFT directly for every peg joint on the IMPORT
  // path, which never runs this lint, so the peg side of a peg joint was
  // unverifiable by construction while its socket (a BORE) was measured.
  "SHAFT",
]);

/** A FLAT_FACE cannot be solid where a hole passes through it.
 *
 *  Found by paying for it. The eval harness ran "a 60mm square plate 5mm thick
 *  with a 6mm hole in the middle" twice, $0.82 total, and both runs failed. The
 *  architect declared a BORE and a FLAT_FACE at the SAME origin, and those two
 *  probes want opposite things at that point: the face probe samples material
 *  across the face including its centre, and the bore removes exactly that
 *  material. The first run spent 5 generator calls and landed in error_contract,
 *  which was the CORRECT attribution. The second spent 4 and "succeeded" by
 *  bridging the bore with a 0.35mm web to satisfy the face, so the part reported
 *  a Ø6 bore that does not go through.
 *
 *  Nothing detected the contradiction, so the cost was paid in generator calls
 *  instead of a lint round. A FLAT_FACE means "this whole disc is material", so
 *  it must not share its origin with a hole. Offsetting the face, shrinking its
 *  size, or dropping one of the two all resolve it, and the architect can do any
 *  of them for free at plan time.
 */
export const cadFaceHoleConflictLint = {
  id: "cad-face-hole-conflict",
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    const HOLE_LIKE = new Set(["CLEARANCE_HOLE", "BORE", "SCREW_SEAT"]);
    for (const n of Object.values(graph.nodes)) {
      if (REGISTRY_HARDWARE.has(n.kind)) continue;
      const ports = (n.contract.payload as CadContractPayload | undefined)?.ports ?? [];
      const faces = ports.filter((p) => p.type === "FLAT_FACE");
      const holes = ports.filter((p) => HOLE_LIKE.has(p.type));
      for (const f of faces) {
        for (const h of holes) {
          // A shared origin is one case. The other, which cost $1.03 and ten
          // generator calls to learn, is a CLEARANCE_HOLE COAXIAL with a face at
          // any axial distance: a clearance hole must pass through, so it pierces
          // every face its axis crosses, not only the one it shares an origin
          // with. plate-a declared screw_hole at +t/2 and mating_face at -t/2 and
          // died contract-infeasible after five calls on "no material just below
          // the declared face".
          //
          // Coaxial is decided on the LATERAL components only, so no size or
          // expression resolution is needed: if the hole's axis passes through
          // the face's centre, the face probe's centre sample is void whatever
          // the declared size. A blind BORE or SCREW_SEAT is exempt because it
          // stops, which is why this widening is safe for a plan blocker.
          const parallel = ["0", "1", "2"].every(
            (i) => Math.abs(Number(f.pose.zAxis[Number(i)] ?? 0)) === Math.abs(Number(h.pose.zAxis[Number(i)] ?? 0)),
          );
          const axis = [0, 1, 2].findIndex((i) => Math.abs(Number(h.pose.zAxis[i] ?? 0)) > 0.5);
          const lateralSame =
            axis >= 0 &&
            [0, 1, 2].every(
              (i) => i === axis || String(f.pose.origin[i]) === String(h.pose.origin[i]),
            );
          const sameOrigin = ["0", "1", "2"].every(
            (i) => String(f.pose.origin[Number(i)]) === String(h.pose.origin[Number(i)]),
          );
          // AN ANNULAR FACE IS EXEMPT. `ring_diameter` switches the probe to a
          // ring of samples and it never touches the centre, so a hole up the
          // middle is not merely tolerable, it is the point: examples/cad-clamp's
          // m4-screw declares head_seat as a FLAT_FACE with ring_diameter 5.5,
          // which is a screw's bearing annulus around its own shank. Without
          // this, the widening below would reject the reference design's own
          // idiom the moment a seat and its clearance hole shared a part.
          const annular = (f.params as { ring_diameter?: unknown } | undefined)?.ring_diameter != null;
          const coaxialThrough =
            !annular && h.type === "CLEARANCE_HOLE" && parallel && lateralSame;
          if (sameOrigin || coaxialThrough)
            problems.push(
              sameOrigin
                ? `${n.id}: port "${f.name}" (FLAT_FACE) and port "${h.name}" (${h.type}) share an origin, ` +
                    `so no geometry satisfies both: the face probe requires material at that point and the ` +
                    `hole removes it. Offset the face, shrink its size below the hole, or drop one of them.`
                : `${n.id}: port "${h.name}" (CLEARANCE_HOLE) is coaxial with port "${f.name}" (FLAT_FACE), ` +
                    `so no geometry satisfies both: a clearance hole passes through, which pierces that face ` +
                    `at its centre where the probe samples. Move the face off the hole axis, or declare the ` +
                    `hole a BORE or SCREW_SEAT if it is meant to stop before that face.`,
            );
        }
      }
    }
    return problems;
  },
};

export const cadProbedPortsLint = {
  id: "cad-probed-ports",
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    const verified = [...PROBED_PORT_TYPES].join(", ");
    for (const n of Object.values(graph.nodes)) {
      if (REGISTRY_HARDWARE.has(n.kind)) continue;
      for (const p of (n.contract.payload as CadContractPayload | undefined)?.ports ?? []) {
        if (!PROBED_PORT_TYPES.has(p.type)) {
          // LIP gets a named substitution rather than the generic list, because
          // it is the one unprobed type that graphs on disk actually use, and it
          // is not one feature. Its six live instances carry three different
          // vocabularies covering OPPOSITE geometries: a raised annular rim
          // (rimOuterDiameter/rimInnerDiameter/rimHeight), a recess that
          // receives one (recessOuterDiameter/recessDepth/fitClearance), and
          // diameter/depth used for BOTH a plug and the seat it enters. So no
          // single probe can verify a LIP: the contract never says which side of
          // the joint it is. Every live instance is round, so each is already
          // expressible as the male or female type that IS measured.
          const hint =
            p.type === "LIP"
              ? `A LIP is not one feature — on disk it means a raised rim, a recess that receives one, and a plug, all under one name, so no probe can know which side of the joint it is. Split it: the part that stands proud is a SHAFT (diameter, length), the part that receives it is a BORE (diameter). That names the fit, and both are measured.`
              : `Re-express this interface with a type the probes measure (${verified}), or drop the port and model the feature as part of one solid.`;
          problems.push(
            `${n.id}: port "${p.name}" is a ${p.type}, which no gate can measure — a node whose ports are all unprobed passes verify even if the geometry is a featureless block. ${hint}`,
          );
        }
      }
    }
    return problems;
  },
};

/** Port params may hold expressions too (a hole Ø bound to the param that
 * drills it); non-arithmetic strings (thread names) pass through untouched. */
function resolvePortParams(graph: GraphDoc, params: Record<string, number | string>) {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "number") {
      out[k] = v;
    } else {
      try {
        out[k] = resolveDim(graph, v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Contract payload → the kernel's probe wire format, expressions resolved. */
function kernelPorts(graph: GraphDoc, payload: CadContractPayload) {
  return payload.ports.map((p) => ({
    key: p.name,
    type: p.type,
    pose: resolvePose(graph, p.pose),
    params: resolvePortParams(graph, p.params),
  }));
}

function kernelEnvelope(graph: GraphDoc, payload: CadContractPayload) {
  return payload.envelope.volumes.map((v) =>
    v.kind === "box"
      ? {
          kind: "box",
          center: resolvePose(graph, v.pose).origin,
          size: v.dims.map((d) => resolveDim(graph, d)),
        }
      : {
          kind: "cylinder",
          center: resolvePose(graph, v.pose).origin,
          radius: resolveDim(graph, v.d) / 2,
          height: resolveDim(graph, v.h),
        },
  );
}

function mergedParams(node: NodeRecord): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const p of node.contract.params) out[p.name] = p.default;
  return { ...out, ...node.params };
}

function failureReport(result: Extract<KernelResult, { ok: false }>): string {
  return `${result.error}${result.hint ? `\nhint: ${result.hint}` : ""}`;
}

export class CadBackend implements DomainBackend<CadContractPayload> {
  id = "cad";
  readonly kernel: KernelClient;
  /** Higher than the engine default: a CAD gate failure hands the model a
   *  measured number to correct against ("expected Ø4.5, measured Ø6.00"),
   *  which converts to a fix far more often than a bare compiler error, so
   *  extra rounds are worth buying here. */
  readonly maxAttempts: number;

  /** A build123d part is a few hundred tokens of code. Measured on real
   *  projects, 89-98% of billed output was reasoning rather than emitted code,
   *  and output is priced 5x input — so the top reasoning tier was most of the
   *  bill for work the gates verify anyway. `medium` with room to answer:
   *  thinking and code share one budget, so the ceiling has to clear both or a
   *  long think returns no part at all. */
  readonly generation = { effort: "medium", maxTokens: 24000 } as const;


  constructor(opts: { kernel?: KernelClient; maxAttempts?: number } = {}) {
    this.kernel = opts.kernel ?? new KernelClient();
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  planning = {
    nodeKinds: [
      { kind: "part", description: "A single printed part.", guidance: "One build(p) function; ports declared in the contract, never in code." },
      { kind: "fastener", description: "Registry socket-head cap screw (never LLM-generated).", guidance: "One node per screw spec; resolved from the fastener registry." },
      { kind: "nut", description: "Registry hex nut (never LLM-generated).", guidance: "Use when a screw is captured by a nut rather than threading into a boss or insert. One param: thread." },
      { kind: "insert", description: "Registry heat-set threaded insert (never LLM-generated).", guidance: "Use for screws threading into printed plastic — the durable choice over tapping the plastic directly. One param: thread." },
      { kind: "threaded_rod", description: "Registry threaded rod / stud, real ISO profile (never LLM-generated).", guidance: "Use for a stud captured by nuts at both ends. Params: thread and length." },
      { kind: "gear", description: "Registry involute spur gear (never LLM-generated).", guidance: "Params: module, teeth, pressure_angle, thickness, bore. Mesh distance between two gears is module * (teeth_a + teeth_b) / 2." },
    ],
    paramUnit: "mm",
    payloadSchema: CadContractPayload as z.ZodType<CadContractPayload>,
    graphLints: [
      cadPortConsistencyLint,
      cadFastenerJustifiedLint,
      cadEnvelopeCoherentLint,
      cadFlatFaceSizeLint,
      cadProbedPortsLint,
      cadFaceHoleConflictLint,
    ],
    architectGuidance: [
      "ONE PART IS A COMPLETE ANSWER. Decomposing is a cost, not a virtue: every",
      "extra part adds an interface to get wrong, a mate to solve, and a joint the",
      "user has to assemble. Emit a single node unless a SECOND part earns its",
      "place for one of these reasons:",
      "  - it moves relative to the first (a hinge, a slide, a thread)",
      "  - it is a different material or process (a printed part plus a bought screw)",
      "  - the whole thing does not fit the print bed in one piece",
      "  - the user must open, service or replace that piece separately",
      "  - the user explicitly asked for separate pieces",
      "A cup, a vase, a bracket, a knob, a tray, an enclosure lid — each of these",
      "is ONE part. Splitting a printable object into a base, a wall and a rim",
      "joined by tongues and grooves is a WORSE answer than modeling it whole:",
      "it invents joinery the user never asked for, and every joint is a fit the",
      "user has to assemble and a tolerance that can be wrong.",
      "",
      "FRAME CONVENTION (critical): every part is modeled in its OWN LOCAL frame,",
      "roughly centered on the origin — the assembly places parts later via port",
      "mates. Never author ports or envelopes in assembly/world coordinates.",
      "Port poses: +z points OUT of the part's mating surface (out of material).",
      "",
      "ONLY THESE PORT TYPES MAY BE USED: CLEARANCE_HOLE, BORE, SCREW_SEAT,",
      "SCREW_BOSS, FLAT_FACE, GROOVE, SLOT. These are the ones the gates can",
      "measure against the real solid. Any other type is rejected at plan time,",
      "because a port nothing can probe makes the whole node unverifiable. If an",
      "interface wants a lip or a snap, express it with the types above, or model",
      "both sides as ONE part and declare no port at all.",
      "GROOVE and SLOT ports MUST carry params: {\"width\": <mm>} — the gap a",
      "  mating tongue or plate sits in, which is the number the other part is cut",
      "  to. Add params.depth only for a channel with a floor; omit it for a cut",
      "  that passes through, or the probe will look for a floor that is not there.",
      "  The channel RUNS ALONG the port's xAxis and its width is measured across.",
      "  The declared width is the NARROWEST gap over the channel's depth, since",
      "  that is what a mating tongue must pass, so keep channels prismatic — a",
      "  chamfered or drafted mouth is fine, a V-groove declared at its mouth is",
      "  not. Channels must also be at least 1.2mm deep to be probed at all;",
      "  anything shallower is a FLAT_FACE, not a channel.",
      "",
      "Hole-like ports (CLEARANCE_HOLE, BORE, SCREW_SEAT) MUST carry",
      '  params: {"diameter": <mm>} — that exact key; probes measure against it.',
      "FLAT_FACE ports MUST carry params: {\"size\": <mm>} — the width of the flat",
      "  the mating part sits on (or {\"ring_diameter\": <mm>} for an annular seat).",
      "  A probe with no size to measure against cannot check the port at all.",
      "",
      "THE ENVELOPE MUST DESCRIBE WHERE THE PART ACTUALLY IS. Two rules, both",
      "checked at plan time, both fatal to a cook if wrong because the generator",
      "cannot see the mistake and will burn its whole repair budget:",
      "  - Every port you declare must lie INSIDE this node's own envelope. A",
      "    port is a feature of the part; one outside the envelope is a",
      "    contradiction, so fix whichever of the two is wrong.",
      "  - Envelope volumes must OVERLAP into one connected region. Two volumes",
      "    with a gap between them ask for a part that spans empty space.",
      "  Size each volume around the geometry it bounds and centre it there —",
      "  an envelope offset by half its own height leaves the part hanging out.",
      "Prefer axis-aligned frames (zAxis one of ±x/±y/±z) and simple orientations:",
      "plates flat in XY, height along Z.",
      "",
      "FASTENERS ARE OPTIONAL, and never decorative. Emit one only when separate",
      "parts are genuinely bolted together, and only alongside the hole ports on",
      "the parts it joins — every fastener must be wired to a CLEARANCE_HOLE,",
      "SCREW_SEAT, SCREW_BOSS or BORE port that it seats into. A one-piece part, a",
      "press fit, a snap fit, or a printed-in-place hinge needs ZERO fastener",
      "nodes. Do not add a screw to satisfy the taxonomy; most designs need none.",
      "",
      "HARDWARE NODES (fastener | nut | insert) are resolved from a registry —",
      "standards-exact, never generated. Give each ONE port: the seat face where",
      "it bears on the part, a FLAT_FACE with params.ring_diameter (an annulus",
      "around its own shank, not a solid disc). The edge that wires the fastener",
      "MUST name that port, so it has to exist — an edge naming a port the node",
      "does not declare fails the port-consistency lint, and the mate will not",
      "solve. examples/cad-clamp is the pattern: m4-screw declares head_seat as a",
      "FLAT_FACE with ring_diameter 5.5, and the edge reads",
      "base-plate.back_right_hole -> m4-screw.head_seat. Declare no OTHER ports,",
      "and a small cylinder envelope around the origin.",
      "Emit one node per hardware ROLE, not per physical piece — counts and",
      "patterns belong to the consuming part's HOLE_PATTERN port params.",
      "  fastener      SHCS, head base at origin, shank hanging -z.",
      "                Params: thread (enum M3|M4|M5) AND length (mm).",
      "  nut           hex nut, seating face on z=0, body +z. Param: thread only.",
      "  insert        heat-set threaded insert, flange on z=0, body +z. Param: thread only.",
      "  threaded_rod  ISO threaded stud from z=0 up. Params: thread AND length.",
      "Pick the mating half deliberately: a screw into printed plastic wants an",
      "`insert` (tapped plastic strips); a screw through both parts wants a `nut`;",
      "a screw into a SCREW_BOSS needs neither.",
      "",
      "GEAR NODES are registry too — an involute tooth profile is not something",
      "to write by hand. Params: module, teeth, pressure_angle (20 unless you",
      "have a reason), thickness, bore (0 for none). The gear is centered on the",
      "origin. Two meshing gears sit module * (teeth_a + teeth_b) / 2 apart; put",
      "that distance in the parts that carry their shafts, via expressions.",
      "",
      "Layout-first: choose each part's envelope primitives, then assign ports at",
      "the mating faces, and size hole/boss diameters from the fastener registry",
      "(M3 clearance 3.4 / M4 4.5 / M5 5.5).",
      "",
      "PARAMS ARE THE USER'S CONTROL PANEL — write them for a person, not a",
      "compiler. Every param needs a `description` saying what it does in plain",
      "words (\"how thick the plate prints\", not \"thickness\"); a blank one leaves",
      "the inspector empty. Give min and max the real usable range, not a token",
      "one — they set the slider's travel. Add `ui` for presentation:",
      '  "ui": {"group": "holes", "unit": "mm"}',
      "Group params that belong together (outer shape / holes / mounting) once a",
      "part has more than about four; `unit` is a display suffix (mm, °) only.",
      "`ui` is presentation-only and deliberately outside the contract hash, so",
      "adding or changing it never dirties a node.",
      "",
      "PARAMETRIC GEOMETRY: any pose component, envelope dimension, or port param",
      "may be an expression string instead of a number — e.g. a top-face port at",
      '  z = "param(base-plate.thickness) / 2", hole Ø = "param(plate.holeDia)".',
      "Use expressions for EVERY dimension that depends on a param, so slider",
      "changes keep ports, probes, and assembly consistent automatically.",
      "",
      "PROPAGATE ENGINEERING KNOWLEDGE with paramBindings (payload.paramBindings:",
      "{paramName: expression}). A bound param re-derives automatically whenever an",
      "upstream param changes — encode every dependency you know:",
      '  hole tracks a thread:   "hole_diameter": "clearance:param:screw-a.thread"',
      '  thread fits a hole:     "thread": "threadForHole:param:plate.boltHoleDia"',
      '  screw spans the stack:  "length": "screwLength: param(plate.thickness) + param(arm.padThickness) + 4"',
      "    (last term = thread engagement, ≈1×d; result snaps UP to standard lengths",
      "    6/8/10/12/16/20/25/30/35/40/45/50)",
      '  derived dimension:      "boreDia": "expr: param(fan-plate.fanSize) - 4"',
      "Bind fastener thread + length this way whenever the joint's stack or holes",
      "are parametric — a user resizing one part must never leave a stale screw.",
    ].join("\n"),
  };

  previewAdapter = {
    // The three.js viewport lands in CAD-M3; cooks work headless meanwhile.
    start: async (_g: GraphDoc, _w: Workspace) => ({ url: "" }),
    hotSwap: async (_g: GraphDoc, _w: Workspace, _n: string[]) => {},
    pushParams: async (_n: string, _p: Record<string, ParamValue>) => {},
    stop: async () => {},
  };

  deterministicArtifact(node: NodeRecord): { code: string } | null {
    const code = resolveDeterministic(node);
    return code ? { code } : null;
  }

  /**
   * Six views of whatever the node currently holds, for a model to look at.
   * Returns null whenever the code cannot be built into a shape — there is
   * nothing to show, and a repair for a syntax error would not benefit anyway.
   */
  async renderArtifact(node: NodeRecord, ws: Workspace): Promise<LlmImage | null> {
    const code = node.artifact?.code;
    if (!code) return null;
    const result = await this.kernel.render(code, mergedParams(node), {
      importDir: this.importDir(ws),
      views: 4, // iso/front/right/top: enough to judge shape, half the tokens of six
    });
    if (!result.ok || !result.sheet) return null;
    const res = await fetch(`${this.kernel.baseUrl}${result.sheet}`);
    if (!res.ok) return null;
    return {
      mediaType: "image/png",
      dataB64: Buffer.from(await res.arrayBuffer()).toString("base64"),
    };
  }

  /** Every cooked part, placed by the assembly solver, in one image. */
  async renderAssembly(graph: GraphDoc, ws: Workspace): Promise<LlmImage | null> {
    const { world } = this.solveScene(graph);
    const parts = Object.values(graph.nodes)
      .filter((n) => n.artifact?.code && world[n.id])
      .map((n) => ({ code: n.artifact!.code, params: mergedParams(n), matrix: world[n.id]! }));
    if (parts.length < 2) return null; // one part is not an assembly

    const result = await this.kernel.renderAssembly(parts, { importDir: this.importDir(ws) });
    if (!result.ok || !result.sheet) return null;
    const res = await fetch(`${this.kernel.baseUrl}${result.sheet}`);
    if (!res.ok) return null;
    return { mediaType: "image/png", dataB64: Buffer.from(await res.arrayBuffer()).toString("base64") };
  }

  /**
   * Write geometry to a file the user can open.
   *
   * One node exports in its OWN frame, which is what a slicer wants — you
   * print parts flat and separately, not posed. The whole graph exports posed,
   * for anyone who wants the assembled object as one mesh.
   */
  async exportGeometry(
    graph: GraphDoc,
    ws: Workspace,
    opts: { nodeId?: string; format: string },
  ): Promise<ExportResult> {
    const { world } = this.solveScene(graph);
    const nodes = Object.values(graph.nodes).filter(
      (n) => n.artifact?.code && (!opts.nodeId || n.id === opts.nodeId),
    );
    const parts = nodes.map((n) => ({
      code: n.artifact!.code,
      params: mergedParams(n),
      matrix: opts.nodeId ? [] : (world[n.id] ?? []),
    }));
    return this.kernel.export(parts, opts.format, { importDir: this.importDir(ws) });
  }

  buildGeneratePrompt(ctx: GenerateCtx<CadContractPayload>): PromptSpec {
    return generatePrompt(ctx);
  }
  buildRepairPrompt(ctx: RepairCtx<CadContractPayload>): PromptSpec {
    return repairPrompt(ctx);
  }

  /** Imported pieces load their mesh from the project's imports/ dir. */
  private importDir(ws: Workspace): string {
    return path.resolve(ws.root, "..", "imports");
  }

  /** G0–G2 kernel-side: static scan, execution, validity. */
  async execute(node: NodeRecord, ws: Workspace): Promise<ExecuteResult> {
    const result = await this.kernel.execute(node.artifact?.code ?? "", mergedParams(node), {
      importDir: this.importDir(ws),
    });
    if (!result.ok) return { ok: false, stage: result.stage, report: failureReport(result) };
    return { ok: true, stage: "execute", report: `volume ${result.measurements.volume_mm3.toFixed(0)} mm³` };
  }

  /** G3+G4: the contract's postconditions probed against the actual solid.
   * Fastener geometry comes from the registry and is exact by construction,
   * so G4 would only be grading the architect's envelope guess — skip it. */
  async verify(node: NodeRecord, _graph: GraphDoc, ws: Workspace): Promise<VerifyResult> {
    const payload = node.contract.payload as CadContractPayload;
    const result = await this.kernel.execute(node.artifact?.code ?? "", mergedParams(node), {
      ports: kernelPorts(_graph, payload),
      envelope: REGISTRY_HARDWARE.has(node.kind) ? [] : kernelEnvelope(_graph, payload),
      importDir: this.importDir(ws),
    });
    if (!result.ok) return { ok: false, stage: result.stage, report: failureReport(result) };
    return {
      ok: true,
      stage: "verify",
      report: JSON.stringify(result.measurements.ports ?? []),
      // The probe results the gates just agreed with. They used to end here,
      // stringified into a report nothing read on success.
      measurements: result.measurements,
    };
  }

  classifyFailure(evidence: {
    node: NodeRecord;
    failures: { stage: string; report: string }[];
    attempts: number;
  }): FailureClass {
    // "Persistent" has to mean a clear majority of the rounds actually spent,
    // not a fixed 2. At a 3-round budget 2 failures is a majority; at 5 it is
    // a minority, and treating it as persistent would send a part the model
    // was still converging on to the architect as unbuildable.
    const persistent = Math.max(2, Math.ceil((evidence.attempts * 2) / 3));
    const stages = evidence.failures.map((f) => f.stage);

    // A persistent envelope escape means the box the architect drew is too
    // small for the features it demanded — only the architect can fix that.
    if (stages.filter((s) => s === "G4").length >= persistent) return "contract-infeasible";
    // The same port failing G3 across materially different attempts points at
    // the declared pose/dims, not the code (design doc heuristic). Judged on
    // the worst single port, not on every G3 failure agreeing: over more
    // rounds one unrelated port miss would otherwise clear the real culprit.
    const g3 = evidence.failures.filter((f) => f.stage === "G3");
    if (g3.length >= persistent) {
      const counts = new Map<string, number>();
      for (const f of g3) {
        const port = /port "([^"]+)"/.exec(f.report)?.[1];
        if (port) counts.set(port, (counts.get(port) ?? 0) + 1);
      }
      for (const n of counts.values()) if (n >= persistent) return "contract-infeasible";
    }
    return "code-invalid";
  }

  /** Static assembly: solve world poses via the universal mate transform and
   * write scene.json (per-node matrix + GLB URL) for the viewport. */
  async assemble(graph: GraphDoc, ws: Workspace): Promise<void> {
    const { scene } = this.solveScene(graph);
    await mkdir(ws.root, { recursive: true });
    await writeFile(path.join(ws.root, "scene.json"), JSON.stringify(scene, null, 1), "utf8");
  }

  solveScene(graph: GraphDoc) {
    const nodes: AssemblyNode[] = Object.values(graph.nodes).map((n) => {
      const payload = n.contract.payload as CadContractPayload;
      const ports: AssemblyNode["ports"] = {};
      for (const p of payload.ports ?? []) {
        try {
          ports[p.name] = resolvePose(graph, p.pose);
        } catch {
          // unresolvable pose expression — leave the port out; the solver reports it
        }
      }
      return { id: n.id, ports };
    });
    const mates: AssemblyMate[] = graph.edges.map((e) => {
      const consumer = graph.nodes[e.to];
      const dof = (name: string) => {
        const v = consumer?.params[`mate.${e.toPort}.${name}`];
        return typeof v === "number" ? v : 0;
      };
      return {
        fromNode: e.from,
        fromPort: e.fromPort,
        toNode: e.to,
        toPort: e.toPort,
        dofs: { clock: dof("clock"), offset: dof("offset"), u: dof("u"), v: dof("v") },
      };
    });
    const { world, problems } = solveAssembly(nodes, mates, graph.assembly.entryNodeId);
    const scene = {
      nodes: Object.fromEntries(
        Object.values(graph.nodes).map((n) => [
          n.id,
          { title: n.title, matrix: world[n.id], version: n.version },
        ]),
      ),
      problems,
    };
    return { scene, world, problems };
  }

  async globalCheck(graph: GraphDoc, ws: Workspace): Promise<CheckResult> {
    if (Object.keys(graph.nodes).length === 0) return { ok: true, problems: [] };
    const problems: string[] = [];
    for (const e of graph.edges) {
      const from = graph.nodes[e.from]?.contract.payload as CadContractPayload | undefined;
      const to = graph.nodes[e.to]?.contract.payload as CadContractPayload | undefined;
      if (from && !from.ports.some((p) => p.name === e.fromPort))
        problems.push(`edge ${e.id}: ${e.from} has no port "${e.fromPort}"`);
      if (to && !to.ports.some((p) => p.name === e.toPort))
        problems.push(`edge ${e.id}: ${e.to} has no port "${e.toPort}"`);
    }
    const { world, problems: sceneProblems } = this.solveScene(graph);
    problems.push(...sceneProblems);

    // G5: two parts in the same space. Every other gate grades ONE part against
    // its own contract, so none of them can see this — a collar passed every
    // probe and every envelope while sitting 1.5mm inside its base. Reported
    // here rather than failing a node's verify because no single part is at
    // fault; failing one arbitrarily would send a generator to fix correct code.
    //
    // Best-effort, but NOT SILENT. A kernel that is down must not turn a clean
    // assembly into a failing one — and a bare catch here made "did not run"
    // indistinguishable from "found nothing": a bad workspace threw inside
    // importDir and every project reported clean in about a millisecond, a
    // perfectly convincing false all-clear. That is the third silence of this
    // shape in this file, one commit after two were deleted, so the reason is
    // reported as a problem of its own.
    const posed = Object.values(graph.nodes)
      .filter((n) => n.artifact?.code && world[n.id])
      .map((n) => ({
        key: n.id,
        code: n.artifact!.code,
        params: mergedParams(n) as Record<string, unknown>,
        matrix: world[n.id]!,
      }));
    if (posed.length >= 2) {
      try {
            const res = await this.kernel.clash(posed, { importDir: this.importDir(ws) });
        for (const e of res.clash?.errors ?? []) {
          problems.push(`clash check incomplete — ${e}. Those two parts were not compared.`);
        }
        for (const c of res.clash?.clashes ?? []) {
          problems.push(
            `${c.a} and ${c.b} occupy the same space: ${c.volume_mm3.toFixed(1)} mm³ of shared material near [${c.at.join(", ")}]. Both parts pass their own gates, so the fault is in a mate offset or a port pose, not in either part's code.`,
          );
        }
      } catch (err) {
        problems.push(
          `clash check did not run: ${(err as Error).message}. Parts may overlap without this reporting it — the gate is skipped, not passed.`,
        );
      }
    }
    return { ok: problems.length === 0, problems };
  }
}
