import path from "node:path";
import type { GraphDoc, ParamValue } from "@patchcad/shared";
import type { PreviewAdapter, Workspace } from "@patchcad/engine";
import { writeNodeModule } from "./assemble.js";

/**
 * Live preview = a programmatic Vite dev server rooted at the materialized
 * workspace. Vite's HMR + React Fast Refresh IS the single-module hot-swap:
 * a re-cooked node writes one file under src/nodes/ and only that component
 * remounts, sibling state preserved.
 */

export interface VitePreviewOptions {
  port: number;
  /** Monorepo root, added to fs.allow so the preview can import workspace sources. */
  fsAllow: string[];
}

export class VitePreviewAdapter implements PreviewAdapter {
  private server: import("vite").ViteDevServer | null = null;
  private opts: VitePreviewOptions;
  private currentRoot: string | null = null;

  constructor(opts: VitePreviewOptions) {
    this.opts = opts;
  }

  async start(graph: GraphDoc, ws: Workspace): Promise<{ url: string }> {
    if (this.server && this.currentRoot === ws.root) return { url: this.url() };
    // Switching projects: tear down and re-root on the same port.
    if (this.server) await this.stop();
    this.currentRoot = ws.root;

    const { createServer } = await import("vite");
    const react = (await import("@vitejs/plugin-react")).default;

    this.server = await createServer({
      configFile: false,
      root: ws.root,
      logLevel: "warn",
      plugins: [react()],
      resolve: {
        alias: {
          "@nodes": path.join(ws.root, "src", "nodes"),
        },
        dedupe: ["react", "react-dom"],
      },
      server: {
        port: this.opts.port,
        strictPort: false,
        cors: true,
        fs: { allow: [ws.root, ...this.opts.fsAllow] },
      },
    });
    await this.server.listen();
    return { url: this.url() };
  }

  url(): string {
    const addr = this.server?.httpServer?.address();
    const port =
      typeof addr === "object" && addr ? addr.port : this.opts.port;
    return `http://localhost:${port}/`;
  }

  async hotSwap(_graph: GraphDoc, ws: Workspace, nodeIds: string[]): Promise<void> {
    // Writing the file is sufficient — Vite's watcher picks it up and Fast
    // Refresh swaps the module. Callers pass artifacts through the graph.
    for (const id of nodeIds) {
      const node = _graph.nodes[id];
      if (node?.artifact) await writeNodeModule(ws, id, node.artifact.code);
    }
  }

  async pushParams(_nodeId: string, _params: Record<string, ParamValue>): Promise<void> {
    // T0 params travel studio → iframe directly via postMessage; nothing to
    // do server-side. Kept on the interface for headless/CAD backends.
  }

  async stop(): Promise<void> {
    await this.server?.close();
    this.server = null;
  }
}
