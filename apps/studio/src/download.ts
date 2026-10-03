import { API } from "./api";

/** Fetch a server file and hand it to the browser as a save. A blob URL is
 *  same-origin, so the browser honours `download` (it ignored the name on a
 *  cross-origin link), and a failure comes back as a sentence instead of a
 *  JSON error page saved to disk. Returns the error, or the server's
 *  x-patchcad-warning, or null. */
export async function download(path: string, fallbackName: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
      return body.hint ? `${body.error} — ${body.hint}` : (body.error ?? `download failed (${res.status})`);
    }
    const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = filename ?? fallbackName;
    a.click();
    URL.revokeObjectURL(url);
    // e.g. imported mesh parts a STEP export had to leave out
    return res.headers.get("x-patchcad-warning");
  } catch (err) {
    return (err as Error).message;
  }
}
