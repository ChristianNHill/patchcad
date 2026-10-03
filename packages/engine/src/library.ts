import { hashValue, type Contract } from "@patchcad/shared";

/**
 * Node library: contract-as-query reuse. v1 policy is exact contract-hash
 * match — a hash pins name, summary, params, ports, and payload, so a hit is
 * code already verified against this exact interface. Cached code still runs
 * execute + verify before committing (the library is a shortcut, not an oracle);
 * a stale entry falls back to generation.
 *
 * Only unspecialized nodes take part: a node with a non-empty thread was
 * shaped by user reprompts, so it neither captures into nor reuses from the
 * library.
 *
 * Entries are also the corpus few-shot exemplars are mined from (exemplars.ts):
 * every one is gate-passing, in-house-style code for a known contract, which
 * is the in-distribution example a static cheat sheet cannot provide.
 */

export interface LibraryEntry {
  code: string;
  testCode: string;
  kind: string;
  title: string;
  /** Extracted interface (.d.ts) captured with the code. */
  dts?: string;
  /**
   * The interface this code was written against and verified for. Captured so
   * an entry can serve as a worked example: the hash is one-way, so without
   * this an exemplar teaches style but not the contract→code mapping, which is
   * the part generators actually get wrong. Absent on entries captured before
   * this field existed — such entries still serve the fast path.
   */
  contract?: Contract;
  /** Generation rounds the code took to pass its gates (1 = first try). */
  attemptsToPass?: number;
  /** Times a later cook committed this entry instead of generating. */
  reused?: number;
}

/** A gate failure a repair cleared. Deliberately no code: mined pitfalls ride
 *  later repair prompts, possibly a neighbor's in the same graph, and code from
 *  one node must never reach another's prompt (hermeticity). */
export interface RepairFix {
  stage: string;
  report: string;
}

/** A pitfall mined from repeated fixes — the shape a backend's table merges. */
export interface LearnedPitfall {
  id: string;
  stage: string;
  /** RegExp source matching the failure's normalized first line. */
  pattern: string;
  fix: string;
  occurrences: number;
}

/** An entry plus the key it is stored under. */
export interface LibraryListing extends LibraryEntry {
  contractHash: string;
}

export interface NodeLibrary {
  lookup(backendId: string, contractHash: string): Promise<LibraryEntry | null>;
  capture(backendId: string, contractHash: string, entry: LibraryEntry): Promise<void>;
  /**
   * Enumerate stored entries for a backend. Optional: a library that cannot
   * index simply offers no exemplars, and cooking carries on unchanged.
   *
   * Note this is deliberately a dumb listing. Choosing WHICH entries a
   * generator may see — in particular excluding the requesting graph's own
   * nodes — is the engine's job, so the hermeticity filter lives in one
   * testable place instead of in every NodeLibrary implementation.
   */
  list?(backendId: string, opts?: { kind?: string }): Promise<LibraryListing[]>;
  /** Outcome stats, all optional and best-effort: a cook never waits on them. */
  recordReuse?(backendId: string, contractHash: string): Promise<void>;
  recordFix?(backendId: string, fix: RepairFix): Promise<void>;
}

/** A failure report reduced to what recurs across parts: its first line with
 *  numbers and quoted names blanked. "port \"bolt\" (BORE): expected Ø4.5,
 *  measured Ø9.00" and the same miss on another part share a signature. */
export function failureSignature(report: string): string {
  return (report.split("\n")[0] ?? "")
    .replace(/"[^"]*"|'[^']*'/g, '"_"')
    .replace(/-?\d+(?:\.\d+)?/g, "#")
    .trim();
}

/** Learned pitfalls need this many separate fixes for one signature: one or
 *  two can be coincidence, and a wrong fix would ride every matching repair. */
export const MIN_PITFALL_OCCURRENCES = 3;

/** What a learned pitfall tells a repair. Built from counts alone, never from
 *  stored text, so no code can ride it into a prompt. */
export function learnedPitfallFix(stage: string, occurrences: number): string {
  return (
    `This ${stage} failure has been seen and repaired ${occurrences} times before: it is a ` +
    "recurring, local mistake. Fix the exact line or value the report names; do not restructure the part."
  );
}

/**
 * Frequent cleared failures as candidate pitfalls, grouped by stage and
 * signature. Domain-agnostic: the backend decides whether to use them.
 */
export function minePitfalls(fixes: RepairFix[]): LearnedPitfall[] {
  const groups = new Map<string, RepairFix[]>();
  for (const f of fixes) {
    const sig = failureSignature(f.report);
    if (!sig) continue;
    const key = `${f.stage}\u0000${sig}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out: LearnedPitfall[] = [];
  for (const [key, group] of groups) {
    if (group.length < MIN_PITFALL_OCCURRENCES) continue;
    const [stage, sig] = key.split("\u0000") as [string, string];
    const pattern = sig
      .split("#")
      .map((part) => part.split('"_"').map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(`(?:"[^"]*"|'[^']*')`))
      .join("-?\\d+(?:\\.\\d+)?");
    out.push({
      id: `learned-${stage}-${hashValue(sig).slice(0, 8)}`,
      stage,
      pattern,
      fix: learnedPitfallFix(stage, group.length),
      occurrences: group.length,
    });
  }
  return out.sort((a, b) => b.occurrences - a.occurrences);
}
