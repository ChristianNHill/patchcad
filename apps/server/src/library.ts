import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { LibraryEntry, NodeLibrary } from "@patchcad/engine";

/**
 * Content-addressed node library on disk:
 *   ~/.patchcad/library/<backendId>/<contractHash>.json
 * One file per contract hash — the hash covers the full interface, so the
 * stored code is known-good for exactly that contract. Cross-project by
 * design: any project whose plan lands on an identical contract reuses the
 * node with zero generator calls.
 */
export class FileLibrary implements NodeLibrary {
  constructor(private root = path.join(os.homedir(), ".patchcad", "library")) {}

  private file(backendId: string, contractHash: string): string {
    return path.join(this.root, backendId, `${contractHash}.json`);
  }

  async lookup(backendId: string, contractHash: string): Promise<LibraryEntry | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(backendId, contractHash), "utf8")) as {
        code?: string;
        testCode?: string;
        kind?: string;
        title?: string;
        dts?: string;
      };
      if (typeof raw.code !== "string" || raw.code.length === 0) return null;
      return {
        code: raw.code,
        testCode: raw.testCode ?? "",
        kind: raw.kind ?? "",
        title: raw.title ?? "",
        dts: raw.dts,
      };
    } catch {
      return null;
    }
  }

  async capture(backendId: string, contractHash: string, entry: LibraryEntry): Promise<void> {
    const dir = path.join(this.root, backendId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      this.file(backendId, contractHash),
      JSON.stringify({ ...entry, savedAt: Date.now() }, null, 2),
      "utf8",
    );
  }
}
