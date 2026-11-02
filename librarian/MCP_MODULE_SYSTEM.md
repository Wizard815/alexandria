# MCP Module System Design for Alexandria Librarian

## Architecture Overview

```
librarian/
├── src/
│   ├── index.ts              # Express server entry point
│   ├── mcp/                  # MCP module system
│   │   ├── index.ts          # Module loader and registry
│   │   ├── types.ts          # Shared types and interfaces
│   │   ├── modules/          # Individual MCP module implementations
│   │   │   ├── base.ts       # Base class for all modules
│   │   │   ├── kanka.ts      # Kanka MCP implementation
│   │   │   ├── legendkeeper.ts  # LegendKeeper MCP implementation
│   │   │   └── generic.ts    # Generic MCP wrapper
│   │   └── client.ts         # Unified client interface
│   └── ...
├── mcp/                      # External MCP servers (optional)
│   ├── kanka/                # Copy of mcp-kanka source
│   └── legendkeeper/         # Copy of legendkeeper-mcp source
└── ...
```

## Module System Design

### 1. Base Module Interface (types.ts)

```typescript
export interface MCPModule {
  readonly name: string;
  readonly version: string;
  
  // Status
  status(): Promise<MCPStatus>;
  
  // Entity Operations
  findEntities(params: FindEntitiesParams): Promise<EntityResult>;
  getEntity(entityId: string): Promise<Entity>;
  createEntity(entity: Entity): Promise<Entity>;
  updateEntity(entity: Entity): Promise<Entity>;
  deleteEntity(entityId: string): Promise<void>;
  
  // Map Operations
  getMapFeatures(mapId: string): Promise<MapFeature[]>;
  createMapFeature(feature: MapFeature): Promise<MapFeature>;
  
  // Timeline Operations
  getTimelineEvents(timelineId: string): Promise<TimelineEvent[]>;
  
  // Document Operations
  readPage(pageId: string): Promise<PageContent>;
  writePage(pageId: string, content: PageContent): Promise<void>;
  
  // Search
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  
  // Health
  health(): Promise<boolean>;
}
```

### 2. Module Loader (modules/index.ts)

```typescript
import { MCPModule } from './types';
import { KankaModule } from './modules/kanka';
import { LegendKeeperModule } from './modules/legendkeeper';
import { GenericModule } from './modules/generic';

export interface ModuleConfig {
  type: 'kanka' | 'legendkeeper' | 'generic';
  url?: string;
  apiKey?: string;
  projectId?: string;
  [key: string]: any;
}

export class MCPModuleLoader {
  private modules: Map<string, MCPModule> = new Map();

  async loadModule(config: ModuleConfig): Promise<MCPModule> {
    let module: MCPModule;

    switch (config.type) {
      case 'kanka':
        module = new KankaModule(config);
        break;
      case 'legendkeeper':
        module = new LegendKeeperModule(config);
        break;
      case 'generic':
        module = new GenericModule(config);
        break;
      default:
        throw new Error(`Unknown MCP module type: ${config.type}`);
    }

    await module.health();
    this.modules.set(config.type, module);
    return module;
  }

  getModule(type: string): MCPModule | undefined {
    return this.modules.get(type);
  }

  async unloadModule(type: string): Promise<void> {
    const module = this.modules.get(type);
    if (module) {
      this.modules.delete(type);
    }
  }

  async getAllModules(): Promise<Map<string, MCPModule>> {
    return this.modules;
  }
}
```

### 3. Kanka Module Implementation (modules/kanka.ts)

```typescript
import { MCPModule } from './base';
import { MCPModuleLoader } from '../index';

export class KankaModule extends MCPModule {
  readonly name = 'kanka';
  readonly version = '0.1.0';
  
  private apiUrl: string;
  private apiKey: string;
  private campaignId: string;

  constructor(config: KankaConfig) {
    super();
    this.apiUrl = config.apiUrl || 'https://api.kanka.io/1.0';
    this.apiKey = config.apiKey;
    this.campaignId = config.campaignId;
  }

  async health(): Promise<boolean> {
    const response = await fetch(`${this.apiUrl}/campaigns/${this.campaignId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });
    return response.ok;
  }

  async findEntities(params: FindEntitiesParams): Promise<EntityResult> {
    // Kanka-specific implementation
    // Uses: https://api.kanka.io/1.0/campaigns/{campaignId}/entities
  }

  async createEntity(entity: Entity): Promise<Entity> {
    // Kanka-specific implementation
    // Uses: https://api.kanka.io/1.0/campaigns/{campaignId}/entities
  }

  // ... other methods
}
```

### 4. LegendKeeper Module Implementation (modules/legendkeeper.ts)

```typescript
import { MCPModule } from './base';

