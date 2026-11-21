# syntax=docker/dockerfile:1.7
# ---- Build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Build tools + python required by isolated-vm's node-gyp.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Install deps and build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY schema ./schema
RUN pnpm build

# Prune to production-only modules (keeps the compiled isolated-vm .node).
RUN pnpm prune --prod

# ---- Deno: the process-isolated sandbox for authenticated HTTP serving ------
# Authenticated HTTP runs execute only in a Deno subprocess (never in the server process).
# Pinned by digest, the same build as uspto-mcp-server.
FROM denoland/deno:bin-2.9.8@sha256:b507583d3c68ba69f3ed2ce5969ae5b8b70f43421c781279c7aea06435263543 AS deno

# ---- Runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      tini \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 1001 --home /app --shell /usr/sbin/nologin ctgov

COPY --from=deno /deno /usr/local/bin/deno

COPY --from=build --chown=ctgov:ctgov /app/node_modules ./node_modules
COPY --from=build --chown=ctgov:ctgov /app/dist ./dist
COPY --chown=ctgov:ctgov schema ./schema
COPY --chown=ctgov:ctgov package.json ./

USER ctgov
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    CTGOV_LOG_LEVEL=info \
    DENO_DIR=/tmp/deno

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The image's default is the public hosting mode: anonymous and docs-only (no execute), so it starts
# safely with no auth configured and does not depend on a platform start command (Railway stops
# reading railway.json on 2026-12-01). With auth configured, run it with `--http` instead.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/bin.js"]
CMD ["--http", "--public-docs"]
