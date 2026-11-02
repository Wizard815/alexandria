# Alexandria Librarian

The Librarian is the mother container for Alexandria. It provides:

- OpenAI API proxy for parallel LLM usage
- Embedding database for semantic search
- Connection to local LLMs (Argos, Ollama, etc.)

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your OpenAI API key and local LLM URLs
npm run dev
```

## Endpoints

- `/health` - Health check
- `/v1/chat/completions` - OpenAI chat completions proxy
- `/v1/embeddings` - OpenAI embeddings proxy
- `/v1/models` - List available models
- `/v1/local/chat/completions` - Local LLM chat (Argos, Ollama)
- `/v1/local/embeddings` - Local LLM embeddings

## Environment Variables

```
OPENAI_API_KEY=your_openai_api_key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_PROXY_PORT=8080
LOCAL_LLM_URL=http://localhost:11434
LOCAL_LLM_MODEL=llama3:70b
EMBEDDING_MODEL=text-embedding-3-small
```
