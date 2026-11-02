import { Router, Request, Response, NextFunction } from 'express';
import { MCPModuleLoader } from '../mcp/loader';
import fs from 'fs';
import path from 'path';

const router = Router();

// In-memory storage
let scribes: Array<{
  id: string;
  username: string;
  role: 'dm' | 'player' | 'guest';
  mcpAccess: 'full' | 'read' | 'custom';
  worldId?: string;
  permissions: string[];
}> = [];

let mcpConfig: {
  legendkeeper?: { apiUrl: string; apiKey: string; githubUrl: string };
  kanka?: { apiUrl: string; apiKey: string; campaignId: string; githubUrl: string };
} = {};

// Admin credentials from environment
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  
  const token = authHeader.substring(7);
  // Decode basic auth (base64 of username:password)
  try {
    const [username, password] = Buffer.from(token, 'base64').toString().split(':');
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      next();
      return;
    }
  } catch {
    // Continue to check other auth methods
  }
  
  // Check if it's a scribe token (Bearer <token>)
  // For admin GUI, use basic auth: Bearer base64(username:password)
  res.status(401).json({ error: 'Admin authentication required' });
}

// Overview endpoint
router.get('/overview', requireAdmin, (req, res) => {
  const moduleLoader = req.app.get('moduleLoader');
  const modules = moduleLoader.getAllModules();
  
  res.json({
    activeScribes: scribes.length,
    mcpModules: modules.size,
    librarianStatus: 'online',
    scribes,
    modules: Array.from(modules.entries()).map(([name, module]) => ({
      name: module.name,
      version: module.version,
      type: name,
      status: 'healthy'
    }))
  });
});

// Scribes endpoints
router.get('/scribes', requireAdmin, (req, res) => {
  res.json(scribes);
});

router.post('/scribes', requireAdmin, (req, res) => {
  const { username, role, mcpAccess, worldId } = req.body;
  
  let permissions: string[] = [];
  if (role === 'dm') {
    permissions = ['world:read', 'world:write', 'node:read', 'node:write', 'map:read', 'map:write', 'mcp:full'];
  } else if (role === 'player') {
    permissions = ['world:read', 'node:read', 'map:read', 'mcp:read'];
  } else if (role === 'guest') {
    permissions = ['world:read', 'node:read', 'mcp:none'];
  }
  
  const newScribe = {
    id: Date.now().toString(),
    username,
    role,
    mcpAccess,
    worldId,
    permissions
  };
  
  scribes.push(newScribe);
  res.status(201).json(newScribe);
});

router.put('/scribes/:id', requireAdmin, (req, res) => {
  const scribeIndex = scribes.findIndex(s => s.id === req.params.id);
  if (scribeIndex === -1) {
    return res.status(404).json({ error: 'Scribe not found' });
  }
  
  const { role, mcpAccess, worldId } = req.body;
  scribes[scribeIndex] = {
    ...scribes[scribeIndex],
    role: role || scribes[scribeIndex].role,
    mcpAccess: mcpAccess || scribes[scribeIndex].mcpAccess,
    worldId: worldId || scribes[scribeIndex].worldId
  };
  
  res.json(scribes[scribeIndex]);
});

router.delete('/scribes/:id', requireAdmin, (req, res) => {
  const scribeIndex = scribes.findIndex(s => s.id === req.params.id);
  if (scribeIndex === -1) {
    return res.status(404).json({ error: 'Scribe not found' });
  }
  
  scribes.splice(scribeIndex, 1);
  res.json({ success: true, message: 'Scribe deleted' });
});

// MCP endpoints
router.get('/mcp/modules', requireAdmin, (req, res) => {
  const moduleLoader = req.app.get('moduleLoader');
  const modules = moduleLoader.getAllModules();
  
  res.json(Array.from(modules.entries()).map(([name, module]) => ({
    name: module.name,
    version: module.version,
    type: name,
    status: 'healthy'
  })));
});

