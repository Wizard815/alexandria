# Alexandria - The D&D World App

A modern D&D campaign management system with a librarian (mother container), library (LegendKeeper MCP), and scribes (desktop/mobile apps).

## Architecture

```
Alexandria/
├── librarian/          # Mother container - OpenAI proxy, embedding DB
├── library/            # LegendKeeper MCP server (the library)
├── scribes/
│   ├── desktop/        # Desktop app for DM/Player
│   └── mobile/         # Mobile app for on-the-go access
└── embeddings/         # Embedding database for local search
```

## Roles

- **Librarian (librarian/)**: The central container that handles:
  - OpenAI API proxy for parallel LLM usage
  - Embedding database for semantic search
  - Connection to local LLMs (Argos, Ollama, etc.)
  
- **Library (library/)**: The LegendKeeper MCP server that provides:
  - D&D world data access
  - Node/page management
  - Map and marker tools
  
- **Scribes (scribes/)**: Desktop and mobile apps that:
  - Search the library using embeddings
  - Read and write D&D content
  - Sync with the librarian for AI assistance

## Quick Start

### 1. Configure the Library (LegendKeeper MCP)

```bash
cd library
cp .env.example .env
# Edit .env with your LegendKeeper API key
docker compose up -d
```

### 2. Configure the Librarian

```bash
cd librarian
npm install
cp .env.example .env
# Edit .env with your OpenAI API key
npm run dev
```

### 3. Run the Embedding Database

```bash
cd embeddings
npm install
cp .env.example .env
npm run dev
```

### 4. Build the Scribes

```bash
cd scribes/desktop
npm install
npm run dev

cd scribes/mobile
npm install
npm start
```

## Environment Variables

### Librarian (.env)
```
OPENAI_API_KEY=your_openai_api_key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_PROXY_PORT=8080
EMBEDDING_MODEL=text-embedding-3-small
```

### Library (.env)
```
LEGENDKEEPER_API_KEY=your_legendkeeper_api_key
MCP_AUTH_TOKEN=your_secure_token
MCP_TRANSPORT=http
```

### Embeddings (.env)
```
EMBEDDING_DB_PORT=8081
OPENAI_PROXY_URL=http://localhost:8080
EMBEDDING_MODEL=text-embedding-3-small
```

## How It Works

1. **Scribes** connect to the **Librarian** for AI-powered search
2. The **Librarian** proxies OpenAI API calls and manages embeddings
3. **Embeddings** stores vector representations of D&D content
4. The **Library** (LegendKeeper MCP) provides structured D&D data
5. When a scribe searches, it uses embeddings to find relevant content from the library

## Local LLM Integration

The Librarian can connect to local LLMs like:
- **Argos**: Run your own models with llama.cpp
- **Ollama**: Simple local LLM server
- **LM Studio**: GUI for local models

Configure in `librarian/.env`:
```
LOCAL_LLM_URL=http://localhost:11434
LOCAL_LLM_MODEL=llama3:70b
```

## Platform Support

- **Linux**: Desktop app via Tauri
- **Windows**: Desktop app via Tauri
- **macOS**: Desktop app via Tauri
- **Android**: Mobile app via Expo
- **iOS**: Mobile app via Expo

## License

MIT
