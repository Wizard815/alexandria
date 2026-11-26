# Alexandria: the librarian (API, MCP, live updates) serving the React app.
#
#   docker build -t alexandria .                      # standard image (Node only)
#   docker build -t alexandria:kanka --target with-kanka .
#                                                     # adds Python, uv and mcp-kanka
#                                                     # for ALX_MCP_STDIO sources
#
# Data (database, Markdown mirror, git sources, uploads) lives in /data.

# Base image. Override to use a registry mirror, e.g.
#   --build-arg NODE_IMAGE=mirror.gcr.io/library/node:24-alpine
ARG NODE_IMAGE=node:24-alpine

# ---- 1. Build the web app -------------------------------------------------
FROM ${NODE_IMAGE} AS web
WORKDIR /src
COPY packages/client/src ./packages/client/src
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web ./web
RUN cd web && npm run build

# ---- 2. Librarian dependencies (production only) ---------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app/librarian
COPY librarian/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---- 3. Runtime -----------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Alexandria" \
      org.opencontainers.image.description="D&D campaign app: library, live table and MCP gateway" \
      org.opencontainers.image.source="https://github.com/Wizard815/alexandria" \
      org.opencontainers.image.licenses="MIT"
# git: for git sources (cloned read-only into /data). tini: clean shutdown.
RUN apk add --no-cache git tini ffmpeg su-exec \
 && mkdir -p /data /vaults \
 && chown node:node /data
WORKDIR /app
COPY --from=deps /app/librarian/node_modules ./librarian/node_modules
COPY librarian/package.json librarian/tsconfig.json ./librarian/
COPY librarian/src ./librarian/src
# Built-in house rules (rule files); a server adds its own with ALX_MODS_DIR.
COPY mods ./mods
COPY --from=web /src/web/dist ./web/dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ARG ALX_VERSION=0.1.0-alpha.1
ARG ALX_RELEASE=AlphaV1
ENV ALX_VERSION=${ALX_VERSION} ALX_RELEASE=${ALX_RELEASE}
# The memory V8 may use for the JavaScript heap. A home server with 2 GB of RAM shares it with the database cache, the page cache and
# the models' clients: 1.5 GB leaves room, and the memory guard (core/memguard.ts) drops caches and stops big jobs before it is reached
# instead of being killed. On a machine with more RAM raise it (NODE_OPTIONS=--max-old-space-size=3072 in librarian/.env).
ENV NODE_OPTIONS=--max-old-space-size=1536 \
    NODE_ENV=production \
    ALX_DATA_DIR=/data \
    ALX_VAULTS_DIR=/vaults \
    ALX_WEB_DIR=/app/web/dist \
    LIBRARIAN_PORT=8090
VOLUME /data
EXPOSE 8090
# /health answers at once, also while a crawl runs or the server is still warming up ("status": "warming", still 200), so a busy server
# is never marked unhealthy. The start period covers a slow first start (an upgrade that rebuilds the search index of a big library).
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${LIBRARIAN_PORT}/health" >/dev/null || exit 1
# Starts as root to fix the ownership of /data, then drops to "node" (see the script).
WORKDIR /app/librarian
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/index.ts"]

# ---- Optional: with Python + uv + mcp-kanka (for ALX_MCP_STDIO) -------------
# The Kanka (API token) connector needs none of this. Use it only to run
# mcp-kanka as a local stdio MCP server. See deploy/examples/kanka-stdio.
FROM runtime AS with-kanka
ARG MCP_KANKA_SPEC="git+https://github.com/Wizard815/mcp-kanka"
RUN apk add --no-cache python3 uv \
 && UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install "${MCP_KANKA_SPEC}" \
 && test -x /usr/local/bin/mcp-kanka

# ---- Optional: with Obsidian's official headless Sync client ----------------
# For the "Obsidian Sync" source (obsidian-sync). Needs an Obsidian Sync
# subscription. Sign in once: docker compose exec -u node alexandria ob login
# (the sign-in is kept in /data/obsidian-home, so it survives restarts).
FROM runtime AS with-obsidian
ARG OBSIDIAN_HEADLESS_SPEC="obsidian-headless"
RUN npm install -g --no-audit --no-fund "${OBSIDIAN_HEADLESS_SPEC}" && command -v ob
ENV ALX_OBSIDIAN_HOME=/data/obsidian-home

# ---- Default: the standard image --------------------------------------------
FROM runtime AS app
