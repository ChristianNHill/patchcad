/**
 * Canonical JSON + hashing. Contract hashes are the unit of dirty detection,
 * so serialization must be deterministic: object keys sorted recursively,
 * no whitespace variance.
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

/** FNV-1a 64-bit over UTF-8, hex encoded. Fast, dependency-free, stable.
 * Used for cache keys and dirty detection, not security. */
export function fnv1a64(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  // Lone surrogates encode as U+FFFD here, where a hand-rolled encoder would
  // emit raw invalid UTF-8. Contract hashes are library keys, so that boundary
  // is pinned by contract-hash-stability.test.ts in @patchcad/engine.
  for (const byte of new TextEncoder().encode(input)) {
    h ^= BigInt(byte);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export function hashValue(value: unknown): string {
  return fnv1a64(canonicalJson(value));
}
