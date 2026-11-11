# Hosting Alexandria

The **librarian** is the gateway. One server holds every world and serves
the app. The DM and the players (scribes) all connect to it from a
browser, a phone, or an AI app over MCP.

```
 players' browsers ─┐
 DM's browser ──────┼──► https://alexandria.example.com ──► Caddy (HTTPS) ──► librarian :8090
 AI apps (MCP) ─────┘                                                          ├─ SQLite (all worlds)
                                                                               ├─ Markdown mirror per world
 world sources ◄── read-only ──────────────────────────────────────────────────┘
 (LegendKeeper, Kanka, vaults, git, any MCP or JSON API)
```

## On a server with a domain (recommended)

1. **Get a domain.** Point a name (e.g. `alexandria.example.com`) at the
   server, and open ports 80 and 443.
2. **Install Docker.** Then:
   ```bash
   git clone https://github.com/Wizard815/alexandria && cd alexandria
   cp deploy/.env.example deploy/.env      # set ALX_DOMAIN at least
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   ```
   Caddy gets the HTTPS certificate on its own.
3. **Open `https://<your domain>`** and create the admin account. The first
   account is always the admin.
4. **Library admin → Worlds:** make a world and pick its DM.
5. **Library admin → World sources:** add your LegendKeeper, Kanka, vault
   or other sources and press Sync.
6. **As the DM, World settings → Invites:** give each player an invite
   code. They open `/join`. Their read-only AI connection is made for them.

To run the LegendKeeper MCP server next to Alexandria:
- Set `LK_MCP_TOKEN` and `LEGENDKEEPER_API_KEY` in `deploy/.env`.
- Add `--profile legendkeeper` to the compose command.
- Add the source as **LegendKeeper (MCP server)** with URL
  `http://legendkeeper-mcp:8000/mcp` and the same token.

Or skip the MCP server: use **LegendKeeper (API key)** with LegendKeeper's
API key directly.

## Changing the setup

Don't edit the compose files. Put changes in an override file. Examples for
a local model, mcp-kanka inside the image, a host data folder, nginx,
Traefik and LAN HTTPS are in
[deploy/examples/](../deploy/examples/README.md).

## At home or on a LAN

`docker compose up -d --build` from the repo root serves plain HTTP on
port 8090. Fine for a table in one house. To reach it from outside, put
it behind the Caddy setup above, a tunnel, or a VPN. Don't expose plain
HTTP to the internet: passwords and keys would travel unencrypted.

## Without Docker

```bash
cd web && npm install && npm run build && cd ..
cd librarian && npm install && npm start
```

Needs Node 22.13 or newer. Data goes to `librarian/data` unless
`ALX_DATA_DIR` says otherwise.

## Settings (environment variables)

| Variable | What it does |
|---|---|
| `LIBRARIAN_PORT` | Port to listen on (default 8090) |
| `ALX_DATA_DIR` | Where the database, the per-world Markdown mirror and git sources live |
| `ALX_DB` | Database file (default `$ALX_DATA_DIR/librarian.db`) |
| `ALX_WEB_DIR` | The built app (default `web/dist`) |
| `ALX_PUBLIC_URL` | The address people use, e.g. `https://alexandria.example.com`. Used in AI connection settings. |
| `ALX_TRUST_PROXY` | Set to `1` behind Caddy or nginx so client IPs and https are read correctly |
| `ALX_RATE_LIMIT` | Requests per minute per IP for the API and MCP (default 900; 0 turns it off) |
| `ALX_VAULTS_DIR` | Folders under this path can be added as Markdown-folder sources |
| `ALX_MCP_STDIO` | Local MCP servers the librarian may start, as JSON: `{"kanka": {"command": ["uvx", "mcp-kanka"], "env": {"KANKA_TOKEN": "…", "KANKA_CAMPAIGN_ID": "…"}}}`. Only these commands can ever be started. |
| `ALX_CORS_ORIGINS` | Other origins allowed to call the API (e.g. a dev server) |
| `MODEL_BASE_URL`, `MODEL_API_KEY`, `LOCAL_LLM_URL` | Model endpoint for AI features (OpenAI, Ollama, LM Studio, Argos…) |

Notes on local MCP servers:
- A stdio MCP server needs its own runtime inside the container. The
  standard image has Node only. For Kanka, the **Kanka (API token)**
  connector needs no MCP server at all.
- To run mcp-kanka over stdio, build an image that adds Python and `uv`.

## Backups

Everything (every world, account, key and page) is one SQLite database.

```bash
ALX_URL=https://alexandria.example.com ALX_ADMIN_KEY=alx_adm_… ./deploy/backup.sh
```

The script:
- downloads a consistent copy from `GET /api/admin/backup`
- keeps the last 14

Make an admin key under Library admin → Keys & AI, and run the script from
cron, e.g. nightly. Restore by stopping the server and putting the file
back as `librarian.db`.

## Security checklist

- **HTTPS only** on the internet: the Caddy setup does it.
- **Passwords** are scrypt-hashed. **Keys and sessions** are stored only
  as hashes and shown once. Revoke keys in Keys & AI.
- **Players can only read.** Their app keys are read-only. A DM's write
  key stops writing if they stop being DM.
- **Sources are read-only.**
  - Write-sounding MCP tools are refused.
  - LegendKeeper's raw API tool may only GET.
  - Source secrets never come back from the API.
- **DM-only text never reaches a player:**
  - player copies are computed on the server
  - unknown block kinds are dropped
  - links to DM-only pages become "(hidden)"

  See `librarian/README.md`.
- **Read-only keys for sources** where the source app offers them (for
  LegendKeeper, the MCP server reports `readOnly`).
