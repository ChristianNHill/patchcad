import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Contract } from "@patchcad/shared";
import type { LibraryEntry, LibraryListing, NodeLibrary } from "@patchcad/engine";

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

  /** Tolerant read: `contract` is absent on entries written before exemplar
   *  mining existed, and such entries still serve the fast path. */
  private parse(raw: unknown): LibraryEntry | null {
    const e = raw as {
      code?: string;
      testCode?: string;
      kind?: string;
      title?: string;
      dts?: string;
      contract?: Contract;
    };
    if (typeof e?.code !== "string" || e.code.length === 0) return null;
    return {
      code: e.code,
      testCode: e.testCode ?? "",
      kind: e.kind ?? "",
      title: e.title ?? "",
      dts: e.dts,
      contract: e.contract,
    };
  }

  async lookup(backendId: string, contractHash: string): Promise<LibraryEntry | null> {
    try {
      return this.parse(JSON.parse(await readFile(this.file(backendId, contractHash), "utf8")));
    } catch {
      return null;
    }
  }

  /** Newest first, so a growing library surfaces recent house style. The store
   *  is a flat directory of a few dozen files — cheap enough to read whole,
   *  and an index would be one more thing to keep true. */
  async list(
    backendId: string,
    opts: { kind?: string; limit?: number } = {},
  ): Promise<LibraryListing[]> {
    const dir = path.join(this.root, backendId);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      return []; // no library for this backend yet
    }

    const out: (LibraryListing & { savedAt: number })[] = [];
    for (const file of files) {
      try {
        const full = path.join(dir, file);
        const raw = JSON.parse(await readFile(full, "utf8")) as { savedAt?: number };
        const entry = this.parse(raw);
        if (!entry) continue;
        if (opts.kind && entry.kind !== opts.kind) continue;
        const savedAt = raw.savedAt ?? (await stat(full)).mtimeMs;
        out.push({ ...entry, contractHash: path.basename(file, ".json"), savedAt });
      } catch {
        continue; // a corrupt entry must not take the whole listing down
      }
    }

    out.sort((a, b) => b.savedAt - a.savedAt);
    const capped = opts.limit ? out.slice(0, opts.limit) : out;
    return capped.map(({ savedAt: _savedAt, ...e }) => e);
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
