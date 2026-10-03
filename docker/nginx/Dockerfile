# Snapland edge image (SPEC section 11.1, user decision D-2): builds the React SPA with Vite, then serves it from nginx and
# reverse-proxies /api, /ws, /docs and /health to the two backend replicas. Build from the repository root:
#   docker build -f docker/nginx/Dockerfile -t snapland-nginx:local .
# The VITE_* build args are feature flags baked into the bundle, never secrets (see ARG below).

ARG NODE_IMAGE=node:22.23.3-alpine3.23
ARG NGINX_IMAGE=nginx:1.30.5-alpine

# -- deps --------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY frontend/package.json frontend/
# Lockfile-exact install of the SPA toolchain only. Vite's native parts (rolldown, lightningcss) come as prebuilt
# linux-musl optional packages, so `--ignore-scripts` is safe.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts -w @snapland/shared -w @snapland/frontend

# -- build -------------------------------------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared/src packages/shared/src
COPY frontend frontend
# main.tsx imports ../../docs/design/tokens.css (the design-token single source), so it must sit at the same relative path.
COPY docs/design/tokens.css docs/design/tokens.css
ARG VITE_API_BASE=/api/v1
ARG VITE_ENABLE_ITM_LAYER=true
ARG VITE_E2E_HOOKS=false
# Vite gives VITE_* process variables precedence over .env files, and .dockerignore keeps every .env* file out of the
# context. The bundle therefore depends only on these build args.
# Text assets above 1 KiB are pre-compressed so nginx serves the .gz twin (gzip_static) without spending CPU per request.
RUN VITE_API_BASE="${VITE_API_BASE}" \
    VITE_ENABLE_ITM_LAYER="${VITE_ENABLE_ITM_LAYER}" \
    VITE_E2E_HOOKS="${VITE_E2E_HOOKS}" \
    npm run build -w @snapland/frontend \
 && test -f frontend/dist/index.html \
 && find frontend/dist -type f \
      \( -name '*.html' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.svg' -o -name '*.json' \
         -o -name '*.map' -o -name '*.txt' -o -name '*.webmanifest' \) \
      -size +1k -exec gzip -9 -k {} +

# -- runtime -----------------------------------------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS runtime
# The stock server block is replaced by nginx.conf. Everything nginx writes (pid, temp files) goes to /tmp, a tmpfs in
# compose, so the root filesystem can be read-only.
RUN rm -f /etc/nginx/conf.d/default.conf \
 && rm -rf /usr/share/nginx/html/*

COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx/snippets/ /etc/nginx/snippets/
COPY --from=build /app/frontend/dist /usr/share/nginx/html

# Master and workers run as `nginx` (uid 101), never root. Binding port 80 unprivileged relies on
# net.ipv4.ip_unprivileged_port_start=0, which Docker sets by default and compose sets explicitly.
USER nginx
EXPOSE 80

# SIGQUIT = graceful shutdown: stop accepting, finish in-flight requests, and close idle WebSockets within
# worker_shutdown_timeout. The master process handles signals and reaps its workers, so no extra init is needed.
STOPSIGNAL SIGQUIT
# The official entrypoint's scripts (envsubst templates, IPv6 listen, worker tuning) would try to write to a read-only
# filesystem and are not needed: the configuration is static and has no runtime templating.
ENTRYPOINT ["nginx"]
CMD []
