# Generic neat image — no demo, no Railway-specific config.
#
# Mount your codebase at /workspace; neat will extract from there. Snapshots
# and the embeddings cache land in /neat-out — give that a volume if you want
# them to survive restarts.
#
# Default CMD runs `neatd start` (ADR-049 + ADR-073), which boots the multi-
# project daemon plus the bundled web UI: REST on :8080, OTLP on :4318, web
# on :6328. Set NEAT_AUTH_TOKEN to bind on a public interface; loopback-only
# stays unauthenticated for the laptop dev path.

FROM node:20-bookworm-slim AS builder
WORKDIR /repo

# tree-sitter ships native prebuilds for the common platforms; keep the build
# chain available so a missing prebuild falls through to source build.
# @xenova/transformers (optional dep) is pure WASM, no native compile needed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/types/package.json packages/types/
COPY packages/instrumentation-registry/package.json packages/instrumentation-registry/
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY packages/web/package.json packages/web/
COPY demo/service-a/package.json demo/service-a/
COPY demo/service-b/package.json demo/service-b/
RUN npm ci

COPY packages packages
RUN npx turbo run build --filter=@neat.is/core --filter=@neat.is/mcp

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Default scan + output locations. Mount over /workspace with -v $(pwd):/workspace
# to point neat at your repo; mount a volume at /neat-out to keep snapshots.
ENV NEAT_SCAN_PATH=/workspace
ENV NEAT_OUT_DIR=/neat-out
ENV NEAT_OUT_PATH=/neat-out/graph.json
ENV HOST=0.0.0.0
ENV PORT=8080
ENV OTEL_PORT=4318
# The image ships without @neat.is/web — that's the npm-install distribution
# path. `neat deploy`'s docker-compose snippet keeps :6328 in the surface so
# an operator who layers the web package in still works; unset this in your
# own image / compose override once the web tarball is included.
ENV NEAT_WEB_DISABLED=1

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/types/dist ./packages/types/dist
COPY --from=builder /repo/packages/types/package.json ./packages/types/package.json
# neatd requires @neat.is/instrumentation-registry at runtime; the node_modules
# symlink from the builder points here, so the dist has to ride along like
# types' does.
COPY --from=builder /repo/packages/instrumentation-registry/dist ./packages/instrumentation-registry/dist
COPY --from=builder /repo/packages/instrumentation-registry/package.json ./packages/instrumentation-registry/package.json
COPY --from=builder /repo/packages/core/dist ./packages/core/dist
COPY --from=builder /repo/packages/core/compat.json ./packages/core/compat.json
COPY --from=builder /repo/packages/core/proto ./packages/core/proto
COPY --from=builder /repo/packages/core/package.json ./packages/core/package.json
COPY --from=builder /repo/packages/mcp/dist ./packages/mcp/dist
COPY --from=builder /repo/packages/mcp/package.json ./packages/mcp/package.json

# Make the CLI reachable as `neat`, the daemon entry as `neatd`, and the
# MCP stdio binary as `neat-mcp` so `docker run ... neat init /workspace`,
# `docker run -i ... neat-mcp`, and the default `neatd start` CMD below all
# work without remembering the dist paths.
RUN printf '#!/bin/sh\nexec node /app/packages/core/dist/cli.cjs "$@"\n' > /usr/local/bin/neat \
  && chmod +x /usr/local/bin/neat \
  && printf '#!/bin/sh\nexec node /app/packages/core/dist/neatd.cjs "$@"\n' > /usr/local/bin/neatd \
  && chmod +x /usr/local/bin/neatd \
  && printf '#!/bin/sh\nexec node /app/packages/mcp/dist/index.cjs "$@"\n' > /usr/local/bin/neat-mcp \
  && chmod +x /usr/local/bin/neat-mcp

# ADR-049 #6 — neatd refuses to boot without a registry, by design for the
# laptop dev path ("you forgot to run `neat init`"). The container ships
# the opposite default: a registry with a single `default` project pointed
# at /workspace, so `docker run` brings the daemon up immediately and the
# operator's repo at `-v $(pwd):/workspace` becomes the project on next
# extract. /workspace is mkdir'd so the slot still bootstraps to active on
# a bare `docker run` with no volume mount (empty extraction).
RUN mkdir -p /workspace /root/.neat \
  && printf '%s\n' '{' \
    '  "version": 1,' \
    '  "projects": [' \
    '    {' \
    '      "name": "default",' \
    '      "path": "/workspace",' \
    '      "registeredAt": "1970-01-01T00:00:00.000Z",' \
    '      "languages": [],' \
    '      "status": "active"' \
    '    }' \
    '  ]' \
    '}' > /root/.neat/projects.json

VOLUME ["/workspace", "/neat-out"]
EXPOSE 8080 4318 6328

# Default to `neatd start` — the multi-project daemon plus the bundled web UI.
# Override with e.g.
#   docker run ... ghcr.io/neat-technologies/neat:latest neat watch /workspace
#   docker run ... ghcr.io/neat-technologies/neat:latest neat init /workspace --project a
CMD ["neatd", "start"]
