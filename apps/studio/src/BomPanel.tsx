import { useEffect, useState, type ReactNode } from "react";
import type { NodeRecord } from "@patchcad/shared";
import { API } from "./api.js";
import { BusyButton } from "./BusyButton.js";
import { download } from "./download.js";
import { Modal } from "./Modal.js";
import { orderLinkText, orderLinkTitle, type OrderLink } from "./order-links.js";
import { useStudio } from "./store.js";

/** Mirrors `@patchcad/backend-cad` bom.ts `Bom`; the studio does not import the backend. */
interface Bom {
  buy: { sku: string; description: string; standard: string; designation: string; qty: number; orderFrom: OrderLink[] }[];
  print: { nodeId: string; title: string; qty: number; material: string; volumeMm3: number | null; massG: number | null; filamentM: number | null }[];
  fabricate: {
    nodeId: string;
    title: string;
    qty: number;
    process: string;
    material: string;
    finish: string | null;
    massG: number | null;
    ready: boolean;
    vendorPackage: string | null;
  }[];
  notGenerated: { nodeId: string; title: string; class: string; status: string }[];
  unverified: { nodeId: string; title: string; class: string; process: string; failedStage: string }[];
}

/** Same rule as backend-cad `sourcingOf` for the one class the canvas flags:
 *  explicit fabricate sourcing, or a part machined per process.kind. */
export function isFabricate(node: NodeRecord): boolean {
  const payload = node.contract.payload as { sourcing?: { class?: string }; process?: { kind?: string } } | undefined;
  return payload?.sourcing ? payload.sourcing.class === "fabricate" : payload?.process?.kind === "CNC";
}

export function VendorBadge() {
  return (
    <span className="vendor-badge" title="custom part: generated, gated, and packaged for a vendor (STEP, DXF, drawing, RFQ)">
      custom — send to vendor
    </span>
  );
}

const num = (v: number | null, unit: string) => (v === null ? "—" : `${v} ${unit}`);

export function BomButton() {
  const [open, setOpen] = useState(false);
  const backend = useStudio((s) => s.graph?.backend);
  if (backend !== "cad") return null;
  return (
    <>
      <button className="btn btn--quiet" onClick={() => setOpen(true)} aria-haspopup="dialog">
        BOM
      </button>
      {open && <BomPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function BomPanel({ onClose }: { onClose: () => void }) {
  const [bom, setBom] = useState<Bom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rev = useStudio((s) => s.graph?.rev);

  useEffect(() => {
    let live = true;
    fetch(`${API}/api/project/bom`)
      .then(async (r) => {
        const body = (await r.json()) as Bom & { error?: string };
        if (!live) return;
        if (!r.ok) return setError(body.error ?? `HTTP ${r.status}`);
        setBom(body);
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [rev]);

  const save = async (path: string, fallbackName: string) => setError(await download(path, fallbackName));

  return (
    <Modal label="bill of materials" onClose={onClose}>
      <div className="modal__head">
        <h2 className="modal__title">Bill of materials</h2>
        <span className="modal__actions">
          <BusyButton onClick={() => save("/api/project/bom?format=csv", "bom.csv")} busyLabel="CSV…">
            CSV
          </BusyButton>
          <button className="btn btn--quiet btn--tiny" onClick={onClose}>
            close
          </button>
        </span>
      </div>
      {error && <p className="modal__error">{error}</p>}
      {bom && (
        <div className="bom">
          <BomSection title="Buy" empty="no catalog hardware">
            {bom.buy.map((r) => (
              <tr key={r.sku}>
                <td className="bom__mono">{r.sku}</td>
                <td>
                  {r.designation}
                  <div className="bom__sub">{r.standard}</div>
                </td>
                <td className="bom__num">×{r.qty}</td>
                <td className="bom__sub">
                  <ul className="bom__order" aria-label={`where to order ${r.designation}`}>
                    {r.orderFrom.map((o) => (
                      <li key={`${o.kind}:${o.vendor}`}>
                        <a href={o.url} target="_blank" rel="noreferrer" title={orderLinkTitle(o)}>
                          {orderLinkText(o)}
                        </a>
                        {o.kind === "verified" && <span className="bom__verified">verified {o.verifiedAt}</span>}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </BomSection>
          <BomSection title="Print" empty="no printed parts">
            {bom.print.map((r) => (
              <tr key={r.nodeId}>
                <td className="bom__mono">{r.nodeId}</td>
                <td>
                  {r.title}
                  <div className="bom__sub">{r.material}</div>
                </td>
                <td className="bom__num">×{r.qty}</td>
                <td className="bom__sub">
                  {num(r.volumeMm3, "mm³")} · {num(r.massG, "g")} · ≤{num(r.filamentM, "m")} filament
                </td>
              </tr>
            ))}
          </BomSection>
          <BomSection title="Fabricate" empty="no custom parts">
            {bom.fabricate.map((r) => (
              <tr key={r.nodeId}>
                <td className="bom__mono">{r.nodeId}</td>
                <td>
                  {r.title} <VendorBadge />
                  <div className="bom__sub">
                    {r.process} · {r.material}
                    {r.finish ? ` · ${r.finish}` : ""} · {num(r.massG, "g")}
                  </div>
                </td>
                <td className="bom__num">×{r.qty}</td>
                <td>
                  {r.vendorPackage ? (
                    <BusyButton
                      onClick={() => save(r.vendorPackage!, `${r.nodeId}-vendor.zip`)}
                      busyLabel="packaging…"
                    >
                      vendor package
                    </BusyButton>
                  ) : (
                    <span className="bom__sub">gates not passed yet</span>
                  )}
                </td>
              </tr>
            ))}
          </BomSection>
          {bom.unverified.length > 0 && (
            <BomSection title="Unverified" empty="">
              {bom.unverified.map((r) => (
                <tr key={r.nodeId}>
                  <td className="bom__mono">{r.nodeId}</td>
                  <td>{r.title}</td>
                  <td />
                  <td className="bom__sub">
                    {r.class} · unverified candidate — failed {r.failedStage}; the gates rejected it, so do not order it
                  </td>
                </tr>
              ))}
            </BomSection>
          )}
          {bom.notGenerated.length > 0 && (
            <BomSection title="Not generated" empty="">
              {bom.notGenerated.map((r) => (
                <tr key={r.nodeId}>
                  <td className="bom__mono">{r.nodeId}</td>
                  <td>{r.title}</td>
                  <td />
                  <td className="bom__sub">
                    {r.class} · {r.status} — no geometry, so nothing to order
                  </td>
                </tr>
              ))}
            </BomSection>
          )}
        </div>
      )}
    </Modal>
  );
}

function BomSection({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <section className="bom__section">
      <h3 className="bom__title">{title}</h3>
      {children.length === 0 ? (
        <p className="bom__sub">{empty}</p>
      ) : (
        <table className="bom__table">
          <tbody>{children}</tbody>
        </table>
      )}
    </section>
  );
}
