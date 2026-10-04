/**
 * A registry gear's mate ports, minted the way joint hardware's are, so a
 * gear never sits in a plan with no ports. hand-winch spent 262–684s planning
 * because its gears declared none: "gear-drum is gear and declares no ports,
 * so "bore" cannot exist", then "no chain of edges connects it", round after
 * round, for geometry the registry fixes anyway.
 *
 * Both run on every expansion of the architect's own draft, so they are
 * stateless: the draft never carries what they add.
 *  - before the joints: every port an edge or a joint names on a gear and the
 *    gear does not declare. An edge from a shaft, spigot or hub gets a
 *    HUB_BORE; a joint's port and a face-to-face edge get a FLAT_FACE (the
 *    joint mints its own HUB_BORE there).
 *  - after the joints: `bore` (HUB_BORE, when bore > 0) and `face`
 *    (FLAT_FACE) if the gear still has none of that type.
 * All on the gear's -z face, outward normal, the side its shaft enters: the
 * gear is centred on its origin (gearCode), so that face is at -thickness/2.
 */
import type { ArchitectOutput } from "@patchcad/engine";
import type { CadContractPayload } from "./index.js";

type OutNode = ArchitectOutput["nodes"][number];
type Port = CadContractPayload["ports"][number];

/** Partner port types that put a gear on an axis, not against a face. */
const AXIAL = new Set(["SHAFT", "HUB_BORE", "BORE"]);

const payloadOf = (n: OutNode) => n.contract.payload as CadContractPayload;

function gearPort(gear: OutNode, name: string, type: "HUB_BORE" | "FLAT_FACE"): Port {
  const has = (p: string) => gear.contract.params.some((x) => x.name === p);
  const t = has("thickness") ? `param(${gear.id}.thickness)` : "0";
  const bore = has("bore") ? `param(${gear.id}.bore)` : "0";
  return {
    name,
    type,
    pose: { origin: [0, 0, `-${t} / 2`], zAxis: [0, 0, -1], xAxis: [1, 0, 0] },
    params: type === "HUB_BORE" ? { diameter: bore, depth: t } : { ring_diameter: `${bore} + 2.4` },
  } as Port;
}

function put(gear: OutNode, port: Port, side: "provides" | "requires", decl: string = port.type) {
  payloadOf(gear).ports.push(port);
  const declared = [...gear.contract.provides, ...gear.contract.requires].some((p) => p.key === port.name);
  if (!declared) gear.contract[side].push({ key: port.name, type: decl, description: "minted gear port" });
}

const gearsOf = (out: ArchitectOutput) => out.nodes.filter((n) => n.kind === "gear" && n.contract.payload);

/** Every port an edge or joint names on a gear that it does not declare. */
export function mintNamedGearPorts(input: ArchitectOutput): ArchitectOutput {
  const gears = gearsOf(input);
  if (!gears.length) return input;
  const out = structuredClone(input) as ArchitectOutput;
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  for (const gear of gearsOf(out)) {
    const named = (name: string) => payloadOf(gear).ports.some((p) => p.name === name);
    for (const e of out.edges) {
      for (const [self, selfPort, other, otherPort, side] of [
        [e.to, e.toPort, e.from, e.fromPort, "requires"],
        [e.from, e.fromPort, e.to, e.toPort, "provides"],
      ] as const) {
        if (self !== gear.id || named(selfPort)) continue;
        const partner = byId.get(other);
        const pType = partner && (partner.contract.payload as CadContractPayload | undefined)?.ports?.find((p) => p.name === otherPort)?.type;
        const pDecl = partner && [...partner.contract.provides, ...partner.contract.requires].find((p) => p.key === otherPort)?.type;
        const axial = AXIAL.has(pType ?? "") || AXIAL.has(pDecl ?? "");
        const hasHub = payloadOf(gear).ports.some((p) => p.type === "HUB_BORE");
        // The genericLints type check compares DECLARED types across the edge.
        put(gear, gearPort(gear, selfPort, axial && !hasHub ? "HUB_BORE" : "FLAT_FACE"), side, pDecl ?? (axial ? "HUB_BORE" : "FLAT_FACE"));
      }
    }
    for (const j of out.joints ?? []) {
      for (const end of [j.a, j.b]) {
        if (end.node === gear.id && !named(end.port)) put(gear, gearPort(gear, end.port, "FLAT_FACE"), "requires");
      }
    }
  }
  return out;
}

/** `bore` and `face` on a gear that has no port of that type once joints are expanded. */
export function mintDefaultGearPorts(input: ArchitectOutput): ArchitectOutput {
  if (!gearsOf(input).length) return input;
  const out = structuredClone(input) as ArchitectOutput;
  for (const gear of gearsOf(out)) {
    const ports = payloadOf(gear).ports;
    const free = (name: string) => !ports.some((p) => p.name === name) && ![...gear.contract.provides, ...gear.contract.requires].some((p) => p.key === name);
    const bore = gear.contract.params.find((p) => p.name === "bore")?.default;
    if (!ports.some((p) => p.type === "HUB_BORE") && typeof bore === "number" && bore > 0 && free("bore")) put(gear, gearPort(gear, "bore", "HUB_BORE"), "requires");
    if (!ports.some((p) => p.type === "FLAT_FACE") && free("face")) put(gear, gearPort(gear, "face", "FLAT_FACE"), "requires");
  }
  return out;
}

/** The HUB_BORE a gear carries, for the lint that tells the architect what to wire. */
export function gearHubName(n: { contract: { payload?: unknown } }): string | undefined {
  return (n.contract.payload as CadContractPayload | undefined)?.ports?.find((p) => p.type === "HUB_BORE")?.name;
}
