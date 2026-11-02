// Base MCP Module class with dynamic loading support
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

export interface MCPStatus {
  name: string;
  version: string;
  status: 'healthy' | 'unhealthy' | 'loading';
  lastCheck: string;
}

export abstract class MCPModule {
  abstract readonly name: string;
  abstract readonly version: string;

  protected config: Record<string, any>;

  constructor(config: Record<string, any>) {
    this.config = config;
  }

  async health(): Promise<boolean> {
    try {
      const status = await this.status();
      return status.status === 'healthy';
    } catch {
      return false;
    }
  }

  abstract async status(): Promise<MCPStatus>;

  // Dynamic module loading - pull from GitHub and build
  static async loadFromGitHub(
    repoUrl: string,
    config: Record<string, any>
  ): Promise<MCPModule> {
    const repoName = this.getRepoName(repoUrl);
    const modulePath = path.join('/app/mcp-modules', repoName);

    console.log(`Loading MCP module from ${repoUrl}...`);

    // Clone/update repository
    if (!fs.existsSync(modulePath)) {
      console.log(`Cloning repository: ${repoUrl}`);
      await execAsync(`git clone ${repoUrl} ${modulePath}`);
    } else {
      console.log(`Updating repository: ${repoUrl}`);
      await execAsync(`cd ${modulePath} && git pull`);
    }

    // Install dependencies if package.json exists
    const packageJsonPath = path.join(modulePath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      console.log('Installing dependencies...');
      await execAsync(`cd ${modulePath} && npm ci --only=production`);
    }

    // Load the module dynamically
    const moduleType = await this.detectModuleType(modulePath);
    return this.createModuleFromType(moduleType, modulePath, config);
  }

  static async createModuleFromType(
    moduleType: string,
    modulePath: string,
    config: Record<string, any>
  ): Promise<MCPModule> {
    // Import the module dynamically
    try {
      const modulePathAbsolute = path.resolve(modulePath, 'src', 'index.ts');
      const importedModule = await import(modulePathAbsolute);

      // Create instance based on module type
      if (moduleType === 'legendkeeper') {
        const { LegendKeeperModule } = await import('./legendkeeper');
        return new LegendKeeperModule(config);
      } else if (moduleType === 'kanka') {
        const { KankaModule } = await import('./kanka');
        return new KankaModule(config);
      } else {
        const { GenericModule } = await import('./generic');
        return new GenericModule(config);
      }
    } catch (err) {
      console.error(`Error creating module from type ${moduleType}:`, err);
      throw err;
    }
  }

  static detectModuleType(modulePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const packageJsonPath = path.join(modulePath, 'package.json');
      
      if (!fs.existsSync(packageJsonPath)) {
        resolve('generic');
        return;
      }

      fs.readFile(packageJsonPath, 'utf8', (err, data) => {
        if (err) {
          reject(err);
          return;
        }

        try {
          const packageJson = JSON.parse(data);
          
          // Check for MCP-specific keywords in package.json
          if (packageJson.name?.includes('legendkeeper') || 
              packageJson.keywords?.includes('legendkeeper')) {
            resolve('legendkeeper');
          } else if (packageJson.name?.includes('kanka') || 
                     packageJson.keywords?.includes('kanka')) {
            resolve('kanka');
          } else {
            resolve('generic');
          }
        } catch (parseErr) {
          resolve('generic');
        }
      });
    });
  }

  static getRepoName(repoUrl: string): string {
    // Extract repo name from GitHub URL
    const parts = repoUrl.replace(/\.git$/, '').split('/');
    return parts[parts.length - 1];
  }
}
