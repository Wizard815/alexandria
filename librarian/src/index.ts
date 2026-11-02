import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';

const app = express();
const PORT = process.env.OPENAI_PROXY_PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Chat completions - proxied to OpenAI
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, model, temperature, max_tokens, stream = false } = req.body;

    const response = await openai.chat.completions.create({
      messages,
      model: model || 'gpt-4o',
      temperature: temperature ?? 0.7,
      max_tokens,
      stream,
    });

    if (stream) {
      res.status(501).json({ error: 'Streaming not implemented' });
    } else {
      res.json(response);
    }
  } catch (error: any) {
    console.error('OpenAI API error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Embeddings - proxied to OpenAI
app.post('/v1/embeddings', async (req, res) => {
  try {
    const { input, model = 'text-embedding-3-small' } = req.body;

    const response = await openai.embeddings.create({
      input,
      model,
    });

    res.json(response);
  } catch (error: any) {
    console.error('OpenAI embeddings error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// List models
app.get('/v1/models', async (req, res) => {
  try {
    const response = await openai.models.list();
    res.json(response);
  } catch (error: any) {
    console.error('OpenAI models list error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Local LLM endpoints (optional - for Argos, Ollama, etc.)
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL;

// Local chat completions
app.post('/v1/local/chat/completions', async (req, res) => {
  if (!LOCAL_LLM_URL) {
    return res.status(501).json({ error: 'Local LLM URL not configured' });
  }

  try {
    const { messages, model, temperature, max_tokens } = req.body;

    const response = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, model, temperature, max_tokens }),
    });

    if (!response.ok) {
      throw new Error(`Local LLM error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    console.error('Local LLM error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Local embeddings
app.post('/v1/local/embeddings', async (req, res) => {
  if (!LOCAL_LLM_URL) {
    return res.status(501).json({ error: 'Local LLM URL not configured' });
  }

  try {
    const { input, model } = req.body;

    const response = await fetch(`${LOCAL_LLM_URL}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, model }),
    });

    if (!response.ok) {
      throw new Error(`Local LLM embeddings error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    console.error('Local LLM embeddings error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Alexandria Librarian running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`OpenAI proxy:`);
  console.log(`  - Chat: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  - Embeddings: http://localhost:${PORT}/v1/embeddings`);
  console.log(`  - Models: http://localhost:${PORT}/v1/models`);
  if (LOCAL_LLM_URL) {
    console.log(`Local LLM proxy (${LOCAL_LLM_URL}):`);
    console.log(`  - Chat: http://localhost:${PORT}/v1/local/chat/completions`);
    console.log(`  - Embeddings: http://localhost:${PORT}/v1/local/embeddings`);
  }
});
