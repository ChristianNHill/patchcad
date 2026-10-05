import { z } from "zod";
import type { GraphDoc, NodeRecord, ParamValue } from "@patchcad/shared";

export * from "./kernel.js";
export * from "./registry.js";
export * from "./assembly.js";
export * from "./bindings.js";
export * from "./grounding.js";
export * from "./g5.js";
export * from "./plan-geometry.js";
export * from "./mesh-source.js";
export { CHEAT_SHEET, normalizeCadCode } from "./prompts.js";
export { useLearnedPitfalls } from "./pitfalls.js";
export { autoFixPlan, fixFrameFlips, fixSpans } from "./frame-flip.js";
export * from "./sourcing.js";
export * from "./dfm.js";
export * from "./bom.js";
export * from "./ordering.js";
export * from "./joints.js";
export * from "./expand.js";
export * from "./segment-joints.js";
export * from "./instructions.js";
export * from "./plan-summary.js";
import type {
  CheckAdvisory,
  CheckFinding,
  ArchitectOutput,
  CheckResult,
  LlmImage,
  DomainBackend,
  ExecuteResult,
  FailureClass,
  GenerateCtx,
  PromptSpec,
  RepairCtx,
  TierHints,
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

/** Each component defaults to the identity, so the architect may leave out
 *  what it would only copy (every token of a plan is ~9ms of waiting). Parsing
 *  fills them, so a stored contract and its hash never see the difference. */
export const Pose = z.object({
  origin: z.tuple([Dim, Dim, Dim]).default([0, 0, 0]),
  zAxis: z.tuple([Dim, Dim, Dim]).default([0, 0, 1]),
  xAxis: z.tuple([Dim, Dim, Dim]).default([1, 0, 0]),
});
export type Pose = z.infer<typeof Pose>;

/** The port types the kernel can actually MEASURE (gates.py _probe_port and its
 * own PROBED_PORT_TYPES, which a test holds identical to this list). A type the
 * kernel has no probe for used to be recorded "skipped" and the job still
 * passed, so a contract built from unprobed ports was verified by nothing: a
 * solid brick satisfied it, which is exactly how a 75x75x95 block once passed
 * as a pen cup holder with hexagonal cutouts. The kernel now FAILS such a port.
 *
 * CadPortType, the architect's allowed-types text and cadProbedPortsLint are
 * all derived from this list, so they cannot disagree again (SHAFT was probed
 * for weeks while the guidance still forbade it). Widen it in the same change
 * that adds a probe, NEVER before. */
export const PROBED_PORT_TYPES = [
  "CLEARANCE_HOLE",
  "BORE",
  "SCREW_SEAT",
  "SCREW_BOSS",
  "FLAT_FACE",
  // Channel types, measured by _probe_channel: void at the pose, walls found by
  // marching out to each side, width compared against the declaration.
  "GROOVE",
  "SLOT",
  // A peg standing out of a mating face, measured by _probe_shaft. Added because
  // --score-projects found 14 SHAFT ports live on disk, all reporting "no probe
  // for this type yet": main.ts emits SHAFT directly for every peg joint on the
  // IMPORT path, which never runs this lint.
  "SHAFT",
  // N holes or bosses behind one port, expanded by _probe_pattern into member
  // probes (polar {count, pcd, start_angle?} or grid {nx, ny, pitch_x, pitch_y}).
  "HOLE_PATTERN",
  "BOSS_PATTERN",
  // Hardware host features: the pocket, seat or trap a catalog part goes into,
  // each a bore graded against a fit band (gates.py HARDWARE_PROBES).
  "THREADED_HOLE",
  "INSERT_POCKET",
  "NUT_TRAP",
  "COUNTERBORE",
  "COUNTERSINK",
  "DOWEL_HOLE",
  "BEARING_SEAT",
  "BUSHING_BORE",
  "MOTOR_MOUNT",
  "MAGNET_POCKET",
  "HUB_BORE",
  "LINEAR_BEARING_SEAT",
  "CLIP_GROOVE",
  "RAIL_MOUNT",
  // A made part's male thread, probed as a peg against its thread's Ø band;
  // G5 allows its overlap with the THREADED_HOLE it mates.
  "THREADED_STUD",
] as const;

export const CadPortType = z.enum(PROBED_PORT_TYPES);

/** The probed types that host a catalog part (gates.py HARDWARE_PROBES). */
export const HARDWARE_PORT_TYPES = new Set<string>([
  "THREADED_HOLE",
  "INSERT_POCKET",
  "NUT_TRAP",
  "COUNTERBORE",
  "COUNTERSINK",
  "DOWEL_HOLE",
  "BEARING_SEAT",
  "BUSHING_BORE",
  "MOTOR_MOUNT",
  "MAGNET_POCKET",
  "HUB_BORE",
  "LINEAR_BEARING_SEAT",
  "CLIP_GROOVE",
  "RAIL_MOUNT",
]);

/** True when a port's feature is wider than every envelope volume, so no cut
 *  of it can pass. Expression dims are skipped: classifyFailure has no graph
 *  to resolve them against, and an unknown never escalates. */
function outgrowsEnvelope(node: NodeRecord, key: string): boolean {
  const payload = node.contract?.payload as CadContractPayload | undefined;
  const port = payload?.ports?.find((p) => p.name === key.split(" #")[0]);
  if (!port || !payload) return false;
  const sizes = ["od", "diameter", "af", "pilot_diameter", "pcd"].map((k) => Number(port.params[k]));
  const feature = Math.max(0, ...sizes.filter(Number.isFinite));
  const extents = payload.envelope.volumes.map((v) =>
    v.kind === "box" ? Math.max(...v.dims.map(Number)) : Math.max(Number(v.d), Number(v.h)),
  );
  return extents.every(Number.isFinite) && feature > Math.max(...extents);
}

export const CadPort = z.object({
  name: z.string(),
  type: CadPortType,
  pose: Pose,
  params: z.record(z.union([z.number(), z.string()])).default({}),
  repeat: z
    .object({ count: z.number().int().min(2).max(50), step: z.tuple([Dim, Dim, Dim]) })
    .optional()
    .describe("the same port at `count` positions, each `step` mm (in this part's frame) past the last: levels up a post, a row along a rail. Plan expansion makes ports <name>_1..<name>_N and repeats every edge and joint on it, so one part wired here is placed at every position"),
});

export const EnvelopePrimitive = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("box"),
    pose: Pose.default({}),
    dims: z.tuple([Dim, Dim, Dim]),
  }),
  z.object({
    kind: z.literal("cylinder"),
    pose: Pose.default({}),
    d: Dim,
    h: Dim,
  }),
]);

/** G4b: the numbers the user actually stated, measured on the solid after G4.
 *  Ports say where features are and the envelope what the part may not exceed;
 *  neither says "an 80mm plate with four holes". */
export const CadAssertion = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("solids"), count: z.number().int().min(1) }),
  z.object({ kind: z.literal("volume_range"), min: z.number().min(0), max: z.number().positive() }).describe("mm³"),
  z
    .object({ kind: z.literal("bbox_axis"), axis: z.enum(["x", "y", "z"]), min: z.number().optional(), max: z.number().optional() })
    .describe("overall size along one axis of the part's own frame, mm"),
  z
    .object({ kind: z.literal("hole_count"), min: z.number().int().min(0), max: z.number().int().optional() })
    .describe("closed round holes, blind or through; a counterbore over a pilot is one"),
  z
    .object({ kind: z.literal("symmetry"), plane: z.enum(["xy", "yz", "xz"]), tol: z.number().min(0).max(0.5).optional() })
    .describe("mirror plane through the bounding-box centre; tol = allowed mismatched fraction, default 0.02"),
  z.object({ kind: z.literal("min_wall"), mm: z.number().positive() }),
  z
    .object({
      kind: z.literal("helix"),
      radius: z.number().positive().describe("mid-flank radius, (major + minor) / 4"),
      z: z.tuple([z.number(), z.number()]).optional().describe("the threaded length along Z; default the whole bbox"),
      center: z.tuple([z.number(), z.number()]).optional().describe("the axis's x, y; default [0, 0]"),
      starts: z.number().int().min(1).optional(),
      hand: z.enum(["right", "left"]).optional(),
      pitch: z.number().positive().optional(),
      tol: z.number().positive().max(1).optional().describe("allowed pitch error as a fraction of pitch, default 0.15"),
    })
    .describe("a modelled thread: a helical surface about an axis parallel to the part's Z, mm"),
  z
    .object({
      kind: z.literal("line_count"),
      from: z.tuple([z.number(), z.number(), z.number()]),
      to: z.tuple([z.number(), z.number(), z.number()]),
      crossings_min: z.number().int().min(0),
      crossings_max: z.number().int().min(0).optional(),
    })
    .describe("material runs a straight probe line crosses, part frame mm: knurl teeth, slots, ribs"),
]);
export type CadAssertion = z.infer<typeof CadAssertion>;

export const CadContractPayload = z.object({
  units: z.literal("mm").default("mm"),
  process: z.object({
    /** CNC = machined (sourcing fabricate/cnc); FDM covers every other process. */
    kind: z.enum(["FDM", "CNC"]),
    minWall: z.number().default(1.2),
    nozzle: z.number().default(0.4),
    /** The printer's build volume, mm. A generated mesh bigger than it is
     *  split into jointed pieces. Optional with no default (250³ when absent),
     *  so a contract without it hashes as before. */
    buildVolumeMm: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional(),
  }).default({ kind: "FDM" }),
  ports: z.array(CadPort).default([]),
  envelope: z.object({
    volumes: z.array(EnvelopePrimitive).min(1).max(4),
    clearance: z.number().default(0.4),
  }),
  /** Symbolic bindings resolved by the kernel from upstream contracts (T1). */
  paramBindings: z.record(z.string()).default({}),
  /** Yes/no questions about the render, YES = correct, for features no gate
   *  measures. Asked by the engine's inspect judge after the gates pass.
   *  Optional with no default, so a contract without them hashes as before. */
  visualChecks: z.array(z.string()).optional(),
  /** Spec-derived checks (G4b). Optional with no default, for the same reason. */
  assertions: z.array(CadAssertion).max(6).optional(),
  /** How many separate solids the part is. G2 fails anything but 1 unless this
   *  says otherwise. Optional with no default, for the same reason. */
  solids: z.number().int().positive().optional(),
  /** How the part's geometry is made: generated build123d (parametric) or a
   *  generated mesh (Phase 6.4, not configured yet). Optional with no default,
   *  so absent reads as parametric and hashes as before. */
  geometrySource: z.enum(["parametric", "mesh"]).optional(),
  /** What this part looks like in the user's reference image(s): a sentence
   *  on its region, read by THIS node's generator only. Optional, no default. */
  visualRef: z.string().optional(),
  /** buy | print | fabricate (+ process, material). Optional with no default,
   *  so absent hashes as before; `sourcingOf` fills the default. */
  sourcing: Sourcing.optional(),
});
export type CadContractPayload = z.infer<typeof CadContractPayload>;

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KernelClient, type ExportResult, type KernelResult } from "./kernel.js";
import { generatePrompt, repairPrompt } from "./prompts.js";
import { FASTENING_HARDWARE, METRIC, REGISTRY_HARDWARE, REGISTRY_SOLIDS, resolveDeterministic, skuOf, unresolvedHardware } from "./registry.js";
import { CadJoint } from "./joints.js";
import { CATALOG, skuFor } from "./catalog.js";
import { cadJointRuleLint, expandJoints, gearMeshJoints, planetaryJoints, graphMates, isJointHardware, jointAxes, mintedNames } from "./expand.js";
import { gearHubName, mintDefaultGearPorts, mintNamedGearPorts } from "./gear-ports.js";
import { IDENTITY, kinematicJoints, poseToMat, solveAssembly, type AssemblyNode } from "./assembly.js";
import { resolveBinding, resolveDim, resolvePose } from "./bindings.js";
import { DIAMETER_KEYS, clashFindings, contactQueries, fitFindings, hardwareAllowances, threadAllowances } from "./g5.js";
import { cadPlanGeometryLint, contains, posedEnvelope } from "./plan-geometry.js";
import { silhouetteAdvisories } from "./silhouette.js";
import { geometrySourceGuidance, isMeshNode, meshNodeCode, meshSourceLint, prepareMeshNode, type MeshSource } from "./mesh-source.js";
import { Sourcing, cadSourcingLint, isMachined, markCncSetups, sourcingOf } from "./sourcing.js";
import { summarizeCadPlan } from "./plan-summary.js";
import { assemblyInstructions } from "./instructions.js";
import { expandRepeats } from "./repeat.js";
import { assemblyFindings, assemblyPlanDefects, cadAssemblyPlanLint } from "./feasibility.js";
import { autoFixPlan } from "./frame-flip.js";
import { G4C_SCORE, kernelProcess } from "./dfm.js";
import { unverifiedCandidate } from "./bom.js";
import { WORKED_PLAN, WORKED_PLAN_GOAL } from "./worked-plan.js";
import { CAD_INSPECT_SYSTEM } from "./judge.js";
import {
  BEARING_DIAMETER,
  FDM_SLIP_FIT_MM,
  SEAT_POSE,
  groundingLines,
  seatBand,
} from "./grounding.js";

/**
 * One name per port, everywhere: contract provides/requires keys, payload
 * geometric ports, and edge endpoints must agree exactly — the assembly
 * solver and the G3 probes both key on payload port names. Runs at plan time
 * so a mismatch becomes an architect repair round, never a hand fix.
 * Fasteners are exempt (registry geometry, no probed ports by convention).
 */
