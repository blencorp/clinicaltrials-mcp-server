# syntax=docker/dockerfile:1.7
# ---- Build stage -----------------------------------------------------------
# isolated-vm 7 ships prebuilt binaries for Node 24/26 (glibc and musl), so no compiler
# toolchain is needed.
# Base images are pinned by digest; Dependabot (docker ecosystem) proposes digest bumps.
FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /app

# Node 25+ no longer bundles corepack; install the pnpm that package.json "packageManager" pins.
RUN npm install -g --ignore-scripts pnpm@12.21.0

# Install deps and build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY schema ./schema
COPY web ./web
COPY legal ./legal
RUN pnpm build

# Prune to production-only modules (keeps the prebuilt isolated-vm .node).
RUN pnpm prune --prod

# ---- Docs: the documentation site (site/, Astro Starlight), served at /docs ---------------
# Its own pnpm root and lockfile. The build reads docs/sdk-reference.md and examples/*.js, and
# its link check reads package.json and .github/workflows/release.yml.
FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS docs
WORKDIR /repo
RUN npm install -g --ignore-scripts pnpm@12.21.0
COPY site/package.json site/pnpm-lock.yaml site/pnpm-workspace.yaml ./site/
RUN cd site && pnpm install --frozen-lockfile
COPY site ./site
COPY docs/sdk-reference.md ./docs/
COPY examples ./examples
COPY package.json ./
COPY .github/workflows/release.yml ./.github/workflows/
RUN cd site && pnpm build

# ---- Deno: the process-isolated sandbox for authenticated HTTP serving ------
# Authenticated HTTP runs execute only in a Deno subprocess (never in the server process).
# Pinned by digest, the same build as uspto-mcp-server.
FROM denoland/deno:bin-2.9.8@sha256:b507583d3c68ba69f3ed2ce5969ae5b8b70f43421c781279c7aea06435263543 AS deno

# ---- Runtime stage ---------------------------------------------------------
FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 1001 --home /app --shell /usr/sbin/nologin ctgov

COPY --from=deno /deno /usr/local/bin/deno

COPY --from=build --chown=ctgov:ctgov /app/node_modules ./node_modules
COPY --from=build --chown=ctgov:ctgov /app/dist ./dist
COPY --chown=ctgov:ctgov schema ./schema
# The documentation site: a sibling of dist/ (never in the npm package), served at /docs by
# --public-docs and by account mode.
COPY --from=docs --chown=ctgov:ctgov /repo/site/dist ./docs-site
COPY --chown=ctgov:ctgov package.json ./
# Apache-2.0 section 4: the license and notices travel with every redistributed copy.
COPY --chown=ctgov:ctgov LICENSE NOTICE ./

USER ctgov
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    CTGOV_LOG_LEVEL=info \
    DENO_DIR=/tmp/deno

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The image's default is the public hosting mode: anonymous and docs-only (no execute), so it starts
# safely with no auth configured and does not depend on a platform start command (Railway stops
# reading railway.json/railway.toml on 2026-12-01; `.railway/railway.ts` is the only Railway config
# and sets none). It needs CTGOV_PUBLIC_ORIGIN (or CTGOV_ALLOWED_HOSTS) because it binds 0.0.0.0.
# With auth configured, run it with `--http` instead; account mode
# (CTGOV_AUTH_PROVIDER=accounts plus DATABASE_URL, BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID/SECRET)
# also runs with `--http`: the portal is in dist/web, so the image needs nothing else.
ENTRYPOINT ["dumb-init", "--", "node", "dist/bin.js"]
CMD ["--http", "--public-docs"]
