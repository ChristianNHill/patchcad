import { describe, expect, it } from "vitest";
import { hashValue } from "@patchcad/shared";
import { CadContractPayload } from "./index.js";

/** visualChecks joined the pinned payload after contracts were already hashed
 *  into the node library. Absent must hash exactly as before the field existed,
 *  or every library entry and every ready node silently goes stale. */
describe("visualChecks keeps contract hashes stable", () => {
  const raw = {
    units: "mm",
    process: { kind: "FDM" },
    ports: [{ name: "bolt", type: "CLEARANCE_HOLE", pose: { origin: [0, 0, 2], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, params: { diameter: 4.5 } }],
    envelope: { volumes: [{ kind: "box", pose: { origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] }, dims: [40, 20, 4] }] },
  };

  it("an absent field hashes as if the field did not exist", () => {
    const parsed = CadContractPayload.parse(raw);
    expect("visualChecks" in parsed).toBe(false);
    expect(hashValue(parsed)).toBe(hashValue(CadContractPayload.omit({ visualChecks: true }).parse(raw)));
  });

  it("present questions are part of the pinned contract", () => {
    const parsed = CadContractPayload.parse({ ...raw, visualChecks: ["Is the slot on the top face?"] });
    expect(parsed.visualChecks).toEqual(["Is the slot on the top face?"]);
    expect(hashValue(parsed)).not.toBe(hashValue(CadContractPayload.parse(raw)));
  });
});
