/** Eval harness: a prompt ladder scored on measured geometry, not on whether a
 *  cook finished.
 *
 *    pnpm exec tsx src/eval.ts --dry-run           # validate cases, zero LLM calls
 *    pnpm exec tsx src/eval.ts --dry --only hinge  # plan only: the architect call, no cook
 *    pnpm exec tsx src/eval.ts --case single-plate --max-usd 0.50
 *    pnpm exec tsx src/eval.ts --max-usd 2.00      # the whole ladder
 *
 *  Cases live in evals/cases/*.json. They assert STRUCTURALLY, never by node id,
 *  because ids come from the architect and change between runs: "somewhere in
 *  this graph there is one CLEARANCE_HOLE measuring 6mm" survives a rename that
 *  `nodes["plate"].ports[0]` does not.
 *
 *  The assertion that matters most is noSkippedPorts. A port type the kernel
 *  cannot probe reports `skipped` and passes, which is how a solid box shipped
 *  as a pen cup holder with hexagonal cutouts. A case that tolerates a skipped
 *  port is measuring nothing, so this defaults to on.
 */
import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cookNodes, EventBus, GraphStore, planGraph } from "@patchcad/engine";
import { buildBom, CadBackend, CHEAT_SHEET, contactQueries, jointOwner, normalizeCadCode, REGISTRY_HARDWARE, transformPoint } from "@patchcad/backend-cad";
import type { CheckFinding, LlmProvider } from "@patchcad/engine";
import { z } from "zod";
import { GraphDoc, type NodeRecord, type RefView } from "@patchcad/shared";
import { resolveProvider } from "./providers.js";
import { prepReferences, writeRefs } from "./refs.js";
import { Budget, budgeted } from "./spend.js";
import { loadProject } from "./project.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const casesDir = path.join(repoRoot, "evals", "cases");
const resultsDir = path.join(repoRoot, "evals", "results");

type PortExpect = {
  /** One exact type. Prefer anyType when the prompt pins geometry rather than
   *  vocabulary: the floor case failed a CORRECT plate because the architect
   *  called its through-hole a BORE and the case demanded CLEARANCE_HOLE. */
  type?: string;
  /** Any of these types satisfies it. */
  anyType?: string[];
  /** The hole must pass through, which is the fact "a hole in the middle"
   *  actually asserts. A bore bridged by a web reports through:false. */
  through?: boolean;
  count?: number;
  minCount?: number;
  /** ONE GENERIC ASSERTION over whatever field the probe actually emits, rather
   *  than a named key per dimension. Named keys were heading for six and each
   *  new probe output needed a scorer change to be assertable at all: a boss
   *  reports `measured_pilot` and never `measured_diameter`, so a case asserting
   *  `diameter` on one failed as "measured by nothing" — a defect in the case,
   *  not the part. Three more were unreachable for the same reason:
   *  `probed_size` and `ring_diameter` on a face, `measured_depth` on holes and
   *  channels, `measured_length` on a shaft.
   *
   *  `field` is the probe's own key, so the next probe output needs no change
   *  here. diameter/width/pilot remain as shorthands for the common cases. */
  measure?: { field: string; value: number; tol?: number };
  diameter?: number;
  width?: number;
  pilot?: number;
  tol?: number;
};
type CaseExpect = {
  nodes?: { min?: number; max?: number };
  allReady?: boolean;
  noSkippedPorts?: boolean;
  /** Every port a ready node declares must appear in its probe list, with
   *  measurements that are present and current. Separate from noSkippedPorts:
   *  they answer different questions, and one flag disabling both meant a case
   *  could drop the contract-vs-probe check by turning off skipped-port
   *  reporting. */
  requireProbedPorts?: boolean;
  /** Absolute measured material, summed over the graph. Fails differently from
   *  volumeFraction, which is scale-free but reads an axis-aligned box: a
   *  diagonal or organic part legitimately fills little of its box while being
   *  solid, and this catches that where the ratio cannot. */
  volume?: { max?: number; min?: number };
  ports?: PortExpect[];
  bboxSize?: { value: number[]; tol: number; axes?: number[] };
  /** measured volume / bbox volume, on the largest node.
   *
   *  READ THIS BEFORE TRUSTING IT: this proves material was removed. It does NOT
   *  verify WHAT was removed. A plain open bucket with no cutouts at all is
   *  0.288 (outer 75x75x95 minus a 65x65x90 cavity), so it sails through a max
   *  of 0.45 while having zero hexagonal anything, and hollowing is the normal
   *  way to be wrong here rather than an exotic one. No max can separate
   *  "correctly cut" from "diagonal and solid" either: a legitimate hex-wall on
   *  disk measures 0.050 and a divider 0.079.
   *
   *  It earns its place anyway, because it is the only assertion that reaches a
   *  part declaring no ports, and it fails the solid block that actually
   *  shipped. Verifying the cutouts themselves needs a probe for the port type
   *  that describes them. */
  volumeFraction?: { max?: number; min?: number };
  zeroLlmKinds?: string[];
  /** Problems from solveScene: unsolved mates and unplaced parts. */
  assemblyProblems?: number;
  /** Problems from the backend's globalCheck, which is where G5 CLASH lives.
   *  assemblyProblems never saw it: two-plate-bolted scored PASS on an assembly
   *  whose screw and nut shared 12.8mm3 of material, because the case only
   *  counted mate-solving problems. A clashing assembly passing its case is the
   *  same defect as a port verified by nothing. Defaults to 0. */
  globalProblems?: number;
  /** Assertion kinds (helix, line_count, ...) that some ready node must have
   *  declared AND had measured. A plain cylinder passes ports and a bbox where
   *  the prompt asked for a thread; only the helix assertion fails it. */
  assertionKinds?: string[];
  /** The case's reference image was prepped to a mask, G6 compared the posed
   *  assembly against it, and the outline matched (no silhouette advisory).
   *  Without the mask G6 returns nothing, which reads exactly like a match. */
  silhouette?: boolean;
  /** Multi-part claims, graded on the cooked graph and the kernel's G5. */
  assembly?: AssemblyExpect;
};

type JointExpect = {
  motion: "fixed" | "revolute" | "prismatic";
  /** Catalog families the joint must expand to; "a|b" accepts either. */
  hardware?: string[];
  /** Joints matching motion and hardware, default 1. */
  count?: number;
  /** Degrees (revolute) or mm (prismatic) the joint's limits must span, swept
   *  clean by G5. A hinge whose derived limits stop at 80° fails a 110 ask. */
  travel?: number;
};
type BomExpect = { family: string; key?: string; qty?: number; minQty?: number };
type AssemblyExpect = {
  /** Named children in the exported assembly STEP, one per placed copy. */
  parts?: number;
  /** At least this many mates had their contact measured; any gap fails. */
  contacts?: number;
  /** At least this many mates went through G5's fit check; any fit finding fails. */
  fits?: number;
  joints?: JointExpect[];
  bom?: BomExpect[];
  /** The posed whole assembly, every placed copy: each extent within `tol` of
   *  its value as a FRACTION (0.15 = 15%). `sorted` compares extents smallest
   *  first, for a product the architect may lay on any side. */
  bbox?: { value: number[]; tol: number; sorted?: boolean };
};

/** What an assembly is graded on. A field left undefined is something the
 *  output does not carry (the raw baseline has no joints or mates), so its
 *  checks are NOT GRADABLE, which is reported and never counted as a pass. */
type AsmFacts = {
  findings: { kind: string; a: string; b: string; measured: number; message: string }[];
  bom: { family: string; key: string; qty: number }[];
  /** STEP child names, or why the export failed. */
  stepNames: string[] | string;
  /** World extents of every placed copy together; undefined when nothing was measured. */
  bbox?: number[];
  joints?: { id: string; motion?: string; expanded?: string; failed?: string; shared?: string }[];
  sweeps?: { id: string; limits: [number, number]; moving: string[] }[];
  contacts?: number;
  fits?: number;
};

type EvalCase = {
  id: string; prompt: string; why?: string; expect: CaseExpect;
  /** Reference images beside the case JSON, prepped through the kernel as
   *  /plan preps them, so the cook's globalCheck runs the G6 silhouette. */
  images?: { file: string; view?: RefView }[];
};

type Probe = Record<string, unknown> & { key?: string; type?: string; skipped?: string };
type Measured = {
  bbox?: { size?: number[] };
  ports?: Probe[];
  volume_mm3?: number;
  assertions?: { kind?: string }[];
};

// parseArgs also rejects a typo'd flag, where the hand-rolled version read it
// as unset and ran the wrong thing silently.
const { values: argv } = parseArgs({
  options: {
    "self-test": { type: "boolean" },
    "score-projects": { type: "boolean" },
    "dry-run": { type: "boolean" },
    /** Plan each case and stop: one architect call, no cook. */
    dry: { type: "boolean" },
    case: { type: "string" },
    only: { type: "string" },
    "max-usd": { type: "string" },
    repeat: { type: "string" },
    /** A subfolder of evals/cases, e.g. `assembly`. */
    suite: { type: "string" },
    /** The baseline: the same prompt to the same model in ONE call, no PatchCAD. */
    raw: { type: "boolean" },
    /** Newest PatchCAD vs newest raw result per case, from results/. */
    compare: { type: "boolean" },
  },
});
const flag = (name: "self-test" | "score-projects" | "dry-run" | "dry" | "raw" | "compare") => argv[name] === true;
const opt = (name: "case" | "only" | "max-usd" | "repeat" | "suite") => argv[name] as string | undefined;

/** A failed expectation, phrased so the line alone says what went wrong. */
type Miss = string;

function checkPorts(probes: Probe[], want: PortExpect): Miss[] {
  const misses: Miss[] = [];
  const types = want.anyType ?? (want.type ? [want.type] : []);
  const label = types.join(" or ");
  const of = probes.filter((p) => types.includes(String(p.type)));
  // A HOLE_PATTERN reports per hole under `members`, never at its own level,
  // so a bracket whose four holes all went through read through=undefined.
  const members = (p: Probe) => (Array.isArray(p["members"]) ? (p["members"] as Probe[]) : []);
  const passes = (p: Probe) => p["through"] === true || (members(p).length > 0 && members(p).every((m) => m["through"] === true));
  if (want.count != null && of.length !== want.count)
    misses.push(`expected ${want.count} ${label} port(s), graph has ${of.length}`);
  if (want.minCount != null && of.length < want.minCount)
    misses.push(`expected at least ${want.minCount} ${label} port(s), graph has ${of.length}`);
  if (want.through) {
    const holed = of.filter(passes);
    if (of.length && !holed.length)
      misses.push(
        `no ${label} passes through; measured ${of.flatMap((p) => [p, ...members(p)]).map((p) => `${p.key}(through=${p["through"]}, depth=${p["measured_depth"]})`).join(", ")}`,
      );
  }
  const claims: [string, number | undefined, number | undefined][] = [
    ["measured_diameter", want.diameter, want.tol],
    ["measured_width", want.width, want.tol],
    ["measured_pilot", want.pilot, want.tol],
    ...(want.measure ? [[want.measure.field, want.measure.value, want.measure.tol ?? want.tol] as [string, number, number | undefined]] : []),
  ];
  for (const [key, want_v, want_tol] of claims) {
    if (want_v == null) continue;
    const tol = want_tol ?? 0.2;
    // ANY port of this type may satisfy it: the architect picks which node
    // carries which hole, and the case must not care.
    const got = of.flatMap((p) => [p, ...members(p)]).map((p) => p[key]).filter((v): v is number => typeof v === "number");
    if (!got.length) misses.push(`no ${label} reported ${key} (measured by nothing)`);
    else if (!got.some((v) => Math.abs(v - want_v) <= tol))
      misses.push(`no ${label} ${key} within ${tol} of ${want_v}; measured ${got.map((v) => v.toFixed(2)).join(", ")}`);
  }
  return misses;
}

