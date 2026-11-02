# Alexandria Embeddings

The Embeddings service stores and searches vector representations of D&D content.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with OpenAI proxy URL
npm run dev
```

## Endpoints

- `/health` - Health check
- `/embeddings` - Store embeddings
- `/search` - Search embeddings by cosine similarity
- `/embeddings/:limit/:offset` - List embeddings

## Environment Variables

```
EMBEDDING_DB_PORT=8081
OPENAI_PROXY_URL=http://localhost:8080
EMBEDDING_MODEL=text-embedding-3-small
```
