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

// ====================
// MCP World Builder Gateway (Kanka, LegendKeeper, Generic)
// ====================

// MCP server configurations
const MCP_SERVERS: Record<string, string> = {
  kanka: process.env.MCP_KANKA_URL || 'http://localhost:3333',
  legendkeeper: process.env.MCP_LEGENDKEEPER_URL || 'http://localhost:3334',
  generic: process.env.MCP_GENERIC_URL || 'http://localhost:3335',
};

// MCP proxy endpoint - generic routing based on world type
app.post('/mcp/:worldType/*', async (req, res) => {
  const { worldType } = req.params;
  const worldUrl = MCP_SERVERS[worldType];

  if (!worldUrl) {
    return res.status(404).json({ 
      error: `Unknown world type: ${worldType}`,
      availableTypes: Object.keys(MCP_SERVERS)
    });
  }

  try {
    // Get the path after /mcp/:worldType/
    const path = req.params[0] || '';
    const url = `${worldUrl}/${path}`;

    const body = req.body;

    const response = await fetch(url, {
      method: req.method,
      headers: { 
        'Content-Type': 'application/json',
        ...req.headers.authorization && { 'Authorization': req.headers.authorization }
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MCP ${worldType} error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    console.error(`MCP ${worldType} error:`, error);
    res.status(error.status || 500).json({ 
      error: error.message,
      worldType,
      suggestions: [
        'Check if MCP server is running',
        'Verify MCP_SERVERS configuration in .env',
        `Try: MCP_${worldType.toUpperCase()}_URL=http://your-server:port`
      ]
    });
  }
});

// Direct MCP server endpoints for convenience
app.post('/mcp/kanka/*', async (req, res) => {
  const path = req.params[0] || '';
  const url = `${MCP_SERVERS.kanka}/${path}`;
  
  try {
    const response = await fetch(url, {
      method: req.method,
      headers: { 
        'Content-Type': 'application/json',
        ...req.headers.authorization && { 'Authorization': req.headers.authorization }
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MCP Kanka error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    console.error('MCP Kanka error:', error);
    res.status(error.status || 500).json({ 
      error: error.message,
      suggestions: [
        'Check MCP Kanka server is running',
        'Verify MCP_KANKA_URL in .env',
        'Default: MCP_KANKA_URL=http://localhost:3333'
      ]
    });
  }
});

app.post('/mcp/legendkeeper/*', async (req, res) => {
  const path = req.params[0] || '';
  const url = `${MCP_SERVERS.legendkeeper}/${path}`;
  
  try {
    const response = await fetch(url, {
      method: req.method,
      headers: { 
        'Content-Type': 'application/json',
        ...req.headers.authorization && { 'Authorization': req.headers.authorization }
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MCP LegendKeeper error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    console.error('MCP LegendKeeper error:', error);
    res.status(error.status || 500).json({ 
      error: error.message,
      suggestions: [
        'Check MCP LegendKeeper server is running',
        'Verify MCP_LEGENDKEEPER_URL in .env',
        'Default: MCP_LEGENDKEEPER_URL=http://localhost:3334'
      ]
    });
  }
});

// World builder status endpoint
app.get('/mcp/status', (req, res) => {
  res.json({
    mcp: {
      kanka: MCP_SERVERS.kanka,
      legendkeeper: MCP_SERVERS.legendkeeper,
      generic: MCP_SERVERS.generic
    }
  });
});

// ====================
// Start Server
// ====================

app.listen(PORT, () => {
  console.log(`Alexandria Librarian running on port ${PORT}`);
  console.log('');
  console.log('Health check:');
  console.log(`  http://localhost:${PORT}/health`);
  console.log('');
  console.log('OpenAI Proxy:');
  console.log(`  Chat:    http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  Embeddings: http://localhost:${PORT}/v1/embeddings`);
  console.log(`  Models:    http://localhost:${PORT}/v1/models`);
  console.log('');
  
  if (LOCAL_LLM_URL) {
    console.log('Local LLM Proxy:');
    console.log(`  Chat:    http://localhost:${PORT}/v1/local/chat/completions`);
    console.log(`  Embeddings: http://localhost:${PORT}/v1/local/embeddings`);
    console.log(`  URL:     ${LOCAL_LLM_URL}`);
    console.log('');
  }
  
  console.log('MCP World Builder Gateway:');
  console.log(`  Status:     http://localhost:${PORT}/mcp/status`);
  console.log(`  Generic:    http://localhost:${PORT}/mcp/:worldType/*`);
  console.log(`  Kanka:      http://localhost:${PORT}/mcp/kanka/*`);
  console.log(`  LegendKeeper: http://localhost:${PORT}/mcp/legendkeeper/*`);
  console.log('');
});