/** Hardware a joint minted. The architect never decided it, so it is not
 *  over-decomposition, and expand.ts sends G3 no ports for it on purpose. */
const jointHardware = (doc: GraphDoc, n: NodeRecord) => jointOwner(doc, n.id) !== undefined;

/** Mates G5's fit check reads (fitFindings): a bearing in its seat, a shaft in
 *  a bearing or bore, a screw in a clearance hole. No fit finding over an
 *  assembly that offered none of these is silence, not a pass. */
function fitPairs(doc: GraphDoc): number {
  return doc.edges.filter((e) => {
    const ends = ([[e.from, e.fromPort], [e.to, e.toPort]] as const).map(([id, port]) => {
      const n = doc.nodes[id];
      const ports = (n?.contract.payload as { ports?: { name: string; type: string }[] } | null)?.ports ?? [];
      return { n, type: ports.find((p) => p.name === port)?.type };
    });
    if (!ends.every((x) => x.n?.artifact)) return false;
    const has = (t: string) => ends.some((x) => x.type === t);
    const kind = (k: string) => ends.some((x) => x.n!.kind === k);
    return (has("BEARING_SEAT") && kind("bearing")) || (has("SHAFT") && (kind("bearing") || has("BORE"))) ||
      (has("CLEARANCE_HOLE") && kind("fastener"));
  }).length;
}

/** Extents of measured local boxes, each posed by its matrices: every corner
 *  transformed, so a rotated part counts at its real reach. */
function worldExtents(boxes: { min: number[]; max: number[]; matrices: number[][] }[]): number[] | undefined {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes)
    for (const m of b.matrices)
      for (let k = 0; k < 8; k++) {
        const corner = [0, 1, 2].map((i) => ((k >> i) & 1 ? b.max[i]! : b.min[i]!));
        transformPoint(m, corner).forEach((v, i) => {
          lo[i] = Math.min(lo[i]!, v);
          hi[i] = Math.max(hi[i]!, v);
        });
      }
  return Number.isFinite(lo[0]) ? hi.map((v, i) => Math.round((v - lo[i]!) * 100) / 100) : undefined;
}

/** The facts an assembly is graded on, from the graph alone (0 kernel calls). */
function graphFacts(backend: CadBackend, doc: GraphDoc, findings: CheckFinding[], stepNames: AsmFacts["stepNames"]): AsmFacts {
  const scene = backend.solveScene(doc);
  const posed = new Set(Object.values(doc.nodes).filter((n) => n.artifact?.code && scene.world[n.id]).map((n) => n.id));
  return {
    findings: findings.map((f) => ({ kind: f.kind, a: f.nodeA, b: f.nodeB, measured: f.measured, message: f.message })),
    // A buy row describes itself as "<family> <key>[×<length>][, material]".
    bom: buildBom(doc).buy.flatMap((r) => {
      const m = /^(\S+) ([^\s×,]+)/.exec(r.description);
      return m ? [{ family: m[1]!, key: m[2]!, qty: r.qty }] : [];
    }),
    stepNames,
    bbox: worldExtents(Object.values(doc.nodes).flatMap((n) => {
      const b = ((n.measurements?.data ?? null) as Measured | null)?.bbox as { min?: number[]; max?: number[] } | undefined;
      const placed = scene.instances[n.id] ?? (scene.world[n.id] ? [scene.world[n.id]!] : []);
      return b?.min && b.max && !n.hidden ? [{ min: b.min, max: b.max, matrices: placed }] : [];
    })),
    joints: doc.joints as AsmFacts["joints"],
    sweeps: scene.joints,
    contacts: contactQueries(doc, scene.mateOrigins, posed).length,
    fits: fitPairs(doc),
  };
}

function scoreAssembly(want: AssemblyExpect, f: AsmFacts): { misses: Miss[]; notGradable: string[] } {
  const misses: Miss[] = [];
  const notGradable: string[] = [];
  const of = (kind: string) => f.findings.filter((x) => x.kind === kind);
  const pairs = (xs: AsmFacts["findings"]) =>
    xs.slice(0, 3).map((x) => `${x.a}/${x.b} ${x.measured.toFixed(2)}`).join(", ") + (xs.length > 3 ? ", ..." : "");
  if (of("clash").length) misses.push(`G5 clash: ${of("clash").length} pair(s) share material (${pairs(of("clash"))} mm3)`);

  if (want.parts != null) {
    if (typeof f.stepNames === "string") misses.push(`assembly STEP export failed: ${f.stepNames.slice(0, 160)}`);
    else if (f.stepNames.length < want.parts)
      misses.push(`assembly STEP has ${f.stepNames.length} named part(s), expected at least ${want.parts}`);
  }

  const counted = (have: number | undefined, min: number | undefined, kind: string, what: string) => {
    if (min == null && !of(kind).length) return;
    if (have === undefined) return void notGradable.push(what);
    if (min != null && have < min) misses.push(`${have} mate(s) went through the ${what} check, expected at least ${min}`);
    if (of(kind).length) misses.push(`G5 ${kind}: ${of(kind).length} mate(s) out of band (${pairs(of(kind))} mm)`);
  };
  counted(f.contacts, want.contacts, "gap", "mate contact");
  counted(f.fits, want.fits, "fit", "fit band");

  if (want.joints?.length && !f.joints) {
    notGradable.push("joint motion type and hardware");
    if (want.joints.some((w) => w.travel != null)) notGradable.push("swept travel");
  }
  for (const w of f.joints ? want.joints ?? [] : []) {
    const families = (j: NonNullable<AsmFacts["joints"]>[number]) =>
      new Set((j.expanded ?? "").split("|").slice(1).map((s) => s.split("=")[1]?.split(":")[0]));
    const hits = f.joints!.filter((j) => (j.motion ?? "fixed") === w.motion && !j.failed &&
      (w.hardware ?? []).every((h) => h.split("|").some((x) => families(j).has(x))));
    if (hits.length < (w.count ?? 1)) {
      const have = f.joints!.map((j) => `${j.id}:${j.motion ?? "fixed"}=${j.failed ? `FAILED ${j.failed.slice(0, 80)}` : j.expanded ?? "unexpanded"}`);
      misses.push(`expected ${w.count ?? 1} ${w.motion} joint(s)${w.hardware ? ` expanding to ${w.hardware.join(" + ")}` : ""}, graph has ${have.join("; ") || "no joints"}`);
    }
    if (w.travel == null) continue;
    const unit = w.motion === "prismatic" ? "mm" : "°";
    for (const j of hits) {
      if (j.shared) continue; // the earlier joint on the same axle sweeps it
      const s = f.sweeps?.find((x) => x.id === j.id);
      if (!s?.moving.length) {
        misses.push(`joint ${j.id} was never swept, so its motion is unchecked`);
        continue;
      }
      const span = s.limits[1] - s.limits[0];
      if (span < w.travel - 1e-6) misses.push(`joint ${j.id} travels ${s.limits.join("..")}${unit}, expected at least ${w.travel}${unit}`);
      const hit = of("swept").find((x) => x.message.includes(`joint ${j.id} `));
      if (hit) misses.push(`joint ${j.id} collides within its travel: ${hit.message.slice(0, 200)}`);
    }
  }

  if (want.bbox) {
    const order = (v: number[]) => (want.bbox!.sorted ? [...v].sort((a, b) => a - b) : v);
    const [got, wanted] = [f.bbox && order(f.bbox), order(want.bbox.value)];
    if (!got) misses.push("no part measured, so the assembly's size is unchecked");
    else if (wanted.some((v, i) => !(Math.abs(got[i]! - v) <= want.bbox!.tol * v)))
      misses.push(`assembly measures ${got.join(" x ")}${want.bbox.sorted ? " (sorted)" : ""}, expected ${wanted.join(" x ")} within ${want.bbox.tol * 100}%`);
  }

  for (const w of want.bom ?? []) {
    const fams = w.family.split("|");
    const qty = f.bom
      .filter((r) => fams.includes(r.family) && (w.key == null || r.key.toLowerCase() === w.key.toLowerCase()))
      .reduce((s, r) => s + r.qty, 0);
    const what = `${w.family}${w.key ? ` ${w.key}` : ""}`;
    if ((w.qty != null && qty !== w.qty) || (w.minQty != null && qty < w.minQty))
      misses.push(`BOM has ${qty}x ${what}, expected ${w.qty ?? `at least ${w.minQty}`}; BOM: ${f.bom.map((r) => `${r.qty}x ${r.family} ${r.key}`).join(", ") || "empty"}`);
  }
  return { misses, notGradable };
}

