# Alexandria Library Setup Guide

This guide covers setting up the Alexandria Library with the Librarian, Admin GUI, and modular MCP modules.

## Architecture Overview

```
Alexandria Library/
├── LegendKeeperMCP/          # LegendKeeper MCP server (data source)
├── librarian/                # OpenAI proxy + MCP gateway + Auth
├── admin-gui/                # Admin web interface for configuration
└── docs/                     # This documentation
```

## Components

### 1. LegendKeeper MCP (Data Source)
- Provides access to your LegendKeeper world data
- Runs on port 8000
- Uses API key authentication

### 2. Librarian (API Gateway)
- OpenAI API proxy with parallel LLM support
- Local LLM integration (Ollama, LM Studio, etc.)
- MCP module management
- Admin authentication
- **Default Port: 8090**

### 3. Admin GUI (Configuration)
- Web interface at http://localhost:8090/admin
- Configure MCP modules from GitHub URLs
- Manage scribes (users)
- Set main + fallback models
- Update MCP modules without downtime

## Quick Start

### Prerequisites
- Docker and Docker Compose
- Node.js 20+ (for local development)
- LegendKeeper API key (or any MCP-compatible API)
- GitHub URL for MCP modules

### Step 1: Configure Environment

```bash
cd alexandria/library

# Copy the example env file
cp .env.example .env

# Edit .env with your configuration
cat .env
```

### Required Configuration

#### Admin Credentials
```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme123
```
Password can contain special characters like `$`, `!`, `@`, `#`, `%`, etc.

#### MCP Module Configuration
Each MCP module needs a GitHub URL:

```env
MCP_LEGENDKEEPER_URL=https://github.com/chase-roohms/legendkeeper-mcp
MCP_LEGENDKEEPER_API_KEY=your_actual_api_key

# Kanka (optional)
MCP_KANKA_URL=https://github.com/kanka/mcp
MCP_KANKA_API_KEY=your_api_key

# Generic (any MCP-compatible API)
MCP_GENERIC_URL=https://github.com/your-org/your-mcp
MCP_GENERIC_API_KEY=your_api_key

DEFAULT_MCP=legendkeeper
```

#### Model Configuration
```env
# Main Model (primary AI)
MAIN_MODEL_TYPE=local
MAIN_MODEL_URL=http://localhost:11434
MAIN_MODEL_NAME=llama3:70b

# Fallback Model (backup if main fails)
FALLBACK_MODEL_TYPE=openrouter
FALLBACK_API_KEY=sk-or-v1-your_openrouter_key
FALLBACK_MODEL_NAME=google/gemini-2.0-flash-exp:free
```

### Step 2: Start Services

```bash
# Build and start all services
docker-compose up -d --build

# Check logs
docker-compose logs -f
```

### Step 3: Access Admin GUI

Open http://localhost:8090/admin in your browser.

#### First-time Setup:
1. Login with admin credentials
2. Configure MCP modules (load from GitHub URLs)
3. Add scribes (users) with roles and permissions
4. Configure models (main + fallback)

## Admin GUI Features

### Overview
- Active scribes count
- Loaded MCP modules count
- Librarian status
- Port number (8090)

### Scribes Management
- **Add Scribe**: Username, Role (DM/Player/Guest), MCP Access (Full/Read/Custom), Linked World
- **Edit Scribe**: Update role, MCP access, linked world
- **Delete Scribe**: Remove users
- **Scribe Types**:
  - DM: Full MCP access, read/write permissions
  - Player: Read-only MCP access
  - Guest: Limited MCP permissions

### Model Configuration
#### Main Model (Primary AI)
- **Local LLM**: Ollama, LM Studio, etc.
- **OpenAI**: Direct API access
- **OpenRouter**: OpenAI-compatible API

#### Fallback Model (Backup)
- Configured similarly to main model
- Used when main model fails

