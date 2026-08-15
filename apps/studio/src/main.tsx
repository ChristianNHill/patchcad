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
function showFatal(message: string) {
  let el = document.getElementById("fatal-error");
  if (!el) {
    el = document.createElement("pre");
    el.id = "fatal-error";
    el.style.cssText =
      "position:fixed;inset:auto 12px 12px 12px;z-index:99999;background:#2a1215;color:#ffb4b4;" +
      "border:1px solid #7a2e2e;border-radius:6px;padding:12px;font:12px/1.5 monospace;" +
      "white-space:pre-wrap;max-height:45vh;overflow:auto;";
    document.body.appendChild(el);
  }
  el.textContent += `${message}\n`;
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
