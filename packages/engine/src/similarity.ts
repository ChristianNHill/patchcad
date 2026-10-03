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

const STOPWORDS = new Set([
  "the", "and", "with", "for", "from", "into", "onto", "that", "this", "its", "one", "two",
  "part", "node", "each", "has", "are", "mm",
]);

/** Content words of a title or spec, crudely singular: "holes" meets "hole". */
export function keywords(text: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of (text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d/.test(w)) continue;
    out.add(w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  }
  return out;
}

/** Modelling techniques a part's code uses, or its spec asks for. Two plates
 *  with the same ports and nothing else alike are not near: a lofted pod and
 *  a flat bracket can share every port type. */
const FEATURES: [tag: string, re: RegExp][] = [
  ["loft", /\bloft/i],
  ["revolve", /\brevolv/i],
  ["sweep", /\bsweep|\bswept/i],
  ["shell", /\bshell|\boffset\(|\bhollow/i],
  ["fillet", /\bfillet/i],
  ["threads", /\bthread|IsoThread/i],
];

export function featureTags(text: string | undefined): Set<string> {
  return new Set(FEATURES.filter(([, re]) => re.test(text ?? "")).map(([tag]) => tag));
}

const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;

/** The node a library entry is being matched against. */
export interface SimilarityTarget {
  contract: Contract;
  title?: string;
  spec?: string;
}

/**
 * How much a stored node looks like the one being cooked. What the part IS
 * leads — shared words between titles and summaries, then shared modelling
 * techniques — and a first-try pass breaks near-ties toward code that is easy
 * to get right. Port multisets come last: for CAD nearly every part has a
 * hole and a face, so ports alone rank almost arbitrarily.
 */
export function nodeSimilarity(target: SimilarityTarget, candidate: LibraryListing): number {
  const want = `${target.title ?? ""} ${target.contract.summary} ${target.spec ?? ""}`;
  const have = `${candidate.title} ${candidate.contract?.summary ?? ""}`;
  const words = overlap(keywords(want), keywords(have));
  const features = overlap(featureTags(want), featureTags(candidate.code));
  const firstPass = candidate.attemptsToPass === 1 ? 1 : 0;
  const ports = candidate.contract ? contractSimilarity(target.contract, candidate.contract) : 0;
  return words * 10 + features * 5 + firstPass * 3 + ports / 10;
}

/** Below this share of the shorter title's words in common, a stored node is
 *  a different part, whatever its ports say. */
export const NEAR_TITLE_MIN = 0.5;

/** Overlap of two titles' keywords, as a share of the shorter one. */
export function titleSimilarity(a: string, b: string): number {
  const ka = keywords(a);
  const kb = keywords(b);
  const shorter = Math.min(ka.size, kb.size);
  return shorter === 0 ? 0 : overlap(ka, kb) / shorter;
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
  /** The cooking node's title: a candidate must read as the same part. */
  title: string;
  spec?: string;
  /** Contract hashes to skip — the exact-hash path has already tried its own. */
  exclude: Set<string>;
  limit?: number;
}): Promise<ReuseCandidate[]> {
  const { library, backendId, contract, kind, title, exclude } = opts;
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
        e.kind === kind &&
        !exclude.has(e.contractHash) &&
        // Gates measure ports, not purpose: a stored lid passes a box's
        // contract well enough to commit as the wrong object.
        titleSimilarity(title, e.title) >= NEAR_TITLE_MIN &&
        paramsCompatible(contract, e.contract) &&
        paramsInRange(contract, e.contract),
    )
    // Nothing in common is not a near miss, it is a different part.
    .filter((e) => contractSimilarity(contract, e.contract!) > 0)
    .map((e) => ({ entry: e, score: nodeSimilarity({ contract, title, spec: opts.spec }, e) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 2);
}
