import { z } from "zod";
import type { ArchitectOutput } from "@patchcad/engine";
import type { GraphDoc, NodeRecord } from "@patchcad/shared";
import type { CadContractPayload } from "./index.js";
import { REGISTRY_HARDWARE } from "./registry.js";

/**
 * Where a part comes from. Every part in an assembly is one of three:
 *
 *  - buy: a catalog part with a real spec, built by registry codegen.
 *  - print: generated, FDM — the default for everything else.
 *  - fabricate: generated, then sent to a vendor: metal for load, wear or
 *    heat, fits tighter than FDM holds, a shaft with a flat, a sheet-metal
 *    bracket. Its process picks the DFM rules G4c holds it to, and its gates
 *    must pass before its vendor package exists.
 *
 * Optional on the payload with no default, so a contract without it hashes
 * as before; `sourcingOf` supplies the default.
 */
export const SOURCING_CLASSES = ["buy", "print", "fabricate"] as const;
export const PROCESSES = ["fdm", "cnc", "sheet_metal", "laser_cut", "sls", "mjf", "resin"] as const;
export type Process = (typeof PROCESSES)[number];

export const Sourcing = z
  .object({
    class: z.enum(SOURCING_CLASSES),
    process: z.enum(PROCESSES).optional(),
    material: z.string().optional().describe('e.g. "6061-T6 aluminium", "304 stainless", "PA12"'),
    finish: z.string().optional().describe('e.g. "anodised black", "bead blast", "as machined"'),
    qty: z.number().int().positive().optional(),
    /** cnc: the smallest end-mill radius the shop should need. Default 1.5. */
    toolRadius: z.number().positive().optional(),
    /** cnc: the part is machined in more than one setup, so faces hidden from ±Z are allowed. */
    allowUndercuts: z.boolean().optional(),
  })
  .describe("How the part is made. Omit for a printed part or catalog hardware; fabricate needs process + material.");
export type Sourcing = z.infer<typeof Sourcing>;

type SourcedNode = Pick<NodeRecord, "kind" | "contract">;

/** The node's sourcing with defaults filled: catalog kinds are bought,
 *  `process.kind: "CNC"` is a machined part, everything else prints FDM. */
export function sourcingOf(node: SourcedNode): Sourcing {
  const payload = node.contract.payload as Partial<CadContractPayload> | undefined;
  const s = payload?.sourcing;
  if (s) return s.class === "print" && !s.process ? { ...s, process: "fdm" } : s;
  if (REGISTRY_HARDWARE.has(node.kind)) return { class: "buy" };
  if (payload?.process?.kind === "CNC") return { class: "fabricate", process: "cnc" };
  return { class: "print", process: "fdm" };
}

/** Processes held to the machined G3 fit bands (gates.py MACHINED); every
 *  other process prints to the FDM bands. */
export function isMachined(process: string | undefined): boolean {
  return process === "cnc" || process === "sheet_metal" || process === "laser_cut";
}

/** True when FDM allowances (slip-fit oversize, nut-trap AF growth) apply. */
export function isFdmPart(node: SourcedNode): boolean {
  const s = sourcingOf(node);
  return s.class === "print" && s.process === "fdm";
}

/** Processes a vendor makes that G4c has rules for. */
export function isVendorProcess(s: Sourcing): boolean {
  return s.class !== "buy" && s.process !== undefined && s.process !== "fdm";
}

/**
 * Plan expansion: a cnc part with a feature port that does not open along ±Z
 * (the motor holes on the upright of an L, a cross hole in a shaft) cannot be
 * reached by a 3-axis mill in one setup. That is a property of the contract
 * the generator can never repair, and G4c's undercut rule would burn the whole
 * budget proving it, so the setup count is decided here, deterministically.
 * FLAT_FACE ports are stock faces, not machined features, and never count. An
 * explicit `allowUndercuts: false` is the architect's call and stays.
 */
export function markCncSetups<T extends ArchitectOutput>(out: T): T {
  for (const n of out.nodes) {
    const payload = n.contract.payload as Partial<CadContractPayload> | undefined;
    const s = payload?.sourcing;
    if (!s || s.class !== "fabricate" || s.process !== "cnc" || s.allowUndercuts !== undefined) continue;
    const sideways = (payload.ports ?? []).some((p) => {
      if (p.type === "FLAT_FACE") return false;
      const z = p.pose.zAxis.map(Number);
      if (z.some(Number.isNaN)) return false;
      const len = Math.hypot(...z);
      return len > 0 && Math.abs(z[2]!) / len < 0.999;
    });
    if (sideways) s.allowUndercuts = true;
  }
  return out;
}

/**
 * Plan-time: a fabricate part names its process and material (a vendor cannot
 * quote "metal"), buy is only for catalog kinds (anything else would be a line
 * item without geometry), and `process.kind` agrees with the sourcing, since
 * the T1 fit bindings read it.
 */
export const cadSourcingLint = {
  run(graph: GraphDoc): string[] {
    const problems: string[] = [];
    for (const n of Object.values(graph.nodes)) {
      const payload = n.contract.payload as Partial<CadContractPayload> | undefined;
      const s = payload?.sourcing;
      const kind = payload?.process?.kind;
      if (!s) {
        if (kind === "CNC") {
          problems.push(
            `${n.id}: process.kind is CNC, which makes it a fabricated part — add payload.sourcing {"class": "fabricate", "process": "cnc", "material": "<alloy>"}.`,
          );
        }
        continue;
      }
      if (s.class === "fabricate") {
        const missing = [!s.process && "process", !s.material?.trim() && "material"].filter(Boolean);
        if (missing.length) {
          problems.push(
            `${n.id}: sourcing class "fabricate" needs ${missing.join(" and ")} — a vendor quotes a named process (${PROCESSES.filter((p) => p !== "fdm").join(", ")}) in a named material, e.g. {"class": "fabricate", "process": "cnc", "material": "6061-T6 aluminium"}.`,
          );
        }
        if (s.process === "fdm") {
          problems.push(`${n.id}: a fabricate part printed FDM is a print part — use {"class": "print"} or name the vendor process.`);
        }
      }
      if (s.class === "buy" && !REGISTRY_HARDWARE.has(n.kind)) {
        problems.push(
          `${n.id}: sourcing "buy" is only for catalog hardware (kinds ${[...REGISTRY_HARDWARE].join(", ")}), which the registry builds from its standard. A ${n.kind} is generated: class it print or fabricate.`,
        );
      }
      if (s.class !== "buy" && s.process && (kind === "CNC") !== (s.process === "cnc")) {
        problems.push(
          `${n.id}: process.kind "${kind}" disagrees with sourcing.process "${s.process}" — set process.kind "CNC" exactly when the part is machined (sourcing.process "cnc"), "FDM" otherwise.`,
        );
      }
    }
    return problems;
  },
};
