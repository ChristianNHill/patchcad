/** Mirrors `@patchcad/backend-cad` ordering.ts `OrderLink`; the studio does not import the backend. */
export type OrderLink =
  | { vendor: string; url: string; kind: "verified"; pn: string; verifiedAt: string }
  | { vendor: string; url: string; kind: "search" };

/** A verified link names its part number; a search link says it is a search,
 *  so nobody mistakes it for a specific product. */
export function orderLinkText(link: OrderLink): string {
  return link.kind === "verified" ? `${link.vendor} ${link.pn}` : `Search ${link.vendor}`;
}

export function orderLinkTitle(link: OrderLink): string {
  return link.kind === "verified"
    ? `part number checked by a person on ${link.verifiedAt}`
    : `searches ${link.vendor} for the designation; not a specific product`;
}

/**
 * Which catalog part the viewport labels: the one under the pointer, else
 * the selected one. Only parts the scene gave a designation (bought catalog
 * hardware) get a label.
 */
export function viewportLabel(
  hovered: string | null,
  selected: string | null,
  designations: Record<string, string | undefined>,
): { nodeId: string; text: string } | null {
  for (const id of [hovered, selected]) {
    const text = id ? designations[id] : undefined;
    if (id && text) return { nodeId: id, text };
  }
  return null;
}
