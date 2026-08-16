import type { Contract, GraphDoc, NodeRecord } from "@patchcad/shared";
import type { Exemplar } from "./backend.js";
import type { LibraryListing, NodeLibrary } from "./library.js";

/**
 * Few-shot exemplars mined from the node library. Every stored entry is
 * gate-passing code written against a known contract, which is exactly the
 * in-distribution example a static cheat sheet cannot supply — and the corpus
 * improves on its own as more nodes cook.
 *
 * HERMETICITY LIVES HERE. Library entries are keyed only by backend + contract
 * hash, and a node captured on commit can later sit next to the node being
 * generated. Feeding that entry back as an "example" would put a neighbor's
 * implementation into a generator prompt, which is the one thing the whole
 * design forbids. Every entry whose contract hash appears anywhere in the
 * requesting graph is therefore dropped, and that is asserted by test.
 */

/** Two exemplars is roughly triple the prompt, and with CAD repairs the block
 *  is re-sent every round, so the cap is deliberately low. */
const DEFAULT_LIMIT = 2;

/** Skip entries too long to be worth their tokens. Truncating instead would
 *  hand the model half a function and teach it that is acceptable. */
const MAX_EXEMPLAR_CHARS = 4000;

/**
 * ...and skip entries too SHORT to be worth reading. Deterministically resolved
 * nodes land in the library as one-line stubs — an imported CAD piece is just
 * `return load_import(...)` — which demonstrate nothing about writing a part
 * while scoring well on the brevity tiebreak below. A floor keeps them out
 * without the engine having to know which kinds a backend resolves itself.
 */
const MIN_EXEMPLAR_CHARS = 200;

function portTypes(c: Contract): string[] {
  return [...c.provides, ...c.requires].map((p) => p.type).sort();
}

/** How much two contracts have in common: shared port types dominate, param
 *  count breaks ties, brevity breaks the rest. Higher is better. */
export function exemplarScore(target: Contract, candidate: Contract, codeLength: number): number {
  const want = portTypes(target);
  const have = portTypes(candidate);
  const pool = [...have];
  let shared = 0;
  for (const t of want) {
    const i = pool.indexOf(t);
    if (i >= 0) {
      pool.splice(i, 1);
      shared += 1;
    }
  }
  const paramGap = Math.abs(target.params.length - candidate.params.length);
  // Brevity is worth a little: a short worked example costs fewer tokens and
  // is easier to pattern-match than a long one.
  return shared * 10 - paramGap - codeLength / 2000;
}

export async function selectExemplars(opts: {
  library: NodeLibrary;
  backendId: string;
  node: NodeRecord;
  graph: GraphDoc;
  limit?: number;
}): Promise<Exemplar[]> {
  const { library, backendId, node, graph } = opts;
  if (!library.list) return [];

  // Every contract hash this graph contains, including the node being cooked.
  const ownHashes = new Set(Object.values(graph.nodes).map((n) => n.contract.hash));
  ownHashes.add(node.contract.hash);

  const usableFrom = (listing: LibraryListing[]) =>
    listing.filter(
      (e) =>
        e.contract !== undefined &&
        e.code.length >= MIN_EXEMPLAR_CHARS &&
        e.code.length <= MAX_EXEMPLAR_CHARS &&
        !ownHashes.has(e.contractHash),
    );

  let usable: LibraryListing[];
  try {
    usable = usableFrom(await library.list(backendId, { kind: node.kind }));
    // Same kind is the better example, but a different kind in the same domain
    // still demonstrates house style and the API — better than nothing, and
    // early libraries hold only one or two kinds.
    if (usable.length === 0) usable = usableFrom(await library.list(backendId));
  } catch {
    return []; // exemplars are an enhancement; never fail a cook over them
  }

  return usable
    .map((e) => ({ e, score: exemplarScore(node.contract, e.contract!, e.code.length) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? DEFAULT_LIMIT)
    .map(({ e }) => ({ title: e.title, kind: e.kind, contract: e.contract!, code: e.code }));
}
