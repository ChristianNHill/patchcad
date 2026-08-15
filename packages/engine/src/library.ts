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
 */

export interface LibraryEntry {
  code: string;
  testCode: string;
  kind: string;
  title: string;
  /** Extracted interface (.d.ts) captured with the code. */
  dts?: string;
}

export interface NodeLibrary {
  lookup(backendId: string, contractHash: string): Promise<LibraryEntry | null>;
  capture(backendId: string, contractHash: string, entry: LibraryEntry): Promise<void>;
}
