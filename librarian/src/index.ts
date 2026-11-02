import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import { MCPModuleLoader } from './mcp/loader';
import adminRoutes from './admin/routes';
import playerApiRoutes from './player-api/routes';

const app = express();
const PORT = parseInt(process.env.LIBRARIAN_PORT || '8090');

app.use(cors());
app.use(express.json());

// Initialize module loader
const moduleLoader = new MCPModuleLoader();
app.set('moduleLoader', moduleLoader);

// Serve admin GUI
app.use('/admin', express.static('admin-gui'));

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    mcpModules: moduleLoader.getModuleNames(),
    port: PORT
  });
});

// OpenAI proxy
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, model, temperature, max_tokens, stream = false } = req.body;
    const response = await openai.chat.completions.create({
      messages, model: model || 'gpt-4o', temperature: temperature ?? 0.7, max_tokens, stream
    });
    if (stream) res.status(501).json({ error: 'Streaming not implemented' });
    else res.json(response);
  } catch (error: any) {
    console.error('OpenAI API error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/v1/embeddings', async (req, res) => {
  try {
    const { input, model = 'text-embedding-3-small' } = req.body;
    const response = await openai.embeddings.create({ input, model });
    res.json(response);
  } catch (error: any) {
    console.error('OpenAI embeddings error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get('/v1/models', async (req, res) => {
  try {
    const response = await openai.models.list();
    res.json(response);
  } catch (error: any) {
    console.error('OpenAI models list error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Local LLM proxy
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL;

app.post('/v1/local/chat/completions', async (req, res) => {
  if (!LOCAL_LLM_URL) return res.status(501).json({ error: 'Local LLM URL not configured' });
  try {
    const { messages, model, temperature, max_tokens } = req.body;
    const response = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, model, temperature, max_tokens })
    });
    if (!response.ok) throw new Error(`Local LLM error: ${response.status}`);
    res.json(await response.json());
  } catch (error: any) {
    console.error('Local LLM error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/v1/local/embeddings', async (req, res) => {
  if (!LOCAL_LLM_URL) return res.status(501).json({ error: 'Local LLM URL not configured' });
  try {
    const { input, model } = req.body;
    const response = await fetch(`${LOCAL_LLM_URL}/v1/embeddings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, model })
    });
    if (!response.ok) throw new Error(`Local LLM embeddings error: ${response.status}`);
    res.json(await response.json());
  } catch (error: any) {
    console.error('Local LLM embeddings error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// MCP endpoints
app.post('/v1/mcp/load', async (req, res) => {
  try {
    const { type, apiKey, campaignId, projectId, apiUrl, githubUrl } = req.body;
    if (!type) return res.status(400).json({ error: 'Module type is required' });
    const config = { type, apiKey, campaignId, projectId, apiUrl, githubUrl };
    const module = await moduleLoader.loadModule(config);
    res.json({
      success: true,
      message: `Loaded MCP module: ${module.name} v${module.version}`,
      module: { name: module.name, version: module.version }
    });
  } catch (error: any) {
    console.error('Error loading MCP module:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/v1/mcp/unload', async (req, res) => {
  try {
    const { type, repoName } = req.body;
    if (!type && !repoName) return res.status(400).json({ error: 'type or repoName is required' });
    const identifier = repoName || type;
    await moduleLoader.unloadModule(identifier);
    res.json({ success: true, message: `Unloaded MCP module: ${identifier}` });
  } catch (error: any) {
    console.error('Error unloading MCP module:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/v1/mcp/modules', (req, res) => {
  const modules = moduleLoader.getAllModules();
  res.json({
    modules: Array.from(modules.entries()).map(([name, module]) => ({
      name: module.name,
      version: module.version,
      type: name,
      status: 'healthy'
    }))
  });
});

app.get('/v1/mcp/:type/status', async (req, res) => {
  try {
    const { type } = req.params;
    const module = moduleLoader.getModule(type);
    if (!module) {
      return res.status(404).json({ 
        error: `Module not found: ${type}`,
        availableTypes: moduleLoader.getModuleNames()
      });
    }
    const status = await module.status();
    res.json({ type, status });
  } catch (error: any) {
    console.error(`Error getting status for ${req.params.type}:`, error);
    res.status(500).json({ error: error.message, type: req.params.type });
  }
});

app.post('/v1/mcp/:type/*', async (req, res) => {
  try {
    const { type } = req.params;
    const module = moduleLoader.getModule(type);
    if (!module) {
      return res.status(404).json({ 
        error: `Module not found: ${type}`,
        suggestions: [
          'Load the module first: POST /v1/mcp/load',
          `Available modules: ${moduleLoader.getModuleNames().join(', ')}`
        ]
      });
    }

    const path = req.params[0] || '';
    const body = req.body;

    if (path === 'find_entities') res.json(await module.findEntities(body));
    else if (path === 'get_entity') res.json(await module.getEntity(body.entityId));
    else if (path === 'create_entity') res.json(await module.createEntity(body.entity));
    else if (path === 'update_entity') res.json(await module.updateEntity(body.entity));
    else if (path === 'delete_entity') { await module.deleteEntity(body.entityId); res.json({ success: true }); }
    else if (path === 'search') res.json(await module.search(body.query, body.options));
    else if (path === 'get_map_features') res.json(await module.getMapFeatures(body.mapId));
    else if (path === 'create_map_feature') res.json(await module.createMapFeature(body.feature));
    else if (path === 'read_page') res.json(await module.readPage(body.pageId));
    else if (path === 'write_page') res.json(await module.writePage(body.pageId, body.content));
    else res.status(404).json({ error: `Unknown endpoint: ${path}` });
  } catch (error: any) {
    console.error(`MCP module ${req.params.type} error:`, error);
    res.status(error.status || 500).json({ error: error.message, type: req.params.type });
  }
});

// Admin API routes
app.use('/api/admin', adminRoutes);

// Player API routes
app.use('/api/player', playerApiRoutes);

// Library API routes (unified)
app.use('/api/library', (req, res) => {
  res.json({
    message: 'Library API available',
    endpoints: {
      admin: '/api/admin/*',
      player: '/api/player/*'
    }
  });
});

app.listen(PORT, () => {
  console.log(`Alexandria Librarian running on port ${PORT}`);
  console.log('Health: http://localhost:' + PORT + '/health');
  console.log('Admin UI: http://localhost:' + PORT + '/admin');
  console.log('OpenAI: /v1/chat/completions, /v1/embeddings, /v1/models');
  console.log('Local LLM: /v1/local/chat/completions, /v1/local/embeddings');
  console.log('MCP: /v1/mcp/load, /v1/mcp/unload, /v1/mcp/modules, /v1/mcp/:type/status, /v1/mcp/:type/*');
  console.log('Admin API: /api/admin/*');
  console.log('Player API: /api/player/*');
  console.log('Library API: /api/library/*');
});
