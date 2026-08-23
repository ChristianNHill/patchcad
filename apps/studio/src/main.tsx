import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "./tokens.css";
import "./studio.css";
import { App } from "./App.js";

// A crash must never be a silent black page: paint uncaught errors into the
// DOM so they are readable without devtools.
//
// BOUNDED, and deliberately so. This used to be `textContent +=` with no cap,
// so a server outage — which retries every 2s and rejects every time — grew the
// box until it covered the app, turning one recoverable fault into a wall of
// identical stack traces. Repeats now increment a count instead of stacking,
// and the history is capped.
const FATAL_MAX = 12;
const counts = new Map<string, number>();

function showFatal(message: string) {
  let el = document.getElementById("fatal-error");
  if (!el) {
    el = document.createElement("pre");
    el.id = "fatal-error";
    el.className = "fatal-error";
    document.body.appendChild(el);
  }
  counts.set(message, (counts.get(message) ?? 0) + 1);
  if (counts.size > FATAL_MAX) counts.delete(counts.keys().next().value!);
  el.textContent = [...counts].map(([m, c]) => (c > 1 ? `${m}\n  (×${c})` : m)).join("\n");
}
window.addEventListener("error", (e) => showFatal(`${e.message}\n  at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) =>
  showFatal(`unhandled rejection: ${String((e.reason as Error)?.stack ?? e.reason)}`),
);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
