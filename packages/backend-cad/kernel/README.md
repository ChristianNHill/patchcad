# patchcad-kernel

Python geometry kernel for the CAD backend: executes generated **build123d**
node code in warm, isolated worker processes and returns GLB meshes plus
measurements, content-addressed by `(code, params)`.

```sh
uv sync                 # one-command bootstrap (uv manages Python 3.12 itself)
uv run patchcad-kernel  # serves on 127.0.0.1:8621
uv run python smoke.py  # acceptance suite against the running service
```

The Node server spawns and health-checks this service automatically via
`KernelClient` (`packages/backend-cad/src/kernel.ts`); starting it by hand is
only needed for kernel development.

## API

- `GET /health` → `{ok, workers:{size,alive,respawns}, timeout_s}`
- `POST /execute` `{code, params, ports?, envelope?}` → `{ok, hash, cached,
  measurements, glb}` or `422 {ok:false, stage, error, hint}` where `stage` ∈
  `G0` (static scan: import allowlist, `def build(p)` present) · `G1`
  (execution — NameErrors get did-you-mean hints vs the real build123d
  namespace) · `G2` (validity: solids, volume, BRep check, bbox sanity) ·
  `G3` (port probes: hole diameters measured, e.g. "expected Ø4.5, measured
  Ø6.00"; FLAT_FACE grid or annular `ring_diameter`; SCREW_BOSS wall + pilot)
  · `G4` (envelope containment) · `TIMEOUT` · `KERNEL_CRASH`. Every failure
  carries a repair-prompt-ready `hint`. Ports/envelope use the part-LOCAL
  frame with +z pointing out of the material.
- `GET /artifact/{hash}/mesh.glb` → binary glTF for the viewport.

## Isolation model

The parent process never imports OCP. Each worker is a spawned process that
pays the build123d import once and then runs jobs warm (~50 ms/part). A job
that hangs is SIGKILLed at 20 s; a native OCCT crash kills only its worker.
Both cases respawn the worker and surface as structured errors — the service
itself never goes down. Node code convention: `def build(p) -> Part`, imports
limited to `build123d` and `math`.

Cache lives at `~/.patchcad/kernel-cache/<hash>/{mesh.glb,measurements.json}`.
Env knobs: `PATCHCAD_KERNEL_PORT` (8621), `PATCHCAD_KERNEL_TIMEOUT` (20),
`PATCHCAD_KERNEL_WORKERS` (2), `PATCHCAD_KERNEL_CACHE`.
