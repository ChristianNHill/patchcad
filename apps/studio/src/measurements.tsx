import { useEffect, useState } from "react";
import { hashValue, type NodeRecord } from "@patchcad/shared";

/**
 * What the gates measured on the last passing verify. The failing numbers have
 * always reached the user (as an error), while the passing ones were computed,
 * cached kernel-side and dropped — so a part that met its contract said so only
 * by turning green. This shows the actual bore, the actual size, the actual
 * envelope result.
 */

interface PortMeasurement {
  key: string;
  type: string;
  measured_diameter?: number;
  probed_size?: number;
  ring_diameter?: number;
  ring_hits?: number;
  measured_pilot?: number;
  skipped?: string;
}

interface Measured {
  volume_mm3?: number;
  area_mm2?: number;
  solids?: number;
  bbox?: { min: number[]; max: number[]; size: number[] };
  ports?: PortMeasurement[];
  envelope?: { vertices_checked: number; violations: number };
}

const mm = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, ""));

/** One line per port, in whatever terms that port type was actually probed in. */
function portLine(p: PortMeasurement): string {
  if (p.skipped) return "no probe for this type yet";
  if (p.measured_diameter !== undefined) return `Ø${mm(p.measured_diameter)} mm`;
  if (p.ring_diameter !== undefined) return `ring Ø${mm(p.ring_diameter)} mm`;
  if (p.probed_size !== undefined) {
    return p.probed_size > 0 ? `${mm(p.probed_size)} mm flat` : "flat (center probe)";
  }
  const boss = [
    p.ring_hits !== undefined ? `${p.ring_hits} wall hits` : "",
    p.measured_pilot !== undefined ? `pilot Ø${mm(p.measured_pilot)} mm` : "",
  ].filter(Boolean);
  return boss.length > 0 ? boss.join(" · ") : "verified";
}

export function MeasurementsSection({ node }: { node: NodeRecord }) {
  const m = node.measurements;
  if (!m) return null;
  const data = m.data as Measured | null;
  if (!data) return null;

  // A T0 slider re-executes the part but does not re-probe it, so these
  // numbers can describe a shape that is no longer on screen. Say so rather
  // than letting a stale bore read as current.
  const stale = hashValue(node.params) !== m.paramsHash;
  const size = data.bbox?.size;

  return (
    <div className="section">
      <span className="section__label">Measured</span>
      <div className="measure">
        {size && (
          <div className="measure__row">
            <span className="measure__key">size</span>
            <span className="measure__val">
              {size.map((s) => mm(s)).join(" × ")} mm
            </span>
          </div>
        )}
        {data.volume_mm3 !== undefined && (
          <div className="measure__row">
            <span className="measure__key">volume</span>
            <span className="measure__val">{data.volume_mm3.toFixed(0)} mm³</span>
          </div>
        )}
        {(data.solids ?? 1) > 1 && (
          <div className="measure__row">
            <span className="measure__key">solids</span>
            <span className="measure__val">{data.solids}</span>
          </div>
        )}
        {data.ports?.map((p) => (
          <div key={p.key} className="measure__row" title={`${p.key} (${p.type})`}>
            <span className="measure__key">{p.key}</span>
            <span className="measure__val">{portLine(p)}</span>
          </div>
        ))}
        {data.envelope && (
          <div className="measure__row">
            <span className="measure__key">envelope</span>
            <span className="measure__val">
              {data.envelope.vertices_checked} pts inside
            </span>
          </div>
        )}
      </div>
      <div className="measure__note">
        {stale
          ? `probed at v${m.version}; params have changed since — re-cook to re-measure`
          : `probed at v${m.version}`}
      </div>
    </div>
  );
}

/**
 * Six views of the part, rendered by the kernel. The gates prove dimensions;
 * only a picture shows that a part is the wrong SHAPE — the failure class no
 * probe can see. Loaded on demand, because rendering costs real time and most
 * of the time you are looking at the code, not the object.
 */
export function RenderSheet({ nodeId, cooked }: { nodeId: string; cooked: boolean }) {
  const [state, setState] = useState<{ url?: string; error?: string; loading?: boolean }>({});

  // A new node, or a re-cook, invalidates whatever is on screen.
  useEffect(() => setState({}), [nodeId, cooked]);

  if (!cooked) return null;

  const load = async () => {
    setState({ loading: true });
    try {
      const res = await fetch(`/api/project/nodes/${nodeId}/sheet`);
      const body = (await res.json()) as { url?: string; error?: string };
      setState(res.ok && body.url ? { url: body.url } : { error: body.error ?? "render failed" });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  };

  return (
    <div className="section">
      <span className="section__label">Views</span>
      {state.url ? (
        <img className="sheet" src={state.url} alt={`${nodeId} rendered from six angles`} />
      ) : (
        <button className="btn btn--quiet btn--tiny" onClick={() => void load()} disabled={state.loading}>
          {state.loading ? "rendering…" : "render six views"}
        </button>
      )}
      {state.error && <div className="measure__note">{state.error}</div>}
    </div>
  );
}
