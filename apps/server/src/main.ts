import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import { EventBus, type DomainBackend } from "@patchcad/engine";
import { CodeBackend } from "@patchcad/backend-code";
import { CadBackend, useLearnedPitfalls } from "@patchcad/backend-cad";
import { buildApp } from "./app.js";
import { FileLibrary } from "./library.js";
import { NO_PROVIDER_HELP, readMaxUsd, readMeshGen, resolveProvider } from "./providers.js";
import { createMeshGen, meshSourceFor } from "./meshgen/index.js";
import { Session } from "./session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const API_PORT = Number(process.env.PATCHCAD_PORT ?? 4100);
/** Fastify binds every address `localhost` resolves to — both 127.0.0.1 and
 * ::1. Binding v4-only strands Windows, where localhost usually resolves to
 * ::1 first: the server looks healthy in the log and every browser fetch dies
 * as a bare "Failed to fetch". */
const API_HOST = process.env.PATCHCAD_HOST ?? "localhost";
const PREVIEW_PORT = Number(process.env.PATCHCAD_PREVIEW_PORT ?? 5174);
/** Only an explicit env override boots into a project; the default is none —
 * the studio shows the welcome screen until a plan or import creates one. */
const initialProjectDir = process.env.PATCHCAD_PROJECT
  ? path.resolve(process.env.PATCHCAD_PROJECT)
  : null;

async function main() {
  const bus = new EventBus();
  const codeBackend = new CodeBackend({ port: PREVIEW_PORT, fsAllow: [repoRoot] });
  // Image-to-3D for mesh-source parts. Read before the backend exists: it
  // decides what the architect is told about mesh generation.
  const meshGenConfig = await readMeshGen();
  const meshGen = meshGenConfig ? createMeshGen(meshGenConfig) : null;
  console.log(`[patchcad] mesh generation: ${meshGen ? meshGen.id : "not configured (mesh parts plan parametric)"}`);
  // The session is built below; mesh spend finds its cook's budget through it.
  let session: Session | undefined;
  const cadBackend = new CadBackend({
    meshSource: meshGen ? meshSourceFor(meshGen, (dir) => session?.budgetFor(dir)) : undefined,
  });
  const backends: Record<string, DomainBackend<unknown>> = {
    [codeBackend.id]: codeBackend,
    [cadBackend.id]: cadBackend as DomainBackend<unknown>,
  };
  const library = new FileLibrary();
  // Fixes this install's repairs keep needing, merged behind the seeded table.
  useLearnedPitfalls(library.pitfallsFile(cadBackend.id));

  const resolved = await resolveProvider();
  if (resolved) console.log(`[patchcad] llm provider: ${resolved.provider.id} (${resolved.source})`);
  else console.log(`[patchcad] no llm provider — planning disabled. ${NO_PROVIDER_HELP}`);
  let maxUsd: number | undefined;
  let budgetError: string | null = null;
  try {
    maxUsd = await readMaxUsd();
  } catch (err) {
    // Fail closed: a cap someone set and we cannot read must not mean no cap.
    budgetError = `${(err as Error).message} — refusing to spend until it is fixed`;
    console.error(`\n[patchcad] !!! COOK BUDGET UNREADABLE !!!\n[patchcad] ${budgetError}\n`);
  }
  if (maxUsd) console.log(`[patchcad] cook budget: $${maxUsd.toFixed(2)} per cook`);

  const s = (session = new Session({
    bus,
    backends,
    codeBackend,
    cadBackend,
    library,
    resolved,
    maxUsd,
    budgetError,
    meshGen,
    projectsRoot: path.join(repoRoot, "projects"),
    examplesRoot: path.join(repoRoot, "examples"),
  }));
  if (initialProjectDir) await s.activate(initialProjectDir);
  else await s.close();
  void s.runGlobalCheck(s.active);

  const app = await buildApp(s);

  // The kernel this server spawned dies with it (an orphaned one kept :8621).
  app.addHook("onClose", () => cadBackend.kernel.stop());
  process.once("exit", () => void cadBackend.kernel.stop());
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      setTimeout(() => process.exit(1), 10_000).unref();
      void app.close().finally(() => process.exit(0));
    });
  }

  // A production studio build (`pnpm --filter @patchcad/studio build`) is served
  // at `/` beside the API, so one port is the whole app. Dev uses Vite instead.
  const studioDist = path.join(repoRoot, "apps", "studio", "dist");
  if (existsSync(path.join(studioDist, "index.html"))) {
    await app.register(fastifyStatic, { root: studioDist });
    console.log(`[patchcad] studio: serving ${studioDist}`);
  }

  await app.listen({ port: API_PORT, host: API_HOST });
  console.log(`[patchcad] api: http://127.0.0.1:${API_PORT} (host ${API_HOST})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
