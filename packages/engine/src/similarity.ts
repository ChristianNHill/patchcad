import type { Contract, ParamDecl } from "@patchcad/shared";
import type { LibraryListing, NodeLibrary } from "./library.js";

/**
 * Contract-as-query: how close two interfaces are, and whether one node's code
 * could possibly serve another's contract.
 *
 * One scoring function feeds both library consumers, because "which stored node
 * is most like this one" is the same question whether the answer becomes a
 * worked example (exemplars.ts) or a candidate for outright reuse (below).
 */

const portTypes = (c: Contract): string[] =>
  [...c.provides, ...c.requires].map((p) => p.type).sort();

/** Size of the multiset intersection — how many of `want`'s port types the
 *  candidate actually has, counting duplicates. */
function sharedPortTypes(want: string[], have: string[]): number {
  const pool = [...have];
  let shared = 0;
  for (const t of want) {
    const i = pool.indexOf(t);
    if (i >= 0) {
      pool.splice(i, 1);
      shared += 1;
    }
  }
  return shared;
}

/** How much two contracts have in common. Shared port types dominate, param
 *  count proximity breaks ties. Higher is better; 0 means nothing in common. */
export function contractSimilarity(target: Contract, candidate: Contract): number {
  const shared = sharedPortTypes(portTypes(target), portTypes(candidate));
  const paramGap = Math.abs(target.params.length - candidate.params.length);
  return shared * 10 - paramGap;
}

const numeric = (p: ParamDecl): p is Extract<ParamDecl, { type: "number" }> => p.type === "number";

/**
 * Could `candidate`'s code run against `target`'s contract at all?
 *
 * Node code reads its params by name (`p.thickness`), so a candidate whose
 * contract declares a param the target lacks will raise the moment it runs —
 * a guaranteed miss, not a gamble worth a kernel round trip. Every param the
 * candidate declares must therefore exist on the target with the same type.
 *
 * The reverse is fine: the target having EXTRA params just means the reused
 * code ignores them.
 */
export function paramsCompatible(target: Contract, candidate: Contract): boolean {
  const byName = new Map(target.params.map((p) => [p.name, p]));
  return candidate.params.every((c) => byName.get(c.name)?.type === c.type);
}

/**
 * Would the target's values sit inside the range the candidate was written
 * for? Reusing a plate's code at 10x its intended thickness is not reuse, it
 * is extrapolation — the gates might even pass it while the part is absurd.
 * Only numeric params with a declared range are judged; anything else passes.
 */
export function paramsInRange(target: Contract, candidate: Contract): boolean {
  const byName = new Map(target.params.map((p) => [p.name, p]));
  for (const c of candidate.params) {
    if (!numeric(c) || c.min === undefined || c.max === undefined) continue;
    const t = byName.get(c.name);
    if (!t || !numeric(t)) continue;
    if (t.default < c.min || t.default > c.max) return false;
  }
  return true;
}

export interface ReuseCandidate {
  entry: LibraryListing;
  score: number;
}

/**
 * Stored nodes whose code could plausibly satisfy this contract, best first.
 *
 * This is deliberately permissive about geometry and strict about names. It
 * cannot know whether the stored code produces the right shape — but it does
 * not have to, because cook runs every candidate through the same execute +
 * verify gauntlet a generated artifact faces, and a candidate that does not
 * satisfy the contract simply fails and falls through to generation. The gates
 * are the oracle; this only decides what is worth the kernel round trip.
 */
export async function findReusable(opts: {
  library: NodeLibrary;
  backendId: string;
  contract: Contract;
  kind: string;
  /** Contract hashes to skip — the exact-hash path has already tried its own. */
  exclude: Set<string>;
  limit?: number;
}): Promise<ReuseCandidate[]> {
  const { library, backendId, contract, kind, exclude } = opts;
  if (!library.list) return [];

  let listing: LibraryListing[];
  try {
    listing = await library.list(backendId, { kind });
  } catch {
    return []; // reuse is an optimisation; never fail a cook over it
  }

  return listing
    .filter(
      (e) =>
        e.contract !== undefined &&
        e.code.length > 0 &&
        !exclude.has(e.contractHash) &&
        paramsCompatible(contract, e.contract) &&
        paramsInRange(contract, e.contract),
    )
    .map((e) => ({ entry: e, score: contractSimilarity(contract, e.contract!) }))
    // Nothing in common is not a near miss, it is a different part.
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 2);
}
