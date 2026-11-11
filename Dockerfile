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
RUN apk add --no-cache git tini \
 && mkdir -p /data /vaults \
 && chown node:node /data
WORKDIR /app
COPY --from=deps /app/librarian/node_modules ./librarian/node_modules
COPY librarian/package.json librarian/tsconfig.json ./librarian/
COPY librarian/src ./librarian/src
COPY --from=web /src/web/dist ./web/dist
ENV NODE_ENV=production \
    ALX_DATA_DIR=/data \
    ALX_VAULTS_DIR=/vaults \
    ALX_WEB_DIR=/app/web/dist \
    LIBRARIAN_PORT=8090
VOLUME /data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${LIBRARIAN_PORT}/health" >/dev/null || exit 1
USER node
WORKDIR /app/librarian
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/index.ts"]

# ---- Optional: with Python + uv + mcp-kanka (for ALX_MCP_STDIO) -------------
# The Kanka (API token) connector needs none of this. Use it only to run
# mcp-kanka as a local stdio MCP server. See deploy/examples/kanka-stdio.
FROM runtime AS with-kanka
ARG MCP_KANKA_SPEC="git+https://github.com/Wizard815/mcp-kanka"
USER root
RUN apk add --no-cache python3 uv \
 && UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install "${MCP_KANKA_SPEC}" \
 && test -x /usr/local/bin/mcp-kanka
USER node

# ---- Default: the standard image --------------------------------------------
FROM runtime AS app