export class LegendKeeperModule extends MCPModule {
  readonly name = 'legendkeeper';
  readonly version = '0.2.0';
  
  private apiUrl: string;
  private apiKey: string;
  private projectId: string;

  constructor(config: LegendKeeperConfig) {
    super();
    this.apiUrl = config.apiUrl || 'https://www.legendkeeper.com/api/v3';
    this.apiKey = config.apiKey;
    this.projectId = config.projectId;
  }

  async health(): Promise<boolean> {
    const response = await fetch(`${this.apiUrl}/projects/${this.projectId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });
    return response.ok;
  }

  async findEntities(params: FindEntitiesParams): Promise<EntityResult> {
    // LegendKeeper-specific implementation
    // Uses: https://www.legendkeeper.com/developers/
  }

  async createEntity(entity: Entity): Promise<Entity> {
    // LegendKeeper-specific implementation
    // Uses: https://www.legendkeeper.com/developers/
  }

  // ... other methods
}
```

### 5. Generic Module (modules/generic.ts)

```typescript
import { MCPModule } from './base';

export class GenericModule extends MCPModule {
  readonly name = 'generic';
  readonly version = '1.0.0';
  
  private apiUrl: string;
  private apiKey?: string;

  constructor(config: GenericConfig) {
    super();
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
  }

  async health(): Promise<boolean> {
    const response = await fetch(`${this.apiUrl}/health`);
    return response.ok;
  }

  async findEntities(params: FindEntitiesParams): Promise<EntityResult> {
    const response = await fetch(`${this.apiUrl}/entities`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      throw new Error(`Generic MCP error: ${response.status}`);
    }

    return await response.json();
  }

  // ... other methods delegate to generic endpoints
}
```

## Configuration System

### .env.example

```bash
# OpenAI
OPENAI_API_KEY=your_openai_api_key
OPENAI_BASE_URL=https://api.openai.com/v1

# Local LLM
LOCAL_LLM_URL=http://localhost:11434
LOCAL_LLM_MODEL=llama3:70b

# MCP Modules
MCP_MODULES=kanka,legendkeeper

# Kanka MCP
MCP_KANKA_URL=http://localhost:3333
MCP_KANKA_API_KEY=your_kanka_token
MCP_KANKA_CAMPAIGN_ID=your_campaign_id

# LegendKeeper MCP
MCP_LEGENDKEEPER_URL=http://localhost:3334
MCP_LEGENDKEEPER_API_KEY=your_legendkeeper_key
MCP_LEGENDKEEPER_PROJECT_ID=your_project_id

# Generic MCP
MCP_GENERIC_URL=http://localhost:3335
MCP_GENERIC_API_KEY=your_api_key
```

### Dynamic Module Loading

```typescript
// Load modules based on .env configuration
const moduleLoader = new MCPModuleLoader();
const moduleNames = (process.env.MCP_MODULES || '').split(',');

for (const moduleName of moduleNames) {
  const cleanName = moduleName.trim();
  if (!cleanName) continue;
  
  const config = getModuleConfig(cleanName);
  if (config) {
    await moduleLoader.loadModule(config);
  }
}
```

## API Endpoints

All modules expose the same API surface:

```
POST /v1/mcp/:module/find_entities
POST /v1/mcp/:module/get_entity/:id
POST /v1/mcp/:module/create_entity
POST /v1/mcp/:module/update_entity
DELETE /v1/mcp/:module/delete_entity/:id
POST /v1/mcp/:module/search
GET /v1/mcp/:module/map_features/:map_id
GET /v1/mcp/:module/status
GET /v1/mcp/:module/health
```

## Benefits of This Design

1. **Extensibility**: Add new MCP servers by implementing the interface
2. **Type Safety**: TypeScript ensures all modules implement required methods
3. **Runtime Loading**: Modules can be enabled/disabled via config
4. **Unified API**: Same endpoints regardless of underlying MCP
5. **Error Handling**: Consistent error responses across all modules
