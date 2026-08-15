import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphDoc } from "@patchcad/shared";
import { cookNodes, EventBus, GraphStore, type LlmProvider } from "@patchcad/engine";
import { CadBackend, plateCode, type CadContractPayload } from "@patchcad/backend-cad";
import { resolveProvider } from "./providers.js";

/**
 * CAD-M2 acceptance (design doc): a hand-written architect graph — base
 * plate + L-bracket + M4 screw — cooks per-node (parts via the LLM, the
 * fastener registry-only), passes gates G0–G4, and assembles. Then a
 * deliberately wrong bore must be caught by G3 and repaired via the hint.
 *
 *   pnpm exec tsx src/cad-acceptance.ts     (kernel + ollama must be running)
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, "..", "..", "..", "projects", ".cad-acceptance");

const payloadDefaults = {
  units: "mm" as const,
  process: { kind: "FDM" as const, minWall: 1.2, nozzle: 0.4 },
  paramBindings: {},
};

function partNode(opts: {
  id: string;
  title: string;
  spec: string;
  kind?: string;
  params: { name: string; default: number }[];
  provides: { key: string; type: string }[];
  requires?: { key: string; type: string }[];
  payload: Omit<CadContractPayload, keyof typeof payloadDefaults> & Partial<CadContractPayload>;
  paramOverrides?: Record<string, number | string>;
  deps?: string[];
}) {
  return {
    id: opts.id,
    kind: opts.kind ?? "part",
    title: opts.title,
    spec: opts.spec,
    contract: {
      name: opts.title,
      summary: opts.spec,
      params: opts.params.map((p) => ({ type: "number", name: p.name, description: "", default: p.default })),
      provides: opts.provides.map((p) => ({ ...p, description: "" })),
      requires: (opts.requires ?? []).map((p) => ({ ...p, description: "" })),
      payload: { ...payloadDefaults, ...opts.payload },
      hash: "",
    },
    pinned: false,
    params: opts.paramOverrides ?? {},
    deps: opts.deps ?? [],
    artifact: null,
    thread: [],
    status: "planned",
    version: 0,
    history: [],
    cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
  };
}

const up: [number, number, number] = [0, 0, 1];
const ex: [number, number, number] = [1, 0, 0];
const pose = (origin: [number, number, number], zAxis = up, xAxis = ex) => ({ origin, zAxis, xAxis });

// Base plate 60×40×5, four Ø4.5 corner holes inset 6 mm (centered box → top z=2.5).
const basePlate = partNode({
  id: "base-plate",
  title: "Base plate",
  spec:
    "A rectangular mounting plate p.width × p.depth × p.thickness (centered box, so the top face is at z = p.thickness/2). " +
    "Drill four Ø p.hole_diameter through-holes, one near each corner, inset p.hole_inset from each edge " +
    "(hole centers at x = ±(p.width/2 − p.hole_inset), y = ±(p.depth/2 − p.hole_inset)).",
  params: [
    { name: "width", default: 60 },
    { name: "depth", default: 40 },
    { name: "thickness", default: 5 },
    { name: "hole_diameter", default: 4.5 },
    { name: "hole_inset", default: 6 },
  ],
  provides: [
    { key: "front_left_hole", type: "CLEARANCE_HOLE" },
    { key: "back_right_hole", type: "CLEARANCE_HOLE" },
  ],
  payload: {
    ports: [
      { name: "front_left_hole", type: "CLEARANCE_HOLE", pose: pose([-24, -14, 2.5]), params: { diameter: 4.5 } },
      { name: "back_right_hole", type: "CLEARANCE_HOLE", pose: pose([24, 14, 2.5]), params: { diameter: 4.5 } },
    ],
    envelope: { volumes: [{ kind: "box", pose: pose([0, 0, 0]), dims: [60, 40, 5] }], clearance: 0.4 },
  },
});

// L-bracket: 30-wide base leg + upright wall, one Ø4.5 hole in the base leg.
const lBracket = partNode({
  id: "l-bracket",
  title: "L-bracket",
  spec:
    "An L-bracket: a base leg p.width × p.depth × p.thickness sitting ON the XY plane (bottom at z=0, so build it as " +
    "Pos(0, 0, p.thickness/2) * Box(...)), plus an upright wall p.width wide, p.thickness thick, p.height tall rising " +
    "from the +Y edge of the base. Drill one Ø p.hole_diameter vertical through-hole in the base leg centered at " +
    "x=0, y = −p.depth/2 + p.hole_inset.",
  params: [
    { name: "width", default: 30 },
    { name: "depth", default: 30 },
    { name: "thickness", default: 4 },
    { name: "height", default: 30 },
    { name: "hole_diameter", default: 4.5 },
    { name: "hole_inset", default: 8 },
  ],
  provides: [],
  requires: [{ key: "base_hole", type: "CLEARANCE_HOLE" }],
  payload: {
    ports: [
      // Mating datum on the BOTTOM face (z out of the mating surface):
      // flip-mating it onto the plate's hole sets the bracket upright on top.
      { name: "base_hole", type: "CLEARANCE_HOLE", pose: pose([0, -7, 0], [0, 0, -1]), params: { diameter: 4.5 } },
    ],
    envelope: {
      volumes: [
        { kind: "box", pose: pose([0, 0, 2]), dims: [30, 30, 4] },
        { kind: "box", pose: pose([0, 13, 15]), dims: [30, 4, 30] },
      ],
      clearance: 0.4,
    },
  },
  deps: ["base-plate"],
});

// M4 SHCS — registry-only; the LLM must never be consulted for this node.
const m4Screw = {
  ...partNode({
    id: "m4-screw",
    title: "M4×12 SHCS",
    spec: "M4 socket head cap screw, 12 mm long, from the fastener registry.",
    kind: "fastener",
    params: [{ name: "length", default: 12 }],
    provides: [],
    requires: [{ key: "head_seat", type: "CLEARANCE_HOLE" }],
    payload: {
      // Annular probe: the seat under the head is an M4 washer face — void at
      // the shank centerline, so the FLAT_FACE check samples a Ø5.5 ring.
      ports: [
        { name: "head_seat", type: "FLAT_FACE", pose: pose([0, 0, 0], [0, 0, -1]), params: { ring_diameter: 5.5 } },
      ],
      // Head z∈[0,4] Ø7, shank z∈[−12,0] Ø4 → cylinder z∈[−12.25, 4.25].
      envelope: { volumes: [{ kind: "cylinder", pose: pose([0, 0, -4]), d: 7.2, h: 16.5 }], clearance: 0.4 },
    },
    deps: ["base-plate"],
  }),
};
m4Screw.contract.params.push({ type: "enum", name: "thread", description: "", default: "M4", options: ["M3", "M4", "M5"] } as never);

const graph = GraphDoc.parse({
  schemaVersion: 1,
  id: "cad-acceptance",
  backend: "cad",
  brief: { goal: "clamp a bracket to a base plate with an M4 screw", constraints: [], clarifications: [] },
  nodes: Object.fromEntries([basePlate, lBracket, m4Screw].map((n) => [n.id, n])),
  edges: [
    { id: "e0", from: "base-plate", fromPort: "front_left_hole", to: "l-bracket", toPort: "base_hole" },
    { id: "e1", from: "base-plate", fromPort: "back_right_hole", to: "m4-screw", toPort: "head_seat" },
  ],
  assembly: { entryNodeId: "base-plate" },
  layout: {},
  rev: 0,
});

async function main() {
  const resolved = await resolveProvider();
  if (!resolved) throw new Error("no LLM provider configured");
  console.log(`provider: ${resolved.provider.id}`);

  const backend = new CadBackend();
  const bus = new EventBus();
  bus.subscribe((e) => {
    if (e.type === "job:log") console.log(`  [${e.nodeId}] ${e.line}`);
  });
  const store = new GraphStore(graph, bus, async () => {});
  const workspace = { root: scratch };

  console.log("\n=== phase 1: cook plate + bracket (LLM) + screw (registry) ===");
  const summary = await cookNodes(
    { store, backend, provider: resolved.provider, workspace },
    ["base-plate", "l-bracket", "m4-screw"],
  );
  for (const n of Object.values(store.doc.nodes)) {
    console.log(
      `  ${n.status.padEnd(12)} ${n.id.padEnd(12)} causes=${JSON.stringify(n.history.map((h) => h.cause))} llm_calls=${n.cost.calls}`,
    );
  }
  const screw = store.doc.nodes["m4-screw"]!;
  if (screw.cost.calls !== 0) throw new Error("FASTENER TOUCHED THE LLM");

  console.log("\n=== phase 2: assembly ===");
  const { world, problems } = backend.solveScene(store.doc);
  console.log("  problems:", problems);
  const bracketOrigin = [world["l-bracket"]![12], world["l-bracket"]![13], world["l-bracket"]![14]];
  console.log("  l-bracket world origin:", bracketOrigin.map((v) => v!.toFixed(2)));
  console.log("  screw world origin:", [world["m4-screw"]![12], world["m4-screw"]![13], world["m4-screw"]![14]].map((v) => v!.toFixed(2)));

  console.log("\n=== phase 3: wrong bore — G3 catch → hint in repair prompt → one-shot fix ===");
  // The mechanism under test is the engine's gate→hint→repair plumbing, so a
  // scripted provider stands in for the (user-parked) generator model: the
  // first attempt drills p.hole_diameter (Ø6) against a contract pinned at
  // Ø4.5; the repair reply is only issued if the G3 measurement actually
  // reached the repair prompt.
  store.applyOp((g) => {
    const n = g.nodes["base-plate"]!;
    n.params = { hole_diameter: 6 };
    n.artifact = null;
    n.version = 0;
    n.history = [];
    n.status = "planned";
    n.cost = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
  });
  let hintSeen = "";
  const scripted: LlmProvider = {
    id: "scripted",
    async complete(req) {
      const zero = { inputTokens: 0, outputTokens: 0, usd: 0 };
      if (req.role === "repair") {
        const last = req.messages[req.messages.length - 1]!.content;
        const match = /expected Ø4\.5, measured Ø6\.0?0?/.exec(last);
        if (!match) throw new Error(`G3 hint missing from repair prompt:\n${last.slice(0, 400)}`);
        hintSeen = match[0];
        const fixed = plateCode().replace("p.hole_diameter / 2", "4.5 / 2");
        return { data: req.schema.parse({ code: fixed, notes: "" }), usage: zero, model: "scripted" };
      }
      return { data: req.schema.parse({ code: plateCode(), notes: "" }), usage: zero, model: "scripted" };
    },
  };
  const summary2 = await cookNodes({ store, backend, provider: scripted, workspace }, ["base-plate"]);
  const plate = store.doc.nodes["base-plate"]!;
  console.log(`  G3 measurement in repair prompt: "${hintSeen}"`);
  console.log(`  result: ${plate.status}, causes=${JSON.stringify(plate.history.map((h) => h.cause))}`);
  if (plate.status !== "ready" || plate.history[0]?.cause !== "repair-2") {
    throw new Error("wrong-bore repair did not complete in one shot");
  }

  console.log(`\ncook summary: phase1 ${summary.succeeded.length} ok/${summary.failed.length} failed; phase3 ${summary2.succeeded.length} ok/${summary2.failed.length} failed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
