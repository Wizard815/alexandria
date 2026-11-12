# Alexandria

A D&D campaign app for the whole table. The DM runs the world: library,
combat, quick events, calendar, inventory, map. Players get their own view
of it, on a laptop or a phone. Nothing the DM keeps secret reaches a
player.

```
alexandria/
├── librarian/   # The server: API, live updates, MCP endpoint, leak guard (Node.js)
├── web/         # The app: admin, DM and player screens (React + Vite)
├── packages/
│   └── client/  # Typed API client used by the app (and future desktop/mobile builds)
├── library/     # Docker setup for the LegendKeeper MCP server
└── scribes/     # Older desktop/mobile skeletons
```

## Run it

Needs Node 22.13 or newer.

```bash
cd web && npm install && npm run build && cd ..   # build the app
cd librarian && npm install && npm start           # serves the app and the API on :8090
```

Open http://localhost:8090. The first visit asks you to create the admin
account. Then:
1. **Library admin → Worlds:** make a world and pick its DM.
2. **As the DM, World settings → Invites:** make an invite code for each
   player.
3. **Players open `/join`**, enter the code and pick a username and
   password. That's all they set up.

Docker: `docker compose up -d --build` builds the app and runs everything
in one container (data in `./data`). For a server with a domain and HTTPS,
see [docs/HOSTING.md](docs/HOSTING.md).

Development: `npm run dev:librarian` and `npm run dev:web`. Vite serves
the app on :5173 and passes API calls to the librarian.

## Who can see what

- **Admin** is the plumbing: accounts, worlds, sources. It opens no world's
  secrets.
- **DM** sees and changes everything in their world.
- **Players** see only what the DM shares. Every record is checked on the
  server. Library pages get a player copy with DM-only parts removed.
  Players' "only me" notes are hidden from the DM too.

See [librarian/README.md](librarian/README.md) for the rules and the
full API.

## Connect an AI (MCP)

The librarian is an MCP server at `/mcp`.
- **Players get a read-only key automatically when they join.** The join
  screen shows ready-to-paste settings for Claude, Cursor and Claude Code.
  Their AI sees only what that player can see, and can't change anything.
- **The DM can make a write key** under "Connect an AI". Their AI can then
  save pages, add NPCs, schedule sessions, send quick events and hand out
  items.

Keys are stored only as hashes and shown once. Read keys refuse every
write, and a write key stops writing if its owner stops being the DM.

## World sources

Alexandria imports any world that has an API or files. It has connectors
for:
- LegendKeeper (MCP or API key)
- Kanka (API token or mcp-kanka)
- Markdown vaults (Obsidian, Lokus, Otterly)
- git repos
- any MCP file server
- any JSON API (REST or an MCP tool)

Imports are read-only, pages keep their layout, and anything a source
hides stays DM-only.

See [docs/CONNECTORS.md](docs/CONNECTORS.md) for writing a new connector.
See [librarian/docs/MCP_SOURCES.md](librarian/docs/MCP_SOURCES.md) for
what was learned from the live LegendKeeper and Kanka servers.

The full API is in [docs/API.md](docs/API.md).

## Models

`/v1/chat/completions`, `/v1/embeddings` and `/v1/models` pass through to
any OpenAI-compatible endpoint: OpenAI, Argos, Ollama or LM Studio. Only
signed-in callers can use them. Set `MODEL_BASE_URL` and `MODEL_API_KEY`
(or `LOCAL_LLM_URL`) in `librarian/.env`.

## What's next

The working plan is in [PLAN.md](PLAN.md), and the build schedule is in
[TODO.md](TODO.md).

## License

MIT