export const cadPortConsistencyLint = {
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
      // BOTH SIDES, one loop. The TO side carried a registry-hardware skip that
      // let plate-a.screw_hole → screw-m4.hole through a whole cook against a
      // screw declaring no ports, and the assembly then reported "missing port"
      // with both fasteners at the origin. Fixing only that side left the
      // identical bug on the FROM side, where a fastener lands whenever the
      // architect phrases the requirement the other way round. Half a symmetric
      // bug fixed is how the first half survived.
      //
      // Hardware is NOT exempt here, only from the contract-vs-payload check
      // above: examples/cad-clamp's m4-screw declares a real head_seat port and
      // its edge names it. An earlier version rejected every edge to hardware
      // instead, which deadlocked against cad-fastener-justified — that lint
      // requires a fastener to be wired, so a fastener could be neither wired
      // nor unwired and no plan containing one was possible.
      //
      // So the rule is that the NAME must exist, and the kind only chooses how
      // to explain it. Branch on the message, never on whether to check.
      for (const [id, port] of [
        [e.from, e.fromPort],
        [e.to, e.toPort],
      ] as const) {
        const n = graph.nodes[id];
        if (!n) continue;
        const names = payloadNames.get(id);
        if (names?.has(port)) continue;
        problems.push(
          REGISTRY_HARDWARE.has(n.kind) && !names?.size
            ? `edge ${e.from}.${e.fromPort} → ${e.to}.${e.toPort}: ${id} is ${n.kind} and declares no ports, so "${port}" cannot exist and the mate will not solve. Give it the seat port the edge names (examples/cad-clamp's screw declares head_seat as a FLAT_FACE with ring_diameter), or better, declare a joint between the two parts it fastens and let expansion mint it (a part clamped on a rod: a fixed joint, b's BORE on a's SHAFT, toolFree for a thumb screw).`
            : `edge ${e.from}.${e.fromPort} → ${e.to}.${e.toPort}: "${port}" is not a payload port name of ${id}`,
        );
      }
    }
    return problems;
  },
};

/** The hole-like ports a screw actually fastens into. */
const FASTENED_PORT_TYPES = new Set([
  "CLEARANCE_HOLE", "SCREW_SEAT", "SCREW_BOSS", "BORE", "HOLE_PATTERN", "BOSS_PATTERN",
  "THREADED_HOLE", "INSERT_POCKET", "NUT_TRAP", "COUNTERBORE", "COUNTERSINK", "DOWEL_HOLE",
]);

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
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    const holePorts = (id: string) =>
      ((graph.nodes[id]?.contract.payload as CadContractPayload | undefined)?.ports ?? []).filter((p) =>
        FASTENED_PORT_TYPES.has(p.type),
      );
    for (const n of Object.values(graph.nodes)) {
      // A joint's own hardware answers to cadJointRuleLint: a drive's spacer
      // washer sits on a bearing, not in a hole, and is no less real for it.
      if (!FASTENING_HARDWARE.has(n.kind) || isJointHardware(graph, n.id)) continue;
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
          `${n.id}: ${n.kind} connects only to ${neighbors.join(", ")}, none of which declare a hole port (${[...FASTENED_PORT_TYPES].join(" / ")}) for it to fasten into. Declare a joint between the parts instead and the rules add the holes, or drop the ${n.kind}.`,
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

/** World AABB of a posed primitive, as G4 sees it: a box's dims lie along its
 *  pose axes, a cylinder's height along its zAxis. */
export function envelopeAabb(graph: GraphDoc, vol: z.infer<typeof EnvelopePrimitive>): Aabb {
  const pose = resolvePose(graph, vol.pose);
  const o = pose.origin;
  let half: number[];
  if (vol.kind === "box") {
    const m = poseToMat(pose);
    const h = vol.dims.map((d) => resolveDim(graph, d) / 2);
    half = [0, 1, 2].map((i) => Math.abs(m[i]!) * h[0]! + Math.abs(m[4 + i]!) * h[1]! + Math.abs(m[8 + i]!) * h[2]!);
  } else {
    const n = Math.hypot(...pose.zAxis);
    const r = resolveDim(graph, vol.d) / 2;
    const h = resolveDim(graph, vol.h) / 2;
    half = pose.zAxis.map((c) => Math.abs(c / n) * h + r * Math.sqrt(Math.max(0, 1 - (c / n) ** 2)));
  }
  return {
    min: [o[0] - half[0]!, o[1] - half[1]!, o[2] - half[2]!],
    max: [o[0] + half[0]!, o[1] + half[1]!, o[2] + half[2]!],
  };
}

const overlaps = (a: Aabb, b: Aabb, slack: number) =>
  [0, 1, 2].every((i) => a.min[i]! - slack <= b.max[i]! && b.min[i]! - slack <= a.max[i]!);

/** Slab test: does the segment from→to pass within `slack` of the box? */
function segmentHitsBox(from: number[], to: number[], b: Aabb, slack: number): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = to[i]! - from[i]!;
    const lo = b.min[i]! - slack - from[i]!;
    const hi = b.max[i]! + slack - from[i]!;
    if (Math.abs(d) < 1e-12) {
      if (lo > 0 || hi < 0) return false;
      continue;
    }
    const [a, c] = d > 0 ? [lo / d, hi / d] : [hi / d, lo / d];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
  }
  return t0 <= t1;
}

/** Every T1 expression in every contract resolves at plan time. Each lint
 *  below skips one it cannot read ("not this lint's business"), so a dovetail
 *  envelope written `tan(param(…) * pi / 180)` before the grammar had tan
 *  planned clean and then threw in all five cook rounds, where no generator
 *  can fix it. */
export const cadExpressionsResolveLint = {
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    for (const n of Object.values(graph.nodes)) {
      const payload = n.contract.payload as CadContractPayload | undefined;
      if (!payload) continue;
      const check = (where: string, dims: (number | string)[]) => {
        for (const d of dims) {
          try {
            resolveDim(graph, d);
          } catch (err) {
            problems.push(`${n.id}: ${where}: ${(err as Error).message}. Expressions may use numbers, + - * /, parentheses, param(<node>.<param>), pi, and sin cos tan atan sqrt abs min max radians degrees (trig in radians).`);
          }
        }
      };
      for (const p of payload.ports ?? []) {
        check(`port "${p.name}" pose`, [...p.pose.origin, ...p.pose.zAxis, ...p.pose.xAxis]);
        // Port params also hold names ("M4", "press"); only what reads as arithmetic is an expression.
        check(`port "${p.name}" params`, Object.values(p.params ?? {}).filter((v) => typeof v === "string" && /param\(|^expr:|[-+*/()]/.test(v)));
      }
      for (const [i, v] of (payload.envelope?.volumes ?? []).entries()) {
        const pose = v.pose;
        check(`envelope volume ${i + 1}`, [...pose.origin, ...pose.zAxis, ...pose.xAxis, ...(v.kind === "box" ? v.dims : [v.d, v.h])]);
      }
      for (const [param, expr] of Object.entries(payload.paramBindings ?? {})) {
        const r = resolveBinding(graph, expr);
        if ("error" in r) problems.push(`${n.id}: binding for "${param}": ${r.error}`);
      }
    }
    return problems;
  },
};

export const cadEnvelopeCoherentLint = {
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
const FACE_SIZE_KEYS = ["size", "faceSize", "face_size", "width", "flatWidth", "flat_width"];
const CHANNEL_PORT_TYPES = new Set(["GROOVE", "SLOT"]);
const PATTERN_PORT_TYPES = new Set(["HOLE_PATTERN", "BOSS_PATTERN"]);
const PATTERN_GRID_KEYS = ["nx", "ny", "pitch_x", "pitch_y"];
// Mirrors gates.py's OUTER_D_KEYS across the language boundary, with no import
// path between them. The drift is asymmetric: a lint list WIDER than the probe's
// only lets a port through to fail at G3, while a lint list NARROWER than the
// probe's blocks a plan the probe could have measured. So if these ever diverge,
// widen this one. Bare "diameter" is deliberately absent from both, and dropping
// it from one alone would have created exactly the narrower case.
export /** Mirrors gates.py PROBE_INSET_MM. Enforced by a test that reads gates.py. */
const PROBE_INSET_MM = 0.3;
export const OUTER_DIAMETER_KEYS = ["outer_diameter", "outerDiameter", "od", "boss_diameter", "bossDiameter"];
const CHANNEL_WIDTH_KEYS = ["width", "slotWidth", "slot_width", "grooveWidth", "groove_width", "channelWidth"];

export const cadFlatFaceSizeLint = {
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
        } else if (p.type === "SCREW_BOSS" || p.type === "BOSS_PATTERN") {
          // The last probed type with no branch here, found by auditing the
          // probed set against this lint rather than by anything failing. Worse
          // than the SHAFT gap was: _probe_boss indexed params["outer_diameter"]
          // raw, so a missing key raised KeyError and reached the model as a
          // stage-G1 surprise instead of a repairable G3. The probe reads through
          // the alias helper now, and this stops it at plan time.
          if (!keys.some((k) => OUTER_DIAMETER_KEYS.includes(k))) {
            problems.push(
              `${n.id}: ${p.type} port "${p.name}" declares no outer diameter (params: ${JSON.stringify(keys)}). Add params.outer_diameter in mm — the boss wall diameter the probe measures.`,
            );
          }
        } else if (p.type === "THREADED_STUD") {
          if (!METRIC[String(p.params.thread ?? "")]) {
            problems.push(`${n.id}: THREADED_STUD port "${p.name}" declares no known thread (params: ${JSON.stringify(keys)}). Add params.thread, one of ${Object.keys(METRIC).join(", ")}, and params.length in mm.`);
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
        // Mirrors gates.py _pattern_offsets: `pcd` makes it polar, else a full grid.
        if (PATTERN_PORT_TYPES.has(p.type)) {
          const layout = keys.includes("pcd") ? ["count", "pcd"] : PATTERN_GRID_KEYS;
          const missing = layout.filter((k) => !keys.includes(k));
          if (missing.length > 0) {
            problems.push(
              `${n.id}: ${p.type} port "${p.name}" is missing ${missing.join(", ")} (params: ${JSON.stringify(keys)}). Declare a polar pattern {count, pcd, start_angle?} or a grid {nx, ny, pitch_x, pitch_y} centred on the port origin.`,
            );
          }
        }
      }
    }
    return problems;
  },
};


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
/** A hardware seat's ring_diameter has to land on the bearing annulus.
 *
 *  The guidance now tells the architect to give every hardware node one seat
 *  port, a FLAT_FACE with ring_diameter. That number has to fall between the
 *  thread's own diameter and the bearing face's outer diameter, both of which
 *  live in the METRIC table the architect never sees. A value outside that band
 *  fails G3 with "no material just below the declared face" — and a fastener
 *  resolves through deterministicArtifact with zero model calls and no repair
 *  round, so it lands as an unrecoverable error_code.
 *
 *  Measured on cad-clamp's M4 screw: 4.5 through 6.9 pass, 7.5 and 8.0 fail.
 *  The band is admitted INCLUSIVE at the top because the architect picked
 *  exactly 7.0 on a passing run (M4 shcsHeadD is 7.0) and a lint that can stop
 *  a plan must not reject geometry that verifiably works. The edge is fragile
 *  rather than wrong: at exactly the head diameter the ring samples the rim and
 *  tessellation decides, so the message says to move inboard.
 */
/** Every node must be reachable from the assembly entry through edges.
 *
 *  solveAssembly already says an unmated non-entry node is always wrong: it
 *  "defaults to the origin, which is almost certainly inside another part". But
 *  that complaint arrives AFTER a full cook. A sweep caught the architect
 *  emitting two plates with holes wired to their fasteners and no plate-to-plate
 *  mate at all, so the graph split into (plate-a, screw) and (plate-b, nut) and
 *  plate-b sat inside plate-a — a whole cook spent proving a defect that is
 *  visible in the edge list alone.
 *
 *  Plausibly a side effect of the face/hole guidance: the easiest way to never
 *  conflict a face with a hole is to declare no faces, which silently removes
 *  the plate-to-plate mate. This makes that trade fail at plan time, where the
 *  repair is free. Connectivity ignores edge direction, because a mate
 *  positions whichever end is not yet placed.
 */
/** The assembly entry is placed once, at the origin: nothing can make a copy
 *  of it. Edges asking for one (two providers onto the same entry port) or a
 *  repeated port on the entry's own seat mean the plan wanted it several times
 *  (the spaghetti shelf made a shelf the entry: one placed, six asked). */
export const cadEntryOnceLint = {
  run(graph: GraphDoc): string[] {
    const entry = graph.assembly.entryNodeId;
    const seats = new Map<string, number>();
    // Edges run provider → consumer: the entry as the consumer of one port
    // twice is the entry asked to be two copies.
    for (const e of graph.edges) if (e.to === entry) seats.set(e.toPort, (seats.get(e.toPort) ?? 0) + 1);
    return [...seats].filter(([, n]) => n > 1).map(([port, n]) =>
      `${entry} is the assembly entry, which is placed once, but ${n} edges seat it by "${port}" as if it were several copies. Make the part that stands on the floor or holds the rest (a frame, a base, a post) the entry, and let ${entry} be placed by it, one copy per edge.`);
  },
};

/** A made part mated INTO a tapped hole must say it has the thread. The
 *  spaghetti shelf's foot met its rod's M8 hole with a FLAT_FACE and built a
 *  stud anyway: nothing allowed the overlap, so G5 blocked 132 mm³ of thread. */
export const cadThreadPartnerLint = {
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    const portOf = (id: string, name: string) =>
      (graph.nodes[id]?.contract.payload as CadContractPayload | undefined)?.ports?.find((p) => p.name === name);
    for (const e of graph.edges) {
      for (const [hostId, hostPort, otherId, otherPort] of [[e.from, e.fromPort, e.to, e.toPort], [e.to, e.toPort, e.from, e.fromPort]] as const) {
        const hole = portOf(hostId, hostPort);
        if (hole?.type !== "THREADED_HOLE") continue;
        const other = graph.nodes[otherId];
        if (!other || REGISTRY_HARDWARE.has(other.kind)) continue;
        const theirs = portOf(otherId, otherPort);
        if (theirs?.type === "THREADED_STUD") {
          if (theirs.params.thread !== hole.params.thread) problems.push(`edge ${e.from}.${e.fromPort} → ${e.to}.${e.toPort}: a ${theirs.params.thread} stud in a ${hole.params.thread} hole. Give both the same thread.`);
          continue;
        }
        problems.push(
          `edge ${e.from}.${e.fromPort} → ${e.to}.${e.toPort}: ${otherId} is mated into ${hostId}'s tapped ${hole.params.thread ?? ""} hole "${hostPort}" by a ${theirs?.type ?? "missing"} port. What threads into it? If ${otherId} has a male thread, declare it as a THREADED_STUD port {thread: "${hole.params.thread ?? "M?"}", length} and mate that; otherwise screw it on with catalog hardware through a joint.`,
        );
      }
    }
    // A tapped hole nothing threads into. Joint-minted holes take their screw
    // by its head, so they have no edge of their own and are exempt.
    const mated = new Set(graph.edges.flatMap((e) => [`${e.from}|${e.fromPort}`, `${e.to}|${e.toPort}`]));
    const minted = (id: string, name: string) => (graph.joints ?? []).some((j) => (j.a.node === id || j.b.node === id) && mintedNames(j as never)(name));
    for (const n of Object.values(graph.nodes)) {
      if (REGISTRY_HARDWARE.has(n.kind)) continue;
      for (const p of (n.contract.payload as CadContractPayload | undefined)?.ports ?? []) {
        if (p.type !== "THREADED_HOLE" || mated.has(`${n.id}|${p.name}`) || minted(n.id, p.name)) continue;
        problems.push(`${n.id}: tapped hole "${p.name}" (${p.params.thread ?? "?"}) has nothing threading into it. Mate the part that does: its THREADED_STUD port, or a catalog screw through a joint. A foot or knob with a stud is mated by its THREADED_STUD to this hole, not by a face.`);
      }
    }
    return problems;
  },
};

