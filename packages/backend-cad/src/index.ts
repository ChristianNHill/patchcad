import { z } from "zod";
import type { GraphDoc, NodeRecord, ParamValue } from "@patchcad/shared";

export * from "./kernel.js";
export * from "./registry.js";
export * from "./assembly.js";
export * from "./bindings.js";
export { normalizeCadCode } from "./prompts.js";
import type {
  CheckResult,
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
import { KernelClient, type KernelResult } from "./kernel.js";
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
      if (to && !REGISTRY_HARDWARE.has(to.kind) && !payloadNames.get(e.to)?.has(e.toPort)) {
        problems.push(`edge ${e.from} → ${e.to}.${e.toPort}: "${e.toPort}" is not a payload port name of ${e.to}`);
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
  private kernelStarted = false;

  constructor(opts: { kernel?: KernelClient; maxAttempts?: number } = {}) {
    this.kernel = opts.kernel ?? new KernelClient();
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  private async ensureKernel(): Promise<void> {
    if (!this.kernelStarted) {
      await this.kernel.start();
      this.kernelStarted = true;
    }
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
    payloadSchema: CadContractPayload as z.ZodType<CadContractPayload>,
    graphLints: [cadPortConsistencyLint, cadFastenerJustifiedLint],
    architectGuidance: [
      "FRAME CONVENTION (critical): every part is modeled in its OWN LOCAL frame,",
      "roughly centered on the origin — the assembly places parts later via port",
      "mates. Never author ports or envelopes in assembly/world coordinates.",
      "Port poses: +z points OUT of the part's mating surface (out of material).",
      "Hole-like ports (CLEARANCE_HOLE, BORE, SCREW_SEAT) MUST carry",
      '  params: {"diameter": <mm>} — that exact key; probes measure against it.',
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
      "standards-exact, never generated. Declare NO geometric ports on them",
      "(probes don't apply) and a small cylinder envelope around the origin.",
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
    await this.ensureKernel();
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
    await this.ensureKernel();
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

  async globalCheck(graph: GraphDoc, _ws: Workspace): Promise<CheckResult> {
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
    problems.push(...this.solveScene(graph).problems);
    return { ok: problems.length === 0, problems };
  }
}
