import type { Contract, GraphDoc } from "@patchcad/shared";
import { hashValue } from "@patchcad/shared";

/**
 * Contract diffing distinguishes VALUE changes (defaults, summaries,
 * descriptions — nothing a neighbor's code depends on) from SHAPE changes
 * (ports/params added, removed, or retyped — the interface itself moved).
 * Only shape changes dirty descendants, and only along the shape-changed
 * provides-ports (port-granular propagation).
 */

export interface ContractDiff {
  /** Any change at all that alters the contract hash. */
  changed: boolean;
  /** Interface shape moved: dirty propagation required. */
  shapeChanged: boolean;
  /** provides-port keys whose shape changed (added/removed/retyped). */
  shapeChangedProvides: string[];
  /** Human-readable change list for the UI. */
  notes: string[];
}

/** The shape signature of a contract: what neighbors structurally depend on. */
function shapeOf(c: Contract) {
  return {
    provides: [...c.provides].sort((a, b) => a.key.localeCompare(b.key)).map((p) => ({ key: p.key, type: p.type })),
    requires: [...c.requires].sort((a, b) => a.key.localeCompare(b.key)).map((p) => ({ key: p.key, type: p.type })),
    params: [...c.params].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ name: p.name, type: p.type })),
    payload: c.payload,
  };
}

export function contractHash(c: Contract): string {
  const { hash: _ignored, ...rest } = c;
  // Param `ui` is presentation only (grouping, unit labels). It is stripped
  // because this hash is load-bearing twice over: it is the dirty-detection
  // unit, and it is the node-library key. Letting a group label move it would
  // dirty every node in every graph and orphan every cached artifact for a
  // change no generated code can even observe.
  const params = rest.params.map(({ ui: _ui, ...p }) => p);
  return hashValue({ ...rest, params });
}

export function diffContract(before: Contract, after: Contract): ContractDiff {
  const notes: string[] = [];
  const beforeShape = shapeOf(before);
  const afterShape = shapeOf(after);

  const shapeChanged = hashValue(beforeShape) !== hashValue(afterShape);
  const valueChanged = contractHash(before) !== contractHash(after);

  const shapeChangedProvides: string[] = [];
  const beforeProvides = new Map(beforeShape.provides.map((p) => [p.key, p.type]));
  const afterProvides = new Map(afterShape.provides.map((p) => [p.key, p.type]));
  for (const [key, type] of afterProvides) {
    if (!beforeProvides.has(key)) {
      shapeChangedProvides.push(key);
      notes.push(`port added: ${key} (${type})`);
    } else if (beforeProvides.get(key) !== type) {
      shapeChangedProvides.push(key);
      notes.push(`port retyped: ${key} (${beforeProvides.get(key)} → ${type})`);
    }
  }
  for (const [key] of beforeProvides) {
    if (!afterProvides.has(key)) {
      shapeChangedProvides.push(key);
      notes.push(`port removed: ${key}`);
    }
  }
  // Payload shape changes (e.g. exports/propsType for code) can break
  // consumers of ANY port — treat as all provides changed.
  if (hashValue(beforeShape.payload) !== hashValue(afterShape.payload)) {
    notes.push("payload changed");
    for (const p of afterProvides.keys()) {
      if (!shapeChangedProvides.includes(p)) shapeChangedProvides.push(p);
    }
  }

  return { changed: valueChanged, shapeChanged, shapeChangedProvides, notes };
}

/**
 * Port-granular dirty set: BFS downstream, but only along edges whose
 * fromPort is one of the shape-changed provides. Untouched siblings stay
 * ready. Transitive spread uses ALL provides of a dirtied node (its own
 * regeneration may change anything it emits — conservative but correct;
 * refined when its own re-cook produces an actual diff).
 */
export function computeDirtySet(
  graph: GraphDoc,
  originId: string,
  changedProvides: string[],
): Set<string> {
  const dirty = new Set<string>();
  const queue: { nodeId: string; ports: Set<string> | null }[] = [
    { nodeId: originId, ports: new Set(changedProvides) },
  ];

  while (queue.length > 0) {
    const { nodeId, ports } = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.from !== nodeId) continue;
      if (ports !== null && !ports.has(edge.fromPort)) continue;
      if (dirty.has(edge.to) || edge.to === originId) continue;
      dirty.add(edge.to);
      // ports: null → all provides of the newly-dirty node are suspect.
      queue.push({ nodeId: edge.to, ports: null });
    }
  }
  return dirty;
}