### MCP Modules
#### Load New MCP
- Enter GitHub repository URL
- Provide API key if required
- Enter campaign/project ID if needed
- Module auto-detects type from package.json

#### Update MCP (Hot-Swap)
- Select MCP to update from dropdown
- Click "Update MCP"
- System pulls latest changes, rebuilds, and hot-swaps
- **No service interruption**

### Configuration Management
- View current settings
- Update main/fallback models
- Update MCP configurations

## MCP Module Management

### Loading Modules
Modules are loaded from GitHub repositories:
```
MCP_LEGENDKEEPER_URL=https://github.com/chase-roohms/legendkeeper-mcp
```

The system:
1. Clones the repository to `/app/mcp-modules/<repo-name>`
2. Installs dependencies via `npm ci --only=production`
3. Loads the module into the Librarian

### Updating Modules (Hot-Swap)
1. Pull latest changes from GitHub
2. Rebuild dependencies
3. Unload old module
4. Load new module

**Result**: No downtime, existing scribes continue working.

## Scribe Authentication Flow

### DM Scribes
- Full MCP access (all tools)
- Can read/write all data
- Can access all MCP endpoints

### Player Scribes  
- Read-only MCP access
- Limited to read operations
- Cannot modify data

### Guest Scribes
- Read-only world access
- Minimal MCP permissions
- Public data only

## Multi-User Support

The system supports multiple concurrent scribes:

```
Example Setup:
- Desktop DM Scribe (full MCP access)
- Mobile Player Scribe 1 (read-only MCP)
- Desktop Player Scribe 2 (read-only MCP)
```

Each scribe:
1. Authenticates with the Librarian
2. Gets permissions based on their role
3. Can only access MCP tools they're authorized for
4. Maintains separate sessions

## Testing the Setup

### Test Admin GUI
```
Open http://localhost:8090/admin
Login: admin / changeme123
```

### Test Librarian Health
```bash
curl http://localhost:8090/health
```

### Test Admin API
```bash
# Get overview
curl -H "Authorization: Bearer $(echo -n 'admin:changeme123' | base64)" http://localhost:8090/api/admin/overview

# List scribes
curl -H "Authorization: Bearer $(echo -n 'admin:changeme123' | base64)" http://localhost:8090/api/admin/scribes
```

### Test MCP Module Load
Use the Admin GUI to load a module from a GitHub URL.

## Troubleshooting

### Admin GUI won't load
- Check port 8090 is not in use
- Verify `admin-gui` directory exists
- Check Docker logs: `docker-compose logs librarian`

### MCP modules won't load
- Verify GitHub URL is accessible
- Check API key is correct
- Ensure `git` is installed in librarian container
- Review logs: `docker-compose logs librarian`

### Authentication failures
- Verify `ADMIN_USERNAME` and `ADMIN_PASSWORD` are set
- Check Authorization header format: `Bearer base64(username:password)`
- Ensure admin credentials in `.env` are correct

### Model configuration errors
- Verify `MAIN_MODEL_URL` is accessible
- Check API keys are set correctly
- Ensure model names are valid for the provider

## Production Considerations

1. **Security**:
   - Change default admin credentials
   - Use strong passwords for all services
   - Implement HTTPS in production
   - Rotate API keys regularly

2. **Scalability**:
   - Consider load balancing
   - Use a proper database for state
   - Implement caching for MCP responses

3. **Monitoring**:
   - Add health check endpoints
   - Implement logging aggregation
   - Set up alerts for failures

4. **Backup**:
   - Regularly backup MCP modules
   - Keep API keys secure
   - Document recovery procedures

## Next Steps

1. Configure your first scribe
2. Test the desktop app
3. Test the mobile app
4. Set up AI features (OpenAI/local LLM)
5. Customize MCP module permissions
6. Update MCP modules as needed

## Support

For issues:
1. Check the logs: `docker-compose logs -f`
2. Review the Admin GUI for configuration errors
3. Verify all API keys are correct
4. Test individual components (LegendKeeper MCP first)
