/**
 * Tolerant JSON for model replies: the first object in `raw`, parsed strictly
 * when it parses, else repaired once before a schema-repair round is paid
 * for. The repairs are the ones models actually make: trailing commas,
 * unquoted keys, and a reply cut off mid-object (the planetary gearbox plan
 * died at position 11638 on "Expected double-quoted property name").
 * Throws the strict parser's error when nothing parses.
 */
export function parseJsonLoose(raw: string): unknown {
  const start = raw.indexOf("{");
  if (start < 0) throw new SyntaxError("no JSON object found");
  const strict = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw.slice(start);
  try {
    return JSON.parse(strict);
  } catch (err) {
    for (const text of repairJson(raw.slice(start))) {
      try {
        return JSON.parse(text);
      } catch {
        // try the next, shorter candidate
      }
    }
    throw err;
  }
}

/** Candidates, best first: the object with commas, keys and an open tail
 *  fixed; then cut back to the last complete member of a truncated tail. */
export function repairJson(text: string): string[] {
  let out = "";
  const stack: string[] = [];
  /** Output length and open brackets just before each top-level-of-its-
   *  container comma: a truncated tail is cut back to the last of these. */
  const cuts: { at: number; stack: string[] }[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      out += ch;
    } else if (ch === "}" || ch === "]") {
      out = out.replace(/,\s*$/, "");
      out += stack.pop() ?? "";
      if (stack.length === 0) return [out];
    } else if (ch === ",") {
      cuts.push({ at: out.length, stack: [...stack] });
      out += ch;
    } else if (/[A-Za-z_$]/.test(ch) && /[{,]\s*$/.test(out) && stack.at(-1) === "}") {
      // An unquoted key: read the identifier and quote it.
      const key = text.slice(i).match(/^[A-Za-z_$][\w$-]*/)![0];
      out += JSON.stringify(key);
      i += key.length - 1;
    } else {
      out += ch;
    }
  }
  // Truncated: close what is open, or cut back to the last complete member.
  const close = (s: string, open: string[]) => s.replace(/[\s,:]*$/, "") + [...open].reverse().join("");
  const tail = close(inString ? out + '"' : out, stack);
  return [tail, ...cuts.slice(-50).reverse().map((c) => close(out.slice(0, c.at), c.stack))];
}
