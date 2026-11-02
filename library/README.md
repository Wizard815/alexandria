# Alexandria Library (LegendKeeper MCP)

The Library is the LegendKeeper MCP server that provides access to D&D world data.

## Setup

```bash
cp .env.example .env
# Edit .env with your LegendKeeper API key
docker compose up -d
```

## Endpoint

- `http://localhost:8000/mcp` - MCP server endpoint

## Environment Variables

```
LEGENDKEEPER_API_KEY=your_legendkeeper_api_key
MCP_AUTH_TOKEN=your_secure_token
MCP_TRANSPORT=http
```
