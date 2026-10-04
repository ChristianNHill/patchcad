import { describe, expect, it } from "vitest";
import { GraphDoc } from "@patchcad/shared";
import { contractHash, makeArchitectSchema, type ArchitectOutput } from "@patchcad/engine";
import { CadBackend, type CadContractPayload } from "./index.js";
import { resolveHardware } from "./registry.js";

/** hand-winch planned for 262–684s on "gear-drum is gear and declares no
 *  ports" and "no chain of edges connects it". A gear's ports are minted. */

const { planning } = new CadBackend();
const schema = makeArchitectSchema(planning.payloadSchema, planning.nodeKinds.map((k) => k.kind), planning.jointSchema);
const pose = (origin: (number | string)[], zAxis = [0, 0, 1]) => ({ origin, zAxis, xAxis: [1, 0, 0] });
const num = (name: string, d: number) => ({ type: "number", name, description: name, default: d });

const carrier = {
  id: "carrier",
  kind: "part",
  title: "Carrier",
  spec: "A block carrying an 8mm spigot the gear sits on.",
  contract: {
    name: "Carrier",
    summary: "40x40x10 block with an 8mm spigot on top",
    params: [num("width", 40), num("thickness", 10)],
    provides: [{ key: "spigot", type: "SHAFT", description: "gear spigot" }],
    requires: [],
    payload: {
      units: "mm",
      process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
      ports: [{ name: "spigot", type: "SHAFT", pose: pose([0, 0, 5]), params: { diameter: 8, length: 10 } }],
      envelope: { volumes: [{ kind: "box", pose: pose([0, 0, 0]), dims: [40, 40, 10] }, { kind: "cylinder", pose: pose([0, 0, 10]), d: 8, h: 10 }], clearance: 0.4 },
    },
  },
};

const gear = (id: string, ports: unknown[] = []) => ({
  id,
  kind: "gear",
  title: "Pinion",
  spec: "Registry involute spur gear, module 1.5, 15 teeth.",
  contract: {
    name: "Pinion",
    summary: "m1.5 z15 spur gear",
    params: [num("module", 1.5), num("teeth", 15), num("pressure_angle", 20), num("thickness", 10), num("bore", 8)],
    provides: [],
    requires: [],
    payload: {
      units: "mm",
      process: { kind: "FDM", minWall: 1.2, nozzle: 0.4 },
      ports,
      envelope: { volumes: [{ kind: "cylinder", pose: pose([0, 0, 0]), d: 25.5, h: 10 }], clearance: 0.4 },
    },
  },
});

const plan = (nodes: unknown[], edges: { from: string; fromPort: string; to: string; toPort: string }[]) =>
  schema.parse({ rationale: "test", entryNodeId: "carrier", nodes, edges }) as ArchitectOutput;

function toGraph(out: ArchitectOutput): GraphDoc {
  return GraphDoc.parse({
    schemaVersion: 1,
    id: "gears",
    backend: "cad",
    brief: { goal: "", constraints: [], clarifications: [] },
    nodes: Object.fromEntries(
      out.nodes.map((n) => {
        const contract = { ...n.contract, hash: "" };
        contract.hash = contractHash(contract as never);
        return [n.id, { ...n, contract }];
      }),
    ),
    edges: out.edges.map((e, i) => ({ id: `e${i}`, ...e })),
    assembly: { entryNodeId: out.entryNodeId },
    joints: out.joints ?? [],
    rev: 0,
  });
}

const portsOf = (out: ArchitectOutput, id: string) => (out.nodes.find((n) => n.id === id)!.contract.payload as CadContractPayload).ports;

