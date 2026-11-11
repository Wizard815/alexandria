# Docker examples and overrides

The base files stay as they are. Add your changes in an override file, and
Compose merges it on top.

| File | Use it to |
|---|---|
| [`../../.env.example`](../../.env.example) | Settings for the home/LAN `docker-compose.yml` |
| [`../../docker-compose.override.example.yml`](../../docker-compose.override.example.yml) | Change the home/LAN setup: localhost only, public address, local model, more vaults |
| [`../.env.example`](../.env.example) | Settings for the server setup in `deploy/` |
| [`../docker-compose.override.example.yml`](../docker-compose.override.example.yml) | Change the server setup: prebuilt image, memory limits, log rotation |
| [`ollama.override.yml`](ollama.override.yml) | Run a local model next to Alexandria |
| [`kanka-stdio.override.yml`](kanka-stdio.override.yml) | Build the `with-kanka` image and run mcp-kanka inside it |
| [`mcp-stdio.example.json`](mcp-stdio.example.json) | The shape of `ALX_MCP_STDIO` |
| [`data-folder.override.yml`](data-folder.override.yml) | Keep data in a host folder instead of a Docker volume |
| [`existing-proxy.override.yml`](existing-proxy.override.yml) | Turn off the bundled Caddy when you already run a proxy |
| [`nginx.conf.example`](nginx.conf.example) | nginx in front of Alexandria |
| [`traefik.override.yml`](traefik.override.yml) | Traefik in front of Alexandria |
| [`Caddyfile.lan.example`](Caddyfile.lan.example) | HTTPS on a home network with no public domain |

## How to use one

```bash
# Server setup plus a local model:
docker compose -f deploy/docker-compose.yml -f deploy/examples/ollama.override.yml \
  --env-file deploy/.env up -d --build

# Home setup with your own override:
cp docker-compose.override.example.yml docker-compose.override.yml   # edit it
docker compose up -d --build        # picks up docker-compose.override.yml by itself
```

- Later files win. Lists such as `ports` and `volumes` are added together.
  Use `!override` to replace a list, which needs Compose 2.24 or newer.
- Your own `docker-compose.override.yml` files are ignored by git.
- **Secrets** (tokens, API keys) go in `.env` files, never in override
  files or JSON you commit.

## Image targets and build arguments

| Target | What it is |
|---|---|
| `app` (default) | Node only. Enough for every connector except local stdio MCP servers that need Python. |
| `with-kanka` | Adds Python, uv and mcp-kanka (`MCP_KANKA_SPEC`, default the Wizard815 fork). |

| Build argument | Default | Use |
|---|---|---|
| `NODE_IMAGE` | `node:24-alpine` | A registry mirror if Docker Hub rate-limits you, e.g. `mirror.gcr.io/library/node:24-alpine` |
| `MCP_KANKA_SPEC` | `git+https://github.com/Wizard815/mcp-kanka` | A different mcp-kanka version |

```bash
docker build -t alexandria .
docker build -t alexandria:kanka --target with-kanka .
docker run -d -p 8090:8090 -v alexandria-data:/data alexandria
```

The image runs as user `node` (uid 1000), stores everything in `/data`, and
has a health check on `/health`.
