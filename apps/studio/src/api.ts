/** Origin of the patchcad server, shared by every caller in the studio.
 *
 * Derived from the host the studio itself was opened on rather than hardcoded,
 * because the two dev servers don't agree on an address family: Fastify binds
 * both 127.0.0.1 and ::1, while Vite binds only whatever `localhost` resolves
 * to (::1 on macOS and Windows). Hardcoding either literal strands the other —
 * open the studio on ::1 and a 127.0.0.1 API constant still works, but open it
 * on a host that doesn't round-trip and you get a bare "Failed to fetch" with
 * no hint that addressing is the problem. Following location.hostname means
 * the pair always agree.
 *
 * Set VITE_PATCHCAD_API to point the studio at a server elsewhere. */
export const API =
  import.meta.env.VITE_PATCHCAD_API ??
  // Guarded so this module is importable outside a browser: a unit test that
  // pulls in any component transitively importing it must not die on `location`.
  (typeof location === "undefined"
    ? "http://localhost:4100"
    : `${location.protocol}//${location.hostname}:4100`);

/** Same origin, ws:// scheme — for the /ws event stream. */
export const WS_API = API.replace(/^http/, "ws");
