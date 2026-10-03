# Snapland backend image (SPEC section 11.1): the Fastify API + WebSocket gateway and the one-shot jobs (`migrate`, `seed`).
# Build from the repository root (the workspaces share one lockfile):
#   docker build -f backend/Dockerfile -t snapland-backend:local .
# The image holds no .env and no secret: configuration comes from the environment at run time.

ARG NODE_IMAGE=node:22.23.3-alpine3.23

# -- base --------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
WORKDIR /app
# No update check, funding banner or audit round trip during builds. The audit runs in CI (`npm audit`), not here.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# -- manifests ---------------------------------------------------------------------------------------------------------
FROM base AS manifests
# .npmrc holds only engine-strict / save-exact / audit-level. The build uses the public registry, so no token is needed.
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/

# -- deps --------------------------------------------------------------------------------------------------------------
FROM manifests AS deps
# `npm ci` installs exactly what the lockfile pins. `-w` limits the install to the two workspaces the backend needs.
# `--ignore-scripts` stops dependency install scripts from running. Native modules (@node-rs/argon2, rollup/rolldown)
# ship prebuilt per-platform optional packages, so they need no install script. The cache mount keeps the npm tarball
# cache out of every layer.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts -w @snapland/shared -w @snapland/backend

# -- build -------------------------------------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared/tsconfig.build.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY backend/tsconfig.build.json backend/
COPY backend/src backend/src
# Shared first: the backend's build resolves @snapland/shared through its compiled `dist` (`customConditions: []`).
# Declaration files are needed only at compile time, so they are removed before the runtime copy. Source maps stay
# for `--enable-source-maps`.
RUN npm run build -w @snapland/shared -w @snapland/backend \
 && find packages/shared/dist backend/dist \( -name '*.d.ts' -o -name '*.d.ts.map' \) -type f -delete

# -- prod-deps ---------------------------------------------------------------------------------------------------------
FROM manifests AS prod-deps
# A fresh production-only install is used instead of `npm prune`: nothing from the dev tree can leak in.
# The mkdir keeps the runtime COPYs valid when npm hoists everything and creates no per-workspace node_modules.
# Last step: fail the build if argon2's native binding for this libc/arch (linux-x64-musl on Alpine) is missing.
# Without it, password hashing would only fail at the first sign-up.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts --omit=dev -w @snapland/shared -w @snapland/backend \
 && mkdir -p backend/node_modules packages/shared/node_modules \
 && node -e "const a = require('@node-rs/argon2'); if (!a.verifySync(a.hashSync('probe'), 'probe')) process.exit(1);"

# -- runtime -----------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# tini runs as PID 1. It forwards SIGTERM/SIGINT to node, so the graceful shutdown (SPEC section 10.12, close-with-grace) runs
# on `docker stop`, and it reaps zombie processes. The version comes from the Alpine release pinned by the base tag.
# The package managers bundled with the base image (npm, npx, corepack, yarn) are never used at run time. Removing
# them means nothing in the running container can install code. Scanners of the final filesystem also stop reporting
# npm's own dependency tree. The bytes remain in the base layer, so this is about attack surface, not size.
RUN apk add --no-cache tini \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# NODE_OPTIONS caps the V8 heap below the 512 MiB compose memory limit; the rest is left for buffers and sockets.
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=384

WORKDIR /app/backend
# Files stay owned by root and are read-only for `node`, so the process cannot modify its own code. The workspace
# symlink node_modules/@snapland/shared -> ../../packages/shared is preserved by COPY.
COPY --from=prod-deps /app/package.json /app/
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules /app/packages/shared/node_modules
COPY --from=prod-deps /app/backend/node_modules /app/backend/node_modules
COPY packages/shared/package.json /app/packages/shared/
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY backend/package.json /app/backend/
COPY backend/migrations /app/backend/migrations
COPY --from=build /app/backend/dist /app/backend/dist

USER node
EXPOSE 3100

# No image HEALTHCHECK: compose probes /health/ready on the replicas, and the one-shot jobs need none.

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
