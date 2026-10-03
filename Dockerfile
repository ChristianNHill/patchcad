# Two images from one file, wired together by docker-compose.yml:
#   kernel  python 3.12 + uv, the build123d/OCP venv baked at build time
#   server  node 22 + pnpm, the Fastify API plus the production studio build
# The browser only ever talks to the server; GLBs, renders and exports reach
# the kernel through it.

# ---------- geometry kernel ----------
FROM python:3.12-slim-bookworm AS kernel
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /uvx /bin/
# OCP links libGL even in its no-VTK build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libxrender1 \
 && rm -rf /var/lib/apt/lists/*
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app/packages/backend-cad/kernel
# Dependencies first, so editing kernel source does not re-download OCP.
COPY packages/backend-cad/kernel/pyproject.toml packages/backend-cad/kernel/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY packages/backend-cad/kernel/ ./
RUN uv sync --frozen --no-dev
ENV PATCHCAD_KERNEL_HOST=0.0.0.0 PATCHCAD_KERNEL_PORT=8621
EXPOSE 8621
CMD [".venv/bin/patchcad-kernel"]

# ---------- server + studio ----------
FROM node:22-bookworm-slim AS server
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @patchcad/studio build
# PATCHCAD_KERNEL_URL also stops the server from spawning a kernel of its own.
ENV PATCHCAD_HOST=0.0.0.0 PATCHCAD_PORT=4100 PATCHCAD_KERNEL_URL=http://kernel:8621
EXPOSE 4100
CMD ["pnpm", "--filter", "@patchcad/server", "start"]
