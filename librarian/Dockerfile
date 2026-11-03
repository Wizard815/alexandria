# Alexandria librarian
FROM node:24-alpine
WORKDIR /app
# git is used by git sources (cloned read-only into the data folder)
RUN apk add --no-cache git
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
ENV ALX_DATA_DIR=/data LIBRARIAN_PORT=8090
VOLUME /data
EXPOSE 8090
USER node
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/index.ts"]