function score(
  c: EvalCase,
  store: GraphStore,
  problems: unknown[],
  global: string[] = [],
  advisories: { kind?: string; message?: string }[] = [],
  asm?: AsmFacts,
): { misses: Miss[]; probes: Probe[]; notGradable: string[] } {
  const nodes = Object.values(store.doc.nodes);
  const misses: Miss[] = [];
  const e = c.expect;

  if (e.nodes?.min != null && nodes.length < e.nodes.min)
    misses.push(`${nodes.length} nodes, expected at least ${e.nodes.min}`);
  const designed = nodes.filter((n) => !jointHardware(store.doc, n));
  if (e.nodes?.max != null && designed.length > e.nodes.max)
    misses.push(`${designed.length} nodes (plus ${nodes.length - designed.length} joint hardware), expected at most ${e.nodes.max} (over-decomposed)`);

  if (e.allReady !== false) {
    const notReady = nodes.filter((n) => n.status !== "ready");
    if (notReady.length)
      misses.push(`not ready: ${notReady.map((n) => `${n.id}=${n.status}`).join(", ")}`);
  }

  const probes: Probe[] = [];
  for (const n of nodes) {
    const data = (n.measurements?.data ?? null) as Measured | null;
    for (const p of data?.ports ?? []) probes.push({ ...p, node: n.id } as Probe);
  }

  if (e.noSkippedPorts !== false) {
    const skipped = probes.filter((p) => p.skipped);
    if (skipped.length)
      misses.push(
        `${skipped.length} port(s) verified by NOTHING: ` +
          skipped.map((p) => `${p["node"]}.${p.key}(${p.type}): ${p.skipped}`).join("; "),
      );

  }

  if (e.requireProbedPorts !== false) {
    // A SKIPPED PORT IS ONLY THE VISIBLE HALF. `skipped` fires on a port that
    // reached the probe list and reported that no probe exists. A port declared
    // and never probed at all is simply absent, and a part that declares no
    // port has nothing to skip: both passed. That is how the pen-cup brick
    // scored green here, in the case written to catch it, which is the harness
    // reproducing the defect it exists to prevent. Verified means the contract
    // and the probes agree, so that is what this checks.
    for (const n of nodes) {
      // Only a READY node claims to be verified. A planned or dirty node has no
      // measurements by definition, and failing it here would report the queue
      // as a defect.
      if (n.status !== "ready" || jointHardware(store.doc, n)) continue;
      const declared = ((n.contract.payload as { ports?: { name?: string; type?: string }[] } | null)?.ports) ?? [];
      const data = (n.measurements?.data ?? null) as Measured | null;
      const probed = new Set((data?.ports ?? []).map((p) => p.key));
      for (const d of declared) {
        // A registry part's face ports are mate frames on exact geometry (a
        // magnet's seat), measured by nothing, as joint hardware's are.
        if (REGISTRY_HARDWARE.has(n.kind) && d.type === "FLAT_FACE") continue;
        if (!probed.has(d.name)) misses.push(`${n.id}.${d.name}(${d.type}) declared but never probed`);
      }
      // `ready` does not imply measurements exist. Three of the four ready
      // nodes in the pen-cup project have measurements: null, so four declared
      // ports were invisible and the catch survived on one node's two.
      if (declared.length && !n.measurements)
        misses.push(`${n.id} is ready with no measurements at all, so its ${declared.length} port(s) are unverified`);
      if (n.measurements && n.measurements.version !== n.version)
        misses.push(`${n.id} scored on v${n.measurements.version} measurements at v${n.version} (stale)`);
    }
  }

  if (e.volume) {
    const total = nodes.reduce(
      (sum, n) => sum + (((n.measurements?.data ?? null) as Measured | null)?.volume_mm3 ?? 0), 0);
    if (!total) misses.push("no volume measured anywhere, so the material claim is unchecked");
    if (e.volume.max != null && total > e.volume.max)
      misses.push(`${total.toFixed(0)} mm3 of material, expected under ${e.volume.max} (a solid block, not a cup)`);
    if (e.volume.min != null && total && total < e.volume.min)
      misses.push(`only ${total.toFixed(0)} mm3 of material, expected at least ${e.volume.min}`);
  }

  for (const want of e.ports ?? []) misses.push(...checkPorts(probes, want));

  if (e.bboxSize) {
    // Largest node by volume stands in for "the part" on a single-part case;
    // on a multi-part case a size claim is about the assembly, not one piece,
    // so it is only checked when the case is single-node.
    const biggest = nodes
      .map((n) => (n.measurements?.data ?? null) as Measured | null)
      .filter((d): d is Measured => !!d?.bbox?.size)
      .sort((a, b) => (b.volume_mm3 ?? 0) - (a.volume_mm3 ?? 0))[0];
    const size = biggest?.bbox?.size;
    if (!size) misses.push("no bbox measured, so the size claim is unchecked");
    else {
      const axes = e.bboxSize.axes ?? e.bboxSize.value.map((_, i) => i);
      for (const i of axes) {
        const got = size[i] ?? NaN;
        const want_v = e.bboxSize.value[i]!;
        if (!(Math.abs(got - want_v) <= e.bboxSize.tol))
          misses.push(`bbox axis ${i} measured ${got.toFixed(1)}, expected ${want_v} +/- ${e.bboxSize.tol}`);
      }
    }
  }

  if (e.volumeFraction) {
    // A SOLID BOX PASSES EVERY BOOKKEEPING CHECK. Declared-vs-probed catches a
    // port nothing measured, but a part that declares no port at all has
    // nothing to compare, and that is the shape the pen-cup brick actually had.
    // Removed material is measurable, so a prompt asking for cutouts asserts it.
    // The largest node by volume, as bboxSize does. Judging every node would
    // fail a thin gasket beside a solid body on a min it should never see.
    const all = nodes
      .map((n) => (n.measurements?.data ?? null) as Measured | null)
      .filter((d): d is Measured => typeof d?.volume_mm3 === "number" && !!d.bbox?.size)
      .sort((a, b) => (b.volume_mm3 ?? 0) - (a.volume_mm3 ?? 0))
      .slice(0, 1);
    if (!all.length) misses.push("no volume measured, so the material claim is unchecked");
    for (const d of all) {
      const size = d.bbox!.size!;
      const box = size.reduce((a, b) => a * b, 1);
      const frac = box > 0 ? d.volume_mm3! / box : 1;
      if (e.volumeFraction.max != null && frac > e.volumeFraction.max)
        misses.push(`solid: fills ${(frac * 100).toFixed(0)}% of its bounding box, expected at most ${(e.volumeFraction.max * 100).toFixed(0)}% (nothing was cut out)`);
      if (e.volumeFraction.min != null && frac < e.volumeFraction.min)
        misses.push(`too thin: fills only ${(frac * 100).toFixed(0)}% of its bounding box, expected at least ${(e.volumeFraction.min * 100).toFixed(0)}%`);
    }
  }

  for (const kind of e.zeroLlmKinds ?? []) {
    const paid = nodes.filter((n) => n.kind === kind && n.cost.calls > 0);
    if (paid.length)
      misses.push(`${kind} nodes called the model: ${paid.map((n) => `${n.id}(${n.cost.calls})`).join(", ")}`);
  }

  if (e.assemblyProblems != null && problems.length !== e.assemblyProblems)
    misses.push(`${problems.length} assembly problem(s), expected ${e.assemblyProblems}: ${JSON.stringify(problems).slice(0, 200)}`);

  for (const kind of e.assertionKinds ?? []) {
    const measured = nodes.some((n) => n.status === "ready" &&
      (((n.measurements?.data ?? null) as Measured | null)?.assertions ?? []).some((a) => a.kind === kind));
    if (!measured) misses.push(`no ready node declared and measured a ${kind} assertion, so the stated feature is unchecked`);
  }

  if (e.silhouette) {
    if (!(store.doc.brief.refs ?? []).some((r) => r.mask && r.view))
      misses.push("no reference silhouette (unprepped or unlabelled image), so G6 never compared anything");
    for (const a of advisories.filter((a) => a.kind === "silhouette")) misses.push(String(a.message));
  }

  // Default 0, unlike assemblyProblems: a clash is never something a case wants
  // to tolerate silently, and every case written before this one asserted
  // nothing about it.
  const wantGlobal = e.globalProblems ?? 0;
  if (global.length !== wantGlobal)
    misses.push(`${global.length} global check problem(s), expected ${wantGlobal}: ${global.join(" | ").slice(0, 300)}`);

  const notGradable: string[] = [];
  if (e.assembly) {
    if (!asm) misses.push("assembly expectations set but no assembly facts gathered, so none were checked");
    else {
      const a = scoreAssembly(e.assembly, asm);
      misses.push(...a.misses);
      notGradable.push(...a.notGradable);
    }
  }
  return { misses, probes, notGradable };
}

/** Feed the scorer synthetic graphs and assert every check fires.
 *
 *  This exists because a harness whose assertions never fire is worse than no
 *  harness: it reports PASS over unverified geometry, which is the exact defect
 *  the ladder is built to catch. Zero LLM calls, so it runs on every change.
 */
