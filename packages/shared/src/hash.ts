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
  const mix = (byte: number) => {
    h ^= BigInt(byte);
    h = (h * prime) & 0xffffffffffffffffn;
  };
  // Manual UTF-8 so this stays lib-free (no TextEncoder in bare ES2022).
  for (let i = 0; i < input.length; i++) {
    let cp = input.codePointAt(i)!;
    if (cp > 0xffff) i++; // surrogate pair consumed
    if (cp < 0x80) mix(cp);
    else if (cp < 0x800) {
      mix(0xc0 | (cp >> 6));
      mix(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      mix(0xe0 | (cp >> 12));
      mix(0x80 | ((cp >> 6) & 0x3f));
      mix(0x80 | (cp & 0x3f));
    } else {
      mix(0xf0 | (cp >> 18));
      mix(0x80 | ((cp >> 12) & 0x3f));
      mix(0x80 | ((cp >> 6) & 0x3f));
      mix(0x80 | (cp & 0x3f));
    }
  }
  return h.toString(16).padStart(16, "0");
}

export function hashValue(value: unknown): string {
  return fnv1a64(canonicalJson(value));
}