router.post('/mcp/load', requireAdmin, (req, res) => {
  const { type, apiUrl, apiKey, githubUrl, campaignId, projectId } = req.body;
  
  if (!type) {
    return res.status(400).json({ error: 'type is required' });
  }
  
  const moduleLoader = req.app.get('moduleLoader');
  
  const config: any = { type, apiUrl, apiKey, campaignId, projectId, githubUrl };
  
  moduleLoader.loadModule(config)
    .then(module => {
      // Store config for update functionality
      if (type === 'legendkeeper' && githubUrl) {
        mcpConfig.legendkeeper = { apiUrl, apiKey, githubUrl };
      } else if (type === 'kanka' && githubUrl) {
        mcpConfig.kanka = { apiUrl, apiKey, campaignId, githubUrl };
      }
      
      res.json({
        success: true,
        message: `Loaded MCP module: ${module.name} v${module.version}`,
        module: { name: module.name, version: module.version, type }
      });
    })
    .catch(err => {
      res.status(500).json({ error: err.message });
    });
});

router.post('/mcp/update/:repoName', requireAdmin, (req, res) => {
  const { repoName } = req.params;
  const moduleLoader = req.app.get('moduleLoader');
  
  moduleLoader.updateModule(repoName)
    .then(success => {
      if (success) {
        res.json({ 
          success: true, 
          message: `MCP module ${repoName} updated successfully`,
          note: 'Module will be available after reload'
        });
      } else {
        res.status(500).json({ error: 'Failed to update module' });
      }
    })
    .catch(err => {
      res.status(500).json({ error: err.message });
    });
});

router.post('/mcp/unload', requireAdmin, (req, res) => {
  const { type, repoName } = req.body;
  
  if (!type && !repoName) {
    return res.status(400).json({ error: 'type or repoName is required' });
  }
  
  const moduleLoader = req.app.get('moduleLoader');
  
  try {
    const identifier = repoName || type;
    await moduleLoader.unloadModule(identifier);
    res.json({ success: true, message: `Unloaded MCP module: ${identifier}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Config endpoints
router.get('/config', requireAdmin, (req, res) => {
  res.json({
    librarian: {
      port: process.env.LIBRARIAN_PORT || '8090'
    },
    admin: {
      username: process.env.ADMIN_USERNAME || 'admin'
    },
    models: {
      main: {
        type: process.env.MAIN_MODEL_TYPE || 'local',
        url: process.env.MAIN_MODEL_URL,
        name: process.env.MAIN_MODEL_NAME
      },
      fallback: {
        type: process.env.FALLBACK_MODEL_TYPE || 'openrouter',
        apiKey: process.env.FALLBACK_API_KEY ? 'configured' : null,
        name: process.env.FALLBACK_MODEL_NAME
      }
    },
    mcp: mcpConfig
  });
});

router.post('/config/models/main', requireAdmin, (req, res) => {
  const { type, url, name } = req.body;
  
  if (type) process.env.MAIN_MODEL_TYPE = type;
  if (url) process.env.MAIN_MODEL_URL = url;
  if (name) process.env.MAIN_MODEL_NAME = name;
  
  res.json({ success: true, message: 'Main model configuration updated' });
});

router.post('/config/models/fallback', requireAdmin, (req, res) => {
  const { type, apiKey, name } = req.body;
  
  if (type) process.env.FALLBACK_MODEL_TYPE = type;
  if (apiKey) process.env.FALLBACK_API_KEY = apiKey;
  if (name) process.env.FALLBACK_MODEL_NAME = name;
  
  res.json({ success: true, message: 'Fallback model configuration updated' });
});

// Update MCP configuration
router.post('/config/mcp', requireAdmin, (req, res) => {
  const { repoName, apiUrl, apiKey, githubUrl, campaignId } = req.body;
  
  if (githubUrl) {
    mcpConfig[repoName] = { apiUrl, apiKey, githubUrl, campaignId };
  }
  
  res.json({ success: true, message: 'MCP configuration updated' });
});

// Health check (no auth required)
router.get('/health', (req, res) => {
  res.json({ status: 'ok', port: process.env.LIBRARIAN_PORT || '8090' });
});

export default router;