async function selfTest(): Promise<void> {
  const mk = (nodes: Record<string, unknown>) =>
    new GraphStore(
      GraphDoc.parse({
        schemaVersion: 1, id: "t", backend: "cad",
        brief: { goal: "t", constraints: [], clarifications: [] },
        nodes, edges: [],
        assembly: { entryNodeId: Object.keys(nodes)[0] ?? "" }, rev: 0,
      }),
      new EventBus(),
      async () => {},
    );

  const node = (id: string, over: Record<string, unknown> = {}, data?: unknown) => ({
    id, title: id, spec: "", kind: "part", status: "ready", version: 1,
    thread: [], history: [], cost: { calls: 1, inputTokens: 1, outputTokens: 1, usd: 0.01 },
    contract: { name: id, summary: "", params: [], provides: [], requires: [], payload: {} },
    measurements: data === undefined ? null : { version: 1, paramsHash: "h", data },
    ...over,
  });

  // A QUIET CASE CANNOT PROVE A CHECK EXISTS. Asserting misses.length === 0 is
  // satisfied just as well by deleting the check under test, so the quiet cases
  // guard against false positives and nothing more. Every check needs its own
  // firing case to prove it is wired at all.
  let failures = 0;
  const expect = (name: string, misses: Miss[], want: "fire" | "quiet", needle?: string) => {
    const fired = misses.length > 0;
    const ok = want === "fire" ? fired && (!needle || misses.some((m) => m.includes(needle))) : !fired;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` -> ${JSON.stringify(misses)}`}`);
    if (!ok) failures++;
  };

  const goodPlate = {
    volume_mm3: 17859, bbox: { size: [60, 60, 5] },
    ports: [{ key: "h", type: "CLEARANCE_HOLE", measured_diameter: 6.01, through: true }],
  };
  const casePlate: EvalCase = {
    id: "t", prompt: "p",
    expect: {
      nodes: { min: 1, max: 1 }, allReady: true, noSkippedPorts: true,
      ports: [{ type: "CLEARANCE_HOLE", count: 1, diameter: 6.0, tol: 0.3 }],
      bboxSize: { value: [60, 60, 5], tol: 1.0 },
    },
  };

  console.log("the scorer must stay quiet on a graph that genuinely passes");
  expect("good plate", score(casePlate, mk({ p: node("p", {}, goodPlate) }), []).misses, "quiet");

  console.log("and must fire on each defect, one at a time");
  // THE BRICK: a port type the kernel cannot probe reports skipped and passes.
  expect("a skipped port is not verification",
    score(casePlate, mk({ p: node("p", {}, {
      ...goodPlate, ports: [{ key: "g", type: "GROOVE", skipped: "no probe for this type yet" },
                            { key: "h", type: "CLEARANCE_HOLE", measured_diameter: 6.0 }] }) }), []).misses,
    "fire", "verified by NOTHING");
  expect("wrong hole diameter",
    score(casePlate, mk({ p: node("p", {}, {
      ...goodPlate, ports: [{ key: "h", type: "CLEARANCE_HOLE", measured_diameter: 12.0 }] }) }), []).misses,
    "fire", "within 0.3 of 6");
  expect("hole measured by nothing",
    score(casePlate, mk({ p: node("p", {}, {
      ...goodPlate, ports: [{ key: "h", type: "CLEARANCE_HOLE" }] }) }), []).misses,
    "fire", "measured by nothing");
  expect("missing hole entirely",
    score(casePlate, mk({ p: node("p", {}, { ...goodPlate, ports: [] }) }), []).misses,
    "fire", "expected 1 CLEARANCE_HOLE");
  expect("wrong size",
    score(casePlate, mk({ p: node("p", {}, { ...goodPlate, bbox: { size: [95, 95, 5] } }) }), []).misses,
    "fire", "bbox axis 0");
  expect("no measurements at all",
    score(casePlate, mk({ p: node("p") }), []).misses, "fire", "no bbox measured");
  expect("over-decomposed",
    score(casePlate, mk({ p: node("p", {}, goodPlate), q: node("q", {}, goodPlate) }), []).misses,
    "fire", "over-decomposed");
  expect("a node that never converged",
    score(casePlate, mk({ p: node("p", { status: "error_code" }, goodPlate) }), []).misses,
    "fire", "not ready");

  // ABSENCE-SHAPED DEFECTS, which the synthetic fixtures above were blind to.
  // Every hole review found in this scorer was an absence rather than a wrong
  // value, and a self-test built from graphs that carry a defect cannot model a
  // graph that carries nothing.
  const withPorts = (over: Record<string, unknown>, data?: unknown) =>
    node("p", {
      contract: { name: "p", summary: "", params: [], provides: [], requires: [],
                  payload: { ports: [{ name: "g", type: "GROOVE" }] } },
      ...over,
    }, data);

  console.log("and on a defect that is an absence rather than a wrong value");
  const bare: EvalCase = { id: "t", prompt: "p", expect: { nodes: { min: 1, max: 1 }, noSkippedPorts: true } };
  // THE BRICK, and the shape that passed before review: a solid box declaring
  // no port at all. Nothing to skip, so nothing fired.
  // NOT A TEST: this documents a known hole, that no port assertion can reach a
  // part which declares nothing. It is the reason volumeFraction exists, so
  // deleting it as redundant would lose the record.
  expect("(documented hole) a part declaring no ports passes the bookkeeping checks",
    score(bare, mk({ p: node("p", {}, { volume_mm3: 1, bbox: { size: [75, 75, 95] }, ports: [] }) }), []).misses,
    "quiet");
  // THE ACTUAL BRICK, and the reason volumeFraction exists: the shape review
  // found passing was a solid box declaring no ports, which no port check can
  // reach. Removed material is the only measurable difference.
  const cut: EvalCase = { id: "t", prompt: "p", expect: { volumeFraction: { max: 0.45 } } };
  expect("a SOLID BOX sold as a part with cutouts",
    score(cut, mk({ p: node("p", {}, { volume_mm3: 75 * 75 * 95, bbox: { size: [75, 75, 95] }, ports: [] }) }), []).misses,
    "fire", "nothing was cut out");
  expect("the real pen cup's measured geometry",
    score(cut, mk({ p: node("p", {}, { volume_mm3: 47231.67, bbox: { size: [75, 75, 95] }, ports: [] }) }), []).misses,
    "quiet");
  expect("a port declared and never probed",
    score(bare, mk({ p: withPorts({}, { volume_mm3: 1, bbox: { size: [1, 1, 1] }, ports: [] }) }), []).misses,
    "fire", "declared but never probed");
  expect("ready with no measurements at all",
    score(bare, mk({ p: withPorts({}) }), []).misses,
    "fire", "ready with no measurements");
  expect("measurements from an older version",
    score(bare, mk({ p: withPorts({ version: 3 }, { volume_mm3: 1, bbox: { size: [1, 1, 1] },
                                                    ports: [{ key: "g", type: "GROOVE", measured_width: 3 }] }) }), []).misses,
    "fire", "stale");
  expect("a planned node is not a defect",
    score({ id: "t", prompt: "p", expect: { allReady: false, noSkippedPorts: true } },
      mk({ p: withPorts({ status: "planned" }) }), []).misses,
    "quiet");

  // The two volume forms fail differently, so both are proven both ways.
  const vol: EvalCase = { id: "t", prompt: "p", expect: { volume: { max: 200000 } } };
  expect("a solid box fails the absolute ceiling",
    score(vol, mk({ p: node("p", {}, { volume_mm3: 534375, bbox: { size: [75, 75, 95] }, ports: [] }) }), []).misses,
    "fire", "a solid block, not a cup");
  expect("the real cup passes the absolute ceiling",
    score(vol, mk({ p: node("p", {}, { volume_mm3: 47231.67, bbox: { size: [75, 75, 95] }, ports: [] }) }), []).misses,
    "quiet");
  // The ratio reads an axis-aligned box, so a diagonal part fills little of it
  // while being solid. That is the case the absolute ceiling exists to cover.
  expect("a diagonal solid slips past the RATIO",
    score({ id: "t", prompt: "p", expect: { volumeFraction: { max: 0.45 } } },
      mk({ p: node("p", {}, { volume_mm3: 100000, bbox: { size: [75, 75, 95] }, ports: [] }) }), []).misses,
    "quiet");
  expect("and the absolute ceiling catches it",
    score({ id: "t", prompt: "p", expect: { volume: { max: 60000 } } },
      mk({ p: node("p", {}, { volume_mm3: 100000, bbox: { size: [75, 75, 95] }, ports: [] }) }), []).misses,
    "fire", "mm3 of material");
  // Turning off skipped-port reporting must NOT also turn off contract-vs-probe.
  const declOnly = mk({ p: node("p", {
    contract: { name: "p", summary: "", params: [], provides: [], requires: [],
                payload: { ports: [{ name: "g", type: "GROOVE" }] } },
  }, { volume_mm3: 1, bbox: { size: [1, 1, 1] }, ports: [] }) });
  expect("noSkippedPorts:false must not disable contract-vs-probe",
    score({ id: "t", prompt: "p", expect: { noSkippedPorts: false } }, declOnly, []).misses,
    "fire", "declared but never probed");
  expect("requireProbedPorts:false disables only its own check",
    score({ id: "t", prompt: "p", expect: { noSkippedPorts: false, requireProbedPorts: false } }, declOnly, []).misses,
    "quiet");

  // anyType and through, both added because a CORRECT plate failed this scorer:
  // the architect called its through-hole a BORE where the case said
  // CLEARANCE_HOLE, and the run that "passed" had bridged the bore with a web.
  const holed: EvalCase = {
    id: "t", prompt: "p",
    expect: { ports: [{ anyType: ["CLEARANCE_HOLE", "BORE"], minCount: 1, diameter: 6.0, tol: 0.3, through: true }] },
  };
  const withHole = (over: Record<string, unknown>) =>
    mk({ p: node("p", {}, { volume_mm3: 1, bbox: { size: [60, 60, 5] },
                            ports: [{ key: "h", type: "BORE", measured_diameter: 6.0, ...over }] }) });
  expect("a BORE satisfies a hole asserted by geometry",
    score(holed, withHole({ through: true }), []).misses, "quiet");
  expect("a bore bridged by a web is not a hole",
    score(holed, withHole({ through: false, measured_depth: 0 }), []).misses,
    "fire", "passes through");
  expect("a type outside anyType does not satisfy it",
    score(holed, mk({ p: node("p", {}, { volume_mm3: 1, bbox: { size: [1, 1, 1] },
                                         ports: [{ key: "g", type: "GROOVE", measured_width: 6 }] }) }), []).misses,
    "fire", "expected at least 1");

  // A HOLE_PATTERN reports each hole under `members`, never at its own level:
  // the bracket failed "through=undefined" with all four holes through.
  const pattern = (through: boolean) => mk({ p: node("p", {}, { volume_mm3: 1, bbox: { size: [1, 1, 1] },
    ports: [{ key: "holes", type: "HOLE_PATTERN", count: 2, members: [
      { key: "holes #1/2", type: "HOLE_PATTERN", measured_diameter: 4.5, through: true },
      { key: "holes #2/2", type: "HOLE_PATTERN", measured_diameter: 4.5, through } ] }] }) });
  const patternCase: EvalCase = {
    id: "t", prompt: "p",
    expect: { ports: [{ anyType: ["CLEARANCE_HOLE", "HOLE_PATTERN"], minCount: 1, diameter: 4.5, tol: 0.4, through: true }] },
  };
  expect("a pattern whose members all pass through is a through hole",
    score(patternCase, pattern(true), []).misses, "quiet");
  expect("a pattern with one bridged member is not",
    score(patternCase, pattern(false), []).misses, "fire", "passes through");

  // Joint-minted hardware is the joint's, not the architect's decomposition,
  // and expand.ts sends G3 no ports for it.
  const jointed = new GraphStore(GraphDoc.parse({
    schemaVersion: 1, id: "t", backend: "cad",
    brief: { goal: "t", constraints: [], clarifications: [] },
    nodes: {
      p: node("p", {}, goodPlate),
      j1_screw: withPorts({ id: "j1_screw" }, { volume_mm3: 1, bbox: { size: [1, 1, 1] }, ports: [] }),
    },
    edges: [], joints: [{ id: "j1", a: { node: "p", port: "h" }, b: { node: "p", port: "h" } }],
    assembly: { entryNodeId: "p" }, rev: 0,
  }), new EventBus(), async () => {});
  expect("joint hardware is neither over-decomposition nor an unprobed port",
    score({ id: "t", prompt: "p", expect: { nodes: { max: 1 } } }, jointed, []).misses, "quiet");

  // A boss reports measured_pilot and never measured_diameter, so a case that
  // asserts `diameter` on one fails as "measured by nothing" — a defect in the
  // case, not the part. Found while writing the fourth ladder case, before it
  // cost anything.
  const bossCase: EvalCase = {
    id: "t", prompt: "p",
    expect: { ports: [{ type: "SCREW_BOSS", minCount: 1, pilot: 5.6, tol: 0.6 }] },
  };
  const bossNode = (probe: Record<string, unknown>) =>
    mk({ p: node("p", {}, { volume_mm3: 1, bbox: { size: [1, 1, 1] }, ports: [probe] }) });
  expect("a boss satisfies a pilot assertion",
    score(bossCase, bossNode({ key: "b", type: "SCREW_BOSS", ring_hits: 8, measured_pilot: 5.6 }), []).misses,
    "quiet");
  expect("a boss with the wrong pilot is caught",
    score(bossCase, bossNode({ key: "b", type: "SCREW_BOSS", ring_hits: 8, measured_pilot: 3.3 }), []).misses,
    "fire", "within 0.6 of 5.6");
  expect("a boss reporting no pilot at all is caught",
    score(bossCase, bossNode({ key: "b", type: "SCREW_BOSS", ring_hits: 8 }), []).misses,
    "fire", "measured by nothing");

  // The generic field, which exists so the next probe output needs no scorer
  // change. Three fields were unassertable before it: probed_size on a face,
  // measured_depth on holes and channels, measured_length on a shaft.
  const anyField = (field: string, value: number): EvalCase => ({
    id: "t", prompt: "p",
    expect: { ports: [{ type: "FLAT_FACE", minCount: 1, measure: { field, value, tol: 0.5 } }] },
  });
  const faceNode = (probe: Record<string, unknown>) =>
    mk({ p: node("p", {}, { volume_mm3: 1, bbox: { size: [1, 1, 1] }, ports: [probe] }) });
  expect("measure reaches probed_size, which no named field could",
    score(anyField("probed_size", 20), faceNode({ key: "f", type: "FLAT_FACE", probed_size: 20 }), []).misses,
    "quiet");
  expect("and catches it when wrong",
    score(anyField("probed_size", 20), faceNode({ key: "f", type: "FLAT_FACE", probed_size: 55.5 }), []).misses,
    "fire", "within 0.5 of 20");
  expect("and catches a field the probe never emitted",
    score(anyField("probed_size", 20), faceNode({ key: "f", type: "FLAT_FACE" }), []).misses,
    "fire", "measured by nothing");
  expect("measure reaches measured_depth too",
    score({ id: "t", prompt: "p",
            expect: { ports: [{ type: "GROOVE", minCount: 1, measure: { field: "measured_depth", value: 4 } }] } },
      faceNode({ key: "g", type: "GROOVE", measured_width: 3, measured_depth: 4 }), []).misses,
    "quiet");

  // globalCheck problems default to zero, because a clash is never something a
  // case should tolerate in silence. two-plate-bolted scored PASS while its
  // screw and nut shared 12.8mm3, since assemblyProblems counts only mates.
  const plain: EvalCase = { id: "t", prompt: "p", expect: { allReady: false } };
  const oneNode = mk({ p: node("p", {}, { volume_mm3: 1, bbox: { size: [1, 1, 1] }, ports: [] }) });
  expect("a clash fails a case that never mentioned clashes",
    score(plain, oneNode, [], ["a and b occupy the same space: 12.8 mm3"]).misses,
    "fire", "global check problem");
  expect("no clash, no complaint",
    score(plain, oneNode, [], []).misses, "quiet");
  expect("a case may accept a known clash by declaring the count",
    score({ id: "t", prompt: "p", expect: { allReady: false, globalProblems: 1 } },
      oneNode, [], ["a and b occupy the same space: 12.8 mm3"]).misses,
    "quiet");

  const threadCase: EvalCase = { id: "t", prompt: "p", expect: { allReady: false, assertionKinds: ["helix"] } };
  expect("a stated thread nothing asserted is unchecked",
    score(threadCase, oneNode, []).misses, "fire", "helix assertion");
  expect("a measured helix assertion satisfies it",
    score(threadCase, mk({ p: node("p", {}, { volume_mm3: 1, bbox: { size: [1, 1, 1] }, ports: [],
                                              assertions: [{ kind: "helix", measured: { starts: 1 } }] }) }), []).misses,
    "quiet");

  // G6 with no mask returns no advisory, which is indistinguishable from a match.
  const silCase: EvalCase = { id: "t", prompt: "p", expect: { allReady: false, silhouette: true } };
  expect("no reference mask means G6 never ran",
    score(silCase, oneNode, []).misses, "fire", "never compared");
  const withRef = mk({ p: node("p", {}, { volume_mm3: 1, bbox: { size: [1, 1, 1] }, ports: [] }) });
  withRef.doc.brief.refs = [{ hash: "h", view: "front", mask: true }];
  expect("a masked reference and no advisory is a match",
    score(silCase, withRef, []).misses, "quiet");
  expect("a silhouette advisory fails the case that asked for the outline",
    score(silCase, withRef, [], [], [{ kind: "silhouette", message: "silhouette IoU 0.41 < 0.8" }]).misses,
    "fire", "IoU 0.41");

  // ASSEMBLY. Each check fires on its own defect, on synthetic facts first.
  console.log("assembly checks");
  const asmWant: AssemblyExpect = {
    parts: 10, contacts: 1, fits: 1,
    joints: [{ motion: "revolute", hardware: ["bearing", "shaft|d_shaft"], travel: 360 }],
    bom: [{ family: "heatset_std|heatset_short", key: "M3", qty: 4 }, { family: "bearing", minQty: 2 }],
  };
  const facts = (over: Partial<AsmFacts> = {}): AsmFacts => ({
    findings: [],
    bom: [{ family: "heatset_std", key: "M3", qty: 4 }, { family: "bearing", key: "625", qty: 2 }],
    stepNames: Array.from({ length: 10 }, (_, i) => `p${i}`),
    joints: [{ id: "j1", motion: "revolute", expanded: "M1|bearing_a=bearing:625|bearing_b=bearing:625|shaft=d_shaft:5" }],
    sweeps: [{ id: "j1", limits: [-180, 180], moving: ["rotor"] }],
    contacts: 2, fits: 2,
    ...over,
  });
  const finding = (kind: string, message = `G5 ${kind}`) => ({ kind, a: "x", b: "y", measured: 1.5, message });
  const asm = (f: AsmFacts, want = asmWant) => scoreAssembly(want, f).misses;
  expect("a clean rotor assembly", asm(facts()), "quiet");
  expect("a fixed joint where a revolute was asked",
    asm(facts({ joints: [{ id: "j1", motion: "fixed", expanded: "M1|bearing_a=bearing:625|shaft=d_shaft:5" }] })), "fire", "expected 1 revolute");
  expect("a revolute on bushings where bearings were asked",
    asm(facts({ joints: [{ id: "j1", motion: "revolute", expanded: "M2|bushing_a=bushing:5|shaft=shaft:5" }] })), "fire", "expanding to bearing");
  expect("a joint whose recipe failed",
    asm(facts({ joints: [{ id: "j1", motion: "revolute", failed: "wallB 3.0 < bearing 5" }] })), "fire", "FAILED wallB");
  expect("limits short of the travel asked",
    asm(facts({ sweeps: [{ id: "j1", limits: [0, 80], moving: ["rotor"] }] })), "fire", "travels 0..80");
  expect("a joint nothing swept",
    asm(facts({ sweeps: [{ id: "j1", limits: [-180, 180], moving: [] }] })), "fire", "never swept");
  expect("a collision inside the travel",
    asm(facts({ findings: [finding("swept", "G5 swept: joint j1 carries rotor into base at 40° of its travel")] })), "fire", "collides within");
  expect("a collision on j10 is not j1's",
    scoreAssembly({ joints: [{ motion: "revolute", travel: 360 }] },
      facts({ findings: [finding("swept", "G5 swept: joint j10 carries rotor into base")] })).misses.filter((m) => m.includes("collides")), "quiet");
  expect("the later joint on a shared axle needs no sweep of its own",
    asm(facts({ joints: [{ id: "j1", motion: "revolute", expanded: "M1|bearing_a=bearing:625|shaft=d_shaft:5", shared: "j0" }], sweeps: [] })), "quiet");
  expect("a clash", asm(facts({ findings: [finding("clash")] })), "fire", "G5 clash");
  expect("a mate that does not touch", asm(facts({ findings: [finding("gap")] })), "fire", "G5 gap");
  expect("no mate contact measured at all", asm(facts({ contacts: 0 })), "fire", "mate contact check");
  expect("a fit out of band", asm(facts({ findings: [finding("fit")] })), "fire", "G5 fit");
  expect("no mate fit-checked at all", asm(facts({ fits: 0 })), "fire", "fit band check");
  expect("three inserts where four were asked",
    asm(facts({ bom: [{ family: "heatset_std", key: "M3", qty: 3 }, { family: "bearing", key: "625", qty: 2 }] })), "fire", "BOM has 3x");
  expect("the right count of the wrong size",
    asm(facts({ bom: [{ family: "heatset_std", key: "M4", qty: 4 }, { family: "bearing", key: "625", qty: 2 }] })), "fire", "BOM has 0x heatset");
  expect("minQty accepts more",
    asm(facts({ bom: [{ family: "heatset_short", key: "m3", qty: 4 }, { family: "bearing", key: "608", qty: 4 }] })), "quiet");
  const sized = (bbox?: number[]) =>
    scoreAssembly({ bbox: { value: [80, 60, 44], tol: 0.1, sorted: true } }, facts({ bbox })).misses;
  expect("an assembly at its stated size, on its side", sized([44, 80, 60]), "quiet");
  expect("an assembly 30% too long", sized([104, 60, 44]), "fire", "within 10%");
  expect("an assembly nothing measured", sized(undefined), "fire", "size is unchecked");
  expect("a posed copy counts at its pose",
    [worldExtents([{ min: [0, 0, 0], max: [10, 10, 10], matrices: [IDENTITY, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 90, 0, 0, 1]] }])]
      .filter((b) => b?.join() !== "100,10,10").map(String), "quiet");
  expect("too few parts in the STEP", asm(facts({ stepNames: ["a", "b"] })), "fire", "2 named part(s)");
  expect("a STEP export that failed", asm(facts({ stepNames: "kernel 500" })), "fire", "export failed");
  // The raw baseline has no joints, mates or fits. Those checks must come back
  // NOT GRADABLE, never silently passed.
  const rawFacts = facts({ joints: undefined, sweeps: undefined, contacts: undefined, fits: undefined });
  const rawScore = scoreAssembly(asmWant, rawFacts);
  expect("raw output: joints, travel, contact and fit are not gradable",
    ["joint motion", "swept travel", "mate contact", "fit band"].filter((w) => !rawScore.notGradable.some((n) => n.includes(w))), "quiet");
  expect("raw output: a clash still fails", asm({ ...rawFacts, findings: [finding("clash")] }), "fire", "G5 clash");
  expect("assembly expectations with no facts gathered",
    score({ id: "t", prompt: "p", expect: { allReady: false, assembly: asmWant } }, oneNode, []).misses, "fire", "no assembly facts");

  // And on the hand-authored joint examples, against the cases written for
  // them: a case that fails a correct graph measures the case.
  const backendCad = new CadBackend();
  const control = async (example: string, caseFile: string) => {
    // Read only: loadProject's persist runs on an applyOp, and none happens here.
    const doc = (await loadProject(path.join(repoRoot, "examples", example), new EventBus())).store.doc;
    // cad-joints and cad-belt-drive were planned and never cooked. The BOM and
    // contact count read only that code exists, so a stub stands in for it.
    for (const n of Object.values(doc.nodes))
      if (!n.artifact?.code) n.artifact = { ...n.artifact, code: "# uncooked", testCode: "", hash: "stub" };
    const want = (JSON.parse(fs.readFileSync(path.join(casesDir, "assembly", caseFile), "utf8")) as EvalCase).expect.assembly!;
    const f = graphFacts(backendCad, doc, [], Array.from({ length: 99 }, (_, i) => `p${i}`));
    return scoreAssembly({ joints: want.joints, bom: want.bom, contacts: want.contacts, fits: want.fits }, f).misses;
  };
  expect("examples/cad-rotor meets asm-rotor-bearings", await control("cad-rotor", "asm-rotor-bearings.json"), "quiet");
  expect("examples/cad-joints meets asm-enclosure-inserts", await control("cad-joints", "asm-enclosure-inserts.json"), "quiet");
  expect("examples/cad-belt-drive meets asm-belt-turntable", await control("cad-belt-drive", "asm-belt-turntable.json"), "quiet");
  expect("examples/cad-rotor fails the enclosure's joints and BOM", await control("cad-rotor", "asm-enclosure-inserts.json"), "fire", "expected 1 fixed");

  const caseBolt: EvalCase = {
    id: "b", prompt: "p",
    expect: { nodes: { min: 1 }, allReady: true, zeroLlmKinds: ["fastener"], assemblyProblems: 0 },
  };
  expect("a fastener that called the model",
    score(caseBolt, mk({ s: node("s", { kind: "fastener" }, goodPlate) }), []).misses,
    "fire", "called the model");
  expect("a registry fastener is free",
    score(caseBolt, mk({ s: node("s", { kind: "fastener", cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 } }, goodPlate) }), []).misses,
    "quiet");
  expect("an unsolved assembly",
    score(caseBolt, mk({ s: node("s", { kind: "part" }, goodPlate) }), ["bracket has no mate"]).misses,
    "fire", "assembly problem");

  console.log(failures ? `\n${failures} SCORER FAILURE(S)` : "\nscorer self-test passed");
  if (failures) process.exit(1);
}

/** Score every project already on disk, with zero model calls.
 *
 *  The scorer self-test is built from synthetic graphs, so it can only catch
 *  defects it models, and all of this harness's holes were ABSENCES rather than
 *  wrong values: a port declared and never probed, a ready node with no
 *  measurements, a stale version. A real payload found in one read what twelve
 *  synthetic fixtures could not. These cost nothing, so they run as fixtures.
 */
function scoreProjects(): void {
  const root = path.join(repoRoot, "projects");
  if (!fs.existsSync(root)) {
    console.log("no projects/ on disk, nothing to score");
    return;
  }
  const dirs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "patchcad.json")));
  // Asks only "is every ready node's declared geometry actually measured", which
  // is the claim the whole project rests on. No prompt-specific expectations.
  const generic: EvalCase = { id: "verified", prompt: "", expect: { allReady: false, noSkippedPorts: true } };
  let unverified = 0;
  let vacuous = 0;
  for (const d of dirs) {
    const doc = JSON.parse(fs.readFileSync(path.join(root, d, "patchcad.json"), "utf8"));
    let store: GraphStore;
    try {
      store = new GraphStore(GraphDoc.parse(doc), new EventBus(), async () => {});
    } catch (err) {
      console.log(`  SKIP  ${d} (will not parse: ${String(err).slice(0, 80)})`);
      continue;
    }
    const nodes = Object.values(store.doc.nodes);
    const ready = nodes.filter((n) => n.status === "ready").length;
    const declared = nodes.reduce(
      (sum, n) => sum + (((n.contract.payload as { ports?: unknown[] } | null)?.ports)?.length ?? 0), 0);
    const { misses } = score(generic, store, []);
    // "clean" over a graph with nothing to judge is the same defect one level
    // up: three of the four projects that first reported clean were web-code
    // graphs declaring no ports, so the verdict was vacuous rather than earned.
    // Say which it is.
    const verdict = misses.length ? "UNVERIFIED" : declared ? "verified  " : "nothing to judge";
    console.log(`  ${verdict.padEnd(16)} ${d}  (${ready}/${nodes.length} ready, ${declared} declared port(s), backend ${store.doc.backend})`);
    for (const m of misses.slice(0, 6)) console.log(`      ${m}`);
    if (misses.length > 6) console.log(`      ...and ${misses.length - 6} more`);
    if (misses.length) unverified++;
    else if (!declared) vacuous++;
  }
  console.log(
    `\n${unverified}/${dirs.length} project(s) carry a ready node whose declared geometry nothing measured. ` +
      `${vacuous} declared no geometry to judge, so their pass is not evidence of anything.`,
  );
}

/** What a plan-only run records: the architect's output, before any cook. */
type DryResult = {
  id: string; pass: boolean; dry: true; misses: string[]; usd: number; calls: number;
  nodes: number; planMs: number; wallMs: number; lintProblems: string[]; planned: { id: string; kind: string }[];
};

async function runCase(c: EvalCase, capUsd: number) {
  const backend = new CadBackend();
  const bus = new EventBus();
  // Generation rounds per node: every attempt passes through "generating"
  // once, and a node's calls alone cannot say that (round 1 drafts several).
  const attempts: Record<string, number> = {};
  bus.subscribe((e) => {
    if (e.type === "node:status" && e.status === "generating") attempts[e.nodeId] = (attempts[e.nodeId] ?? 0) + 1;
  });
  const resolved = (await resolveProvider())?.provider;
  if (!resolved) throw new Error("no LLM provider configured");
  // What is left of --max-usd, enforced per call: checking only between cases
  // let one assembly overrun the whole ladder's cap on its own.
  const provider = capUsd > 0 ? budgeted(resolved, new Budget(capUsd)) : resolved;

  const refs = await prepReferences(
    backend.kernel,
    (c.images ?? []).map((img) => ({
      dataB64: fs.readFileSync(path.join(casesDir, img.file)).toString("base64"),
      mediaType: img.file.endsWith(".png") ? "image/png" as const : "image/jpeg" as const,
      view: img.view,
    })),
    (line) => console.log(`  ${line}`),
  );

  const t0 = Date.now();
  const plan = await planGraph({
    provider, backend, projectId: `eval-${c.id}`, goal: c.prompt,
    references: refs.map((r) => ({ image: r.image, view: r.ref.view, aspect: r.ref.aspect })),
  }).catch((err: Error & { draft?: unknown }) => {
    // A plan that failed its lints: keep the last draft to replay offline.
    if (err.draft) {
      const dir = path.join(repoRoot, "evals", "results", ".work", c.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "failed-plan.json"), JSON.stringify(err.draft, null, 1));
    }
    throw err;
  });
  const planMs = Date.now() - t0;
  plan.graph.brief.refs = refs.map((r) => r.ref);
  // One draft plus one call per lint-repair round.
  const archCalls = 1 + plan.lintRounds.length;

  if (flag("dry")) {
    const dir = path.join(repoRoot, "evals", "results", ".work", c.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan.graph, null, 1));
    const all = Object.values(plan.graph.nodes);
    const planned = all.map((n) => ({ id: n.id, kind: n.kind }));
    const designed = all.filter((n) => !jointHardware(plan.graph, n)).length;
    const { min = 0, max = Infinity } = c.expect.nodes ?? {};
    // The only expectation a plan alone can answer.
    const misses = planned.length < min || designed > max
      ? [`planned ${designed} nodes (plus ${planned.length - designed} joint hardware), expected ${min}..${max}`] : [];
    return {
      id: c.id, pass: misses.length === 0, dry: true, misses,
      usd: plan.usage.usd, calls: archCalls, nodes: planned.length,
      planMs, wallMs: planMs, lintProblems: plan.lintRounds.flat(), planned,
    } satisfies DryResult;
  }

  const store = new GraphStore(plan.graph, bus, async () => {});
  const workspace = { root: path.join(repoRoot, "evals", "results", ".work", c.id) };
  fs.mkdirSync(workspace.root, { recursive: true });
  // globalCheck reads masks from <workspace>/../refs, as a project reads refs/.
  await writeRefs(path.dirname(workspace.root), refs);

  const t1 = Date.now();
  await cookNodes({ store, backend, provider, workspace }, Object.keys(store.doc.nodes));
  const cookMs = Date.now() - t1;

  let problems: unknown[] = [];
  try {
    problems = backend.solveScene(store.doc).problems as unknown[];
  } catch (err) {
    problems = [`solveScene threw: ${String(err)}`];
  }

  // globalCheck is a SEPARATE question from solveScene, and it is where the
  // clash gate lives. Running one and asserting on it while calling the case
  // "assembly verified" is how a clashing assembly passed.
  let global: string[] = [];
  let advisories: { kind?: string; message?: string }[] = [];
  let findings: CheckFinding[] = [];
  try {
    const res = await backend.globalCheck?.(store.doc, workspace);
    findings = res?.findings ?? [];
    // Advisories (the G6 silhouette) ride in problems too so a user reads
    // them, but they are not blocking by design, so they are recorded apart.
    advisories = res?.advisories ?? [];
    const advisory = new Set((res?.advisories ?? []).map((a) => a.message));
    global = ((res?.problems ?? []) as string[]).filter((m) => !advisory.has(m));
  } catch (err) {
    global = [`globalCheck threw: ${String(err)}`];
  }

  const nodes = Object.values(store.doc.nodes);
  // THE ARCHITECT'S CALL BELONGS TO NO NODE. Summing node costs alone
  // understates every case by the largest single output in the system, which is
  // the plan itself, and this harness exists to report real dollars.
  const arch = plan.usage;
  const usd = nodes.reduce((s, n) => s + n.cost.usd, arch.usd);
  // Not a hardcoded 1: a repaired plan is two or more, and a harness whose
  // point is real numbers must not round its own headline down.
  const calls = nodes.reduce((s, n) => s + n.cost.calls, archCalls);
  const outTok = nodes.reduce((s, n) => s + n.cost.outputTokens, arch.outputTokens);
  const inTok = nodes.reduce((s, n) => s + n.cost.inputTokens, arch.inputTokens);
  // A node that passed on its first generation. Deterministic nodes cost 0
  // calls and are not "first try" in the interesting sense, so they are counted
  // separately rather than inflating the rate.
  const modelNodes = nodes.filter((n) => n.cost.calls > 0);
  // Generation ROUNDS, not calls: round 1 drafts several candidates, so
  // calls === 1 read every case as 0/N.
  const firstTry = modelNodes.filter((n) => n.status === "ready" && attempts[n.id] === 1);
  const dead = nodes.filter((n) => n.status.startsWith("error"));

  let asm: AsmFacts | undefined;
  if (c.expect.assembly) {
    // The file a user downloads, not a re-count of nodes: one named child per
    // placed copy, or the reason there is no file.
    let stepNames: AsmFacts["stepNames"];
    try {
      const res = await backend.exportGeometry(store.doc, workspace, { format: "step" });
      stepNames = res.ok ? res.export?.names ?? [] : String((res as { error?: string }).error ?? "export failed");
    } catch (err) {
      stepNames = String(err);
    }
    asm = graphFacts(backend, store.doc, findings, stepNames);
  }

  const { misses, probes, notGradable } = score(c, store, problems, global, advisories, asm);

  return {
    id: c.id, pass: misses.length === 0, misses, notGradable,
    joints: store.doc.joints, bom: asm?.bom, stepParts: asm?.stepNames,
    nodes: nodes.length, modelNodes: modelNodes.length,
    deterministic: nodes.length - modelNodes.length,
    firstTry: firstTry.length, dead: dead.length,
    calls, inTok, outTok, usd,
    architect: {
      usd: arch.usd, inTok: arch.inputTokens, outTok: arch.outputTokens, repaired: plan.repaired,
      // The audit's observability fix: WHICH lint each repair round was for,
      // not just that one happened. The repaired boolean hid a single missing
      // guidance rule behind 14 identical-looking repair rounds.
      lintRounds: plan.lintRounds.map((round) => round.map((m) => m.split(":")[0] ?? m)),
      lintProblems: plan.lintRounds.flat(),
    },
    globalProblems: global,
    advisories,
    planMs, cookMs, wallMs: planMs + cookMs, probes: probes.length,
    skipped: probes.filter((p) => p.skipped).length,
    // A FAIL THAT CANNOT BE DIAGNOSED COSTS A SECOND FULL RUN, which is the
    // "pay twice" this harness exists to avoid. The first real run landed a node
    // in error_contract and recorded nothing about why, so everything needed to
    // read the failure without calling a model again is captured here: the gate
    // verdict, the attribution, what each attempt was blamed on, and the code.
    perNode: nodes.map((n) => ({
      id: n.id, kind: n.kind, status: n.status, pass: n.status === "ready",
      attempts: attempts[n.id] ?? 0, calls: n.cost.calls, usd: n.cost.usd,
      version: n.version,
      detail: n.statusDetail ?? null,
      causes: n.history.map((h) => h.cause),
      declaredPorts: (((n.contract.payload as { ports?: { name?: string; type?: string }[] } | null)?.ports) ?? [])
        .map((pt) => `${pt.name}:${pt.type}`),
      measurements: n.measurements?.data ?? null,
      spec: n.spec,
      code: n.artifact?.code ?? null,
    })),
    graph: store.doc,
  };
}

/** The raw baseline's answer: one module, every part a named entry, plus a BOM. */
const RawAnswer = z.object({
  code: z.string().describe("the complete Python module defining PARTS"),
  parts: z.array(z.string()).describe("every key of PARTS"),
  bom: z.array(z.object({
    family: z.string().describe("catalog family id, e.g. shcs, heatset_std, bearing"),
    key: z.string().describe("catalog key, e.g. M3, 625, 6x3"),
    qty: z.number().int(),
    length: z.number().optional(),
  })).describe("purchased hardware only"),
});

/** As strong a single-call prompt as PatchCAD's own generator gets: the same
 *  build123d cheat sheet, the whole hardware catalog with its dimensions, and
 *  the grading rules stated up front. A baseline that loses because it was
 *  never told how it is scored measures the prompt, not the model. */
function rawSystem(): string {
  const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages", "backend-cad", "catalog", "hardware.json"), "utf8")) as Record<string, unknown>;
  const { skus: _skus, ...dims } = catalog;
  return [
    "You are a senior mechanical design engineer. Design the whole assembly the user asks for as ONE build123d",
    "Python module. It must define PARTS, a dict from a part name to a function taking `p` and returning ONE",
    "solid for ONE physical piece, already in its ASSEMBLED position and orientation in a shared world frame",
    "(millimetres, +Z up, moving parts at their rest pose). Every physical piece is its own entry, purchased",
    "hardware included: four screws are four entries (screw_1..screw_4), each nut, washer, insert, bearing, shaft,",
    "pin, magnet, gear, pulley, belt and motor too. Helper functions are fine. Do NOT define build(): the grader",
    "appends `def build(p): return PARTS[name](p)` once per name, which is how the RULES below apply here.",
    "",
    "HOW YOU ARE GRADED (all of it is measured by a geometry kernel, none of it is taken on trust):",
    "  - every entry executes alone in under 20s, imports only build123d and math, and returns one valid closed solid;",
    "  - every pair of entries is intersected: ANY shared volume is a clash. Holes, pockets and seats for",
    "    hardware must be cut so the hardware sits in them with zero overlap (a press fit is modelled touching,",
    "    not overlapping); model a screw's thread at its minor diameter where it enters a threaded host;",
    "  - the assembly is exported to STEP with one named child per entry, and the count is checked;",
    "  - the BOM lists purchased hardware only, by the catalog's family ids and keys below, with quantities that",
    "    match the entries you modelled. Printed or machined parts are not in the BOM.",
    "Use the catalog's dimensions for every bought part, so the parts you design around them fit.",
    "",
    CHEAT_SHEET,
    "",
    "HARDWARE CATALOG (families keyed by thread or size, dims in mm):",
    JSON.stringify(dims),
  ].join("\n");
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** One call, graded by the same kernel: per-part G0-G2, pairwise clash at
 *  identity, the STEP's named parts, and the BOM. Joints, mates, fits and
 *  motion do not exist in the output, so they are reported as not gradable. */
async function runRaw(c: EvalCase, provider: LlmProvider, backend: CadBackend) {
  const t0 = Date.now();
  const res = await provider.complete({
    role: "generator", system: rawSystem(), schema: RawAnswer, label: `raw:${c.id}`, maxTokens: 32000,
    messages: [{ role: "user", content: `${c.prompt}\n\nEmit the complete module, every part name, and the BOM.` }],
  });
  const callMs = Date.now() - t0;
  const code = normalizeCadCode(res.data.code);
  const entry = (name: string) => `${code}\n\ndef build(p):\n    return PARTS[${JSON.stringify(name)}](p)\n`;
  const names = [...new Set(res.data.parts)];
  const built = await Promise.all(names.map(async (name) => ({ name, r: await backend.kernel.execute(entry(name), {}, { solids: 1 }) })));
  const misses: Miss[] = built.flatMap(({ name, r }) => (r.ok ? [] : [`${name} failed ${r.stage}: ${r.error.slice(0, 160)}`]));
  const parts = built.filter((b) => b.r.ok).map((b) => ({ key: b.name, code: entry(b.name), params: {}, matrix: IDENTITY }));
  const findings: AsmFacts["findings"] = [];
  if (parts.length >= 2) {
    const clash = await backend.kernel.clash(parts);
    if (!clash.ok || !clash.clash) misses.push(`clash check did not run: ${clash.error ?? "no report"}`);
    else for (const x of clash.clash.clashes)
      findings.push({ kind: "clash", a: x.a, b: x.b, measured: x.volume_mm3, message: `${x.a} and ${x.b} share ${x.volume_mm3.toFixed(1)} mm3` });
  }
  const step = parts.length ? await backend.kernel.export(parts.map((p) => ({ ...p, name: p.key })), "step") : null;
  const scored = scoreAssembly(c.expect.assembly ?? {}, {
    findings,
    bom: res.data.bom.map((r) => ({ family: r.family, key: r.key, qty: r.qty })),
    stepNames: step?.ok ? step.export?.names ?? [] : String((step as { error?: string } | null)?.error ?? "no part built"),
    bbox: worldExtents(built.flatMap(({ r }) => (r.ok ? [{ ...r.measurements.bbox, matrices: [IDENTITY] }] : []))),
  });
  misses.push(...scored.misses);
  return {
    id: c.id, raw: true, pass: misses.length === 0, misses, notGradable: scored.notGradable,
    usd: res.usage.usd, calls: 1, inTok: res.usage.inputTokens, outTok: res.usage.outputTokens,
    callMs, wallMs: Date.now() - t0, parts: names.length, built: parts.length, bom: res.data.bom, code,
  };
}

/** The fields the summary table reads; every result kind carries some. */
type RunRow = {
  id: string; pass: boolean; usd: number; error?: string; nodes?: number; calls?: number;
  wallMs?: number; globalProblems?: string[];
  perNode?: { pass: boolean; attempts: number }[];
};

/** The newest earlier result of the same kind (dry vs cooked), to diff against.
 *  Results predating the dry flag were all cooked. */
function latestResult(dry: boolean, raw = false): { file: string; results: RunRow[] } | null {
  if (!fs.existsSync(resultsDir)) return null;
  for (const f of fs.readdirSync(resultsDir).filter((n) => n.endsWith(".json")).sort().reverse()) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf8")) as { dry?: boolean; raw?: boolean; results?: RunRow[] };
      if (Boolean(doc.dry) === dry && Boolean(doc.raw) === raw && doc.results?.length) return { file: f, results: doc.results };
    } catch {
      // a half-written result from a killed run is not a baseline
    }
  }
  return null;
}

/** One screen: a row per run, and what moved since the previous result. */
function summaryTable(rows: RunRow[], previous: ReturnType<typeof latestResult>): void {
  const cells = (r: RunRow) => {
    const nodes = r.perNode ?? [];
    return {
      verdict: r.error ? "THREW" : r.pass ? "pass" : "FAIL",
      nodes: nodes.length ? `${nodes.filter((n) => n.pass).length}/${nodes.length}` : String(r.nodes ?? "-"),
      attempts: nodes.length ? String(nodes.reduce((a, n) => a + n.attempts, 0)) : "-",
      calls: String(r.calls ?? "-"),
      usd: `$${r.usd.toFixed(3)}`,
      wall: r.wallMs != null ? `${(r.wallMs / 1000).toFixed(0)}s` : "-",
      g5: r.globalProblems ? String(r.globalProblems.length) : "-",
    };
  };
  const head = ["case", "verdict", "ready", "attempts", "calls", "$", "wall", "G5", "vs previous"];
  const table = rows.map((r) => {
    const c = cells(r);
    const before = previous?.results.find((p) => p.id === r.id);
    let delta = "new";
    if (before) {
      const b = cells(before);
      const moved = (Object.keys(c) as (keyof typeof c)[])
        .filter((k) => c[k] !== b[k] && k !== "wall")
        .map((k) => `${k} ${b[k]}->${c[k]}`);
      delta = moved.join(", ") || "same";
    }
    return [r.id, c.verdict, c.nodes, c.attempts, c.calls, c.usd, c.wall, c.g5, delta];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]!.length)));
  const line = (row: string[]) => row.map((v, i) => (i === row.length - 1 ? v : v.padEnd(widths[i]!))).join("  ");
  console.log(`\n${line(head)}\n${widths.map((w) => "-".repeat(w)).join("  ")}`);
  for (const row of table) console.log(line(row));
  console.log(previous ? `diff vs ${previous.file}` : "no previous result of this kind to diff against");
}

/** Newest PatchCAD result beside newest raw result, per case of the suite.
 *  Runs split across processes land in separate files, so each case takes its
 *  own newest row rather than one file's. */
function compareResults(cases: EvalCase[]): void {
  type Row = RunRow & { misses?: string[]; notGradable?: string[] };
  const cooked = new Map<string, Row>();
  const raw = new Map<string, Row>();
  for (const f of fs.readdirSync(resultsDir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf8")) as { dry?: boolean; raw?: boolean; results?: Row[] };
      if (doc.dry) continue;
      for (const r of doc.results ?? []) (doc.raw ? raw : cooked).set(r.id, r);
    } catch {
      // a half-written result from a killed run is not a result
    }
  }
  const verdict = (r?: Row) => (!r ? "-" : r.error ? "THREW" : !r.pass ? "FAIL" : r.notGradable?.length ? "pass*" : "pass");
  const money = (r?: Row) => (r ? `$${r.usd.toFixed(2)}` : "-");
  const secs = (r?: Row) => (r?.wallMs != null ? `${(r.wallMs / 1000).toFixed(0)}s` : "-");
  const head = ["case", "PatchCAD", "$", "calls", "wall", "raw", "$", "calls", "wall"];
  const rows = cases.map((c) => {
    const [p, r] = [cooked.get(c.id), raw.get(c.id)];
    return [c.id, verdict(p), money(p), String(p?.calls ?? "-"), secs(p), verdict(r), money(r), String(r?.calls ?? "-"), secs(r)];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (row: string[]) => row.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd();
  const out = [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)];
  const total = (m: Map<string, Row>) => cases.reduce((a, c) => a + (m.get(c.id)?.usd ?? 0), 0);
  const passes = (m: Map<string, Row>) => cases.filter((c) => m.get(c.id)?.pass).length;
  out.push(
    "",
    `PatchCAD ${passes(cooked)}/${cases.length} pass, $${total(cooked).toFixed(2)}. ` +
      `Raw ${passes(raw)}/${cases.length} pass*, $${total(raw).toFixed(2)}. ` +
      "pass* = every GRADABLE check passed; joints, mates, fits and motion cannot be graded on raw output and never count as passes.",
    "",
  );
  for (const c of cases) {
    out.push(c.id);
    for (const [who, r] of [["PatchCAD", cooked.get(c.id)], ["raw", raw.get(c.id)]] as const) {
      if (!r) out.push(`  ${who}: not run`);
      else if (r.error) out.push(`  ${who}: threw: ${r.error.slice(0, 200)}`);
      else for (const m of r.misses?.length ? r.misses : ["(all checks passed)"]) out.push(`  ${who}: ${m.slice(0, 240)}`);
      if (r?.notGradable?.length) out.push(`  ${who}: not gradable: ${r.notGradable.join(", ")}`);
    }
  }
  console.log(out.join("\n"));
  const file = path.join(resultsDir, `compare-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
  fs.writeFileSync(file, out.join("\n") + "\n");
  console.log(`\n${file}`);
}

