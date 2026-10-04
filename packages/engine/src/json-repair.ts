/**
 * Tolerant JSON for model replies: the first object in `raw`, parsed strictly
 * when it parses, else repaired once before a schema-repair round is paid
 * for. The repairs are the ones models actually make: trailing and doubled
 * commas, unquoted or single-quoted keys, // and block comments, NaN-like
 * values, and a reply cut off mid-object (the planetary gearbox plan
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

/** Non-JSON value words models write, as the JSON that means the same or
 *  nothing: a number that is not one is null. */
const LITERALS: Record<string, string> = { NaN: "null", Infinity: "null", undefined: "null", None: "null", True: "true", False: "false" };

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
    } else if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      // A comment: to the end of its line, or to its close.
      const end = text[i + 1] === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2) + 1;
      i = end <= 0 ? text.length : end;
    } else if (ch === ",") {
      // A doubled comma, or one straight after an opening bracket, holds nothing.
      if (/[{[,]\s*$/.test(out)) continue;
      cuts.push({ at: out.length, stack: [...stack] });
      out += ch;
    } else if (ch === "'") {
      // A single-quoted string, key or value: re-quoted.
      let body = "";
      for (i++; i < text.length && text[i] !== "'"; i++) body += text[i] === "\\" ? text[++i] ?? "" : text[i];
      out += JSON.stringify(body);
    } else if (/[\w$]/.test(ch) && /[{,]\s*$/.test(out) && stack.at(-1) === "}") {
      // An unquoted key, digits too: read it and quote it.
      const key = text.slice(i).match(/^[\w$][\w$-]*/)![0];
      out += JSON.stringify(key);
      i += key.length - 1;
    } else if (/[A-Za-z]/.test(ch) && /[:[,]\s*$/.test(out)) {
      // A value no JSON has: NaN, Infinity, undefined, Python's True/None.
      const word = text.slice(i).match(/^[A-Za-z]+/)![0];
      out += LITERALS[word] ?? word;
      i += word.length - 1;
    } else if (ch === "-" && text.startsWith("-Infinity", i) && /[:[,]\s*$/.test(out)) {
      out += "null";
      i += "-Infinity".length - 1;
    } else {
      out += ch;
    }
  }
  // Truncated: close what is open, or cut back to the last complete member.
  const close = (s: string, open: string[]) => s.replace(/[\s,:]*$/, "") + [...open].reverse().join("");
  const tail = close(inString ? out + '"' : out, stack);
  return [tail, ...cuts.slice(-50).reverse().map((c) => close(out.slice(0, c.at), c.stack))];
}
