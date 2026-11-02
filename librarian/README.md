# Alexandria Librarian

The Librarian is the mother container for Alexandria. It provides:

- **OpenAI API proxy** for parallel LLM usage
- **Embedding database** for semantic search
- **Local LLM connection** (Argos, Ollama, etc.)
- **MCP World Builder Gateway** - unified access to Kanka, LegendKeeper, and generic world builder APIs

## Setup

```bash
cd librarian
npm install
cp .env.example .env
# Edit .env with your API keys and world builder URLs
npm run dev
```

## Endpoints

### OpenAI Proxy
- `/health` - Health check
- `/v1/chat/completions` - OpenAI chat completions proxy
- `/v1/embeddings` - OpenAI embeddings proxy
- `/v1/models` - List available models

### Local LLM Proxy (Argos, Ollama)
- `/v1/local/chat/completions` - Local LLM chat
- `/v1/local/embeddings` - Local LLM embeddings

### MCP World Builder Gateway
- `/mcp/status` - List configured MCP servers
- `/mcp/:worldType/*` - Generic MCP proxy (e.g., `/mcp/legendkeeper/...`)
- `/mcp/kanka/*` - Direct Kanka MCP endpoint
- `/mcp/legendkeeper/*` - Direct LegendKeeper MCP endpoint

### Embedding Database
- `/v1/search/embeddings` - Search embeddings
- `/v1/store/embeddings` - Store embeddings

## Environment Variables

### OpenAI
```
OPENAI_API_KEY=your_openai_api_key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_PROXY_PORT=8080
EMBEDDING_MODEL=text-embedding-3-small
```

### Local LLM
```
LOCAL_LLM_URL=http://localhost:11434
LOCAL_LLM_MODEL=llama3:70b
```

### MCP World Builder APIs
```
# Kanka MCP
MCP_KANKA_URL=http://localhost:3333

# LegendKeeper MCP
MCP_LEGENDKEEPER_URL=http://localhost:3334

# Generic world builder API
MCP_GENERIC_URL=http://localhost:3335
```

## Usage Examples

### Kanka MCP
```bash
# Search for entities
curl -X POST http://localhost:8080/mcp/kanka/search \
  -H "Content-Type: application/json" \
  -d '{"type": "character", "name": "Gandalf"}'

# Get entities
curl -X POST http://localhost:8080/mcp/kanka/entities \
  -H "Content-Type: application/json" \
  -d '{"entity_type": "location"}'
```

### LegendKeeper MCP
```bash
# Search for nodes
curl -X POST http://localhost:8080/mcp/legendkeeper/search \
  -H "Content-Type: application/json" \
  -d '{"query": "dragon"}'

# Get map markers
curl -X GET http://localhost:8080/mcp/legendkeeper/map_markers
```

### Generic MCP
```bash
# Use any world builder by type
curl -X POST http://localhost:8080/mcp/:worldType/endpoint \
  -H "Content-Type: application/json" \
  -d '{"param": "value"}'
```

## MCP World Builder Support

The Librarian supports any MCP-compatible world builder API:

| World Builder | Config Env Var | Default Port |
|---------------|----------------|--------------|
| Kanka | `MCP_KANKA_URL` | 3333 |
| LegendKeeper | `MCP_LEGENDKEEPER_URL` | 3334 |
| Generic | `MCP_GENERIC_URL` | 3335 |

Add new world builders by setting the appropriate environment variable.