describe("gear ports are minted, not asked for", () => {
  it("mints the HUB_BORE an edge names on a gear that declares none (hand-winch run 1)", () => {
    const out = planning.expandPlan(plan([carrier, gear("pinion")], [{ from: "carrier", fromPort: "spigot", to: "pinion", toPort: "bore" }]));
    const bore = portsOf(out, "pinion").find((p) => p.name === "bore")!;
    expect(bore).toMatchObject({ type: "HUB_BORE", params: { diameter: "param(pinion.bore)" } });
    expect(bore.pose.zAxis).toEqual([0, 0, -1]);
    expect(out.nodes.find((n) => n.id === "pinion")!.contract.requires).toContainEqual(expect.objectContaining({ key: "bore", type: "SHAFT" }));
    const graph = toGraph(out);
    const problems = planning.graphLints.flatMap((l) => l.run(graph));
    expect(problems.filter((p) => p.includes("pinion"))).toEqual([]);
    // The registry cuts that bore, at its own Ø, to the slip band's middle.
    expect(resolveHardware(graph.nodes.pinion!)).toContain('nominal = p.get("bore", p.bore)');
    expect(resolveHardware(graph.nodes.pinion!)).toContain("Cylinder((nominal + 0.15) / 2");
  });

  it("gives a loose gear `bore` and `face`, and the lint names the port to wire", () => {
    const out = planning.expandPlan(plan([carrier, gear("pinion")], []));
    expect(portsOf(out, "pinion").map((p) => `${p.name}:${p.type}`)).toEqual(["bore:HUB_BORE", "face:FLAT_FACE"]);
    const problems = planning.graphLints.flatMap((l) => l.run(toGraph(out)));
    expect(problems.join("\n")).toContain("add an edge from that shaft to pinion.bore");
    expect(problems.join("\n")).not.toContain("declares no ports");
  });

  it("mints the face a joint names, so the joint cuts the only hub, and the plan lints clean", () => {
    const plate = {
      ...carrier,
      id: "plate",
      contract: {
        ...carrier.contract,
        provides: [{ key: "axle_face", type: "FLAT_FACE", description: "" }],
        payload: {
          ...carrier.contract.payload,
          ports: [{ name: "axle_face", type: "FLAT_FACE", pose: pose([0, 0, 10]), params: { ring_diameter: 30 } }],
          envelope: { volumes: [{ kind: "box", pose: pose([0, 0, 0]), dims: [80, 80, 20] }], clearance: 0.4 },
        },
      },
    };
    const draft = schema.parse({
      rationale: "test",
      entryNodeId: "plate",
      nodes: [plate, gear("pinion")],
      edges: [],
      joints: [{ id: "crank", a: { node: "plate", port: "axle_face" }, b: { node: "pinion", port: "face" }, intent: "removable", motion: "revolute", duty: "continuous", load: "light", access: "both_sides", wallA: 20, wallB: 10 }],
    }) as ArchitectOutput;
    const out = planning.expandPlan(draft);
    expect(portsOf(out, "pinion").map((p) => `${p.name}:${p.type}`)).toEqual(["face:FLAT_FACE", "crank_hub:HUB_BORE"]);
    expect(planning.graphLints.flatMap((l) => l.run(toGraph(out)))).toEqual([]);
  });

  it("leaves a gear's own HUB_BORE alone", () => {
    const own = { name: "hub", type: "HUB_BORE", pose: pose([0, 0, -5], [0, 0, -1]), params: { diameter: 8 } };
    const out = planning.expandPlan(plan([carrier, { ...gear("pinion", [own]), contract: { ...gear("pinion", [own]).contract, requires: [{ key: "hub", type: "SHAFT", description: "" }] } }], [{ from: "carrier", fromPort: "spigot", to: "pinion", toPort: "hub" }]));
    expect(portsOf(out, "pinion").filter((p) => p.type === "HUB_BORE").map((p) => p.name)).toEqual(["hub"]);
  });

  it("does not echo minted ports into the draft", () => {
    const draft = plan([carrier, gear("pinion")], []);
    planning.expandPlan(draft);
    expect(portsOf(draft, "pinion")).toEqual([]);
  });
});