/** A round rod has no face on its side. The spaghetti shelf's rod declared six
 *  FLAT_FACE ports on its curved surface, so its generator milled a flat down
 *  the full 2.5m to give them one, and the flat's corners cut into every
 *  bracket bore (10.7 mm³ each). A part that slides on a rod mates by a BORE
 *  to a SHAFT station on the rod's axis. Slender cylinders only (length over
 *  three diameters): a flat on a knob or a hub is a real feature. */
export const cadRoundFaceLint = {
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    for (const n of Object.values(graph.nodes)) {
      if (REGISTRY_HARDWARE.has(n.kind)) continue;
      let prims: ReturnType<typeof posedEnvelope> = [];
      try {
        prims = posedEnvelope(graph, n.id, IDENTITY);
      } catch {
        continue;
      }
      const rods = prims.filter((b) => b.round && b.half[2] > 3 * b.half[0]);
      if (!rods.length) continue;
      for (const p of (n.contract.payload as CadContractPayload | undefined)?.ports ?? []) {
        if (p.type !== "FLAT_FACE") continue;
        let pose;
        try {
          pose = resolvePose(graph, p.pose);
        } catch {
          continue;
        }
        const zl = Math.hypot(...pose.zAxis) || 1;
        const onSide = rods.some((b) => {
          const d = pose.origin.map((v, i) => v - b.c[i]!);
          const along = d.reduce((t, v, i) => t + v * b.axes[2][i]!, 0);
          const radial = Math.hypot(...d.map((v, i) => v - along * b.axes[2][i]!));
          const axial = Math.abs(pose.zAxis.reduce((t, v, i) => t + v * b.axes[2][i]!, 0)) / zl;
          return Math.abs(along) < b.half[2] - 1 && Math.abs(radial - b.half[0]) < 1 && axial < 0.2;
        });
        if (onSide) {
          problems.push(`${n.id}: FLAT_FACE port "${p.name}" sits on the curved side of a round rod, which has no face there; the generator would mill a flat to make one. A part that slides onto the rod mates by its BORE to a SHAFT station on the rod's axis (pose on the axis, +z along it, params.diameter = the rod Ø); for levels, one SHAFT port with repeat {count, step}.`);
        }
      }
    }
    return problems;
  },
};

/** A bore a shaft slides through must be wider than the shaft, by the
 *  process's slip, unless it declares its fit (then the probe grades it). */
export const cadBoreShaftLint = {
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    const portOf = (id: string, name: string) =>
      (graph.nodes[id]?.contract.payload as CadContractPayload | undefined)?.ports?.find((p) => p.name === name);
    const dia = (p: { params: Record<string, unknown> }) => {
      try {
        return resolveDim(graph, (p.params.diameter ?? p.params.d) as never);
      } catch {
        return NaN;
      }
    };
    for (const e of graph.edges) {
      const ends = [[e.from, portOf(e.from, e.fromPort)], [e.to, portOf(e.to, e.toPort)]] as const;
      const bore = ends.find(([, p]) => p?.type === "BORE");
      const shaft = ends.find(([, p]) => p?.type === "SHAFT");
      if (!bore || !shaft || bore[1]!.params.fit) continue;
      const [b, sh] = [dia(bore[1]!), dia(shaft[1]!)];
      if (!Number.isFinite(b) || !Number.isFinite(sh)) continue;
      const machined = [bore[0], shaft[0]].some((id) => graph.nodes[id] && isMachined(sourcingOf(graph.nodes[id]!).process));
      const need = machined ? 0 : FDM_SLIP_FIT_MM / 2;
      if (b - sh < need - 1e-9) {
        problems.push(`edge ${e.from}.${e.fromPort} → ${e.to}.${e.toPort}: ${bore[0]}.${bore[1]!.name} is Ø${b} on a Ø${sh} shaft, which cannot slide in. Cut it Ø${+(sh + (machined ? 0.02 : FDM_SLIP_FIT_MM)).toFixed(2)}, or declare {"diameter": ${sh}, "fit": "slip"} and let the probe grade it.`);
      }
    }
    return problems;
  },
};

/** Every pose a contract declares needs a real frame: zAxis and xAxis of
 *  non-zero length and not parallel. A zero axis threw deep in the solver
 *  and ended the robot arm's plan with no repair round. */
export const cadPoseAxesLint = {
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    const bad = (pose: { zAxis?: unknown; xAxis?: unknown } | undefined): string | undefined => {
      const vec = (v: unknown) => (Array.isArray(v) ? v.map((c) => (typeof c === "number" ? c : Number(c))) : []);
      const [z, x] = [vec(pose?.zAxis), vec(pose?.xAxis)];
      if (z.length !== 3 || x.length !== 3 || [...z, ...x].some((c) => !Number.isFinite(c))) return "its axes must be three numbers each";
      const [nz, nx] = [Math.hypot(...z), Math.hypot(...x)];
      if (nz < 1e-9) return "zAxis has zero length";
      if (nx < 1e-9) return "xAxis has zero length";
      const cx = [z[1]! * x[2]! - z[2]! * x[1]!, z[2]! * x[0]! - z[0]! * x[2]!, z[0]! * x[1]! - z[1]! * x[0]!];
      if (Math.hypot(...cx) < 1e-6 * nz * nx) return "xAxis is parallel to zAxis";
      return undefined;
    };
    for (const n of Object.values(graph.nodes)) {
      const payload = n.contract.payload as CadContractPayload | undefined;
      for (const p of payload?.ports ?? []) {
        const why = bad(p.pose);
        if (why) problems.push(`${n.id}: port "${p.name}" pose: ${why} (zAxis ${JSON.stringify(p.pose.zAxis)}, xAxis ${JSON.stringify(p.pose.xAxis)}). zAxis points out of the mating face, xAxis lies in it.`);
      }
      (payload?.envelope?.volumes ?? []).forEach((v, k) => {
        // A cylinder's x is arbitrary and is fixed up when parallel.
        const why = bad(v.pose);
        if (why && !(v.kind === "cylinder" && why.includes("parallel"))) problems.push(`${n.id}: envelope volume ${k + 1} pose: ${why}.`);
      });
    }
    return problems;
  },
};

export const cadMateConnectivityLint = {
  run(graph: GraphDoc): string[] {
    const ids = Object.keys(graph.nodes);
    if (ids.length <= 1) return [];
    const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const e of graph.edges) {
      adj.get(e.from)?.push(e.to);
      adj.get(e.to)?.push(e.from);
    }
    const entry = graph.assembly.entryNodeId;
    const seen = new Set<string>([entry]);
    const queue = [entry];
    while (queue.length) {
      for (const n of adj.get(queue.shift()!) ?? []) {
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    // A gear meshing with another is still placed by what it turns on: the
    // mesh couples their motion (gearMeshes), it positions neither. The
    // extruder's pinion and main gear were dropped from the plan instead.
    const gearHelp = (id: string) =>
      graph.nodes[id]!.kind === "gear"
        ? ` A gear is positioned by the shaft or hub it turns on, never by the gear it meshes with: add an edge from that shaft to ${id}.${gearHubName(graph.nodes[id]!) ?? "bore"} (its HUB_BORE; a pinion on a motor: the motor's shaft → ${id}.${gearHubName(graph.nodes[id]!) ?? "bore"}), or make ${id}.face a revolute joint's b. Keep it in the plan; the mesh with its partner follows from the centre distance.`
        : "";
    return ids
      .filter((id) => !seen.has(id))
      .map(
        (id) =>
          `${id}: no chain of edges connects it to the assembly entry "${entry}", so nothing positions it and it lands at the origin, inside whatever is there. Parts joined face to face need a FLAT_FACE mate edge between them — a hole wired to a fastener positions the FASTENER, not the plate.${gearHelp(id)}`,
      );
  },
};

/** Hardware is built only from the catalog. A sku or thread that names no
 *  catalog row would otherwise surface mid-cook as a G1 failure on a node
 *  with no repair round; here it is an architect repair. */
export const cadHardwareResolvesLint = {
  run(graph: GraphDoc): string[] {
    return Object.values(graph.nodes).flatMap((n) => unresolvedHardware(n) ?? []);
  },
};

/** Registry kinds whose bore is cut to its fit band (registry.ts boreFit),
 *  so a HUB_BORE they declare is a feature of their own. */
const BORED_HARDWARE = new Set(["gear", "pulley", "collar", "bushing", "bearing", "linear_bearing"]);

/** A host feature (the pocket, seat or trap a catalog part goes INTO) declared
 *  on the catalog part itself. magnetic-lid put a MAGNET_POCKET on the magnet:
 *  the registry magnet has no hole, failed G3 with no repair round, and all 8
 *  magnets left the BOM. G3 never probes one (kernelRequest), and the plan lint
 *  sends it back to the host. */
export function hostFeatureOnHardware(kind: string, type: string): boolean {
  return REGISTRY_HARDWARE.has(kind) && HARDWARE_PORT_TYPES.has(type) && !(type === "HUB_BORE" && BORED_HARDWARE.has(kind));
}

/** Which of a node's ports G3 probes. On catalog hardware only what it owns
 *  and the plan lints vouch for: a bored part's HUB_BORE, a fastener's seat
 *  (cadHardwareSeatLint). Every other hardware port is a mate frame, as on
 *  joint hardware: magnetic-lid's seat at mid-thickness failed G3 with
 *  "material found above" and no repair round. G5 judges where it lands. */
function probedPort(kind: string, type: string): boolean {
  if (!REGISTRY_HARDWARE.has(kind)) return true;
  return type === "HUB_BORE" ? BORED_HARDWARE.has(kind) : !!BEARING_DIAMETER[kind] && !HARDWARE_PORT_TYPES.has(type);
}

export const cadHardwareSeatLint = {
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    for (const n of Object.values(graph.nodes)) {
      // Joint hardware's ports are mate frames (INSET_POSE), never probed.
      if (!REGISTRY_HARDWARE.has(n.kind) || isJointHardware(graph, n.id)) continue;
      for (const p of (n.contract.payload as CadContractPayload | undefined)?.ports ?? []) {
        if (!hostFeatureOnHardware(n.kind, p.type)) continue;
        problems.push(
          `${n.id}: port "${p.name}" is a ${p.type}, the pocket a part goes INTO, so it belongs on the host part that holds this ${n.kind}, not on the ${n.kind}. A ${n.kind} is built from the catalog with no such feature and no repair round. Declare the ${p.type} on the host, and give this payload port type FLAT_FACE posed where the ${n.kind} meets the pocket (its contract requires entry may keep type ${p.type}, so the edge types still match).`,
        );
      }
      if (n.kind === "magnet") {
        // magnetic-lid posed the seat at [0, 0, 1.5]: half the magnet stood
        // proud of its pocket. The registry magnet's faces are z = 0 and z = h.
        for (const p of (n.contract.payload as CadContractPayload | undefined)?.ports ?? []) {
          const o = p.pose.origin.map((v) => Number(v));
          const z = p.pose.zAxis.map((v) => Number(v));
          if (o.every((v) => v === 0) && z[0] === 0 && z[1] === 0 && Math.abs(z[2]!) === 1) continue;
          problems.push(
            `${n.id}: port "${p.name}" is posed origin [${o.join(", ")}] zAxis [${z.join(", ")}]. A magnet's face is at the origin with its body running +z, so pose its port at origin [0, 0, 0]: zAxis [0, 0, 1] sinks the body INTO the host's pocket from the pocket's mouth (face flush), zAxis [0, 0, -1] sits it ON a face.`,
          );
        }
      }
      if (!BEARING_DIAMETER[n.kind]) continue;
      // Hardware may name a sku rather than a thread; skuOf reads either.
      const thread = skuOf(n)?.key;
      // The band comes from grounding.ts rather than being recomputed here: the
      // same numbers are rendered into the architect's guidance, and a lint that
      // derives them separately can disagree with what the model was told.
      const band = thread ? seatBand(n.kind, thread) : null;
      if (!thread || !band) continue; // an unknown thread is another lint's business
      const { min: shank, max, recommended } = band;
      for (const p of (n.contract.payload as CadContractPayload | undefined)?.ports ?? []) {
        // THE POSE, and this one cost a green ladder. All three hardware kinds
        // put their bearing face at z = 0 with the body running +z: an SHCS
        // sits head-down with the head on z in [0, headH], a nut seats on z = 0
        // with its body +z, an insert's flange the same. So a seat port's +z
        // must point DOWN, out of that material.
        //
        // The guidance told the architect to declare a seat port and said
        // nothing about which way it faced, which is a coin flip on one sign.
        // It got [0,0,-1] on one run and [0,0,1] on the next, and the second
        // failed G3 with "material found above the declared face" — on a node
        // that resolves from the registry with ZERO model calls and no repair
        // round, so both fasteners landed in unrecoverable error_code.
        //
        // A lint is the right place for it because the geometry is fixed and
        // standards-exact: the architect cannot negotiate with it, so the only
        // question is whether the mismatch is caught before or after a cook.
        const z = p.pose.zAxis.map((v) => Number(v));
        const o = p.pose.origin.map((v) => Number(v));
        const want = SEAT_POSE;
        if (z.some((v, i) => v !== want.zAxis[i]) || o.some((v, i) => v !== want.origin[i])) {
          problems.push(
            `${n.id}: seat port "${p.name}" is posed origin [${o.join(", ")}] zAxis [${z.join(", ")}]. A ${n.kind}'s bearing face sits at the origin with its body running +z, so the port must be origin [0, 0, 0] zAxis [0, 0, -1] to face out of the material. As posed it fails G3 with "material found above the declared face", and ${n.kind} nodes resolve from the registry with no repair round, so that is unrecoverable.`,
          );
        }
        const ring = (p.params as { ring_diameter?: unknown } | undefined)?.ring_diameter;
        if (typeof ring !== "number") continue; // an expression is not resolved here
        if (ring <= shank || ring > max) {
          problems.push(
            `${n.id}: seat port "${p.name}" declares ring_diameter ${ring}, which is not on the bearing annulus of a ${thread} ${n.kind} (between Ø${shank} and Ø${max}). The probe samples that ring and would find air, and ${n.kind} nodes resolve from the registry with no repair round, so this fails unrecoverably. Use a value inside the band, e.g. ${recommended}.`,
          );
        }
        // NOTHING AT THE BOUNDARY. ring === max samples the rim, where
        // tessellation decides, so it is fragile — but a passing run used
        // exactly 7.0 on an M4, and a lint that flags working geometry buys a
        // repair round for nothing and risks the loop that 97c82ed created. The
        // guidance asks for the midpoint instead.
      }
    }
    return problems;
  },
};

