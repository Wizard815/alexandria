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

## Phones and desktops

- **Install on a phone.** Open your server's address in Chrome (Android) and
  choose Install app, or in Safari (iOS) Share, then Add to Home Screen. It
  then opens full screen and keeps working offline for what it has saved. The
  DM phone page (Remote tab) shows an Install button when the browser offers
  one. This needs HTTPS (or `localhost`); on plain LAN HTTP browsers will only
  offer a shortcut, not a full install.
- **Desktop app.** `desktop/` holds a Tauri wrapper that asks for your server's
  address and adds an Assistant window with always-on-top and a global
  shortcut. It signs in like the browser. Build steps are in
  [desktop/README.md](../desktop/README.md).

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
| `ALX_APPS_DIR` | Where this server keeps the app builds it offers signed-in people on This device (default: `<data>/apps`). Drop the release files in as they are named (`Alexandria-<version>-android.apk`, `...-windows-x64-setup.exe`, `...-macos-universal.dmg`, `...-linux-x64.tar.gz`); the apps offer an update when a newer version is here. |
| `ALX_APPS_AUTO_FETCH` | `1` fetches the latest release's builds from GitHub 30 seconds after start and every 12 hours, replacing older builds of the same platform. Off by default; an admin can also fetch by hand (`POST /api/admin/apps/fetch`). |
| `ALX_APPS_MAX_MB` | The largest build an admin can upload in Admin, App builds (default 1536). A reverse proxy in front of the server needs to allow bodies that big too (nginx: `client_max_body_size 1536m;` for `/api/admin/apps/`). |
| `ALX_APP_RELEASES_REPO` | The GitHub repository those builds come from (default `Wizard815/alexandria`). |
| `ALX_APP_DOWNLOADS` | Where the public **Get the app** page (`/get-app`) sends people for the Android APK and the desktop installers (default: this project's GitHub releases page). Only an http(s) address is used. |
| `ALX_CORS_ORIGINS` | Other origins allowed to call the API (e.g. a dev server). Empty (the default) means none. |
| `ALX_MEMORY_MB` | The heap size the memory guard measures against (default: V8's limit, `NODE_OPTIONS=--max-old-space-size`) |
| `ALX_AUDIO_STALE_MIN` | Minutes without a line or audio after which a recording session is closed (default 30; 0 turns it off) |
| `ALX_V1_RATE_PER_MIN`, `ALX_V1_DAILY_REQUESTS`, `ALX_V1_DAILY_TOKENS` | Limits of a listed (non-DM) account or key on the `/v1` model gateway (20 a minute, 200 requests and 100 000 tokens a day). The DM and admin: `…_DM` (120, 5 000, 2 000 000). |
| `MODEL_BASE_URL`, `MODEL_API_KEY`, `LOCAL_LLM_URL` | Model endpoint for AI features (OpenAI, Ollama, LM Studio, Argos…) |

Notes on local MCP servers:
- A stdio MCP server needs its own runtime inside the container. The
  standard image has Node only. For Kanka, the **Kanka (API token)**
  connector needs no MCP server at all.
- To run mcp-kanka over stdio, build an image that adds Python and `uv`.

## Memory, a busy server and starting up

Recommended: **2 GB of RAM** for Alexandria on a home server (4 GB with a library of several thousand pages and an
embeddings model, since the vectors are held in memory for search). The container sets `NODE_OPTIONS=--max-old-space-size=1536`;
raise it in `librarian/.env` if you have the RAM. Alexandria's own models run elsewhere (Argos), not in this container.

- **Heavy admin work does not stop the table.** A crawl, a sync, a re-index, a module import, the rebuilding of the player copies and
  the building of a session recording work in short steps (or in another process) with the server answering requests in between. The
  jobs bar at the top of the admin pages (`GET /api/admin/jobs`) lists what is running, how far it is, and stops what can be stopped.
  `/health` says `busyJobs`.
- **Starting is quick.** The server listens as soon as the database is open. `/health` answers `200` with `"status": "warming"` while
  it finishes in the background (rebuilding the copies after an upgrade, starting again the jobs a restart interrupted, warming the
  search caches); it is `"ok"` afterwards. Docker's health check allows for both.
- **A job survives a restart.** A crawl, a source sync or a rebuild that was running when the server stopped is started again where it
  left off (what was saved stays saved; embeddings carry on with the pages not yet read).
- **A memory guard** watches the heap. Over 80% of the limit it drops the caches (they are made again when needed) and holds background
  work back; over 92% it stops the running jobs, so the server is not killed and restarted from nothing. `ALX_MEMORY_MB` sets the
  limit it measures against (default: V8's heap limit).
- **Nothing to do means no work.** With no new or changed content the embeddings, the story bible and the transcript passes make no model
  calls. A recording session nobody has touched for 30 minutes (`ALX_AUDIO_STALE_MIN`) is closed.
- **Model servers stay private.** Bind Argos, Ollama, LM Studio and whisper to `127.0.0.1` (or the Docker network), never forward
  their ports, and set an API key on each (see [SECURITY.md](SECURITY.md)). Alexandria's own `/v1` gateway answers only the DM and the
  admin, with per-minute and daily limits, and logs every call.
- **Measuring.** `node --experimental-strip-types librarian/scripts/bigworld.ts all --data /tmp/bigworld` builds a large world (3000
  pages, 700 LegendKeeper resources, 20 000 transcript lines, 50 MB of uploads) and measures start-up time, call latency and event
  loop delay while each heavy job runs. `PERF=1 npm test` runs the guard in `test/perf.test.ts`.

## Backups

Everything (every world, account, key and page) is one SQLite database, plus
the data folders (recorded audio under `recordings/`, and under `audio/` while
a session is still being joined).

```bash
ALX_URL=https://alexandria.example.com ALX_ADMIN_KEY=alx_adm_… ./deploy/backup.sh
```

The script:
- downloads one `.tar.gz` from `GET /api/admin/backup`: a consistent copy of
  the database (`librarian.db`) and the data folders (`recordings/`, `audio/`)
- with `ALX_DB_ONLY=1` it downloads just the database (`?db=1`)
- keeps the last 14

Make an admin key under Library admin → Keys & AI, and run the script from
cron, e.g. nightly. Restore by stopping the server and unpacking the archive
into the data folder (it holds `librarian.db`, `recordings/` and `audio/`):
`tar -xzf alexandria-….tar.gz -C /data`. A plain `.db` backup goes back as `librarian.db`.

## Session recordings

When the DM stops a recording, the server joins the five-second chunks with
ffmpeg (the Docker image has it) and keeps plain files you can open without
the app:

```
data/recordings/<World name>/<YYYY-MM-DD> <Session name>/
  Full session.mp3              every microphone mixed, one file for the whole session
  <Mic name> - <Person>.mp3     one file per microphone (silence where it had nothing)
  Transcript.md                 the DM's transcript; DM-only lines are marked
  session.json                  what is in the folder: session, mics and who they belong to, files
```

Every audio file starts at the session's time zero, so they line up. MP3
plays everywhere, including iOS Safari. Once the files are checked (length
and size) the raw chunks under `data/audio/` are deleted to save space; if
the build fails they are kept, and the DM's **Recordings** page shows "Build
failed" with a **Rebuild** button. Sessions recorded before this existed are
built the first time the server starts (one at a time) or with **Build
recording**. The build runs in the background, one session at a time, and
streams through ffmpeg, so a four hour session is not held in memory.

**Back these up.** `recordings/` is part of the backup archive above, and
the files are the only copy of the audio, so a plain copy of the folder is
a valid backup too. Expect roughly 30 MB an hour for the mix and 20 MB an
hour for each microphone.

**Retention.** The world setting *Keep raw audio for (days)* (default 30,
blank keeps forever) is the default for every session. On the Recordings page
the DM can set a session to *Delete after N days*, *Keep forever*, or press
**Delete audio now**. Deleting removes only the audio files; the transcript,
summaries and logs always stay (`Transcript.md` and `session.json` stay in
the folder). The days count from when the session ended. Deletion runs
hourly.

**Who can listen.** The DM can play and download everything. A player's
*My recordings* page offers only the track of their own microphone and the
transcript as players see it (never DM-only lines); the full mix and other
people's tracks are refused. Players who did not agree to recording are not
recorded and have no track.

## Security checklist

- **HTTPS only** on the internet: the Caddy setup does it.
- **Passwords** are scrypt-hashed. **Keys and sessions** are stored only
  as hashes and shown once. Revoke keys in Keys & AI.
- **Admin sign-in is separate** from the table sign-in. Admins sign in
  at `/admin/login` and get an admin session that opens only the admin
  pages (never a world as DM). A table sign-in opens the admin pages only
  while the server has a single account, or when you set
  `ALX_ADMIN_TABLE_LOGIN=1` (for a small server where one person is DM and
  admin). With a second account and no env var, admins use `/admin/login`
  or an admin key (`alx_adm_...`, which always works).
  - **Authenticator app:** Admin → Security sets up a 6-digit code
    (TOTP) and 10 single-use recovery codes. Once on, a table sign-in no
    longer opens the admin pages for that account. Admin keys are not
    covered by the code, so keep them safe and revoke ones you don't use.
  - **Allowed networks:** `ALX_ADMIN_ALLOW=127.0.0.1/32,192.168.0.0/16,::1/128`
    limits admin login and every admin route to those IPv4/IPv6 ranges
    (others get 403 and an audit entry). Behind a proxy set
    `ALX_TRUST_PROXY` so the real client address is used. A typo in the
    list stops the server from starting.
  - **Guessing:** 3 wrong tries per account and address (and 10 per
    address) lock admin login for 5 minutes. Logins, failures, code
    changes and refused addresses are in the audit log.
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

## Macros, trigger URLs and lights

The gateway hosts the action registry, macro trigger URLs (`POST /api/trigger/<token>`)
and the lights drivers; see [MACROS.md](MACROS.md). Lights need the gateway to
reach your lights on the local network (WLED, a Hue bridge, Home Assistant,
OpenRGB on port 6742); from Docker on a LAN, use host names or addresses the
container can reach. Public IP addresses are refused unless
`ALX_LIGHTS_ALLOW_PUBLIC=1`; `ALX_LIGHTS_MIN_MS` (default 250) is the gap
between updates to one light group.

Planned, not built: a gateway audio helper for a mic and speaker plugged into
the gateway machine. In Docker that needs the sound device passed into the
container (for example `devices: ["/dev/snd:/dev/snd"]` on Linux).