async function main() {
  if (flag("self-test")) return selfTest();
  if (flag("score-projects")) return scoreProjects();

  const dir = opt("suite") ? path.join(casesDir, opt("suite")!) : casesDir;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const only = opt("only") ?? opt("case");
  const cases: EvalCase[] = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as EvalCase)
    .filter((c) => !only || only.split(",").includes(c.id));

  if (!cases.length) throw new Error(`no cases matched${only ? ` --case ${only}` : ""}`);

  // The cap is a HARD stop, not advice. A ladder left running against a real
  // provider is the one way this harness can cost more than it is worth.
  const maxUsd = Number(opt("max-usd") ?? "0");

  // An expectation that asserts nothing is worse than a missing one: it reads
  // like a check. A port expectation with neither diameter nor width only counts
  // probes, and an empty ports array runs a zero-iteration loop.
  const vacuous: string[] = [];
  for (const c of cases) {
    if (c.expect.ports && c.expect.ports.length === 0)
      vacuous.push(`${c.id}: "ports": [] asserts nothing, remove the key or fill it`);
    if (c.expect.silhouette && !c.images?.some((i) => i.view))
      vacuous.push(`${c.id}: silhouette needs an image with a view, or G6 compares nothing`);
    for (const pe of c.expect.ports ?? []) {
      if (!pe.type && !pe.anyType)
        vacuous.push(`${c.id}: a port expectation names no type`);
      if (pe.diameter == null && pe.width == null && pe.pilot == null && !pe.measure && !pe.through)
        vacuous.push(
          `${c.id}: ${pe.anyType?.join("|") ?? pe.type} expectation has no diameter, width, pilot, measure or through, so it only counts probes`,
        );
    }
    for (const b of c.expect.assembly?.bom ?? [])
      if (b.qty == null && b.minQty == null) vacuous.push(`${c.id}: BOM expectation ${b.family} has no qty or minQty`);
    if (flag("raw") && !c.expect.assembly) vacuous.push(`${c.id}: --raw grades assembly expectations only, and this case has none`);
  }
  if (vacuous.length) {
    for (const v of vacuous) console.error(`INVALID CASE: ${v}`);
    process.exit(2);
  }

  if (flag("dry-run")) {
    console.log(`${cases.length} case(s), validated without calling a model:\n`);
    for (const c of cases) {
      const e = c.expect;
      const checks = [
        e.nodes && `nodes ${e.nodes.min ?? 0}..${e.nodes.max ?? "inf"}`,
        e.allReady !== false && "all nodes ready",
        e.noSkippedPorts !== false && "NO port verified by nothing",
        ...(e.ports ?? []).map((p) =>
          `${p.anyType?.join("|") ?? p.type} ${p.diameter ?? p.width ?? p.pilot ?? (p.measure ? `${p.measure.field}=${p.measure.value}` : "")}${p.through ? " through" : ""}`.trim()),
        e.bboxSize && `bbox ${e.bboxSize.value.join("x")} +/-${e.bboxSize.tol}`,
        e.volume && `material ${e.volume.min != null ? `>=${e.volume.min}` : ""}${e.volume.max != null ? `<=${e.volume.max}` : ""} mm3`,
        e.requireProbedPorts !== false && "every declared port probed, current",
        e.volumeFraction && `fills ${e.volumeFraction.min != null ? `>=${e.volumeFraction.min * 100}%` : ""}${e.volumeFraction.max != null ? `<=${e.volumeFraction.max * 100}%` : ""} of its bbox`,
        e.zeroLlmKinds && `zero LLM: ${e.zeroLlmKinds.join(",")}`,
        e.assemblyProblems != null && `assembly problems == ${e.assemblyProblems}`,
        e.assertionKinds && `measured assertion: ${e.assertionKinds.join(",")}`,
        e.silhouette && `outline matches ${(c.images ?? []).map((i) => `${i.file} (${i.view ?? "unlabelled"})`).join(", ")}`,
        e.assembly?.parts != null && `assembly STEP has >= ${e.assembly.parts} named parts`,
        e.assembly?.contacts != null && `>= ${e.assembly.contacts} mates contact-checked, no G5 gap`,
        e.assembly?.fits != null && `>= ${e.assembly.fits} mates fit-checked, no G5 fit finding`,
        ...(e.assembly?.joints ?? []).map((j) =>
          `${j.count ?? 1}x ${j.motion} joint${j.hardware ? ` -> ${j.hardware.join(" + ")}` : ""}${j.travel != null ? `, swept clean over ${j.travel}${j.motion === "prismatic" ? "mm" : "deg"}` : ""}`),
        ...(e.assembly?.bom ?? []).map((b) => `BOM ${b.qty ?? `>=${b.minQty}`}x ${b.family}${b.key ? ` ${b.key}` : ""}`),
        e.assembly?.bbox && `assembly ${e.assembly.bbox.value.join("x")} +/-${e.assembly.bbox.tol * 100}%${e.assembly.bbox.sorted ? " (any orientation)" : ""}`,
      ].filter(Boolean);
      console.log(`  ${c.id}`);
      console.log(`    prompt: ${c.prompt}`);
      for (const ch of checks) console.log(`      - ${ch}`);
    }
    console.log("\ndry run: no provider resolved, no tokens spent.");
    return;
  }

  if (flag("compare")) return compareResults(cases);

  // A dry run is one architect call per case, so it needs no cap to be cheap.
  if (!maxUsd && !flag("dry")) {
    console.error("refusing to run without --max-usd N (a ladder against a real provider spends money)");
    process.exit(2);
  }

  // REPEATS, because a sweep of one run each is what hid the seat-pose
  // regression behind four green lines. rib-blocked-hole's generator calls
  // measured 2, 2, 4, 1, 2 across five runs, so a single sample of any case is
  // one draw from a distribution, and a case that passes is not a case that
  // always passes.
  const repeat = Math.max(1, Number(opt("repeat") ?? "1"));
  const plan = repeat > 1 ? cases.flatMap((c) => Array.from({ length: repeat }, () => c)) : cases;
  if (repeat > 1) console.log(`${cases.length} case(s) x ${repeat} repeats = ${plan.length} runs\n`);

  const results: unknown[] = [];
  let spent = 0;
  const rawProvider = flag("raw") ? (await resolveProvider())?.provider : undefined;
  if (flag("raw") && !rawProvider) throw new Error("no LLM provider configured");
  const rawBackend = new CadBackend();
  for (const c of plan) {
    if (maxUsd && spent >= maxUsd) {
      console.log(`\nSTOPPING: spent $${spent.toFixed(3)} of $${maxUsd.toFixed(2)}. ${plan.length - plan.indexOf(c)} run(s) not started.`);
      break;
    }
    console.log(`\n=== ${c.id} ===\n  ${c.prompt}`);
    let r: Awaited<ReturnType<typeof runCase>> | { id: string; pass: false; error: string; usd: number; misses: string[]; perNode: never[] };
    try {
      if (rawProvider) {
        const raw = await runRaw(c, budgeted(rawProvider, new Budget(maxUsd - spent)), rawBackend);
        spent += raw.usd;
        results.push(raw);
        console.log(`  ${raw.pass ? "PASS*" : "FAIL"}  ${raw.built}/${raw.parts} parts built, $${raw.usd.toFixed(3)}, ${(raw.wallMs / 1000).toFixed(0)}s`);
        for (const m of raw.misses) console.log(`    MISS: ${m}`);
        if (raw.notGradable.length) console.log(`    not gradable: ${raw.notGradable.join(", ")}`);
        continue;
      }
      r = await runCase(c, maxUsd - spent);
    } catch (err) {
      // A RUN THAT THROWS RECORDED NOTHING. pen-cup-hexagonal died in the
      // architect on a JSON parse failure, and because the result file is only
      // written on the success path there was no artifact at all: no cost, no
      // error text, nothing to read afterwards. That is the same pay-twice this
      // harness exists to avoid, one level up from the failure capture inside
      // runCase. A thrown call still billed, and LlmCallError carries what it
      // billed, so the ledger stays honest.
      const billed = (err as { usage?: { usd: number } }).usage?.usd ?? 0;
      r = {
        id: c.id, pass: false, error: String(err instanceof Error ? err.message : err),
        // `error` carries the text; duplicating it into misses said the same
        // thing twice.
        usd: billed, misses: [], perNode: [],
      };
      console.log(`  THREW  $${billed.toFixed(3)} billed before the throw`);
      console.log(`    ${r.error.slice(0, 400)}`);
    }
    spent += r.usd;
    results.push(r);
    if ("error" in r) continue; // already reported above, and there is no run to summarise
    if ("dry" in r) {
      const d = r as DryResult;
      console.log(
        `  ${d.pass ? "PLANNED" : "FAIL"}  ${d.nodes} nodes [${d.planned.map((n) => `${n.id}:${n.kind}`).join(", ")}], ` +
          `$${d.usd.toFixed(3)}, plan ${(d.planMs / 1000).toFixed(1)}s`,
      );
      for (const m of d.misses) console.log(`    MISS: ${m}`);
      for (const m of d.lintProblems) console.log(`    lint-repair: ${m.slice(0, 160)}`);
      continue;
    }
    console.log(
      `  ${r.pass ? "PASS" : "FAIL"}  ${r.nodes} nodes (${r.deterministic} deterministic), ` +
        `${r.firstTry}/${r.modelNodes} first-try, ${r.dead} dead, ${r.calls} calls, ` +
        `${r.probes} ports (${r.skipped} skipped), $${r.usd.toFixed(3)}, ` +
        `plan ${(r.planMs / 1000).toFixed(1)}s cook ${(r.cookMs / 1000).toFixed(1)}s`,
    );
    for (const m of r.misses) console.log(`    MISS: ${m}`);
    for (const round of r.architect.lintProblems.length ? [r.architect.lintProblems] : [])
      console.log(`    lint-repair: ${round.map((m) => m.slice(0, 90)).join(" | ").slice(0, 240)}`);
    for (const n of r.perNode) {
      if (!n.status.startsWith("error") && n.status === "ready") continue;
      const d = n.detail as { stage?: string; message?: string; attribution?: string } | null;
      console.log(`    ${n.id}: ${n.status} after ${n.calls} call(s), causes=[${n.causes.join(",")}]`);
      if (n.declaredPorts.length) console.log(`      declared: ${n.declaredPorts.join(", ")}`);
      if (d) console.log(`      ${d.stage} (${d.attribution}): ${(d.message ?? "").slice(0, 400)}`);
    }
  }

  fs.mkdirSync(resultsDir, { recursive: true });
  // Read BEFORE writing, or the newest file is this run and the diff is empty.
  const previous = latestResult(flag("dry"), flag("raw"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(resultsDir, `${stamp}${flag("raw") ? "-raw" : ""}.json`);
  fs.writeFileSync(out, JSON.stringify({ spent, maxUsd, dry: flag("dry"), raw: flag("raw"), results }, null, 2));
  summaryTable(results as RunRow[], previous);

  const passed = results.filter((r) => (r as { pass: boolean }).pass).length;

  if (repeat > 1) {
    console.log("\n--- per case, across repeats ---");
    for (const c of cases) {
      const mine = results.filter((r) => (r as { id: string }).id === c.id) as {
        pass: boolean; usd: number; perNode?: { calls: number }[];
      }[];
      const calls = mine.flatMap((r) => (r.perNode ?? []).filter((n) => n.calls > 0).map((n) => n.calls));
      const mean = calls.length ? calls.reduce((a, b) => a + b, 0) / calls.length : 0;
      // Report the SPREAD, not just the mean: a mean alone reads as a
      // measurement when it is one draw's worth of information.
      const spread = calls.length ? `${Math.min(...calls)}-${Math.max(...calls)}` : "n/a";
      console.log(
        `  ${c.id.padEnd(22)} ${mine.filter((r) => r.pass).length}/${mine.length} pass  ` +
          `generator calls ${calls.join(",") || "none"}  mean ${mean.toFixed(2)}  range ${spread}  ` +
          `$${mine.reduce((a, r) => a + r.usd, 0).toFixed(3)}`,
      );
    }
  }

  console.log(`\n${passed}/${results.length} runs pass. $${spent.toFixed(3)} spent. ${out}`);
  if (passed !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
