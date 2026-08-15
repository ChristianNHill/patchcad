import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { GraphDoc } from "@patchcad/shared";
import { lBracketCode, plateCode, shcsCode } from "@patchcad/backend-cad";

/**
 * Dev script: (re)generate examples/cad-clamp — the hand-authored CAD
 * reference project (plate + L-bracket + M4 screw, all code from the
 * deterministic registry factories). The bracket's hole diameter is BOUND to
 * the plate's (T1): slide the plate's hole and the bracket re-resolves and
 * re-executes with zero LLM calls.
 *
 *   pnpm exec tsx src/seed-cad-example.ts
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "..", "..", "..", "examples", "cad-clamp");

const payloadBase = {
  units: "mm",
  process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
  paramBindings: {},
};
const pose = (origin: (number | string)[], zAxis: (number | string)[] = [0, 0, 1], xAxis: (number | string)[] = [1, 0, 0]) => ({ origin, zAxis, xAxis });

const num = (name: string, def: number) => ({ type: "number", name, description: "", default: def, min: def / 2, max: def * 2 });

function node(partial: Record<string, unknown>) {
  return {
    pinned: true,
    params: {},
    deps: [],
    artifact: null,
    thread: [],
    status: "ready",
    version: 1,
    history: [{ version: 1, contractHash: "", artifactHash: "", cause: "handwritten", at: 1755200000000 }],
    cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
    ...partial,
  };
}

const nodes = {
  "base-plate": node({
    id: "base-plate",
    kind: "part",
    title: "Base plate",
    spec: "Rectangular mounting plate with four corner clearance holes.",
    contract: {
      name: "Base plate",
      summary: "60×40×5 plate, Ø4.5 corner holes inset 6 mm.",
      params: [num("width", 60), num("depth", 40), num("thickness", 5), num("hole_diameter", 4.5), num("hole_inset", 6)],
      provides: [
        { key: "front_left_hole", type: "CLEARANCE_HOLE", description: "" },
        { key: "back_right_hole", type: "CLEARANCE_HOLE", description: "" },
      ],
      requires: [],
      payload: {
        ...payloadBase,
        // Parametric geometry declarations: poses/dims are T1 expressions, so
        // thickening the plate MOVES its hole ports to the new top face and
        // grows the envelope — probes and assembly always match the sliders.
        ports: [
          {
            name: "front_left_hole",
            type: "CLEARANCE_HOLE",
            pose: pose(
              [
                "-(param(base-plate.width) / 2 - param(base-plate.hole_inset))",
                "-(param(base-plate.depth) / 2 - param(base-plate.hole_inset))",
                "param(base-plate.thickness) / 2",
              ],
            ),
            params: { diameter: "param(base-plate.hole_diameter)" },
          },
          {
            name: "back_right_hole",
            type: "CLEARANCE_HOLE",
            pose: pose(
              [
                "param(base-plate.width) / 2 - param(base-plate.hole_inset)",
                "param(base-plate.depth) / 2 - param(base-plate.hole_inset)",
                "param(base-plate.thickness) / 2",
              ],
            ),
            params: { diameter: "param(base-plate.hole_diameter)" },
          },
        ],
        envelope: {
          volumes: [
            {
              kind: "box",
              pose: pose([0, 0, 0]),
              dims: ["param(base-plate.width)", "param(base-plate.depth)", "param(base-plate.thickness)"],
            },
          ],
          clearance: 0.4,
        },
      },
      hash: "",
    },
  }),
  "l-bracket": node({
    id: "l-bracket",
    kind: "part",
    title: "L-bracket",
    spec: "L-bracket bolted to the plate through its base leg.",
    contract: {
      name: "L-bracket",
      summary: "30 mm L-bracket; base hole tracks the plate's hole diameter (T1 binding).",
      params: [num("width", 30), num("depth", 30), num("thickness", 4), num("height", 30), num("hole_diameter", 4.5), num("hole_inset", 8)],
      provides: [],
      requires: [{ key: "base_hole", type: "CLEARANCE_HOLE", description: "" }],
      payload: {
        ...payloadBase,
        paramBindings: { hole_diameter: "param:base-plate.hole_diameter" },
        ports: [
          {
            name: "base_hole",
            type: "CLEARANCE_HOLE",
            pose: pose(
              [0, "-(param(l-bracket.depth) / 2) + param(l-bracket.hole_inset)", 0],
              [0, 0, -1],
            ),
            params: { diameter: "param(l-bracket.hole_diameter)" },
          },
        ],
        envelope: {
          volumes: [
            {
              kind: "box",
              pose: pose([0, 0, "param(l-bracket.thickness) / 2"]),
              dims: ["param(l-bracket.width)", "param(l-bracket.depth)", "param(l-bracket.thickness)"],
            },
            {
              kind: "box",
              pose: pose([
                0,
                "param(l-bracket.depth) / 2 - param(l-bracket.thickness) / 2",
                "param(l-bracket.height) / 2",
              ]),
              dims: ["param(l-bracket.width)", "param(l-bracket.thickness)", "param(l-bracket.height)"],
            },
          ],
          clearance: 0.4,
        },
      },
      hash: "",
    },
    deps: ["base-plate"],
  }),
  "m4-screw": node({
    id: "m4-screw",
    kind: "fastener",
    title: "M4×12 SHCS",
    spec: "M4 socket head cap screw from the fastener registry.",
    contract: {
      name: "M4×12 SHCS",
      summary:
        "Registry fastener — never generated. Its thread follows the plate's hole and its length follows the clamped stack (T1 bindings).",
      params: [
        num("length", 12),
        { type: "enum", name: "thread", description: "", default: "M4", options: ["M3", "M4", "M5"] },
      ],
      provides: [],
      requires: [{ key: "head_seat", type: "CLEARANCE_HOLE", description: "" }],
      payload: {
        ...payloadBase,
        // The engineering knowledge: drill a bigger hole → the screw steps up
        // a thread size; thicken either part → the screw lengthens to the
        // next standard size (stack + 4 mm engagement). All zero-LLM.
        paramBindings: {
          thread: "threadForHole:param:base-plate.hole_diameter",
          length: "screwLength: param(base-plate.thickness) + param(l-bracket.thickness) + 4",
        },
        ports: [{ name: "head_seat", type: "FLAT_FACE", pose: pose([0, 0, 0], [0, 0, -1]), params: { ring_diameter: 5.5 } }],
        envelope: {
          volumes: [
            {
              kind: "cylinder",
              pose: pose([0, 0, "(5 - param(m4-screw.length)) / 2"]),
              d: 9,
              h: "param(m4-screw.length) + 11",
            },
          ],
          clearance: 0.4,
        },
      },
      hash: "",
    },
    deps: ["base-plate"],
  }),
};

const graph = GraphDoc.parse({
  schemaVersion: 1,
  id: "cad-clamp",
  backend: "cad",
  brief: { goal: "clamp an L-bracket to a base plate with an M4 screw", constraints: [], clarifications: [] },
  nodes,
  edges: [
    { id: "e0", from: "base-plate", fromPort: "front_left_hole", to: "l-bracket", toPort: "base_hole" },
    { id: "e1", from: "base-plate", fromPort: "back_right_hole", to: "m4-screw", toPort: "head_seat" },
  ],
  assembly: { entryNodeId: "base-plate" },
  layout: {},
  rev: 0,
});

async function main() {
  const code: Record<string, string> = {
    "base-plate": plateCode(),
    "l-bracket": lBracketCode(),
    "m4-screw": shcsCode("M4"),
  };
  for (const [id, body] of Object.entries(code)) {
    const nodeDir = path.join(dir, "nodes", id);
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, "v1.code.py"), body, "utf8");
  }
  await writeFile(path.join(dir, "patchcad.json"), JSON.stringify(graph, null, 2), "utf8");
  console.log(`seeded ${dir} (${Object.keys(graph.nodes).length} nodes, backend=cad)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