export const cadFaceHoleConflictLint = {
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
          // AXIS-ALIGNED BY CONSTRUCTION, not by the corpus happening to be. The
          // previous test compared |zAxis| elementwise, so [0.7,0,0.7] and
          // [0.7,0,-0.7] read as parallel while being 90 degrees apart, and the
          // fail-safe I claimed for it did not exist: findIndex(|v| > 0.5)
          // returns 0 for [0.7,0,0.7], so it picked x as the axis and compared
          // the wrong two components. Only a body diagonal fell through to -1.
          // A lint that can stop a plan has to fail safe on its own terms, so an
          // oblique pose now skips the coaxial branch entirely.
          const aligned = (v: unknown[]) =>
            [0, 1, 2].findIndex((i) => Math.abs(Number(v[i] ?? 0)) > 0.999);
          const hAxis = aligned(h.pose.zAxis);
          const fAxis = aligned(f.pose.zAxis);
          const parallel = hAxis >= 0 && hAxis === fAxis;
          const lateralSame =
            parallel &&
            [0, 1, 2].every(
              (i) => i === hAxis || String(f.pose.origin[i]) === String(h.pose.origin[i]),
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
          // Annular exempts BOTH branches, not only the coaxial one. An annular
          // face sharing the hole's exact origin is equally fine: the ring sits
          // in material and the centre is never sampled. Exempting one branch
          // left the ordinary bolted plate — clearance hole plus a coaxial
          // screw-head seat — blocked at plan time.
          //
          // Residual, and the price of not resolving expressions: a hole WIDER
          // than the ring is still unsatisfiable and still undetectable here,
          // because comparing them needs both numbers resolved.
          const annular = (f.params as { ring_diameter?: unknown } | undefined)?.ring_diameter != null;
          const coaxialThrough = h.type === "CLEARANCE_HOLE" && parallel && lateralSame;

          // THE OFFSET CASE, which cost $0.638 and five generator calls to stop
          // being hypothetical. A face and a hole 20mm apart are not coaxial, so
          // the rule above correctly stays quiet, and the part is still
          // unsatisfiable: rib-plate declared mounting_face with size 40 at the
          // plate centre and a clearance hole 20mm along it, and the face
          // probe's outer ring at radius 19.7 lands inside that hole.
          //
          // I declined to build this once, on the grounds that comparing an
          // offset against a size needs both resolved and getting it wrong
          // blocks a correct plan. Both objections still hold, so this fires
          // ONLY when every value resolves to a number, and it reproduces the
          // probe's own sample radii rather than approximating them: a hole
          // sitting between two rings passes today, and blocking it would be
          // exactly the false positive I was warned about.
          //
          // Verified against the real probe before writing this: on that part a
          // declared size of 40 fails and 36, 34, 30 and 20 pass, matching the
          // ring arithmetic to the millimetre.
          let offsetHit: { at: number; d: number; size: number; dia: number } | null = null;
          if (!annular && !sameOrigin && h.type === "CLEARANCE_HOLE" && parallel && !lateralSame) {
            try {
              const size = resolveDim(graph, (f.params as { size?: number | string }).size!);
              const dia = resolveDim(graph, (h.params as { diameter?: number | string }).diameter!);
              const lateral = [0, 1, 2]
                .filter((i) => i !== hAxis)
                .map((i) => resolveDim(graph, f.pose.origin[i] as number | string) - resolveDim(graph, h.pose.origin[i] as number | string));
              const d = Math.hypot(...lateral);
              const outer = size / 2 - PROBE_INSET_MM;
              const near = d - dia / 2;
              const far = d + dia / 2;
              for (const at of [0, outer / 2, outer]) {
                if (at >= near && at <= far) {
                  offsetHit = { at, d, size, dia };
                  break;
                }
              }
            } catch {
              // An unresolvable expression means no claim. Silence is the safe
              // direction for something that can stop a plan.
            }
          }

          if (!annular && (sameOrigin || coaxialThrough || offsetHit))
            problems.push(
              sameOrigin
                ? `${n.id}: port "${f.name}" (FLAT_FACE) and port "${h.name}" (${h.type}) share an origin, ` +
                    `so no geometry satisfies both: the face probe requires material at that point and the ` +
                    `hole removes it. Offset the face, shrink its size below the hole, or drop one of them.`
                : offsetHit
                  ? `${n.id}: port "${f.name}" (FLAT_FACE, size ${offsetHit.size}) reaches port "${h.name}" ` +
                      `(CLEARANCE_HOLE) ${offsetHit.d.toFixed(1)}mm away, so no geometry satisfies both: the face ` +
                      `probe samples a ring at ${offsetHit.at.toFixed(1)}mm from its centre and that ring falls ` +
                      `inside the hole. Shrink the face below ${(2 * (offsetHit.d - offsetHit.dia / 2) + 2 * PROBE_INSET_MM).toFixed(1)}mm, ` +
                      `move it off the hole, or declare the hole a BORE if it is meant to stop first.`
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
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    const verified = PROBED_PORT_TYPES.join(", ");
    const probed = new Set<string>(PROBED_PORT_TYPES);
    for (const n of Object.values(graph.nodes)) {
      if (REGISTRY_HARDWARE.has(n.kind)) continue;
      for (const p of (n.contract.payload as CadContractPayload | undefined)?.ports ?? []) {
        // Typed as probed by the schema, but graphs on disk predate it.
        const type: string = p.type;
        if (!probed.has(type)) {
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
            type === "LIP"
              ? `A LIP is not one feature — on disk it means a raised rim, a recess that receives one, and a plug, all under one name, so no probe can know which side of the joint it is. Split it: the part that stands proud is a SHAFT (diameter, length), the part that receives it is a BORE (diameter). That names the fit, and both are measured.`
              : `Re-express this interface with a type the probes measure (${verified}), or drop the port and model the feature as part of one solid.`;
          problems.push(
            `${n.id}: port "${p.name}" is a ${type}, which no gate can measure — unchecked, a featureless block would satisfy it, so G3 fails it outright and no generated code can pass it. ${hint}`,
          );
        }
      }
    }
    return problems;
  },
};

/** The round holes a port puts in its part, as G4b's counter sees them: a
 *  counterbore over its pilot is one, a pattern is its members, a motor mount
 *  is its pilot plus its screws. Hex traps and channels are not round. */
function portHoles(graph: GraphDoc, p: CadContractPayload["ports"][number]): number {
  const v = (k: string) => {
    try {
      return resolveDim(graph, p.params[k]!);
    } catch {
      return NaN;
    }
  };
  // A motor's grid layout is its 2×2 square; an unreadable pattern counts as
  // its one certain member, so the lint never rejects on a guess.
  const grid = v("nx") * v("ny") || v("count") || (p.type === "MOTOR_MOUNT" ? 4 : 1);
  switch (p.type) {
    case "CLEARANCE_HOLE": case "SCREW_SEAT": case "BORE": case "THREADED_HOLE": case "INSERT_POCKET":
    case "COUNTERBORE": case "COUNTERSINK": case "DOWEL_HOLE": case "BEARING_SEAT": case "BUSHING_BORE":
    case "MAGNET_POCKET": case "HUB_BORE": case "LINEAR_BEARING_SEAT": case "CLIP_GROOVE":
      return 1;
    case "RAIL_MOUNT":
      return v("count") || 1;
    case "HOLE_PATTERN":
      return grid;
    case "MOTOR_MOUNT":
      return 1 + grid;
    default:
      return 0;
  }
}

/**
 * An envelope volume holding a port that stands past the rest of the envelope
 * along axis `i`, when `max` covers the rest but not it. real-magnet-hinged-box:
 * y max 116 for a 112 body, its Ø6.4 knuckles outside the back wall (their own
 * cylinders, holding the hinge ports), measured 118.4 on base and lid alike.
 * A padded single box never fires: nothing stands past the rest.
 */
function featurePastMax(graph: GraphDoc, n: NodeRecord, boxes: Aabb[], i: number, max: number): { volume: string; port: string; span: number } | undefined {
  if (boxes.length < 2) return undefined;
  const lo = Math.min(...boxes.map((b) => b.min[i]!));
  const hi = Math.max(...boxes.map((b) => b.max[i]!));
  if (hi - lo <= max + ENVELOPE_LINT_MARGIN) return undefined;
  const payload = n.contract.payload as CadContractPayload;
  let prims: ReturnType<typeof posedEnvelope> = [];
  let origins: { name: string; o: [number, number, number] }[] = [];
  try {
    prims = posedEnvelope(graph, n.id, IDENTITY);
    origins = payload.ports.map((p) => ({ name: p.name, o: resolvePose(graph, p.pose).origin as [number, number, number] }));
  } catch {
    return undefined; // unresolvable expression — cadExpressionsResolveLint's
  }
  if (prims.length !== boxes.length) return undefined;
  // The body is the volume widest along the axis; the max must at least hold it.
  const body = boxes.reduce((w, b) => (b.max[i]! - b.min[i]! > w.max[i]! - w.min[i]! ? b : w));
  if (body.max[i]! - body.min[i]! > max + ENVELOPE_LINT_MARGIN) return undefined;
  for (const [k, b] of boxes.entries()) {
    if (b.max[i]! <= body.max[i]! + ENVELOPE_LINT_MARGIN && b.min[i]! >= body.min[i]! - ENVELOPE_LINT_MARGIN) continue;
    const port = origins.find((p) => contains(prims[k]!, p.o, 0.01));
    if (port) return { volume: `${payload.envelope.volumes[k]!.kind} volume ${k}`, port: port.name, span: hi - lo };
  }
  return undefined;
}

/** Assertions no geometry can satisfy, caught before a cook pays to find out.
 *  Only true contradictions: a bbox_axis MAX beyond the envelope is merely
 *  loose (G4 is the tighter bound and still holds), but a MIN beyond it asks
 *  for a part bigger than the box it must fit in. Likewise a volume_range min
 *  above the summed envelope volumes, which bound the union from above.
 *
 *  And one assertion that can only be gamed: a hole_count its own hole-like
 *  ports already reach. The ports' probes check those holes exactly, so the
 *  assertion adds nothing, and when the counter disagreed with a probe about
 *  what a hole is (a D-bore, before it counted) a generator passed it by
 *  drilling decorative holes the user never asked for. */
export const cadAssertionsCoherentLint = {
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    for (const n of Object.values(graph.nodes)) {
      if (REGISTRY_HARDWARE.has(n.kind)) continue;
      const payload = n.contract.payload as CadContractPayload | undefined;
      const assertions = payload?.assertions ?? [];
      if (assertions.length === 0) continue;
      let boxes: Aabb[] = [];
      let capacity = Infinity;
      try {
        const volumes = payload?.envelope?.volumes ?? [];
        boxes = volumes.map((v) => envelopeAabb(graph, v));
        if (volumes.length > 0) {
          capacity = volumes.reduce(
            (sum, v) =>
              sum +
              (v.kind === "box"
                ? v.dims.reduce<number>((p, d) => p * resolveDim(graph, d), 1)
                : Math.PI * (resolveDim(graph, v.d) / 2) ** 2 * resolveDim(graph, v.h)),
            0,
          );
        }
      } catch {
        boxes = []; // unresolvable expression — not this lint's business
      }
      for (const a of assertions) {
        if (a.kind === "volume_range") {
          if (a.min > a.max) problems.push(`${n.id}: assertion volume_range has min ${a.min} > max ${a.max} mm³.`);
          else if (a.min > capacity * 1.01)
            problems.push(
              `${n.id}: assertion volume_range min ${a.min} mm³ exceeds the whole envelope (${capacity.toFixed(0)} mm³). The part cannot hold more material than the volume it must fit in; lower the min or grow the envelope.`,
            );
        } else if (a.kind === "bbox_axis") {
          if (a.min === undefined && a.max === undefined)
            problems.push(`${n.id}: assertion bbox_axis ${a.axis} declares neither min nor max.`);
          if (a.min !== undefined && a.max !== undefined && a.min > a.max)
            problems.push(`${n.id}: assertion bbox_axis ${a.axis} has min ${a.min} > max ${a.max} mm.`);
          const i = { x: 0, y: 1, z: 2 }[a.axis];
          const past = a.max === undefined ? undefined : featurePastMax(graph, n, boxes, i, a.max);
          if (past)
            problems.push(
              `${n.id}: assertion bbox_axis ${a.axis} max ${a.max} mm covers the body but not the ${past.volume} holding port ${past.port}, which stands past the body: the part spans ${past.span.toFixed(1)} mm along ${a.axis} with it. ` +
                `An overall size includes every feature outside the body (hinge knuckles, tabs, bosses): raise max to at least ${past.span.toFixed(1)}, or shrink that volume if it is bigger than the feature.`,
            );
          if (boxes.length > 0 && a.min !== undefined) {
            const extent = Math.max(...boxes.map((b) => b.max[i]!)) - Math.min(...boxes.map((b) => b.min[i]!));
            if (a.min > extent + 2 * ENVELOPE_LINT_MARGIN)
              problems.push(
                `${n.id}: assertion bbox_axis ${a.axis} min ${a.min} mm is larger than the envelope's ${extent.toFixed(1)} mm along ${a.axis}. The part must fit the envelope, so one of the two is wrong.`,
              );
          }
        } else if (a.kind === "hole_count") {
          if (a.max !== undefined && a.min > a.max)
            problems.push(`${n.id}: assertion hole_count has min ${a.min} > max ${a.max}.`);
          const holePorts = (payload?.ports ?? []).filter((p) => portHoles(graph, p) > 0);
          const declared = holePorts.reduce((k, p) => k + portHoles(graph, p), 0);
          if (a.min > 0 && declared >= a.min)
            problems.push(
              `${n.id}: assertion hole_count min ${a.min} is already met by its hole-like ports (${holePorts.map((p) => `${p.name} ${p.type}`).join(", ")}), whose probes check them exactly. hole_count is for holes the user stated that are NOT interfaces (drain holes, a pegboard grid); drop it, or raise min to count those holes too.`,
            );
        } else if (a.kind === "helix") {
          // The farthest any envelope corner sits from the thread's axis bounds the radius.
          const [cx, cy] = a.center ?? [0, 0];
          const reach = Math.max(
            ...boxes.map((b) => Math.hypot(Math.max(cx - b.min[0], b.max[0] - cx), Math.max(cy - b.min[1], b.max[1] - cy))),
          );
          if (boxes.length > 0 && a.radius > reach + ENVELOPE_LINT_MARGIN)
            problems.push(
              `${n.id}: assertion helix radius ${a.radius} mm is farther from its axis than any of the envelope reaches (${reach.toFixed(1)} mm). The thread must fit the envelope, so one of the two is wrong.`,
            );
          if (a.z && a.z[0] >= a.z[1]) problems.push(`${n.id}: assertion helix z range [${a.z.join(", ")}] is empty.`);
        } else if (a.kind === "line_count") {
          if (a.crossings_max !== undefined && a.crossings_min > a.crossings_max)
            problems.push(`${n.id}: assertion line_count has crossings_min ${a.crossings_min} > crossings_max ${a.crossings_max}.`);
          if (a.from.every((v, i) => v === a.to[i]))
            problems.push(`${n.id}: assertion line_count has from = to; the probe line needs a length.`);
          if (a.crossings_min === 0 && a.crossings_max === undefined)
            problems.push(`${n.id}: assertion line_count with crossings_min 0 and no max holds for every part; give the count the feature makes.`);
          // Walls are not in the plan, only envelopes, so this is the one count
          // the plan can refute: a line that never enters the envelope crosses nothing.
          if (boxes.length > 0 && a.crossings_min > 0 && !boxes.some((b) => segmentHitsBox(a.from, a.to, b, ENVELOPE_LINT_MARGIN)))
            problems.push(`${n.id}: assertion line_count from [${a.from.join(", ")}] to [${a.to.join(", ")}] never enters the envelope, so it crosses no material; run it through the features it counts.`);
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
export function kernelPorts(graph: GraphDoc, payload: CadContractPayload) {
  return payload.ports.map((p) => ({
    key: p.name,
    type: p.type,
    pose: resolvePose(graph, p.pose),
    params: resolvePortParams(graph, p.params),
  }));
}

export function kernelEnvelope(graph: GraphDoc, payload: CadContractPayload) {
  return payload.envelope.volumes.map((v) => {
    const { origin: center, zAxis, xAxis } = resolvePose(graph, v.pose);
    return v.kind === "box"
      ? { kind: "box", center, zAxis, xAxis, size: v.dims.map((d) => resolveDim(graph, d)) }
      : { kind: "cylinder", center, zAxis, xAxis, radius: resolveDim(graph, v.d) / 2, height: resolveDim(graph, v.h) };
  });
}

export function mergedParams(node: NodeRecord): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const p of node.contract.params) out[p.name] = p.default;
  return { ...out, ...node.params };
}

type KernelFailed = Extract<KernelResult, { ok: false }>;

/** One failure reads as before. Several (the contract gates report every
 *  failing port and the envelope at once) become a numbered list, each with
 *  its own hint, so one repair round can fix all of them. classifyFailure
 *  reads the `[G4]` tags and `port "…"` names back out of this text. */
function failureReport(result: KernelFailed): string {
  const failures = result.failures ?? [];
  if (failures.length <= 1) return `${result.error}${result.hint ? `\nhint: ${result.hint}` : ""}`;
  const items = failures.map(
    (f, i) => `${i + 1}. [${f.stage}] ${f.error}${f.hint ? `\n   hint: ${f.hint}` : ""}`,
  );
  return `${failures.length} gate failures — fix all of them in this attempt:\n${items.join("\n")}`;
}

// CONTRACT: the kernel could not read a declaration (a hole_count with only
// `max`, a box with no size). The part built; the contract is what is broken.
const CONTRACT_STAGES = new Set(["G3", "G4", "G4b", "G4c", "CONTRACT"]);

/** Higher = closer to passing, so the engine can repair from the best attempt.
 *  G3 earns partial credit for the fraction of ports that measured right. */
function gateScore(result: KernelResult, totalPorts: number): number {
  if (result.ok) return 5;
  if (result.stage === "G3") {
    const failing = new Set(
      (result.failures ?? []).filter((f) => f.stage === "G3").map((f) => f.port ?? f.error),
    ).size;
    return 3 + (totalPorts > 0 ? Math.max(0, totalPorts - Math.max(failing, 1)) / totalPorts : 0);
  }
  if (result.stage === "G4") {
    // Graded by the worst overshoot, inside (4, 4.5]: a flat G4 score made the
    // engine pick the first of three candidates over a closer one, and counted
    // a shrinking overshoot as a stale repair.
    const worst = (result.failures ?? []).find((f) => f.stage === "G4")?.measured;
    return typeof worst === "number" ? 4 + 0.5 / (1 + worst) : 4.25;
  }
  const rank: Record<string, number> = { G0: 0, G1: 1, G2: 2, G4b: 4.75, G4c: G4C_SCORE, CONTRACT: 3, TIMEOUT: 0.5, KERNEL_CRASH: 0.5 };
  return rank[result.stage] ?? 0;
}

/** Replaces the engine's web-flavoured decomposition rules ("prefer header,
 *  grid, theme"), which contradict ONE PART IS A COMPLETE ANSWER. */
const CAD_ARCHITECT_RULES = [
  "- Declare a param for every dimension a user might slide: overall sizes,",
  "  wall thickness, hole diameters, counts. Never colours or labels.",
  "- Fewest parts wins. Split only for a reason the ONE PART rule names, and",
  "  never along the features of one printed object.",
];

/** Reprompt routing in CAD words. A port's pose and diameter are pinned and
 *  probed, so "make the mount hole 5mm" is a contract change only T3 can make,
 *  while "rounder", "add a fillet" or "smoother" reshape inside the ports. */
export const CAD_TIER_HINTS: TierHints = {
  addsInterface: /\b(?:add|cut|drill)\s+(?:a|an|another|one|two|three|four|\d+)?\s*(?:new\s+)?(?:\w+\s+)?(?:holes?|ports?|mounts?|mounting points?|bores?)\b/i,
  sizeWords:
    /\b(?:holes?|diameter|thick|thickness|thicker|thinner|wider|narrower|taller|shorter|longer|bigger|smaller|larger|size|mount|bore|envelope)\b|[Øø]|\d\s*mm\b|\bmm\b/i,
  classifierGuide: [
    "T2 — the request reshapes the part INSIDE its pinned interface: fillets,",
    "     chamfers, smoothness, internal ribs, styling, anything that leaves",
    "     every port's position, axis and diameter and the envelope as they are.",
    "T3 — the request moves the interface: a port's position, axis or size",
    "     (hole/bore diameter, face size), adding or removing a hole, mount or",
    "     port, or growing the part past its envelope. Neighbours mate to these.",
  ].join("\n"),
};

/** Kinds the joint rules mint. The architect never declares them: it declares
 *  a joint and gets them. */
const JOINT_HARDWARE_KINDS = new Set(["washer", "dowel", "bearing", "bushing", "shaft", "collar", "eclip", "linear_bearing", "rail", "carriage", "motor", "coupler", "lead_nut"]);

/** Every other catalog kind, from the catalog, so a new family is plannable. */
function catalogKinds() {
  const listed = new Set(["part", "fastener", "nut", "insert", "threaded_rod", "gear"]);
  const byKind = new Map<string, string[]>();
  for (const [name, f] of Object.entries(CATALOG.families)) {
    if (!listed.has(f.kind)) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), name]);
  }
  return [...byKind].map(([kind, families]) => {
    const f = CATALOG.families[families[0]!]!;
    const example = skuFor(families[0]!, Object.keys(f.dims)[0]!)!.id;
    return {
      kind,
      description: `Registry ${families.join(" / ")} (never LLM-generated).`,
      guidance: JOINT_HARDWARE_KINDS.has(kind)
        ? "Minted by the joint rules: declare a joint with intent and motion, never this node."
        : `Param: sku, a catalog id such as ${example}.`,
    };
  });
}

