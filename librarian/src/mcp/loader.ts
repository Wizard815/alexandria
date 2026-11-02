import { MCPModule } from './modules/base';
import { KankaModule, KankaConfig } from './modules/kanka';
import { LegendKeeperModule, LegendKeeperConfig } from './modules/legendkeeper';
import { GenericModule, GenericConfig } from './modules/generic';

export interface ModuleConfig {
  type: 'kanka' | 'legendkeeper' | 'generic';
  url?: string;
  apiUrl?: string;
  apiKey?: string;
  campaignId?: string;
  projectId?: string;
  [key: string]: any;
}

export class MCPModuleLoader {
  private modules: Map<string, MCPModule> = new Map();

  /**
   * Load an MCP module by type
   */
  async loadModule(config: ModuleConfig): Promise<MCPModule> {
    let module: MCPModule;

    switch (config.type) {
      case 'kanka':
        if (!config.apiKey || !config.campaignId) {
          throw new Error('Kanka module requires apiKey and campaignId');
        }
        module = new KankaModule({
          apiUrl: config.apiUrl || config.url,
          apiKey: config.apiKey,
          campaignId: config.campaignId
        });
        break;

      case 'legendkeeper':
        if (!config.apiKey) {
          throw new Error('LegendKeeper module requires apiKey');
        }
        module = new LegendKeeperModule({
          apiUrl: config.apiUrl || config.url,
          apiKey: config.apiKey,
          projectId: config.projectId
        });
        break;

      case 'generic':
        if (!config.apiUrl) {
          throw new Error('Generic module requires apiUrl');
        }
        module = new GenericModule({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey
        });
        break;

      default:
        throw new Error(`Unknown MCP module type: ${config.type}`);
    }

    // Verify the module is healthy
    const status = await module.status();
    if (status.status !== 'healthy') {
      throw new Error(`Module ${config.type} is not healthy: ${status.status}`);
    }

    this.modules.set(config.type, module);
    return module;
  }

  /**
   * Get a loaded module by type
   */
  getModule(type: string): MCPModule | undefined {
    return this.modules.get(type);
  }

  /**
   * Unload a module by type
   */
  async unloadModule(type: string): Promise<void> {
    const module = this.modules.get(type);
    if (module) {
      this.modules.delete(type);
    }
  }

  /**
   * Get all loaded modules
   */
  getAllModules(): Map<string, MCPModule> {
    return this.modules;
  }

  /**
   * Get all module names
   */
  getModuleNames(): string[] {
    return Array.from(this.modules.keys());
  }

  /**
   * Check if a module is loaded
   */
  hasModule(type: string): boolean {
    return this.modules.has(type);
  }
}
