import { MCPModule } from './modules/base';
import { LegendKeeperModule, LegendKeeperConfig } from './modules/legendkeeper';
import { KankaModule, KankaConfig } from './modules/kanka';
import { GenericModule, GenericConfig } from './modules/generic';

export interface ModuleConfig {
  type: 'legendkeeper' | 'kanka' | 'generic';
  apiUrl?: string;
  apiKey?: string;
  githubUrl?: string;
  campaignId?: string;
  projectId?: string;
  [key: string]: any;
}

export class MCPModuleLoader {
  private modules: Map<string, MCPModule> = new Map();
  private githubRepos: Map<string, { url: string; path: string }> = new Map();

  /**
   * Load an MCP module from GitHub repository
   */
  async loadModuleFromGitHub(config: ModuleConfig): Promise<MCPModule> {
    if (!config.githubUrl) {
      throw new Error('GitHub URL is required for dynamic loading');
    }

    const repoName = this.getRepoName(config.githubUrl);
    const modulePath = `/app/mcp-modules/${repoName}`;

    // Check if already loaded
    if (this.modules.has(repoName)) {
      return this.modules.get(repoName)!;
    }

    // Load module
    const module = await this.loadModule({
      type: config.type,
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      campaignId: config.campaignId,
      projectId: config.projectId
    });

    // Store GitHub URL for updates
    this.githubRepos.set(repoName, { url: config.githubUrl, path: modulePath });

    return module;
  }

  /**
   * Load an MCP module by type
   */
  async loadModule(config: ModuleConfig): Promise<MCPModule> {
    let module: MCPModule;

    switch (config.type) {
      case 'legendkeeper':
        if (!config.apiKey) {
          throw new Error('LegendKeeper module requires apiKey');
        }
        module = new LegendKeeperModule({
          apiUrl: config.apiUrl || 'https://www.legendkeeper.com/api/v3',
          apiKey: config.apiKey,
          projectId: config.projectId
        });
        break;

      case 'kanka':
        if (!config.apiKey || !config.campaignId) {
          throw new Error('Kanka module requires apiKey and campaignId');
        }
        module = new KankaModule({
          apiUrl: config.apiUrl || 'https://api.kanka.io/1.0',
          apiKey: config.apiKey,
          campaignId: config.campaignId
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

    const repoName = this.getRepoName(config.githubUrl || '');
    if (repoName) {
      this.modules.set(repoName, module);
    } else {
      this.modules.set(config.type, module);
    }

    return module;
  }

  /**
   * Get a loaded module by type or repo name
   */
  getModule(identifier: string): MCPModule | undefined {
    // First try exact match
    if (this.modules.has(identifier)) {
      return this.modules.get(identifier);
    }

    // Try as type
    const types = ['legendkeeper', 'kanka', 'generic'];
    if (types.includes(identifier)) {
      return this.modules.get(identifier);
    }

    return undefined;
  }

  /**
   * Unload a module by type or repo name
   */
  async unloadModule(identifier: string): Promise<void> {
    const module = this.modules.get(identifier);
    if (module) {
      this.modules.delete(identifier);
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
  hasModule(identifier: string): boolean {
    return this.modules.has(identifier);
  }

  /**
   * Update MCP module from GitHub
   */
  async updateModule(repoName: string): Promise<boolean> {
    const repoInfo = this.githubRepos.get(repoName);
    if (!repoInfo) {
      throw new Error(`No GitHub repo found for: ${repoName}`);
    }

    console.log(`Updating MCP module: ${repoName}`);
    console.log(`Repository: ${repoInfo.url}`);

    try {
      // Pull latest changes
      const { stdout, stderr } = await execAsync(`cd ${repoInfo.path} && git pull`);
      console.log(`Git pull: ${stdout}`);
      if (stderr) console.error(`Git stderr: ${stderr}`);

      // Rebuild if needed
      const packageJsonPath = `${repoInfo.path}/package.json`;
      if (require('fs').existsSync(packageJsonPath)) {
        console.log('Rebuilding module...');
        const { stdout: npmStdout, stderr: npmStderr } = await execAsync(
          `cd ${repoInfo.path} && npm ci --only=production`
        );
        console.log(`NPM install: ${npmStdout}`);
        if (npmStderr) console.error(`NPM stderr: ${npmStderr}`);
      }

      // Reload module
      const moduleConfig = this.getModuleConfigFromEnv(repoName);
      await this.unloadModule(repoName);
      const newModule = await this.loadModule(moduleConfig);

      return true;
    } catch (err) {
      console.error(`Failed to update module ${repoName}:`, err);
      throw err;
    }
  }

  /**
   * Get module configuration from environment variables
   */
  private getModuleConfigFromEnv(repoName: string): ModuleConfig {
    const envKey = repoName.toUpperCase().replace(/-/g, '_');
    const apiUrl = process.env[`${envKey}_API_URL`];
    const apiKey = process.env[`${envKey}_API_KEY`];
    const campaignId = process.env[`${envKey}_CAMPAIGN_ID`];
    const projectId = process.env[`${envKey}_PROJECT_ID`];

    return {
      type: repoName.includes('legendkeeper') ? 'legendkeeper' :
             repoName.includes('kanka') ? 'kanka' : 'generic',
      apiUrl,
      apiKey,
      campaignId: campaignId ? parseInt(campaignId) : undefined,
      projectId
    };
  }

  private getRepoName(githubUrl: string): string {
    return githubUrl.replace(/\.git$/, '').split('/').pop() || 'generic';
  }
}

export default MCPModuleLoader;
