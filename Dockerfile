# Alexandria: the librarian (API, MCP) serving the React app.
FROM node:24-alpine AS web
WORKDIR /src
COPY packages/client/src ./packages/client/src
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web ./web
RUN cd web && npm run build

FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache git
COPY librarian/package.json ./librarian/
RUN cd librarian && npm install --omit=dev --no-audit --no-fund
COPY librarian/tsconfig.json ./librarian/
COPY librarian/src ./librarian/src
COPY --from=web /src/web/dist ./web/dist
ENV ALX_DATA_DIR=/data ALX_WEB_DIR=/app/web/dist LIBRARIAN_PORT=8090
VOLUME /data
EXPOSE 8090
USER node
WORKDIR /app/librarian
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/index.ts"]
