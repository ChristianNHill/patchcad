import type { GraphDoc } from "@patchcad/shared";
import type { CheckAdvisory } from "@patchcad/engine";
import type { SilhouetteView } from "./kernel.js";

/**
 * G6 image grounding (Phase 6.5): the posed assembly's silhouette against the
 * user's reference, per labelled view.
 *
 * ADVISORY, not blocking. There is no calibration data yet for what IoU a
 * correct printable assembly reaches against a hand-held photo — perspective,
 * a background-removal halo, or a plausible simplification of a sculpted shape
 * can all cost tenths of IoU on a part that is right. Until real projects say
 * where that line sits, a low score is reported for the user to judge and
 * never moves a node to error.
 */
export const SILHOUETTE_MIN_IOU = 0.8;

/** A part shares the blame when it accounts for at least this fraction of the
 *  worst part's disagreement. */
const BLAME_SHARE = 0.5;

export function silhouetteAdvisories(graph: GraphDoc, views: SilhouetteView[]): CheckAdvisory[] {
  const out: CheckAdvisory[] = [];
  for (const v of views) {
    if (v.iou >= SILHOUETTE_MIN_IOU) continue;
    // Placed copies (node#i) are one node's geometry: sum them.
    const score = new Map<string, number>();
    for (const p of v.parts) {
      const id = p.key.split("#")[0]!;
      score.set(id, (score.get(id) ?? 0) + p.excess_px + p.missing_px);
    }
    const ranked = [...score].sort((a, b) => b[1] - a[1]);
    const worst = ranked[0]?.[1] ?? 0;
    const nodes = ranked.filter(([, s]) => s > 0 && s >= worst * BLAME_SHARE).slice(0, 3).map(([id]) => id);
    const names = nodes.map((id) => graph.nodes[id]?.title ?? id).join(", ");
    out.push({
      kind: "silhouette",
      nodes,
      measured: v.iou,
      expected: SILHOUETTE_MIN_IOU,
      view: v.view,
      ref: v.ref,
      message:
        `silhouette IoU ${v.iou.toFixed(2)} < ${SILHOUETTE_MIN_IOU} in ${v.view} view against the reference image` +
        (names ? `; the outline differs most around ${names}` : "") +
        " (advisory: not blocking until the threshold is calibrated)",
    });
  }
  return out;
}
