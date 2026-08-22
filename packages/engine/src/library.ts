import type { Contract } from "@patchcad/shared";

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
}
