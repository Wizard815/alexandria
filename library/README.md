# Alexandria Library

The Alexandria Library is a modular MCP (Model Context Protocol) gateway that connects to any world-building API including LegendKeeper, Kanka, and custom MCP implementations.

## Architecture

```
Alexandria Library/
├── LegendKeeperMCP/          # LegendKeeper MCP server (data source)
├── librarian/                # OpenAI proxy + MCP gateway + Auth
├── admin-gui/                # Admin web interface for configuration
├── docker-compose.yml        # Multi-container setup
└── docs/                     # Documentation
```

## Quick Start

### 1. Configure Environment

```bash
cp .env.example .env
# Edit .env with your settings
```

### 2. Start Services

```bash
docker-compose up -d --build
```

### 3. Access Admin GUI

Create the admin on first run (the first account is the admin): `curl -X POST localhost:8090/api/setup -H 'Content-Type: application/json' -d '{"username":"wizard","password":"at least ten characters"}'`. See `librarian/README.md`.

## Features

### Admin GUI (Port 8090)
- Configure MCP modules from GitHub
- Manage scribes (DM, Player, Guest roles)
- Set main + fallback models
- Update MCP modules without downtime
- Configure API keys for various world builders

### MCP Module Management
- Load from any GitHub repository
- Auto-detect module type (LegendKeeper, Kanka, Generic)
- Hot-swap updates (pull, rebuild, replace without service interruption)
- Multiple MCP modules can be loaded simultaneously

### Model Configuration
- **Main Model**: Primary AI for agent (Local LLM, OpenAI, or OpenRouter)
- **Fallback Model**: Backup if main fails (OpenRouter, OpenAI, or Local LLM)
- Local LLM support (Ollama, LM Studio, etc.)

### Scribe Authentication
- **DM Scribes**: Full MCP access (all tools)
- **Player Scribes**: Read-only MCP access
- **Guest Scribes**: Limited MCP permissions

## Environment Variables

### Librarian Configuration
```
LIBRARIAN_PORT=8090
ALX_DATA_DIR=/data
ALX_VAULTS_DIR=/vaults
```

### Model Configuration
```
MAIN_MODEL_TYPE=local
MAIN_MODEL_URL=http://localhost:11434
MAIN_MODEL_NAME=llama3:70b

FALLBACK_MODEL_TYPE=openrouter
FALLBACK_API_KEY=your_openrouter_key
FALLBACK_MODEL_NAME=google/gemini-2.0-flash-exp:free
```

### MCP Module Configuration
```
MCP_LEGENDKEEPER_URL=https://github.com/chase-roohms/legendkeeper-mcp
MCP_LEGENDKEEPER_API_KEY=your_legendkeeper_key

MCP_KANKA_URL=https://github.com/kanka/mcp
MCP_KANKA_API_KEY=your_kanka_key

MCP_GENERIC_URL=https://github.com/your-org/your-mcp
MCP_GENERIC_API_KEY=your_generic_key

DEFAULT_MCP=legendkeeper
```

### Docker Compose
```
MCP_AUTH_TOKEN=your_secure_token
```

## Admin API Endpoints

### Authentication
- Admin login via Basic Auth in Authorization header
- Format: `Bearer base64(username:password)`

### Endpoints
- `GET /api/admin/overview` - System overview
- `GET /api/admin/scribes` - List scribes
- `POST /api/admin/scribes` - Add scribe
- `PUT /api/admin/scribes/:id` - Update scribe
- `DELETE /api/admin/scribes/:id` - Delete scribe
- `GET /api/admin/mcp/modules` - List MCP modules
- `POST /api/admin/mcp/load` - Load MCP module
- `POST /api/admin/mcp/update/:repoName` - Update MCP (hot-swap)
- `POST /api/admin/mcp/unload` - Unload MCP module
- `GET /api/admin/config` - Get configuration
- `POST /api/admin/config/models/main` - Update main model
- `POST /api/admin/config/models/fallback` - Update fallback model
- `POST /api/admin/config/mcp` - Update MCP config

## Updating MCP Modules

1. Go to Admin GUI > MCP Modules tab
2. Select MCP to update from dropdown
3. Click "Update MCP"
4. Module will be pulled, rebuilt, and hot-swapped

No service interruption occurs during updates.

## Multi-User Support

Each scribe maintains separate:
- Session state
- MCP permissions (based on role)
- World access (based on permissions)

Example setup:
```
Desktop DM Scribe → Full MCP access
Mobile Player Scribe 1 → Read-only MCP
Desktop Player Scribe 2 → Read-only MCP
```

## Development

```bash
# Local development
cd librarian
npm install
npm run dev

# Build
npm run build
```

## License

MIT
