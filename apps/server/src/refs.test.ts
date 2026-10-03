import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { refLoader, saveThreadRef } from "./refs.js";

describe("refLoader", () => {
  it("loads names from refs/ and nothing outside it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "patchcad-refs-"));
    await mkdir(path.join(dir, "refs"));
    await writeFile(path.join(dir, "refs", "0123456789abcdef.png"), "png");
    await writeFile(path.join(dir, "secret.png"), "nope");
    const load = refLoader(dir);
    expect(await load("0123456789abcdef.png")).toEqual({ mediaType: "image/png", dataB64: Buffer.from("png").toString("base64") });
    for (const name of ["../secret.png", "/etc/passwd", "0123456789abcdef.png/../../secret.png", "secret.png", "0123456789ABCDEF.png", "0123456789abcdef.gif"]) {
      expect(await load(name)).toBeNull();
    }
  });

  it("round-trips what saveThreadRef stored", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "patchcad-refs-"));
    const name = await saveThreadRef(dir, { dataB64: Buffer.from("jpeg bytes here!").toString("base64"), mediaType: "image/jpeg" });
    expect(name).toMatch(/^[a-f0-9]{16}\.jpg$/);
    expect((await refLoader(dir)(name))?.mediaType).toBe("image/jpeg");
  });
});