/** The architect's view of CAD. Mesh availability is the only input, so the
 *  system prompt is stable for a given configuration. */
function cadPlanning(meshAvailable: boolean) {
  return {
    nodeKinds: [
      { kind: "part", description: "A single printed part.", guidance: "One build(p) function; ports declared in the contract, never in code." },
      { kind: "fastener", description: "Registry socket-head cap screw (never LLM-generated).", guidance: "One node per screw spec; resolved from the fastener registry." },
      { kind: "nut", description: "Registry hex nut (never LLM-generated).", guidance: "Use when a screw is captured by a nut rather than threading into a boss or insert. One param: thread." },
      { kind: "insert", description: "Registry heat-set threaded insert (never LLM-generated).", guidance: "Use for screws threading into printed plastic — the durable choice over tapping the plastic directly. One param: thread." },
      { kind: "threaded_rod", description: "Registry threaded rod / stud, real ISO profile (never LLM-generated).", guidance: "Use for a stud captured by nuts at both ends. Params: thread and length." },
      { kind: "gear", description: "Registry involute spur gear (never LLM-generated).", guidance: "Params: module, teeth, pressure_angle, thickness, bore. Mesh distance between two gears is module * (teeth_a + teeth_b) / 2. Declare no ports: it gets `bore` (HUB_BORE) and `face` (FLAT_FACE) on its -z face; wire a shaft to `bore` or name `face` as a joint's b." },
      ...catalogKinds(),
    ],
    jointSchema: CadJoint,
    expandPlan: (out: ArchitectOutput, live?: Parameters<typeof expandJoints>[1]) =>
      markCncSetups(mintDefaultGearPorts(expandJoints(mintNamedGearPorts(expandRepeats(out)), live))),
    autoFix: autoFixPlan,
    critic: {
      summarize: summarizeCadPlan,
      repairHint:
        "A count short of the brief (six shelves, one placed): one node, wired once per position, or once to a port with repeat {count, step} on the part that holds it; what is mated only to a repeated part is copied with it, and the entry is placed once. Add a part the brief names as its own node, mated into the assembly. Add a motion or a piece of hardware the brief names (an axle, pin, bearing, gear pair, spring, screw) as a JOINT between the two parts it connects, with the motion it has and `prefer` naming that hardware, so plan expansion mints it. A joint whose hardware will not fit is fixed, never dropped.",
    },
    paramUnit: "mm",
    payloadSchema: CadContractPayload as z.ZodType<CadContractPayload>,
    graphLints: [
      cadExpressionsResolveLint,
      cadPortConsistencyLint,
      cadFastenerJustifiedLint,
      cadEnvelopeCoherentLint,
      cadFlatFaceSizeLint,
      cadPoseAxesLint,
      cadProbedPortsLint,
      cadAssertionsCoherentLint,
      cadFaceHoleConflictLint,
      cadHardwareResolvesLint,
      cadHardwareSeatLint,
      cadMateConnectivityLint,
      cadEntryOnceLint,
      cadThreadPartnerLint,
      cadRoundFaceLint,
      cadBoreShaftLint,
      cadPlanGeometryLint,
      cadAssemblyPlanLint,
      meshSourceLint(meshAvailable),
      cadSourcingLint,
      cadJointRuleLint,
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
      "SOURCING: every part is buy (catalog hardware kinds, implied), print (FDM, the",
      "default — omit payload.sourcing) or fabricate. Class a part fabricate only when",
      "FDM cannot meet the requirement, or the user asks for it: metal for load, wear or",
      "heat; fits tighter than ~0.1mm; a shaft with a flat or keyway; a sheet-metal",
      'bracket. Then write payload.sourcing {"class": "fabricate", "process": cnc |',
      'sheet_metal | laser_cut | sls | mjf | resin, "material": "6061-T6 aluminium",',
      '"finish"?, "qty"?} — process AND material are required — and set process.kind',
      '"CNC" exactly when the process is cnc. A fabricated part is still generated and',
      "gated like any other, plus that process's manufacturability rules.",
      "CNC SETUPS: a 3-axis mill reaches only faces it sees from +Z or -Z. A cnc part",
      "whose features open in more than one direction (holes on both legs of an L)",
      'is machined in two setups: set sourcing.allowUndercuts true (expansion does it',
      "for you when a non-FLAT_FACE port's +z is off the Z axis), or lay every feature",
      "along Z if one setup matters to the user.",
      "",
      "FRAME CONVENTION (critical): every part is modeled in its OWN LOCAL frame,",
      "roughly centered on the origin — the assembly places parts later via port",
      "mates. Never author ports or envelopes in assembly/world coordinates.",
      "Port poses: +z points OUT of the part's mating surface (out of material).",
      "",
      // Measured: plan time is output tokens at ~120/s, and the defaults below
      // were a tenth of a typical plan, every value of them copied by rote.
      "LEAVE DEFAULTS OUT; parsing fills them, so writing one only costs time:",
      'pose zAxis [0,0,1], xAxis [1,0,0], origin [0,0,0] (an envelope volume',
      'centred on the origin needs no pose at all), units "mm", process',
      '{"kind": "FDM", "minWall": 1.2, "nozzle": 0.4} (write it only for CNC),',
      "envelope.clearance 0.4, paramBindings {}, geometrySource",
      '"parametric", and a joint\'s motion "fixed", duty "occasional", load',
      '"light", access "both_sides", count 1.',
      "",
      // Derived, so it can never again disagree with the schema or the lint.
      `ONLY THESE PORT TYPES MAY BE USED: ${PROBED_PORT_TYPES.join(", ")}.`,
      "These are the ones the gates can measure against the real solid. Any",
      "other type is rejected at plan time, because a port nothing can probe",
      "makes the whole node unverifiable. If an interface wants a lip or a snap,",
      "express it with the types above, or model both sides as ONE part and",
      "declare no port at all.",
      "GROOVE and SLOT ports MUST carry params: {\"width\": <mm>} — the gap a",
      "  mating tongue or plate sits in, which is the number the other part is cut",
      "  to. Add params.depth only for a channel with a floor; omit it for a cut",
      "  that passes through, or the probe will look for a floor that is not there.",
      "  The channel RUNS ALONG the port's xAxis and its width is measured across.",
      "  The origin sits on the MOUTH, the face the channel opens through, with +z",
      "  out of it, and params.depth runs from the mouth INTO the material along",
      "  -z to the floor — never on the floor itself. A keyway 4 wide whose floor",
      "  is 8mm from a Ø12 bore's axis opens through the bore wall: origin",
      "  [0, 6, z], zAxis [0, -1, 0] (out into the bore), depth 2.",
      "  The declared width is the NARROWEST gap over the channel's depth, since",
      "  that is what a mating tongue must pass, so keep channels prismatic — a",
      "  chamfered or drafted mouth is fine, a V-groove declared at its mouth is",
      "  not. Channels must also be at least 1.2mm deep to be probed at all;",
      "  anything shallower is a FLAT_FACE, not a channel.",
      "",
      "Hole-like ports (CLEARANCE_HOLE, BORE, SCREW_SEAT) MUST carry",
      '  params: {"diameter": <mm>} — that exact key; probes measure against it.',
      '  A BORE a shaft or rod slides through may instead declare {"diameter": <the shaft Ø>,',
      '  "fit": "slip"|"press"}: the probe then grades it on the fit band for its process.',
      "FLAT_FACE ports MUST carry params: {\"size\": <mm>} — the width of the flat",
      "  the mating part sits on (or {\"ring_diameter\": <mm>} for an annular seat).",
      "  A probe with no size to measure against cannot check the port at all.",
      "SCREW_BOSS ports MUST carry params.outer_diameter (and pilot_diameter if",
      "  it has a pilot hole). SHAFT ports (a peg standing out of the face along",
      "  +z) MUST carry params.diameter, plus params.length to check its tip.",
      "HOLE_PATTERN / BOSS_PATTERN: ONE port for N identical holes or bosses,",
      "  each probed on its own. Same diameter params as the single feature, plus",
      "  a layout in the port frame (x along xAxis, centred on the origin):",
      '    polar: {"count": 4, "pcd": 50, "start_angle": 45} (pcd = bolt-circle',
      "           DIAMETER, start_angle in degrees from xAxis, default 0)",
      '    grid:  {"nx": 2, "ny": 2, "pitch_x": 40, "pitch_y": 40} (all four, even for',
      "           a single row: the lint rejects a grid missing pitch_y)",
      "  Members are probed like a BORE: they must exist at the right Ø, but a",
      "  pattern does not assert that its holes pass through.",
      "HARDWARE HOST FEATURES, one per catalog part, all centred on the origin, axis on +z:",
      '  THREADED_HOLE {"thread": "M3", "depth"}: tapped into metal, cut at the tap drill.',
      '  THREADED_STUD {"thread": "M8", "length"}: a MALE thread on a made part (a foot\'s stud, a',
      "    spindle) standing out of its face along +z. Whatever threads into a THREADED_HOLE is a",
      "    catalog screw, rod or stud, or a part with a THREADED_STUD mated to that hole.",
      '  INSERT_POCKET {"diameter", "depth"}: heat-set insert hole, cut depth+0.3, 1.2mm wall around it.',
      '  NUT_TRAP {"af", "depth", "entry": "axial"|"side"}: hex, a CORNER on xAxis; side entry opens toward +x.',
      '  COUNTERBORE {"diameter", "depth", "through_diameter"}: head recess over a through bore.',
      '  COUNTERSINK {"diameter", "angle", "through_diameter"}: cone Ø at the face, included angle.',
      '  DOWEL_HOLE {"diameter", "depth", "fit": "press"|"slip"}: nominal dowel Ø; the probe applies the fit.',
      '  BEARING_SEAT {"od", "width", "fit": "press"|"slip"}: outer-ring pocket with a shoulder below it so the bearing stops.',
      '  DOWEL_HOLE and BEARING_SEAT MUST carry a literal "fit"; without it G3 fails the port.',
      '  BUSHING_BORE {"od", "length"}: press-fit pocket for a plain bushing.',
      '  MOTOR_MOUNT {"pilot_diameter", "hole_diameter", "pcd"+"count" | "pitch_x"+"pitch_y"}: pilot + screw pattern.',
      '  MAGNET_POCKET {"diameter", "depth"}: disc magnet pocket, 0.05-0.2 over the magnet Ø.',
      '  HUB_BORE {"diameter", "flat"?}: slip bore on a shaft; flat = axis-to-flat distance along +xAxis.',
      '  LINEAR_BEARING_SEAT {"od", "length", "fit", "retention": "lip"|"clip"}: LM-UU pocket, length deep;',
      '    "lip" stands it on a shoulder (bore below ≤ od − 2), "clip" may run through.',
      '  CLIP_GROOVE {"diameter", "width", "shaft_diameter"}: e-clip groove ON a shaft, origin on the axis',
      "    at the groove's middle, +z along the shaft.",
      '  RAIL_MOUNT {"width", "length", "pitch", "count", "hole_diameter", "depth"?}: flat rail land along',
      "    xAxis with its fixing holes at pitch, centred.",
      "  For DOWEL_HOLE, BEARING_SEAT, BUSHING_BORE, MAGNET_POCKET, HUB_BORE and the MOTOR_MOUNT",
      "  pilot, declare the PART's nominal size (the dowel, bearing, magnet); the gate adds the fit.",
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
      "  A volume's pose orients it: box dims run along its xAxis, y = z × x and",
      "  zAxis, and a cylinder's height runs along its zAxis, so a horizontal rod",
      "  is a cylinder with zAxis [1,0,0], not an upright one.",
      "Prefer axis-aligned frames (zAxis one of ±x/±y/±z) and simple orientations:",
      "plates flat in XY, height along Z.",
      "",
      "IDENTICAL PARTS ARE ONE NODE, REPEATED BY EDGES. Four arms on a frame,",
      "two skids under a body, six identical legs: emit ONE node for the part and",
      "wire it once per position — every edge landing on the SAME port of that",
      "node, from a DIFFERENT port on the part it mounts to. The assembly places",
      "a copy per edge, so four seats on a plate give four arms from one node,",
      "and reprompting that node changes all of them together. Give the mounting",
      "part a seat port per position (arm_seat_fl, arm_seat_fr, ...); the repeated",
      "part needs only its single mating port. Edges onto DIFFERENT ports of the",
      "same node still mean one part held at two points, so do not reuse a port",
      "name to mean two features.",
      "COPIES CARRY WHAT HANGS ON THEM: a part mated only to a repeated part (and",
      "to what hangs below it) is placed on every copy, so a rod under each of",
      "two brackets is one rod node with one edge. Levels and rows: give the",
      "holding part ONE port with repeat {count, step} (a station every 400mm up",
      "a post: repeat {count: 6, step: [0, 0, 400]}) and wire the repeated part",
      "to it once; expansion makes <name>_1..<name>_N and an edge to each.",
      "THE ENTRY IS PLACED ONCE: make the part that stands on the floor or holds",
      "the rest (a frame, a base, a post) the entry, never a part the brief",
      "asks for several of.",
      "Features repeated WITHIN one part — a bolt circle, four blades on a hub,",
      "a hole pattern — are not nodes at all: the generator writes a loop, and",
      "the contract declares them as one HOLE_PATTERN or BOSS_PATTERN port.",
      "",
      // Intent in, hardware out (joints.ts, expand.ts). The architect used to
      // pick screws and inserts itself, and a plausible wrong pick cost a
      // cook; a rule costs nothing to run again.
      "JOINTS, NOT HARDWARE. Wherever two parts are held, aligned, spun or slid",
      "against each other, declare a joint in `joints` and NO hardware nodes. The",
      "rules choose the screw, insert, nut, washers, dowel, bearings, shaft,",
      "collars, rail or motor, add the host features (counterbore, insert pocket,",
      "nut trap, bearing seat, hub bore, ...) to both parts' contracts with exact",
      "catalog sizes, and wire every edge. You state what the joint must DO:",
      '  {"id": "j1", "a": {"node": "base", "port": "lid_face"}, "b": {"node": "lid", "port": "base_face"},',
      '   "intent": "removable", "motion": "fixed", "load": "light", "access": "both_sides",',
      '   "count": 4, "pitch": 40, "wallA": "param(base.wall)", "wallB": "param(lid.thickness)"}',
      "  a is the part that stays put; b is the part joined to it, and the part",
      "  that MOVES for revolute and prismatic joints. a.port and b.port are",
      "  FLAT_FACE ports where the joint sits, +z toward the other part, sized to",
      "  leave flat around what the rules cut there. A fixed joint's two ports are",
      "  also the a-b face mate (wire that edge as usual). A moving b is placed",
      "  through its hardware, so never wire a to b directly for motion.",
      "  At travel 0 the two parts of a revolute joint face AWAY from each other:",
      "  pick b.port's xAxis so b lies on the far side of the axis from a (hinge",
      "  leaves open flat), never on top of a.",
      "  wallA / wallB: each part's thickness at the joint, along the joint axis,",
      "  as a number or a param expression. A wall too thin for every rule comes",
      "  back as a lint naming the wall and how thick it must be.",
      "  intent: permanent | removable | serviceable | alignment (dowels).",
      "  motion: fixed | revolute | prismatic, duty: occasional | continuous,",
      "  load: none | light | medium | heavy, access: one_side | both_sides.",
      "  Optional: flush (countersunk), count and pitch (a pattern of N, spacing",
      "  mm), driven + speedClass/torqueClass low|medium|high (adds a motor),",
      "  strokeMm (prismatic), shaftHint/threadHint (mm / M3..M8), allowPrinted",
      "  (a printed pin pivot), lateral (room for a side nut trap), hubFit press",
      "  (b pressed onto the shaft: a wheel onto its axle; default slip).",
      "  A printed pin can only take a b that slides onto it; b between a's",
      "  knuckles (an interleaved hinge) gets a separate pin, filament stock for",
      "  shaftHint 1.75. printInPlace: true (revolute, both FDM) when a and b print",
      "  as ONE piece, the pin captive: a print-in-place hinge, a fidget, or a",
      "  brief that says it prints assembled. Nothing is inserted, so never with",
      "  hardware, and never for parts that must come apart.",
      "  STATED HARDWARE IS BINDING. When the brief names hardware (type, size,",
      "  quantity), put it in `prefer` and its size in the hint too: \"two 4mm",
      "  dowels\" = prefer {family: dowel, key: \"4\"}, shaftHint 4, count 2; \"M5",
      "  through-bolts with nuts and washers\" = prefer {recipe: R3}, threadHint",
      "  M5; \"a GT2 belt\" = prefer {family: gt2_pulley}; \"608 bearings\" =",
      "  prefer {family: bearing, key: \"608\"}; \"a 3mm steel pin\" = prefer",
      "  {family: shaft, key: \"3\"} (any Ø3 shaft or pin); also hex_nut, heatset_std,",
      "  bushing, lm_uu, spur_gear, mgn_rail. Furniture names: \"connector screw\",",
      "  \"Euro screw\" or \"confirmat\" = prefer {family: confirmat}; \"cam lock\" or",
      "  \"minifix\" = prefer {family: cam_lock}; \"double-ended screw\", \"hanger",
      "  bolt\" or \"dowel screw\" = prefer {family: dowel_screw}; \"axle nail\" =",
      "  prefer {family: wire_nail}. Only rules that use it are tried;",
      "  if it cannot fit, the lint names what it needs. Never drop it.",
      "  travel (revolute): when the brief states one (\"opens 0 to 110°\", \"swings",
      "  at least 120°\"), place b at the pose the travel starts from (a lid CLOSED",
      "  on its box) and write travel: 110. Expansion turns it whichever way the",
      "  parts allow and writes the limits; never work out a direction by hand.",
      "  limits only when the direction matters beyond that: degrees about",
      "  a.port's +z, right-handed, 0 = the pose the mates place.",
      "  One part placed several times (four identical wheels) is one node whose",
      "  joints all name the SAME b.port; joints on opposite faces of a on one",
      "  axis line share one axle. Never two joints on one a.port + b.port pair:",
      "  it mints a second set of hardware on the same axes. A pattern of",
      "  screws or dowels is one joint with count and pitch; two guide rods are",
      "  two joints, each on its own a.port and b.port at its rod's axis.",
      "  A rod held at both ends (two end blocks) is a on the near block and",
      "  far: {node, port} on the far one: its own node, a FLAT_FACE facing back",
      "  along the rod. Nothing places one node at both ends of a rod.",
      "  A driven revolute joint with ratio (motor turns per output turn) or",
      "  centerMm (motor axis to driven axis) gets a NEMA 17 beside the axis and a",
      "  GT2 belt, or a spur pair at high torque / low speed / a short centre;",
      "  the motor sits on +x of a's port, under a. wallMotor: a's thickness",
      "  under the motor when thinner than wallA (a pocket in a's underside).",
      "  A driven prismatic joint gets a lead screw (stroke <= 300, not fast:",
      "  axis along a's port +z) or a belt-driven rail carriage (along +x).",
      "  A rotor that spins freely is revolute/continuous: a gets two bearing seats",
      "  (wallA must hold two bearings and a shoulder), b gets a hub bore on the",
      "  shaft, and the swept clearance of b around the axis is checked.",
      "Never emit a fastener, nut, insert, washer, dowel, bearing, shaft, collar,",
      "rail, motor, pulley, belt, gear, coupler or lead nut node for a joint: the",
      "rules mint them, with ids like",
      "j1_screw. Hardware no joint owns must still be justified by a host port.",
      "",
      "",
      "A part CLAMPED ON A ROD or post (a bracket, a collar-held shelf, a lamp arm):",
      "  a fixed joint with a = the rod at its SHAFT station (on the axis, +z along",
      "  it), b = the part at its BORE, wallB = b's wall around the bore; toolFree:",
      "  true when it is set by hand (a DIN 464 thumb screw), else a set screw; a",
      "  medium load adds a DIN 705 collar under b. Never hand-wire the screw.",
      "",
      "Every hole or bore the brief states with a size is a declared port on",
      "its part (a BORE or CLEARANCE_HOLE at that Ø), joint or no joint.",
      "",
      // THE RULE THE ARCHITECT TRIPPED ON 14 OF 15 PLANS. It lived only in the
      // lint, so every first emission declared a face and a hole on one axis —
      // the natural reading of 'a plate with a hole in the middle' — and paid a
      // whole-graph repair round (~$0.07, 15-30s) to learn a rule one sentence
      // states. Confirmed live: cad-face-hole-conflict fired on the simplest
      // prompt in the ladder, every time.
      "A FLAT_FACE may not share its origin with a hole port, and a",
      "CLEARANCE_HOLE may not be coaxial with a FLAT_FACE at any distance: a",
      "clearance hole passes through, so it pierces every face on its axis at",
      "the exact point the face probe samples. Offset the face from the hole",
      "axis (a face beside a hole is an ordinary plate), shrink it clear, or use",
      "an annular face (params.ring_diameter) whose probe never samples its",
      "centre. A BORE or SCREW_SEAT stops, so it only conflicts at a shared",
      "origin.",
      "",
      // Rendered from grounding.ts, so the numbers the architect reads are the
      // same objects the lints check. The pose sign is in here because guessing
      // it cost two unrecoverable fastener failures.
      ...groundingLines(),
      "",
      "GEAR NODES are registry too — an involute tooth profile is not something",
      "to write by hand. Params: module, teeth, pressure_angle (20 unless you",
      "have a reason), thickness, bore (0 for none). The gear is centered on the",
      "origin. Two meshing gears sit module * (teeth_a + teeth_b) / 2 apart; put",
      "that distance in the parts that carry their shafts, via expressions.",
      "Leave a gear's ports empty: every gear gets `bore` (HUB_BORE, Ø = bore)",
      "and `face` (FLAT_FACE), both on its -z face, normal -z. Position it by",
      "what it turns on: an edge from a shaft or spigot to <gear>.bore, or a",
      "revolute joint whose b is <gear>.face (the joint cuts the hub). Any other",
      "port name an edge or joint gives a gear is minted there too.",
      "",
      "Layout-first: choose each part's envelope primitives, then assign ports at",
      "the mating faces, and size hole/boss diameters from the fastener registry",
      "(M3 clearance 3.4 / M4 4.5 / M5 5.5).",
      "",
      "REFERENCE IMAGES. When the goal arrives with reference images, they are",
      "the user's spec: match the silhouette and proportions they show. A view",
      "label says where the camera stood: front = seen from -y (+x to the right,",
      "+z up), side = seen from +x (+y to the right), back = seen from +y, top =",
      "seen from +z (+x right, +y up). Pose the assembly so its world frame",
      "matches, since the assembly's silhouette is compared against each",
      "labelled image. If a target height is given, it is the assembly's overall",
      "Z extent: derive every dimension from it and the image's proportions.",
      "For every non-hardware part also write payload.visualRef: one or two",
      "sentences describing that part's region of the image (where it sits,",
      "its outline, its taper or curvature). It is the ONLY sight of the image",
      "that part's generator gets, so describe the shape, not the photo.",
      "Tie that part's visualChecks to the image too (\"Does the tail fin sweep",
      "back as in the reference?\").",
      ...geometrySourceGuidance(meshAvailable),
      "",
      "VISUAL CHECKS: give every part that is NOT registry hardware",
      "payload.visualChecks, 2 to 5 yes/no questions a reviewer answers by looking",
      "at renders of the finished part (iso, front, right and top views). Ask about",
      "what the ports and envelope cannot pin: where a feature sits, its shape,",
      "how many there are, which way it faces. Phrase each so YES means correct:",
      '  "Is the cockpit opening on the top face?"',
      '  "Does the tail boom taper toward the tail?"',
      '  "Are there exactly two skids, one on each side?"',
      "One fact per question, visible from outside. Never ask about a measured",
      "size (the gates already check every declared dimension), and never ask",
      "anything that a correct part could leave hidden from all four views.",
      "",
      "ASSERTIONS PIN THE USER'S NUMBERS. Give every non-hardware part 1-4",
      "payload.assertions that capture what the user actually stated, measured on",
      "the finished solid in its own frame:",
      '  {"kind": "bbox_axis", "axis": "x", "min": 79.5, "max": 80.5}  overall size, mm',
      '  {"kind": "hole_count", "min": 6, "max": 6}   closed round holes, blind or',
      "      through; a counterbore over its pilot counts once. ONLY for holes the",
      "      user stated that are NOT ports: every hole a port declares (bores,",
      "      seats, hub bores, screw holes, pattern members) is already probed, and",
      "      a hole_count those ports alone satisfy is rejected. The count covers",
      "      the port holes too, so min = port holes + the stated ones.",
      '  {"kind": "symmetry", "plane": "yz"}           mirror plane through the part\'s',
      "      bounding-box centre",
      '  {"kind": "volume_range", "min": ..., "max": ...}  mm³, only for a stated',
      "      weight or material budget",
      '  {"kind": "min_wall", "mm": 2}                  only for a stated wall',
      '  {"kind": "solids", "count": 2}                 only when the user wants',
      "      several separate bodies printed as one part",
      '  {"kind": "helix", "radius": 3.65, "pitch": 1.25, "z": [0, 30]}  a modelled',
      "      thread about an axis parallel to the part's Z (\"center\": [x, y], default",
      "      the origin). radius = MID-FLANK = (major + minor) / 4; z = the THREADED",
      "      length only, never a plain shank or head; hand/starts if stated",
      '  {"kind": "line_count", "from": [-20, 0, 5], "to": [20, 0, 5], "crossings_min": 12}',
      "      solid runs a straight probe line crosses, part frame mm: one per",
      "      knurl tooth, rib or slot web it passes through. It counts EVERY",
      "      material run on the segment, outer walls included, and an end inside",
      "      a wall counts that wall. Start and end the line outside the part.",
      "      A 90mm box with 2.4mm walls and two dividers along x, probed from",
      "      [-46, 0, 15] to [46, 0, 15], crosses wall, divider, divider, wall: 4.",
      "EVERY STATED FEATURE GETS AN ASSERTION THAT FAILS WITHOUT IT. Ports and a",
      "bbox pass a plain cylinder where the user asked for a threaded rod, so a",
      "thread, knurl, slot or rib the user named needs its own helix or",
      "line_count. \"An M8 x 1.25 bolt with 30 mm of thread from z=0\" earns",
      '{"kind": "helix", "radius": 3.65, "pitch": 1.25, "z": [0, 30]} (major 8, minor',
      "6.6) beside the bbox_axis on z; \"a knob with 18 knurl ridges\" earns a",
      "line_count across the grip.",
      "NEVER assert anything the user did not say or clearly imply: a guessed",
      "number fails a correct part. \"An 80mm soap dish with six drain holes\"",
      "earns a bbox_axis on its length and a hole_count of 6; \"an 80mm plate",
      "with four M4 mounting holes\" earns the bbox_axis and a HOLE_PATTERN port,",
      "not a hole_count. Neither earns a thickness, a volume or a symmetry.",
      "Every assertion must fit inside the",
      "envelope, which is checked at plan time.",
      "",
      "PARAMS ARE THE USER'S CONTROL PANEL — write them for a person, not a",
      "compiler. Every param needs a `description` saying what it does in plain",
      "words (\"how thick the plate prints\", not \"thickness\"); a blank one leaves",
      "the inspector empty. Give min and max the real usable range, not a token",
      "one — they set the slider's travel. Never write `ui`: the plan schema",
      "drops it, so it is output you pay for and nobody reads.",
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
      "",
      `WORKED PLAN for "${WORKED_PLAN_GOAL}" (the shape of a good answer, not a`,
      "template — copy its conventions, never its numbers or its part count):",
      JSON.stringify(WORKED_PLAN),
    ].join("\n"),
    architectRules: CAD_ARCHITECT_RULES,
    tierHints: CAD_TIER_HINTS,
    advisoryPayloadKeys: ["visualChecks", "visualRef", "sourcing"],
  };
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
   *  long think returns no part at all. Round 1 drafts three candidates in
   *  parallel because the gates are a free oracle; from round 3 the model
   *  thinks harder, since cheap rounds have already failed twice. */
  readonly generation = {
    effort: "medium",
    maxTokens: 24000,
    firstRoundCandidates: 3,
    escalate: { fromAttempt: 3, effort: "high", maxTokens: 32000 },
  } as const;

  /** Port probes (G3) and envelope (G4) fail on a built shape worth showing. */
  readonly renderStages = ["G3", "G4"];
  /** A declaration the gates could not read or resolve fails every rewrite. */
  readonly terminalStages = ["CONTRACT"];
  readonly inspectSystem = CAD_INSPECT_SYSTEM;


  /** Makes the surface of `geometrySource: "mesh"` nodes; absent = none. */
  readonly meshSource?: MeshSource;
  readonly planning: ReturnType<typeof cadPlanning>;

  constructor(opts: { kernel?: KernelClient; maxAttempts?: number; meshSource?: MeshSource } = {}) {
    this.kernel = opts.kernel ?? new KernelClient();
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.meshSource = opts.meshSource;
    this.planning = cadPlanning(opts.meshSource !== undefined);
  }


  deterministicArtifact(node: NodeRecord): { code: string } | null {
    // A mesh node loads its fitted surface, like an imported piece, until a
    // reprompt routes it to the generator to edit that mesh.
    if (isMeshNode(node)) return node.thread.length > 0 ? null : { code: meshNodeCode(node) };
    const code = resolveDeterministic(node);
    return code ? { code } : null;
  }

  /** Catalog hardware: no model ever writes it, not even as a G5 repair. */
  deterministicOnly(node: NodeRecord): boolean {
    return REGISTRY_HARDWARE.has(node.kind);
  }

  /** Mesh nodes need their surface on disk before `meshNodeCode` builds:
   *  generated once (billed), re-fitted into the envelope when it moves. */
  prepareArtifact(node: NodeRecord, ws: Workspace, graph: GraphDoc, signal?: AbortSignal, log?: (line: string) => void) {
    if (!isMeshNode(node) || node.thread.length > 0) return null;
    return prepareMeshNode({
      node,
      graph,
      projectDir: path.resolve(ws.root, ".."),
      kernel: this.kernel,
      source: this.meshSource,
      signal,
      log,
    });
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
    opts: { nodeId?: string; format: string; includeUnverified?: boolean },
  ): Promise<ExportResult> {
    const { world, instances } = this.solveScene(graph);
    // Hidden parts drop out of the EXPORT here. solveScene above still sees
    // them, so hiding a base plate does not unmoor the bracket bolted to it.
    // The viewport's mesh list is filtered separately, in the cad-scene route.
    // A node stuck on its contract exports its unverified candidate only when
    // the caller asked for it by name.
    const nodes = Object.values(graph.nodes).filter(
      (n) =>
        (unverifiedCandidate(n) ? opts.includeUnverified : n.artifact?.code) &&
        !n.hidden &&
        (!opts.nodeId || n.id === opts.nodeId),
    );
    const parts = nodes.map((n) => ({
      code: unverifiedCandidate(n)?.code ?? n.artifact!.code,
      params: mergedParams(n),
      matrix: opts.nodeId ? [] : (world[n.id] ?? []),
      // Each placed copy is its own STEP child / 3MF build item, named by node.
      matrices: opts.nodeId ? [] : (instances[n.id] ?? []),
      name: n.id,
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

  /** One kernel build per attempt: execute runs every gate and leaves the
   *  result here for verify, slotted per node AND code (concurrent candidates
   *  of one node must not evict each other) and checked against the exact
   *  request so a changed code, param or contract never reads a stale verdict. */
  private lastRun = new Map<string, { key: string; result: KernelResult }>();

  private kernelRequest(node: NodeRecord, graph: GraphDoc, ws: Workspace) {
    const payload = node.contract.payload as CadContractPayload;
    const code = node.artifact?.code ?? "";
    const params = mergedParams(node);
    // A solids assertion is the same claim as payload.solids, which G2 checks
    // first; left in the array, a count of 2 would fail G2 at the default of 1
    // before G4b ever saw it. So it feeds the count and leaves the array.
    const solidsAssertion = payload.assertions?.find((a) => a.kind === "solids");
    const hardware = REGISTRY_HARDWARE.has(node.kind);
    const contract = {
      // A joint's hardware ports are mate frames the expansion derived, not
      // features of the part: the registry builds it exactly (expand.ts).
      ports: isJointHardware(graph, node.id) ? [] : kernelPorts(graph, payload).filter((p) => probedPort(node.kind, p.type)),
      // Fastener geometry comes from the registry and is exact by construction,
      // so G4 would only be grading the architect's envelope guess — skip it.
      envelope: REGISTRY_HARDWARE.has(node.kind) ? [] : kernelEnvelope(graph, payload),
      assertions: REGISTRY_HARDWARE.has(node.kind) ? [] : (payload.assertions ?? []).filter((a) => a.kind !== "solids"),
      // Hardware is one solid unless REGISTRY_SOLIDS says otherwise; null there
      // means uncountable, so the check is skipped.
      solids: hardware
        ? (REGISTRY_SOLIDS[node.kind] === null ? undefined : (REGISTRY_SOLIDS[node.kind] ?? 1))
        : (payload.solids ?? (solidsAssertion?.kind === "solids" ? solidsAssertion.count : undefined) ?? 1),
      // G4c: every made part is also held to its process's rules (fdm for a print).
      process: kernelProcess(node),
      importDir: this.importDir(ws),
    };
    return { code, params, contract, key: JSON.stringify([code, params, contract]) };
  }

  private async runGates(node: NodeRecord, graph: GraphDoc, ws: Workspace) {
    let req: ReturnType<CadBackend["kernelRequest"]>;
    try {
      req = this.kernelRequest(node, graph, ws);
    } catch (err) {
      // A contract expression that does not resolve (cadExpressionsResolveLint
      // catches it at plan time). No code was run and none can fix it.
      const error = `the contract cannot be resolved: ${(err as Error).message}`;
      const hint = "no code change can pass this: the architect must rewrite the expression";
      const result: KernelFailed = { ok: false, stage: "CONTRACT", error, hint, failures: [{ stage: "CONTRACT", error, hint }] };
      return { result, req: null, score: gateScore(result, 0) };
    }
    const cached = this.lastRun.get(`${node.id}:${node.artifact?.hash}`);
    this.lastRun.delete(`${node.id}:${node.artifact?.hash}`);
    const result =
      cached?.key === req.key ? cached.result : await this.kernel.execute(req.code, req.params, req.contract);
    return { result, req, score: gateScore(result, req.contract.ports.length) };
  }

  /** G0–G2 kernel-side: static scan, execution, validity. Given the graph,
   *  the contract gates run in the same build and their verdict waits for
   *  verify; without it (contract expressions need the graph) this builds
   *  G0–G2 alone and verify pays for a second build. */
  async execute(node: NodeRecord, ws: Workspace, graph?: GraphDoc): Promise<ExecuteResult> {
    if (!graph) {
      const result = await this.kernel.execute(node.artifact?.code ?? "", mergedParams(node), {
        importDir: this.importDir(ws),
      });
      // A G0–G2 pass has not met the contract yet, so it ranks as reaching G3.
      const score = result.ok ? 3 : gateScore(result, 0);
      if (!result.ok) return { ok: false, stage: result.stage, report: failureReport(result), score };
      return { ok: true, stage: "execute", report: `volume ${result.measurements.volume_mm3.toFixed(0)} mm³`, score };
    }
    const { result, req, score } = await this.runGates(node, graph, ws);
    if (!result.ok && (!req || !CONTRACT_STAGES.has(result.stage))) {
      return { ok: false, stage: result.stage, report: failureReport(result), score };
    }
    if (req) this.lastRun.set(`${node.id}:${node.artifact?.hash}`, { key: req.key, result });
    const volume = result.measurements?.volume_mm3;
    return { ok: true, stage: "execute", report: `volume ${volume?.toFixed(0) ?? "?"} mm³`, score };
  }

  /** G3+G4: the contract's postconditions probed against the actual solid. */
  async verify(node: NodeRecord, graph: GraphDoc, ws: Workspace): Promise<VerifyResult> {
    const { result, score } = await this.runGates(node, graph, ws);
    if (!result.ok) return { ok: false, stage: result.stage, report: failureReport(result), score };
    return {
      ok: true,
      stage: "verify",
      report: JSON.stringify(result.measurements.ports ?? []),
      // The probe results the gates just agreed with. They used to end here,
      // stringified into a report nothing read on success.
      measurements: result.measurements,
      score,
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

    // A declaration the kernel could not read fails the same way whatever the
    // code does, so one round of it is already proof.
    if (evidence.failures.some((f) => f.stage === "CONTRACT" || /\[CONTRACT\]/.test(f.report))) return "contract-infeasible";

    // A persistent envelope escape means the box the architect drew is too
    // small for the features it demanded — only the architect can fix that.
    // A combined G3 report carries the envelope verdict too, tagged `[G4]`.
    const g4 = evidence.failures.filter((f) => f.stage === "G4" || /\[G4\]/.test(f.report));
    if (g4.length >= persistent) return "contract-infeasible";
    // The same port failing G3 across materially different attempts points at
    // the declared pose/dims, not the code (design doc heuristic). Judged on
    // the worst single port, not on every G3 failure agreeing: over more
    // rounds one unrelated port miss would otherwise clear the real culprit.
    // ...EXCEPT the "channel is open" variant. That message means material
    // which should be there was cut away, and the usual cause is a local
    // modelling defect near the mouth (an over-sized lead-in chamfer: a Box
    // rotated 45° spans leg*√2 in each rotated axis, so a "small" flare eats
    // the whole wall). The contract is buildable; escalating it ends the very
    // repair loop that would have fixed it and asks the user to re-plan a part
    // that was never impossible. A dimension MISMATCH still escalates — that
    // one really can be a contract no geometry satisfies.
    // A report can name several ports, one per line; each counts once per round.
    // The engine hands back report text only, so the port names are read from it.
    const counts = new Map<string, number>();
    const repeats = new Map<string, number>();
    for (const f of evidence.failures) {
      if (f.stage !== "G3") continue;
      const ports = new Set<string>();
      const lines = new Set<string>();
      for (const line of f.report.split("\n")) {
        const [, port, type] = /port "([^"]+)"(?: \((\w+))?/.exec(line) ?? [];
        if (!port || /the channel is open/.test(line)) continue;
        // A hardware feature's size comes from the catalog, so a persistent
        // miss is a cut the generator keeps getting wrong, not a bad contract,
        // unless the feature cannot fit inside the envelope at all. Or unless
        // the probe reads the same numbers twice with its smallest on target
        // (a nut trap's 8.60..11.93 against 8.4..8.8): the cut is right and
        // the probe or the declared pose reads past it, so no code change helps.
        if (type && HARDWARE_PORT_TYPES.has(type) && !outgrowsEnvelope(evidence.node, port)) {
          const [, lo, , min, max] = /measured ([\d.]+)\.\.([\d.]+).*expected ([\d.]+)\.\.([\d.]+)/.exec(line) ?? [];
          if (lo && Number(min) <= Number(lo) && Number(lo) <= Number(max)) lines.add(line.replace(/^\s*\d+\. \[G3\] /, ""));
          continue;
        }
        ports.add(port);
      }
      for (const port of ports) counts.set(port, (counts.get(port) ?? 0) + 1);
      for (const line of lines) repeats.set(line, (repeats.get(line) ?? 0) + 1);
    }
    for (const n of counts.values()) if (n >= persistent) return "contract-infeasible";
    for (const n of repeats.values()) if (n >= 2) return "contract-infeasible";
    // G4b: an overall size or material volume that stays wrong across rounds is
    // usually the stated number fighting the envelope or the ports, which only
    // the architect can reconcile. Hole count, symmetry, solids and wall
    // thickness stay with the generator: a part can always gain a hole, a
    // mirror, a union or a thicker wall without touching its contract.
    const budget = new Map<string, number>();
    for (const f of evidence.failures) {
      const hit = new Set(
        [...f.report.matchAll(/assertion "((?:volume_range|bbox_axis)[^"]*)"/g)].map((m) => m[1]!),
      );
      for (const label of hit) budget.set(label, (budget.get(label) ?? 0) + 1);
    }
    for (const n of budget.values()) if (n >= persistent) return "contract-infeasible";
    // A line_count that reads the same count twice on a part that otherwise
    // passes is the architect's count, not the model's: a divided box's line
    // asserted at 2 crossings where its walls and dividers make 4 was "fixed"
    // by cutting windows nobody asked for through the dividers.
    const lineCounts = new Map<string, number>();
    for (const f of evidence.failures) {
      if (f.stage !== "G4b") continue;
      for (const [label] of f.report.matchAll(/assertion "line_count[^\n]*measured \d+/g))
        lineCounts.set(label, (lineCounts.get(label) ?? 0) + 1);
    }
    for (const n of lineCounts.values()) if (n >= 2) return "contract-infeasible";
    // A persistent cnc undercut is the setup count: the contract's port poses
    // put features where a 3-axis mill cannot reach them from ±Z, and only a
    // contract change (sourcing.allowUndercuts) or a re-posed port fixes it.
    const undercuts = evidence.failures.filter((f) => f.stage === "G4c" && /"undercut"/.test(f.report));
    if (undercuts.length >= persistent) return "contract-infeasible";
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
    const { world, instances, problems, mateOrigins } = solveAssembly(nodes, graphMates(graph), graph.assembly.entryNodeId, (id) => isJointHardware(graph, id));
    // Motion joints are kinematic, not rigid: the poses above are each joint
    // at 0, and this says which axis it turns or slides along, how far, and
    // which parts go with it (G5 sweeps them).
    // A gear pair meshed without a drive joint turns too (gearMeshes).
    const kinematic = kinematicJoints(jointAxes(graph), world, instances);
    // A planetary stage is swept in its carrier's frame (planetaryJoints).
    const joints = planetaryJoints(graph, instances, [...kinematic, ...gearMeshJoints(graph, world, kinematic)]);
    const scene = {
      nodes: Object.fromEntries(
        Object.values(graph.nodes).map((n) => [
          n.id,
          {
            title: n.title,
            // `matrix` stays the primary pose so every existing reader keeps
            // working; `matrices` carries the repeats, and is what the viewport
            // walks. A node wired to one seat has a single-entry list.
            matrix: world[n.id],
            matrices: instances[n.id] ?? [world[n.id]],
            version: n.version,
          },
        ]),
      ),
      problems,
      joints,
    };
    return { scene, world, instances, problems, mateOrigins, joints };
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
    const { world, instances, mateOrigins, joints, problems: sceneProblems } = this.solveScene(graph);
    problems.push(...sceneProblems);

    // G5: the parts against each other (g5.ts). Every other gate grades ONE
    // part against its own contract, so none of them can see this — a collar
    // passed every probe and every envelope while sitting 1.5mm inside its base.
    // Each verdict names its two nodes, and the engine blocks exactly those
    // (applyCheck), so the user is pointed at a pair instead of a problem bar.
    //
    // Best-effort, but NOT SILENT. A kernel that is down must not turn a clean
    // assembly into a failing one — and a bare catch here made "did not run"
    // indistinguishable from "found nothing": a bad workspace threw inside
    // importDir and every project reported clean in about a millisecond, a
    // perfectly convincing false all-clear. That is the third silence of this
    // shape in this file, one commit after two were deleted, so the reason is
    // reported as a problem of its own.
    const findings: CheckFinding[] = fitFindings(graph);
    /** A pair went uncompared, so applyCheck must not release its blocks. */
    let incomplete = false;
    // Every placed copy, keyed node#i past the first: a second arm hung off
    // the same seat is a part in space like any other.
    const posed = Object.values(graph.nodes)
      .filter((n) => n.artifact?.code && world[n.id])
      .flatMap((n) =>
        (instances[n.id] ?? [world[n.id]!]).map((matrix, i) => ({
          key: i === 0 ? n.id : `${n.id}#${i}`,
          code: n.artifact!.code,
          params: mergedParams(n) as Record<string, unknown>,
          matrix,
        })),
      );
    if (posed.length >= 2) {
      try {
        const res = await this.kernel.clash(posed, {
          importDir: this.importDir(ws),
          allow: [...threadAllowances(graph), ...hardwareAllowances(graph)],
          contacts: contactQueries(graph, mateOrigins, new Set(posed.map((p) => p.key))),
          sweeps: joints.map(({ id, ...j }) => ({ joint: id, ...j })),
        });
        if (!res.ok || !res.clash) throw new Error(res.error ?? "the kernel returned no clash report");
        for (const e of res.clash.errors ?? []) {
          problems.push(`clash check incomplete — ${e}. Those two parts were not compared.`);
        }
        if ((res.clash.errors ?? []).length > 0) incomplete = true;
        findings.push(...clashFindings(graph, res.clash, instances));
      } catch (err) {
        incomplete = true;
        problems.push(
          `clash check did not run: ${(err as Error).message}. Parts may overlap without this reporting it — the gate is skipped, not passed.`,
        );
      }
    }
    // Plan defects no sweep can see (a gear hanging off its shaft's end is
    // unsupported, not blocked): the contract's, so the part is blocked for T3.
    // Both are blocked: the fix is the part's own seat or mate, read against the other.
    for (const d of assemblyPlanDefects(graph)) {
      findings.push({ nodeA: d.node, nodeB: d.other, kind: "assembly", measured: 1, expected: 0, message: `Assembly: ${d.message}` });
    }
    // Feasibility: can each part actually get to its pose? The sequencer's
    // insertion sweeps (instructions.ts) after G5, no pages drawn.
    const made = posed.filter((p) => sourcingOf(graph.nodes[p.key.split("#")[0]!]!).class !== "buy");
    if (made.length >= 2) {
      const { sequence } = await assemblyInstructions(graph, { instances, joints }, this.kernel, { importDir: this.importDir(ws), render: false });
      const skipped = sequence.sequenceProblems.find((s) => s.startsWith("insertion check did not run"));
      if (skipped) {
        incomplete = true;
        problems.push(skipped);
      }
      findings.push(...assemblyFindings(graph, sequence, instances));
    }
    problems.push(...findings.map((f) => f.message));
    const ok = problems.length === 0;
    // G6 against the user's reference image. Advisory (see silhouette.ts), so
    // it never sets ok; in `problems` too so the user actually reads it.
    const advisories = await this.silhouetteCheck(graph, ws, posed, problems);
    problems.push(...advisories.map((a) => a.message));
    return { ok, problems, findings, advisories, incomplete };
  }

  private async silhouetteCheck(
    graph: GraphDoc,
    ws: Workspace,
    posed: { key: string; code: string; params: Record<string, unknown>; matrix: number[] }[],
    problems: string[],
  ): Promise<CheckAdvisory[]> {
    const refs = (graph.brief.refs ?? []).filter((r) => r.mask && r.view);
    if (refs.length === 0 || posed.length === 0) return [];
    const dir = path.resolve(ws.root, "..", "refs");
    try {
      const views = await Promise.all(
        refs.map(async (r) => ({
          view: r.view!,
          ref: r.hash,
          mask_b64: (await readFile(path.join(dir, `${r.hash}.mask.png`))).toString("base64"),
        })),
      );
      const res = await this.kernel.silhouette(posed, views, { importDir: this.importDir(ws) });
      if (!res.ok || !res.silhouette) throw new Error(res.error ?? "the kernel returned no silhouette report");
      return silhouetteAdvisories(graph, res.silhouette.views);
    } catch (err) {
      problems.push(`silhouette check did not run: ${(err as Error).message}. The assembly was not compared against the reference image.`);
      return [];
    }
  }
}
